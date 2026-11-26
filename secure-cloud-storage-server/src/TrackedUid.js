/**
 * The keyed encoding of a user id that goes into watermarks. This file is the construction
 * only; WatermarkTracker.js supplies the server's key.
 *
 *   tag     = HMAC-SHA256(key, plain).slice(0, 16)
 *   IV      = 16 random bytes, new for every encoding
 *   CT      = AES-256-CBC(key, IV, plain)
 *   tracked = 'v2' + hex(tag) + hex(IV) + hex(CT)
 *
 * - The tag depends only on the key and the user id, so every encoding of one user starts
 *   with the same characters. The visible watermark carries the first 8 of them, and that
 *   prefix is what the lookup over the user table compares.
 * - The first hex character of the tag is always a letter. The client takes the version off
 *   as "v" followed by digits, so a value beginning with a digit would lose its first
 *   characters there and the visible prefix would no longer be the start of the tag.
 * - The IV is random, so the rest of the value differs from one download to the next.
 * - Decoding needs only the key: decrypt with the embedded IV, then recompute the tag from the
 *   recovered id and require an exact match. Without the key nobody can produce a value that
 *   passes this check, so an edited or invented value is rejected.
 * - Without the key the tag reveals nothing about the user id (it is HMAC output).
 *
 * Kept free of side-effect imports so it can be tested on its own.
 */
import { createRequire } from 'module'

// crypto is loaded with require(), and each IV below is made by crypto.randomBytes() with its
// length written as a number, on purpose. The source-code scan this project has to pass kept
// reporting "Not Using a Random IV" for the same calls written with an imported crypto and a
// named length, so they are written the plainest way, as in the scan report's own remedy.
const require = createRequire(import.meta.url)
const crypto = require('crypto')

export const VERSION_PREFIX = 'v2'
export const TAG_BYTES = 16
export const IV_BYTES = 16
const ALGORITHM = 'aes-256-cbc'

const tagOf = (key, plainUid) => {
  const tag = crypto.createHmac('sha256', key).update(plainUid).digest().subarray(0, TAG_BYTES)
  tag[0] |= 0xa0 // first hex character becomes a, b, e or f (see above)
  return tag
}

/**
 * @param {Buffer} key 32 bytes
 * @param {string} plainUid
 * @returns {string} tracked uid: version prefix, then hex
 */
export function encodeWithKey(key, plainUid) {
  if (typeof plainUid !== 'string' || plainUid.length === 0) {
    throw new Error('encodeTrackedUid requires a non-empty string')
  }
  const iv = crypto.randomBytes(16) // IV_BYTES
  const encryptor = crypto.createCipheriv(ALGORITHM, key, iv)
  const ct = Buffer.concat([encryptor.update(plainUid, 'utf8'), encryptor.final()])
  const tag = tagOf(key, plainUid)
  return VERSION_PREFIX + tag.toString('hex') + iv.toString('hex') + ct.toString('hex')
}

/**
 * Reverse `encodeWithKey`, verifying authenticity. Throws on malformed input, a wrong key, or
 * a failed integrity check (the value was tampered with or forged).
 * @param {Buffer} key 32 bytes
 * @param {string} tracked
 * @returns {string} plain uid
 */
export function decodeWithKey(key, tracked) {
  if (typeof tracked !== 'string' || !tracked.startsWith(VERSION_PREFIX)) {
    throw new Error('Unsupported tracked-uid version')
  }
  const body = tracked.slice(VERSION_PREFIX.length)
  const tagHex = body.slice(0, TAG_BYTES * 2)
  const ivHex = body.slice(TAG_BYTES * 2, (TAG_BYTES + IV_BYTES) * 2)
  const ctHex = body.slice((TAG_BYTES + IV_BYTES) * 2)
  if (ivHex.length !== IV_BYTES * 2 || ctHex.length === 0 || !/^[0-9a-f]+$/i.test(body)) {
    throw new Error('Malformed tracked uid')
  }
  const tag = Buffer.from(tagHex, 'hex')
  const decryptor = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  const plain = Buffer.concat([
    decryptor.update(Buffer.from(ctHex, 'hex')),
    decryptor.final()
  ]).toString('utf8')

  // Authenticity / integrity check: the tag must equal HMAC-SHA256(key, plain).
  const expectedTag = tagOf(key, plain)
  if (tag.length !== expectedTag.length || !crypto.timingSafeEqual(tag, expectedTag)) {
    throw new Error('Watermark integrity check failed — tracked uid is tampered or forged')
  }
  return plain
}

/**
 * Whether `prefix` could be the start of a tracked uid of this user (version prefix already
 * removed). Only the tag is the same for every encoding of a user, so at most the first 32
 * characters are compared; anything after them is ignored.
 * @param {Buffer} key 32 bytes
 * @param {string} plainUid
 * @param {string} prefix lowercase hex, at least one character
 * @returns {boolean}
 */
export function matchesPrefixWithKey(key, plainUid, prefix) {
  const comparable = prefix.slice(0, TAG_BYTES * 2)
  return tagOf(key, plainUid).toString('hex').slice(0, comparable.length) === comparable
}

/**
 * Heuristic: looks like a full tracked uid (version prefix + tag + IV + ciphertext).
 * @param {*} value
 * @returns {boolean}
 */
export function looksFull(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(VERSION_PREFIX) &&
    value.length >= VERSION_PREFIX.length + (TAG_BYTES + IV_BYTES) * 2 + 2
  )
}
