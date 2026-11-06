// Run: node --test test/fido/*.test.mjs
// Real key for the last test: FIDO_E2E=1 node --test test/fido/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import RecoveryManager, { RecoveryFlowError } from '../../src/main/RecoveryManager.js'
import FidoProvider, {
  FidoError,
  deriveExtraKeyFromFidoSecret,
  resolveHelperPath
} from '../../src/main/FidoProvider.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', '..')
const serverRoot = join(clientRoot, '..', 'secure-cloud-storage-server')
const b64u = (buf) => Buffer.from(buf).toString('base64url')

// Stand-in for encryptDataShareKey / recoverDataShareKey: 10 shares that only open with the same key.
const fakeEncryptShares = async (extraKey, dataStr) =>
  Array.from({ length: 10 }, (_, i) => Buffer.from(JSON.stringify({ i, extraKey, dataStr })))
const fakeOpenShares = (extraKey, shares) => {
  const first = JSON.parse(shares[0].toString())
  if (first.extraKey !== extraKey) throw new Error('wrong extra key')
  return JSON.parse(first.dataStr)
}

const SECRET_KEYS = { walletKey: '0xwallet', preKeys: { pk: 'p', sk: 's' } }

function fakeProvider() {
  const deviceKey = randomBytes(32)
  const calls = []
  const secretFor = (salt) => createHmac('sha256', deviceKey).update(salt).digest()
  return {
    calls,
    secrets: [],
    secretCopies: [],
    async register(params, handlers) {
      calls.push(['register', params])
      handlers?.onEvent?.({ event: 'touch' })
      const secret = secretFor(params.salt)
      this.secrets.push(secret)
      this.secretCopies.push(Buffer.from(secret))
      return {
        credential: { id: 'Y3JlZA', clientDataJSON: 'e30', attestationObject: 'AA' },
        secret
      }
    },
    async authenticate(params) {
      calls.push(['authenticate', params])
      const secret = secretFor(params.salt)
      this.secrets.push(secret)
      return { assertion: { id: 'Y3JlZA', signature: 'c2ln' }, secret }
    },
    cancel() {
      calls.push(['cancel'])
    }
  }
}

test('bind: decodes server params, wipes the secret, sends only credential and shares', async () => {
  const fido = fakeProvider()
  const sent = []
  const salt = randomBytes(32)
  const emit = async (event, payload) => {
    sent.push([event, payload])
    if (event === 'fido-bind-begin') {
      return {
        rpId: 'secure-cloud-storage.local',
        challenge: b64u(Buffer.from('chal')),
        userId: b64u(Buffer.from('user-1')),
        userName: 'Alice',
        salt: b64u(salt)
      }
    }
    return { method: { id: 'm1', type: 'fido', label: 'Key', sharesStored: 3 } }
  }
  const rm = new RecoveryManager({
    emit,
    fido,
    getSecretKeys: () => SECRET_KEYS,
    encryptShares: fakeEncryptShares,
    restoreFromShares: async () => {}
  })
  const events = []
  const method = await rm.bindSecurityKey(
    { label: 'Key' },
    { onEvent: (e) => events.push(e.event) }
  )

  assert.equal(method.id, 'm1')
  assert.deepEqual(events, ['touch'])
  const [, params] = fido.calls[0]
  assert.equal(params.rpId, 'secure-cloud-storage.local')
  assert.equal(params.challenge.toString(), 'chal')
  assert.equal(params.userId.toString(), 'user-1')
  assert.ok(params.salt.equals(salt))
  assert.ok(fido.secrets[0].equals(Buffer.alloc(32)), 'device secret zeroed after use')

  const [finishEvent, payload] = sent[1]
  assert.equal(finishEvent, 'fido-bind-finish')
  assert.deepEqual(Object.keys(payload).sort(), ['credential', 'label', 'shares'])
  assert.equal(payload.shares.length, 10)
  const opened = JSON.parse(Buffer.from(payload.shares[0], 'base64').toString())
  assert.deepEqual(JSON.parse(opened.dataStr), SECRET_KEYS)
  const wire = JSON.stringify(sent)
  const secret = fido.secretCopies[0]
  for (const encoding of ['hex', 'base64', 'base64url']) {
    assert.equal(
      wire.includes(secret.toString(encoding)),
      false,
      `device secret (${encoding}) never sent`
    )
  }
})

test('bind and recover: errors from the server, the key and bad responses surface with codes', async () => {
  const fido = fakeProvider()
  const rm = (emit, extra = {}) =>
    new RecoveryManager({
      emit,
      fido,
      getSecretKeys: () => SECRET_KEYS,
      encryptShares: fakeEncryptShares,
      restoreFromShares: async () => {},
      ...extra
    })

  await assert.rejects(
    rm(async () => {
      throw new Error('Not logged in.')
    }).bindSecurityKey(),
    /Not logged in/
  )
  await assert.rejects(
    rm(async () => ({
      rpId: 'evil host/../',
      challenge: 'AA',
      userId: 'AA',
      salt: 'AA'
    })).bindSecurityKey(),
    (e) => e instanceof RecoveryFlowError && e.code === 'BAD_SERVER_RESPONSE'
  )

  const failingKey = {
    ...fakeProvider(),
    register: async () => {
      throw new FidoError('UV_FAILED', 'Too many failed fingerprint attempts')
    }
  }
  const noFinish = []
  await assert.rejects(
    new RecoveryManager({
      emit: async (event) => {
        noFinish.push(event)
        return { rpId: 'secure-cloud-storage.local', challenge: 'AA', userId: 'AA', salt: 'AA' }
      },
      fido: failingKey,
      getSecretKeys: () => SECRET_KEYS,
      encryptShares: fakeEncryptShares,
      restoreFromShares: async () => {}
    }).bindSecurityKey(),
    (e) => e instanceof FidoError && e.code === 'UV_FAILED'
  )
  assert.deepEqual(noFinish, ['fido-bind-begin'], 'nothing is sent when the key fails')

  const oneShare = async (event) =>
    event === 'fido-recover-begin'
      ? {
          rpId: 'secure-cloud-storage.local',
          challenge: 'AA',
          credentialIds: ['Y3JlZA'],
          salt: b64u(randomBytes(32))
        }
      : { shares: ['c2hhcmU='] }
  let restored = false
  await assert.rejects(
    rm(oneShare, {
      restoreFromShares: async () => {
        restored = true
      }
    }).recoverWithSecurityKey({ methodId: randomUUID() }),
    (e) => e.code === 'NOT_ENOUGH_SHARES'
  )
  assert.equal(restored, false)

  const threeShares = async (event) =>
    event === 'fido-recover-begin'
      ? {
          rpId: 'secure-cloud-storage.local',
          challenge: 'AA',
          credentialIds: ['Y3JlZA'],
          salt: b64u(randomBytes(32))
        }
      : { shares: ['c2hhcmUx', 'c2hhcmUy', 'c2hhcmUz'] }
  await assert.rejects(
    rm(threeShares, {
      restoreFromShares: async () => {
        throw new Error('Unexpected error.')
      }
    }).recoverWithSecurityKey({ methodId: randomUUID() }),
    (e) => e instanceof RecoveryFlowError && e.code === 'RESTORE_FAILED'
  )

  // Keys restored but the server refused the login: keep the code and the server's reason.
  await assert.rejects(
    rm(threeShares, {
      restoreFromShares: async () => {
        throw Object.assign(new Error('Already logged in from another client.'), {
          code: 'LOGIN_FAILED'
        })
      }
    }).recoverWithSecurityKey({ methodId: randomUUID() }),
    (e) =>
      e instanceof RecoveryFlowError &&
      e.code === 'LOGIN_FAILED' &&
      /Already logged in/.test(e.message)
  )
})

/**
 * Client RecoveryManager against the real server RecoveryService (in-memory stores).
 * With FIDO_E2E=1 the physical key is used instead of the software authenticator.
 */
test('client and server together: bind, email OTP, recover restores the same keys', async () => {
  const { createRecoveryService, RecoveryError } = await import(
    join(serverRoot, 'src', 'RecoveryService.js')
  )
  const { memoryMethodStore, memoryShareStore } = await import(
    join(serverRoot, 'test', 'recovery', 'memoryStores.js')
  )
  const { createSoftAuthenticator } = await import(
    join(serverRoot, 'test', 'recovery', 'softAuthenticator.js')
  )
  const config = {
    rpId: 'secure-cloud-storage.local',
    rpName: 'Secure Cloud Storage',
    challengeTimeoutSec: 120,
    recoverWindowMin: 10,
    maxMethodsPerUser: 5,
    maxRecoverAttempts: 5
  }
  const methodStore = memoryMethodStore()
  const shareStore = memoryShareStore()
  const { handlers } = createRecoveryService({
    methodStore,
    shareStore,
    config,
    isLoggedIn: (s) => Boolean(s.authed)
  })

  // One server-side socket per client connection, like socket.io.
  const connect = (serverSocket) => async (event, payload) => {
    try {
      return await handlers[event](serverSocket, payload)
    } catch (e) {
      throw e instanceof RecoveryError ? new Error(e.message) : e
    }
  }

  let fido
  if (process.env.FIDO_E2E) {
    fido = new FidoProvider({ helperPath: resolveHelperPath({ appPath: clientRoot }) })
  } else {
    const soft = createSoftAuthenticator({ rpId: config.rpId })
    const deviceKey = randomBytes(32)
    const secretFor = (salt) => createHmac('sha256', deviceKey).update(salt).digest()
    fido = {
      register: async ({ challenge, salt }) => ({
        credential: soft.makeCredential({ challenge: b64u(challenge) }),
        secret: secretFor(salt)
      }),
      authenticate: async ({ challenge, credentialIds, salt }) => {
        assert.deepEqual(credentialIds, [soft.id])
        return {
          assertion: soft.getAssertion({ challenge: b64u(challenge) }),
          secret: secretFor(salt)
        }
      }
    }
  }
  const handlersForUser = {
    onEvent: (e) => {
      if (e.event === 'touch') console.log('  >>> 現在按指紋：手指平放，同時碰到銀色金屬環')
      if (e.event === 'uv-failed') console.log(`  指紋比對失敗，還可再試 ${e.retriesLeft} 次`)
    },
    requestPin: async () => process.env.FIDO_PIN ?? null
  }

  const userId = randomUUID()
  let bindExtraKey
  const loggedIn = new RecoveryManager({
    emit: connect({ userId, name: 'Alice', authed: true }),
    fido,
    getSecretKeys: () => SECRET_KEYS,
    encryptShares: async (extraKey, data) => {
      bindExtraKey = extraKey
      return fakeEncryptShares(extraKey, data)
    },
    restoreFromShares: async () => assert.fail('not used while binding')
  })
  if (process.env.FIDO_E2E) console.log('  [綁定]')
  const method = await loggedIn.bindSecurityKey({ label: 'Test key' }, handlersForUser)
  assert.equal(method.sharesStored, 3)
  assert.deepEqual(
    (await loggedIn.listMethods()).map((m) => m.id),
    [method.id]
  )

  // New connection, not logged in; the email OTP step has passed (Authentication.js sets this).
  let restoredKeys
  const recovering = new RecoveryManager({
    emit: connect({ userId, recoverVerified: { userId, at: Date.now(), failures: 0 } }),
    fido,
    getSecretKeys: () => assert.fail('not used while recovering'),
    encryptShares: async () => assert.fail('not used while recovering'),
    restoreFromShares: async (extraKey, shares) => {
      assert.equal(extraKey, bindExtraKey, 'recovery re-derives the binding extra key')
      assert.equal(shares.length, 3)
      restoredKeys = fakeOpenShares(extraKey, shares)
    }
  })
  if (process.env.FIDO_E2E) console.log('  [復原]')
  await recovering.recoverWithSecurityKey({ methodId: method.id }, handlersForUser)
  assert.deepEqual(restoredKeys, SECRET_KEYS)
  assert.match(deriveExtraKeyFromFidoSecret(Buffer.alloc(32, 1)), /^[0-9a-f]{64}$/)
})
