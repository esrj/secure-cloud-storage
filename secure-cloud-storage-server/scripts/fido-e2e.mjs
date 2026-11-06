#!/usr/bin/env node
/**
 * Real-key end-to-end check for fingerprint recovery (stage 2).
 *
 * Runs the server's bind and recover flows (RecoveryService + FidoVerifier) against the
 * client's FidoProvider and fido_helper.py with the physical security key. Databases are
 * replaced by in-memory stores, so nothing is written anywhere.
 *
 *   cd secure-cloud-storage-server && node scripts/fido-e2e.mjs
 *
 * Touch the key twice. The PIN is asked (hidden) only if the fingerprint gets locked.
 */
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.removeAllListeners('warning') // hide experimental / module-type warnings from dependencies

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', '..', 'secure-cloud-storage-client')
const {
  default: FidoProvider,
  deriveExtraKeyFromFidoSecret,
  resolveHelperPath
} = await import(join(clientRoot, 'src', 'main', 'FidoProvider.js'))
const { createRecoveryService } = await import('../src/RecoveryService.js')
const { memoryMethodStore, memoryShareStore } = await import('../test/recovery/memoryStores.js')

const config = {
  rpId: 'secure-cloud-storage.local',
  rpName: 'Secure Cloud Storage',
  challengeTimeoutSec: 120,
  recoverWindowMin: 10,
  maxMethodsPerUser: 5,
  maxRecoverAttempts: 5
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let input = ''
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode?.(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(input || null)
          return
        }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1)
        else input += c
      }
    }
    stdin.on('data', onData)
  })
}

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
  requestPin: ({ retries }) => promptHidden(`  >>> 請輸入 FIDO2 PIN（剩餘 ${retries} 次）：`)
}

const ok = (msg) => console.log(`  [OK]   ${msg}`)
const fail = (msg) => {
  console.log(`  [FAIL] ${msg}`)
  process.exit(1)
}
const unwrap = async (promise) => {
  try {
    return await promise
  } catch (e) {
    fail(`${e.code ?? e.name}: ${e.message}`)
  }
}

const provider = new FidoProvider({
  helperPath: resolveHelperPath({ appPath: clientRoot }),
  rpId: config.rpId
})
const methodStore = memoryMethodStore()
const shareStore = memoryShareStore()
const service = createRecoveryService({
  methodStore,
  shareStore,
  config,
  isLoggedIn: (s) => s.authed
})
const h = service.handlers
const userId = 'e2e-user'
const shares = Array.from({ length: 10 }, () => randomBytes(64).toString('base64'))

console.log('[0] 金鑰狀態')
const info = await unwrap(provider.getInfo())
console.log(
  `  ${info.product}，hmac-secret=${info.hmacSecret}，指紋=${info.fingerprintEnrolled}，PIN 剩餘 ${info.pinRetries} 次`
)

console.log('\n[1] 綁定：Server 發 challenge 與 salt，金鑰建立憑證並導出秘密值')
const session = { userId, name: 'E2E', authed: true }
const bindBegin = await unwrap(h['fido-bind-begin'](session, { label: 'e2e' }))
const reg = await unwrap(
  provider.register(
    {
      challenge: Buffer.from(bindBegin.challenge, 'base64url'),
      userId: Buffer.from(bindBegin.userId, 'base64url'),
      userName: bindBegin.userName,
      salt: Buffer.from(bindBegin.salt, 'base64url')
    },
    handlers
  )
)
const extraKey1 = deriveExtraKeyFromFidoSecret(reg.secret)
const { method } = await unwrap(
  h['fido-bind-finish'](session, { credential: reg.credential, shares })
)
ok(`Server 驗證註冊成功，方法 ${method.id.slice(0, 8)}...，存了 ${method.sharesStored} 份碎片`)
const row = methodStore.rows.get(method.id)
const countAtBind = row.signCount
console.log(`  aaguid=${row.aaguid}  sign_count=${countAtBind}`)
if (JSON.stringify(row).includes(reg.secret.toString('base64url')))
  fail('秘密值出現在 Server 資料裡')
ok('Server 端資料不含秘密值')

console.log('\n[2] 復原：OTP 已通過，Server 發新 challenge，金鑰按指紋重新導出秘密值')
const recovering = { userId, recoverVerified: { userId, at: Date.now(), failures: 0 } }
const recBegin = await unwrap(h['fido-recover-begin'](recovering, { methodId: method.id }))
const auth = await unwrap(
  provider.authenticate(
    {
      challenge: Buffer.from(recBegin.challenge, 'base64url'),
      credentialIds: recBegin.credentialIds,
      salt: Buffer.from(recBegin.salt, 'base64url')
    },
    handlers
  )
)
const extraKey2 = deriveExtraKeyFromFidoSecret(auth.secret)
const res = await unwrap(h['fido-recover-finish'](recovering, { assertion: auth.assertion }))
ok(
  `Server 驗證簽章與 UV 旗標成功，sign_count ${countAtBind} → ${methodStore.rows.get(method.id).signCount}`
)
if (JSON.stringify(res.shares) !== JSON.stringify(shares.slice(0, 3))) fail('取回的碎片不一致')
ok('取回的碎片與綁定時相同')
if (!auth.secret.equals(reg.secret) || extraKey1 !== extraKey2) fail('兩次導出的秘密值不同')
ok('兩次導出的 extraKey 相同，可以解開碎片')

console.log('\n[3] 重放：同一份斷言再送一次')
const replay = await h['fido-recover-finish'](recovering, { assertion: auth.assertion }).catch(
  (e) => e
)
if (!(replay instanceof Error)) fail('重放竟然成功')
ok(`直接重送被拒絕，因為這次 OTP 授權已用掉：${replay.message}`)
// Even with a fresh OTP grant and a new challenge, the old assertion must fail.
recovering.recoverVerified = { userId, at: Date.now(), failures: 0 }
await unwrap(h['fido-recover-begin'](recovering, { methodId: method.id }))
const replay2 = await h['fido-recover-finish'](recovering, { assertion: auth.assertion }).catch(
  (e) => e
)
if (!(replay2 instanceof Error)) fail('重新收信後重放竟然成功')
ok(`重新收信、拿新 challenge 後重送舊斷言，仍被拒絕：${replay2.message}（${replay2.detail?.code}）`)

reg.secret.fill(0)
auth.secret.fill(0)
console.log('\n階段 2 端到端驗證通過：真金鑰的資料可以通過 Server 驗證。')
process.exit(0)
