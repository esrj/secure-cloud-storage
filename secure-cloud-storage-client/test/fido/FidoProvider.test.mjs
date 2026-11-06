// Run: node --test test/fido/*.test.mjs
// Real-key test: FIDO_E2E=1 node --test test/fido/*.test.mjs   (touch the key when asked; FIDO_PIN is used if the PIN is needed)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import FidoProvider, {
  FidoError,
  deriveExtraKeyFromFidoSecret,
  resolveHelperPath
} from '../../src/main/FidoProvider.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', '..')
const quietLogger = { info() {}, warn() {}, error() {} }

function fakeProvider(mode, opts = {}) {
  process.env.FAKE_MODE = mode
  return new FidoProvider({
    helperPath: join(here, 'fake_helper.mjs'),
    pythonPath: process.execPath,
    logger: quietLogger,
    ...opts
  })
}

test('register forwards base64url params, relays events, returns secret as Buffer', async () => {
  const p = fakeProvider('register')
  const events = []
  const res = await p.register(
    {
      challenge: Buffer.from([1, 2, 3]),
      userId: Buffer.from('u1'),
      userName: 'alice',
      salt: Buffer.alloc(32, 9)
    },
    { onEvent: (e) => events.push(e.event) }
  )
  assert.deepEqual(events, ['uv', 'uv-failed'])
  assert.ok(Buffer.isBuffer(res.secret))
  assert.equal(res.secret.length, 32)
  assert.equal(res.credential.id, 'Y3JlZA')
  assert.equal(
    'secret' in res.credential,
    false,
    'secret must not be inside the object sent to the server'
  )
  const echo = res.credential.echo
  assert.equal(echo.cmd, 'register')
  assert.equal(echo.rpId, 'secure-cloud-storage.local')
  assert.equal(echo.challenge, 'AQID')
  assert.equal(echo.salt, Buffer.alloc(32, 9).toString('base64url'))
})

test('PIN fallback round trip succeeds with the right PIN', async () => {
  const p = fakeProvider('pin')
  let asked = null
  const res = await p.authenticate(
    { challenge: randomBytes(32), credentialIds: ['Y3JlZA'], salt: randomBytes(32) },
    { requestPin: async ({ retries }) => ((asked = retries), '123456') }
  )
  assert.equal(asked, 7)
  assert.equal(res.assertion.id, 'Y3JlZA')
})

test('PIN fallback surfaces PIN_INVALID', async () => {
  const p = fakeProvider('pin')
  await assert.rejects(
    p.authenticate(
      { challenge: randomBytes(32), credentialIds: ['Y3JlZA'], salt: randomBytes(32) },
      { requestPin: async () => '000000' }
    ),
    (e) => e instanceof FidoError && e.code === 'PIN_INVALID'
  )
})

test('helper error is mapped to FidoError with code', async () => {
  await assert.rejects(fakeProvider('error').getInfo(), (e) => e.code === 'NO_DEVICE')
})

test('helper crash without result rejects with HELPER_CRASHED', async () => {
  await assert.rejects(fakeProvider('crash').getInfo(), (e) => e.code === 'HELPER_CRASHED')
})

test('missing interpreter rejects with HELPER_START_FAILED', async () => {
  const p = new FidoProvider({
    helperPath: 'x.py',
    pythonPath: '/nonexistent/python3',
    logger: quietLogger
  })
  await assert.rejects(p.getInfo(), (e) => e.code === 'HELPER_START_FAILED')
})

test('timeout and cancel', async () => {
  await assert.rejects(
    fakeProvider('hang', { timeoutMs: 300 }).getInfo(),
    (e) => e.code === 'TIMEOUT'
  )
  const p = fakeProvider('hang')
  const pending = p.getInfo()
  await assert.rejects(p.getInfo(), (e) => e.code === 'BUSY')
  setTimeout(() => p.cancel(), 100)
  await assert.rejects(pending, (e) => e.code === 'CANCELLED')
})

test('deriveExtraKeyFromFidoSecret is deterministic, 64 hex chars, and secret-dependent', () => {
  const s = Buffer.alloc(32, 1)
  const k1 = deriveExtraKeyFromFidoSecret(s)
  assert.match(k1, /^[0-9a-f]{64}$/)
  assert.equal(deriveExtraKeyFromFidoSecret(Buffer.alloc(32, 1)), k1)
  assert.notEqual(deriveExtraKeyFromFidoSecret(Buffer.alloc(32, 2)), k1)
  assert.notEqual(k1, s.toString('hex'), 'must not be the raw secret')
  assert.throws(
    () => deriveExtraKeyFromFidoSecret(Buffer.alloc(8)),
    (e) => e.code === 'BAD_SECRET'
  )
})

test('resolveHelperPath finds the helper in the dev tree', () => {
  const p = resolveHelperPath({ appPath: clientRoot })
  assert.equal(p, join(clientRoot, 'resources', 'fido', 'fido_helper.py'))
})

test(
  'real key: register then authenticate re-derives the same secret',
  { skip: !process.env.FIDO_E2E },
  async () => {
    const p = new FidoProvider({
      helperPath: resolveHelperPath({ appPath: clientRoot }),
      logger: quietLogger
    })
    const handlers = {
      onEvent: (e) => {
        const msg = {
          uv: '  等金鑰綠燈閃...',
          touch: '  >>> 現在按指紋：手指平放，同時碰到銀色金屬環',
          'uv-failed': `  指紋比對失敗，還可再試 ${e.retriesLeft} 次`,
          'lift-finger': '  請把手指完全移開',
          'uv-blocked': '  指紋已鎖定，改用 PIN（輸入正確 PIN 會解除鎖定）',
          'need-second-touch': '  需要再比對一次指紋'
        }[e.event]
        if (msg) console.log(msg)
      },
      requestPin: async () => process.env.FIDO_PIN ?? null
    }
    const info = await p.getInfo()
    assert.equal(info.hmacSecret, true)
    assert.equal(info.pinSet, true)

    const salt = randomBytes(32)
    console.log('  [綁定]')
    const reg = await p.register(
      { challenge: randomBytes(32), userId: randomBytes(16), userName: 'e2e-test', salt },
      handlers
    )
    console.log('  [復原]')
    const auth = await p.authenticate(
      { challenge: randomBytes(32), credentialIds: [reg.credential.id], salt },
      handlers
    )
    assert.equal(auth.assertion.id, reg.credential.id)
    assert.ok(auth.secret.equals(reg.secret), 'same salt must yield the same secret')
    assert.equal(
      deriveExtraKeyFromFidoSecret(auth.secret),
      deriveExtraKeyFromFidoSecret(reg.secret)
    )
    reg.secret.fill(0)
    auth.secret.fill(0)
  }
)
