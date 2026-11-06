// Run: node --test test/recovery/*.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FidoVerificationError,
  randomB64u,
  verifyFidoAssertion,
  verifyFidoRegistration
} from '../../src/FidoVerifier.js'
import { createSoftAuthenticator } from './softAuthenticator.js'

const rpId = 'secure-cloud-storage.local'
const rejects = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof FidoVerificationError && e.code === code)

async function registered(opts) {
  const key = createSoftAuthenticator({ rpId, ...opts })
  const challenge = randomB64u()
  const reg = await verifyFidoRegistration({
    credential: key.makeCredential({ challenge }),
    expectedChallenge: challenge,
    rpId
  })
  return {
    key,
    stored: { id: reg.credentialId, publicKey: reg.publicKey, counter: reg.counter },
    reg
  }
}

test('registration: valid credential yields public data only', async () => {
  const { key, reg } = await registered()
  assert.equal(reg.credentialId, key.id)
  assert.match(reg.publicKey, /^[A-Za-z0-9_-]+$/)
  assert.equal(reg.counter, 1)
  assert.equal(reg.aaguid, '00000000-0000-0000-0000-000000000000')
})

test('registration: rejects wrong challenge, origin, rpId, missing UV, missing hmac-secret', async () => {
  const key = createSoftAuthenticator({ rpId })
  const challenge = randomB64u()
  const verify = (credential) =>
    verifyFidoRegistration({ credential, expectedChallenge: challenge, rpId })
  await rejects(verify(key.makeCredential({ challenge: randomB64u() })), 'REGISTRATION_INVALID')
  await rejects(
    verify(key.makeCredential({ challenge, origin: 'https://evil.example' })),
    'REGISTRATION_INVALID'
  )
  await rejects(
    verify(key.makeCredential({ challenge, hashRpId: 'evil.example' })),
    'REGISTRATION_INVALID'
  )
  await rejects(verify(key.makeCredential({ challenge, uv: false })), 'REGISTRATION_INVALID')
  const noHmac = createSoftAuthenticator({ rpId, hmacSecret: false })
  await rejects(verify(noHmac.makeCredential({ challenge })), 'NO_HMAC_SECRET')
})

test('assertion: valid signature returns the new counter', async () => {
  const { key, stored } = await registered()
  const challenge = randomB64u()
  const res = await verifyFidoAssertion({
    assertion: key.getAssertion({ challenge }),
    expectedChallenge: challenge,
    rpId,
    credential: stored
  })
  assert.equal(res.newCounter, 2)
})

test('assertion: rejects wrong challenge, missing UV, counter replay, tampering, foreign keys', async () => {
  const { key, stored } = await registered()
  const challenge = randomB64u()
  const verify = (assertion, credential = stored) =>
    verifyFidoAssertion({ assertion, expectedChallenge: challenge, rpId, credential })

  await rejects(verify(key.getAssertion({ challenge: randomB64u() })), 'ASSERTION_INVALID')
  await rejects(verify(key.getAssertion({ challenge, uv: false })), 'ASSERTION_INVALID')
  await rejects(
    verify(key.getAssertion({ challenge, origin: 'https://evil.example' })),
    'ASSERTION_INVALID'
  )
  await rejects(
    verify(key.getAssertion({ challenge }), { ...stored, counter: 50 }),
    'COUNTER_REPLAY'
  )

  const good = key.getAssertion({ challenge })
  const sig = Buffer.from(good.signature, 'base64url')
  sig[sig.length - 1] ^= 0x01
  await rejects(verify({ ...good, signature: sig.toString('base64url') }), 'ASSERTION_INVALID')

  const other = createSoftAuthenticator({ rpId })
  await rejects(verify(other.getAssertion({ challenge })), 'WRONG_CREDENTIAL')
  // A different key that claims our credential id: signature does not match the stored public key.
  await rejects(
    verify({ ...other.getAssertion({ challenge }), id: stored.id }),
    'ASSERTION_INVALID'
  )
})
