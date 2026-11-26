// Run: node --test test/crypto/*.test.js
// The encoded user id that goes into watermarks: decodable with the server key only, with a
// prefix that is the same for every download of one user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  IV_BYTES,
  TAG_BYTES,
  VERSION_PREFIX,
  decodeWithKey,
  encodeWithKey,
  looksFull,
  matchesPrefixWithKey
} from '../../src/TrackedUid.js'

const key = randomBytes(32)
const bodyOf = (tracked) => tracked.slice(VERSION_PREFIX.length)
/** As the client does for the visible watermark: drop the version, keep 8 characters. */
const visiblePart = (tracked) => tracked.replace(/^v\d+/, '').slice(0, 8)

test('an encoded user id decodes back to the user id', async () => {
  for (let i = 0; i < 50; i++) {
    const userId = randomUUID()
    assert.equal(decodeWithKey(key, await encodeWithKey(key, userId)), userId)
  }
  assert.equal(decodeWithKey(key, await encodeWithKey(key, 'a')), 'a')
})

test('the value is the version, then hex: tag, IV, ciphertext', async () => {
  const tracked = await encodeWithKey(key, randomUUID())
  assert.ok(tracked.startsWith(VERSION_PREFIX))
  assert.match(bodyOf(tracked), /^[0-9a-f]+$/)
  // a UUID is 36 characters: three AES blocks
  assert.equal(bodyOf(tracked).length, (TAG_BYTES + IV_BYTES + 48) * 2)
  // the shape the client looks for in a watermark payload
  assert.match(`uid:${tracked} | fid:abc`, /uid:((?:v\d+)?[a-f0-9]+)/i)
})

test('every encoding has a new IV, but all encodings of one user share the tag', async () => {
  const userId = randomUUID()
  const all = await Promise.all(Array.from({ length: 200 }, () => encodeWithKey(key, userId)))
  assert.equal(new Set(all).size, 200)
  assert.equal(new Set(all.map((t) => bodyOf(t).slice(TAG_BYTES * 2, (TAG_BYTES + IV_BYTES) * 2))).size, 200)
  assert.equal(new Set(all.map((t) => bodyOf(t).slice(0, TAG_BYTES * 2))).size, 1)
  assert.equal(new Set(all.map(visiblePart)).size, 1)
  for (const tracked of all) assert.equal(decodeWithKey(key, tracked), userId)
})

test('the value never starts with a digit, so taking the version off never eats into it', async () => {
  // The client removes /^v\d+/. A digit right after the version would be removed with it.
  for (let i = 0; i < 2000; i++) {
    const tracked = await encodeWithKey(key, randomUUID())
    assert.match(tracked[VERSION_PREFIX.length], /[a-f]/)
    assert.equal(tracked.replace(/^v\d+/, ''), bodyOf(tracked))
  }
})

test('the visible prefix finds its user among many, and nobody else', async () => {
  const users = Array.from({ length: 500 }, () => randomUUID())
  // every single user, not a sample: the visible part printed for them leads back to them
  for (const target of users) {
    const prefix = visiblePart(await encodeWithKey(key, target))
    assert.equal(prefix.length, 8)
    assert.equal(matchesPrefixWithKey(key, target, prefix), true)
    // a second download of the same user gives the same prefix
    assert.equal(visiblePart(await encodeWithKey(key, target)), prefix)
  }
  const target = users[137]
  const prefix = visiblePart(await encodeWithKey(key, target))
  assert.deepEqual(
    users.filter((id) => matchesPrefixWithKey(key, id, prefix)),
    [target]
  )
  // longer prefixes work the same way; past the tag only the tag is compared
  const body = bodyOf(await encodeWithKey(key, target))
  for (const length of [1, 8, 16, TAG_BYTES * 2, TAG_BYTES * 2 + 10]) {
    assert.equal(matchesPrefixWithKey(key, target, body.slice(0, length)), true)
  }
  assert.equal(matchesPrefixWithKey(key, users[0], body.slice(0, 16)), false)
  // with the version still in front it is not a prefix of the hex part
  assert.equal(matchesPrefixWithKey(key, target, VERSION_PREFIX + body.slice(0, 8)), false)
})

test('another key gives another tag and cannot decode', async () => {
  const userId = randomUUID()
  const other = randomBytes(32)
  const tracked = await encodeWithKey(key, userId)
  assert.throws(() => decodeWithKey(other, tracked))
  assert.notEqual(visiblePart(await encodeWithKey(other, userId)), visiblePart(tracked))
})

test('an edited or invented value is rejected', async () => {
  const userId = randomUUID()
  const tracked = await encodeWithKey(key, userId)
  const body = bodyOf(tracked)
  const flipAt = (index) => {
    const replacement = body[index] === '0' ? '1' : '0'
    return VERSION_PREFIX + body.slice(0, index) + replacement + body.slice(index + 1)
  }
  // one changed character anywhere: in the tag, in the IV, in each ciphertext block
  for (const index of [0, 31, 32, 63, 64, 100, 130, body.length - 1]) {
    assert.throws(() => decodeWithKey(key, flipAt(index)), `changed at ${index}`)
  }
  // the tag of one user in front of the rest of another user's value
  const otherBody = bodyOf(await encodeWithKey(key, randomUUID()))
  assert.throws(
    () => decodeWithKey(key, VERSION_PREFIX + body.slice(0, 32) + otherBody.slice(32)),
    /integrity check failed/
  )
  // cut short, wrong version, not hex, not a string
  assert.throws(() => decodeWithKey(key, tracked.slice(0, 40)), /Malformed/)
  assert.throws(() => decodeWithKey(key, tracked.slice(0, tracked.length - 2)))
  assert.throws(() => decodeWithKey(key, 'v1' + body), /Unsupported/)
  assert.throws(() => decodeWithKey(key, body), /Unsupported/)
  assert.throws(() => decodeWithKey(key, VERSION_PREFIX + 'zz' + body.slice(2)), /Malformed/)
  assert.throws(() => decodeWithKey(key, undefined), /Unsupported/)
  // random hex of the right length
  for (let i = 0; i < 50; i++) {
    assert.throws(() => decodeWithKey(key, VERSION_PREFIX + randomBytes(body.length / 2).toString('hex')))
  }
})

test('only a non-empty string can be encoded', async () => {
  for (const bad of ['', undefined, null, 7]) {
    await assert.rejects(encodeWithKey(key, bad), /non-empty string/)
  }
})

test('a key that is not 32 bytes is refused', async () => {
  for (const length of [0, 16, 24, 31, 33, 64]) {
    await assert.rejects(encodeWithKey(randomBytes(length), randomUUID()), /Invalid key length/, `${length} bytes`)
  }
  await assert.rejects(encodeWithKey(undefined, randomUUID()), /Invalid key length/)
})

test('full values are told apart from short prefixes', async () => {
  const tracked = await encodeWithKey(key, randomUUID())
  assert.equal(looksFull(tracked), true)
  assert.equal(looksFull(visiblePart(tracked)), false)
  assert.equal(looksFull(bodyOf(tracked)), false)
  assert.equal(looksFull(tracked.slice(0, VERSION_PREFIX.length + (TAG_BYTES + IV_BYTES) * 2)), false)
  assert.equal(looksFull(undefined), false)
})
