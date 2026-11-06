// Run: node --test test/recovery/*.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  RecoveryError,
  RecoveryErrorMsg,
  createRecoveryService
} from '../../src/RecoveryService.js'
import { createSoftAuthenticator } from './softAuthenticator.js'
import { memoryMethodStore, memoryShareStore } from './memoryStores.js'

const config = {
  rpId: 'secure-cloud-storage.local',
  rpName: 'Secure Cloud Storage',
  challengeTimeoutSec: 120,
  recoverWindowMin: 10,
  maxMethodsPerUser: 2,
  maxRecoverAttempts: 3
}
const FIDO_SHARES = ['ZmlkbzE=', 'ZmlkbzI=', 'ZmlkbzM=', 'ZmlkbzQ=']
const PASSWORD_SHARES = ['cHcx', 'cHcy', 'cHcz']

function setup({ shareDown = [] } = {}) {
  let clock = 1_000_000
  const methodStore = memoryMethodStore()
  const shareStore = memoryShareStore({ down: shareDown })
  const service = createRecoveryService({
    methodStore,
    shareStore,
    config,
    isLoggedIn: (socket) => Boolean(socket.authed),
    now: () => clock
  })
  const h = service.handlers
  const call = (event, socket, request) => h[event](socket, request)
  return {
    service,
    methodStore,
    shareStore,
    call,
    advance: (ms) => (clock += ms),
    now: () => clock
  }
}

const rejectsWith = (promise, msg) =>
  assert.rejects(promise, (e) => e instanceof RecoveryError && e.message === msg)

async function bindKey(ctx, socket, key, label = 'YubiKey Bio') {
  const begin = await ctx.call('fido-bind-begin', socket, { label })
  const finish = await ctx.call('fido-bind-finish', socket, {
    credential: key.makeCredential({ challenge: begin.challenge }),
    shares: FIDO_SHARES
  })
  return { begin, method: finish.method }
}

const loggedIn = (userId = randomUUID()) => ({ userId, name: 'Alice', authed: true })
const otpPassed = (ctx, userId) => ({
  userId,
  recoverVerified: { userId, at: ctx.now(), failures: 0 }
})

test('binding stores shares under a new method and lists it', async () => {
  const ctx = setup()
  const socket = loggedIn()
  await ctx.shareStore.storeUserShares(socket.userId, PASSWORD_SHARES)
  const key = createSoftAuthenticator({ rpId: config.rpId })

  const { begin, method } = await bindKey(ctx, socket, key)
  assert.equal(begin.rpId, config.rpId)
  assert.equal(Buffer.from(begin.challenge, 'base64url').length, 32)
  assert.equal(Buffer.from(begin.salt, 'base64url').length, 32)
  assert.equal(method.label, 'YubiKey Bio')
  assert.equal(method.sharesStored, 3)

  const row = ctx.methodStore.rows.get(method.id)
  assert.equal(row.credentialId, key.id)
  assert.equal(row.salt, begin.salt)
  assert.deepEqual(
    await ctx.shareStore.retrieveUserShares(socket.userId, method.id),
    FIDO_SHARES.slice(0, 3)
  )
  assert.deepEqual(
    await ctx.shareStore.retrieveUserShares(socket.userId),
    PASSWORD_SHARES,
    'password shares untouched'
  )

  const { methods } = await ctx.call('recovery-methods', socket)
  assert.deepEqual(
    methods.map((m) => [m.id, m.type, m.sharesAvailable]),
    [
      ['password', 'password', true],
      [method.id, 'fido', true]
    ]
  )
})

test('binding requires login, a fresh single-use challenge, and a valid key', async () => {
  const ctx = setup()
  const key = createSoftAuthenticator({ rpId: config.rpId })
  await rejectsWith(ctx.call('fido-bind-begin', { userId: 'x' }, {}), RecoveryErrorMsg.notLoggedIn)

  const socket = loggedIn()
  const finish = (credential) =>
    ctx.call('fido-bind-finish', socket, { credential, shares: FIDO_SHARES })
  await rejectsWith(finish(key.makeCredential({ challenge: 'AAAA' })), RecoveryErrorMsg.noBegin)

  let begin = await ctx.call('fido-bind-begin', socket, {})
  await rejectsWith(
    finish(key.makeCredential({ challenge: 'wrong' })),
    RecoveryErrorMsg.keyRejected
  )
  await rejectsWith(
    finish(key.makeCredential({ challenge: begin.challenge })),
    RecoveryErrorMsg.noBegin,
    'single use'
  )

  begin = await ctx.call('fido-bind-begin', socket, {})
  ctx.advance(121_000)
  await rejectsWith(
    finish(key.makeCredential({ challenge: begin.challenge })),
    RecoveryErrorMsg.challengeExpired
  )

  begin = await ctx.call('fido-bind-begin', socket, {})
  const noHmac = createSoftAuthenticator({ rpId: config.rpId, hmacSecret: false })
  await rejectsWith(
    finish(noHmac.makeCredential({ challenge: begin.challenge })),
    RecoveryErrorMsg.keyNoHmacSecret
  )

  begin = await ctx.call('fido-bind-begin', socket, {})
  const other = loggedIn()
  other.fidoBind = socket.fidoBind // state of another user must not be usable
  await rejectsWith(
    ctx.call('fido-bind-finish', other, {
      credential: key.makeCredential({ challenge: begin.challenge }),
      shares: FIDO_SHARES
    }),
    RecoveryErrorMsg.noBegin
  )

  await rejectsWith(
    ctx.call('fido-bind-begin', socket, { label: 'x'.repeat(65) }),
    RecoveryErrorMsg.invalidArgument
  )
  assert.equal(ctx.methodStore.rows.size, 0)
  assert.equal(
    ctx.shareStore.dbs.every((db) => db.size === 0),
    true,
    'nothing stored after failures'
  )
})

test('binding is limited per user and rolls back when too few shares are stored', async () => {
  const ctx = setup()
  const socket = loggedIn()
  await bindKey(ctx, socket, createSoftAuthenticator({ rpId: config.rpId }))
  await bindKey(ctx, socket, createSoftAuthenticator({ rpId: config.rpId }))
  await rejectsWith(ctx.call('fido-bind-begin', socket, {}), RecoveryErrorMsg.tooManyKeys)

  const degraded = setup({ shareDown: [0, 1] })
  const s2 = loggedIn()
  await rejectsWith(
    bindKey(degraded, s2, createSoftAuthenticator({ rpId: config.rpId })),
    RecoveryErrorMsg.sharesNotStored
  )
  assert.equal(degraded.methodStore.rows.size, 0)
  assert.equal(degraded.shareStore.dbs[2].size, 0, 'partial shares removed')
})

test('recovery after OTP releases only that method’s shares and is single use', async () => {
  const ctx = setup()
  const owner = loggedIn()
  await ctx.shareStore.storeUserShares(owner.userId, PASSWORD_SHARES)
  const key = createSoftAuthenticator({ rpId: config.rpId })
  const { begin: bindBegin, method } = await bindKey(ctx, owner, key)

  const socket = otpPassed(ctx, owner.userId)
  const begin = await ctx.call('fido-recover-begin', socket, { methodId: method.id })
  assert.deepEqual(begin.credentialIds, [key.id])
  assert.equal(
    begin.salt,
    bindBegin.salt,
    'same salt as binding so the key re-derives the same secret'
  )

  const assertion = key.getAssertion({ challenge: begin.challenge })
  const { shares } = await ctx.call('fido-recover-finish', socket, { assertion })
  assert.deepEqual(shares, FIDO_SHARES.slice(0, 3))
  assert.equal(ctx.methodStore.rows.get(method.id).signCount, key.counter)
  assert.ok(ctx.methodStore.rows.get(method.id).lastUsedAt)

  // The OTP grant and the challenge are both consumed.
  await rejectsWith(
    ctx.call('fido-recover-finish', socket, { assertion }),
    RecoveryErrorMsg.noEmailAuth
  )
  await rejectsWith(
    ctx.call('fido-recover-begin', socket, { methodId: method.id }),
    RecoveryErrorMsg.noEmailAuth
  )

  // A fresh OTP grant does not revive the old assertion: new challenge, and the counter has moved on.
  const again = otpPassed(ctx, owner.userId)
  await rejectsWith(ctx.call('fido-recover-finish', again, { assertion }), RecoveryErrorMsg.noBegin)
  await ctx.call('fido-recover-begin', again, { methodId: method.id })
  await rejectsWith(
    ctx.call('fido-recover-finish', again, { assertion }),
    RecoveryErrorMsg.keyRejected
  )
})

test('recovery is bound to the OTP user, expires, and locks after repeated failures', async () => {
  const ctx = setup()
  const alice = loggedIn()
  const bob = loggedIn()
  const aliceKey = createSoftAuthenticator({ rpId: config.rpId })
  const { method: aliceMethod } = await bindKey(ctx, alice, aliceKey)
  const { method: bobMethod } = await bindKey(
    ctx,
    bob,
    createSoftAuthenticator({ rpId: config.rpId })
  )

  await rejectsWith(
    ctx.call('fido-recover-begin', { userId: alice.userId }, { methodId: aliceMethod.id }),
    RecoveryErrorMsg.noEmailAuth
  )

  // OTP passed for Alice; switching socket.userId must not unlock Bob's method.
  const socket = otpPassed(ctx, alice.userId)
  socket.userId = bob.userId
  await rejectsWith(
    ctx.call('fido-recover-begin', socket, { methodId: bobMethod.id }),
    RecoveryErrorMsg.methodNotFound
  )
  await ctx.call('fido-recover-begin', socket, { methodId: aliceMethod.id })

  // Expired OTP window.
  const late = otpPassed(ctx, alice.userId)
  ctx.advance(10 * 60 * 1000 + 1)
  await rejectsWith(
    ctx.call('fido-recover-begin', late, { methodId: aliceMethod.id }),
    RecoveryErrorMsg.emailAuthExpired
  )

  // Wrong key three times ends the OTP grant.
  const attacker = otpPassed(ctx, alice.userId)
  const wrongKey = createSoftAuthenticator({ rpId: config.rpId })
  for (let i = 0; i < config.maxRecoverAttempts; i++) {
    const begin = await ctx.call('fido-recover-begin', attacker, { methodId: aliceMethod.id })
    const forged = { ...wrongKey.getAssertion({ challenge: begin.challenge }), id: aliceKey.id }
    await rejectsWith(
      ctx.call('fido-recover-finish', attacker, { assertion: forged }),
      RecoveryErrorMsg.keyRejected
    )
  }
  await rejectsWith(
    ctx.call('fido-recover-begin', attacker, { methodId: aliceMethod.id }),
    RecoveryErrorMsg.noEmailAuth
  )

  // Challenge timeout.
  const slow = otpPassed(ctx, alice.userId)
  const begin = await ctx.call('fido-recover-begin', slow, { methodId: aliceMethod.id })
  ctx.advance(121_000)
  await rejectsWith(
    ctx.call('fido-recover-finish', slow, {
      assertion: aliceKey.getAssertion({ challenge: begin.challenge })
    }),
    RecoveryErrorMsg.challengeExpired
  )
})

test('deleting a method removes its shares only, and only for its owner', async () => {
  const ctx = setup()
  const socket = loggedIn()
  await ctx.shareStore.storeUserShares(socket.userId, PASSWORD_SHARES)
  const { method } = await bindKey(ctx, socket, createSoftAuthenticator({ rpId: config.rpId }))

  await rejectsWith(
    ctx.call('recovery-method-delete', loggedIn(), { methodId: method.id }),
    RecoveryErrorMsg.methodNotFound
  )
  await ctx.call('recovery-method-delete', socket, { methodId: method.id })
  assert.equal(ctx.methodStore.rows.size, 0)
  assert.deepEqual(await ctx.shareStore.retrieveUserShares(socket.userId, method.id), [])
  assert.deepEqual(await ctx.shareStore.retrieveUserShares(socket.userId), PASSWORD_SHARES)
  await rejectsWith(
    ctx.call('recovery-method-delete', socket, { methodId: method.id }),
    RecoveryErrorMsg.methodNotFound
  )
})
