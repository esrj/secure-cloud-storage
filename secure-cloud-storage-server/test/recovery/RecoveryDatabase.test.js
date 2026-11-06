// PostgreSQL-backed tests. They create and drop their own databases (scs_rt_*),
// so point SCS_TEST_PG at a server where that is acceptable:
//   SCS_TEST_PG=postgres://postgres@localhost:55432/postgres node --test test/recovery/*.test.js
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  PASSWORD_METHOD_ID,
  RECOVERY_METHOD_TABLE_SQL,
  SECRET_SHARE_SQLS
} from '../../src/RecoverySchema.js'
import { createRecoveryMethodStore } from '../../src/RecoveryMethodStore.js'
import { createSecretShareStore } from '../../src/SecretShareStore.js'
import { createRecoveryService } from '../../src/RecoveryService.js'
import { createSoftAuthenticator } from './softAuthenticator.js'

const baseUrl = process.env.SCS_TEST_PG
const skip = !baseUrl && 'set SCS_TEST_PG to run database tests'
const suffix = randomBytes(4).toString('hex')
const names = ['main', 'share1', 'share2', 'share3'].map((n) => `scs_rt_${n}_${suffix}`)
const urlFor = (db) => {
  const u = new URL(baseUrl)
  u.pathname = `/${db}`
  return u.toString()
}
const quietLogger = { error() {} }

let admin
let mainPool
let sharePools = []

before(async () => {
  if (skip) return
  admin = new pg.Client({ connectionString: baseUrl })
  await admin.connect()
  for (const db of names) await admin.query(`CREATE DATABASE ${db}`)
  mainPool = new pg.Pool({ connectionString: urlFor(names[0]) })
  sharePools = names.slice(1).map((db) => new pg.Pool({ connectionString: urlFor(db) }))
  await mainPool.query(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)`)
  for (let i = 0; i < 2; i++) await mainPool.query(RECOVERY_METHOD_TABLE_SQL) // idempotent
})

after(async () => {
  if (skip) return
  await Promise.all([mainPool, ...sharePools].map((p) => p.end()))
  for (const db of names) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
  await admin.end()
})

async function primaryKeyColumns(pool) {
  const r = await pool.query(`
    SELECT a.attname FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = 'secret_share'::regclass AND c.contype = 'p'
     ORDER BY k.ord`)
  return r.rows.map((row) => row.attname)
}

test(
  'legacy secret_share (userid primary key) is upgraded in place, idempotently',
  { skip },
  async () => {
    const pool = sharePools[0]
    await pool.query(`CREATE TABLE secret_share (
      userid TEXT NOT NULL PRIMARY KEY, share TEXT NOT NULL, retrievable BOOLEAN NOT NULL)`)
    await pool.query(`INSERT INTO secret_share VALUES ('legacy-user', 'bGVnYWN5', TRUE)`)

    for (let i = 0; i < 3; i++) for (const sql of SECRET_SHARE_SQLS) await pool.query(sql)

    assert.deepEqual(await primaryKeyColumns(pool), ['userid', 'method_id'])
    const rows = (await pool.query(`SELECT userid, method_id, share FROM secret_share`)).rows
    assert.deepEqual(rows, [
      { userid: 'legacy-user', method_id: PASSWORD_METHOD_ID, share: 'bGVnYWN5' }
    ])

    // The old password flow keeps working on the upgraded table.
    const store = createSecretShareStore([pool], quietLogger)
    assert.deepEqual(await store.retrieveUserShares('legacy-user'), ['bGVnYWN5'])
  }
)

test('fresh share databases get the new layout, idempotently', { skip }, async () => {
  for (const pool of sharePools.slice(1)) {
    for (let i = 0; i < 2; i++) for (const sql of SECRET_SHARE_SQLS) await pool.query(sql)
    assert.deepEqual(await primaryKeyColumns(pool), ['userid', 'method_id'])
  }
})

test(
  'share store keeps methods apart and tolerates a database that is down',
  { skip },
  async () => {
    const store = createSecretShareStore(sharePools, quietLogger)
    const userId = randomUUID()
    const fidoId = randomUUID()
    assert.equal(await store.storeUserShares(userId, ['cHcx', 'cHcy', 'cHcz', 'cHc0']), 3)
    assert.equal(await store.storeUserShares(userId, ['ZjE=', 'ZjI=', 'ZjM='], fidoId), 3)
    assert.equal(
      await store.storeUserShares(userId, ['cHdB', 'cHdC', 'cHdD']),
      3,
      'password re-share overwrites'
    )

    assert.deepEqual(await store.retrieveUserShares(userId), ['cHdB', 'cHdC', 'cHdD'])
    assert.deepEqual(await store.retrieveUserShares(userId, fidoId), ['ZjE=', 'ZjI=', 'ZjM='])
    assert.deepEqual(
      [...(await store.listUserShareMethodIds(userId))].sort(),
      [fidoId, PASSWORD_METHOD_ID].sort()
    )

    await store.deleteUserShares(userId, fidoId)
    assert.deepEqual(await store.retrieveUserShares(userId, fidoId), [])
    assert.equal((await store.retrieveUserShares(userId)).length, 3)
    await store.deleteUserShares(userId)
    assert.deepEqual(await store.listUserShareMethodIds(userId), new Set())

    // First database unreachable: shares move on to the next databases.
    const downPool = new pg.Pool({ connectionString: urlFor(`scs_rt_missing_${suffix}`) })
    const degraded = createSecretShareStore([downPool, ...sharePools.slice(1)], quietLogger)
    assert.equal(await degraded.storeUserShares(userId, ['YTE=', 'YTI=', 'YTM=']), 2)
    assert.deepEqual(await degraded.retrieveUserShares(userId), ['YTE=', 'YTI='])
    await downPool.end()
  }
)

test(
  'full bind, recover and delete flow on real tables; user deletion cascades',
  { skip },
  async () => {
    const config = {
      rpId: 'secure-cloud-storage.local',
      rpName: 'Secure Cloud Storage',
      challengeTimeoutSec: 120,
      recoverWindowMin: 10,
      maxMethodsPerUser: 5,
      maxRecoverAttempts: 5
    }
    const methodStore = createRecoveryMethodStore(mainPool)
    const shareStore = createSecretShareStore(sharePools, quietLogger)
    const { handlers, listMethods } = createRecoveryService({
      methodStore,
      shareStore,
      config,
      isLoggedIn: (s) => Boolean(s.authed)
    })
    const userId = randomUUID()
    await mainPool.query(`INSERT INTO users (id) VALUES ($1)`, [userId])
    const key = createSoftAuthenticator({ rpId: config.rpId })
    const shares = ['c2hhcmUx', 'c2hhcmUy', 'c2hhcmUz', 'c2hhcmU0']

    const session = { userId, name: 'Alice', authed: true }
    const bindBegin = await handlers['fido-bind-begin'](session, { label: 'YubiKey Bio' })
    const { method } = await handlers['fido-bind-finish'](session, {
      credential: key.makeCredential({ challenge: bindBegin.challenge }),
      shares
    })
    const stored = await methodStore.getById(method.id)
    assert.equal(stored.credentialId, key.id)
    assert.equal(stored.signCount, 1)
    assert.equal(stored.salt, bindBegin.salt)

    const recovering = { userId, recoverVerified: { userId, at: Date.now(), failures: 0 } }
    const begin = await handlers['fido-recover-begin'](recovering, { methodId: method.id })
    const res = await handlers['fido-recover-finish'](recovering, {
      assertion: key.getAssertion({ challenge: begin.challenge })
    })
    assert.deepEqual(res.shares, shares.slice(0, 3))
    const used = await methodStore.getById(method.id)
    assert.equal(used.signCount, 2)
    assert.ok(used.lastUsedAt instanceof Date)

    // recordUse never moves the counter backwards.
    await methodStore.recordUse(method.id, 1)
    assert.equal((await methodStore.getById(method.id)).signCount, 2)

    assert.deepEqual(
      (await listMethods(userId)).map((m) => m.type),
      ['fido']
    )
    await handlers['recovery-method-delete'](session, { methodId: method.id })
    assert.deepEqual(await listMethods(userId), [])

    // Deleting the user removes their methods through the foreign key.
    const second = createSoftAuthenticator({ rpId: config.rpId })
    const b2 = await handlers['fido-bind-begin'](session, {})
    await handlers['fido-bind-finish'](session, {
      credential: second.makeCredential({ challenge: b2.challenge }),
      shares
    })
    await mainPool.query(`DELETE FROM users WHERE id = $1`, [userId])
    assert.deepEqual(await methodStore.listByUser(userId), [])
  }
)
