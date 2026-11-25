// Run: node --test test/crypto/*.test.js
// Name and email in the users table: encrypted with a new random IV each time, the email
// stored behind a keyed lookup value so it can still be found.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  decryptSearchable,
  decryptText,
  encryptSearchable,
  encryptText,
  lookupValue
} from '../../src/UserFieldCrypto.js'

const key = randomBytes(32)
const lookupKey = randomBytes(32)
const texts = ['Alice', '使用者 A', 'a', 'someone@example.com', 'Mixed.Case+tag@Example.COM', 'x'.repeat(5000)]

test('a text comes back unchanged', () => {
  for (const text of texts) {
    assert.equal(decryptText(encryptText(text, key), key), text)
    assert.equal(decryptSearchable(encryptSearchable(text, key, lookupKey), key), text)
  }
})

test('the stored form is IV : ciphertext : tag, with a 12-byte IV and a 16-byte tag', () => {
  const parts = encryptText('Alice', key).split(':')
  assert.equal(parts.length, 3)
  const [iv, encrypted, tag] = parts.map((part) => Buffer.from(part, 'base64'))
  assert.equal(iv.length, 12)
  assert.equal(encrypted.length, Buffer.byteLength('Alice'))
  assert.equal(tag.length, 16)
  for (const part of parts) assert.match(part, /^[A-Za-z0-9+/]+=*$/)
})

test('every encryption uses a new IV, so the same text never repeats', () => {
  const ivs = new Set()
  const values = new Set()
  for (let i = 0; i < 300; i++) {
    const stored = encryptText('same-name', key)
    ivs.add(stored.split(':')[0])
    values.add(stored)
  }
  assert.equal(ivs.size, 300)
  assert.equal(values.size, 300)
})

test('the lookup value is the same for the same text and the same key, and only then', () => {
  const email = 'someone@example.com'
  assert.equal(lookupValue(email, lookupKey), lookupValue(email, lookupKey))
  assert.match(lookupValue(email, lookupKey), /^[0-9a-f]{64}$/)
  // compared exactly, as the equality on the stored value was before
  for (const other of ['Someone@example.com', 'someone@example.com ', ' someone@example.com', 'someone@example.co']) {
    assert.notEqual(lookupValue(other, lookupKey), lookupValue(email, lookupKey))
  }
  assert.notEqual(lookupValue(email, randomBytes(32)), lookupValue(email, lookupKey))
})

test('a searchable value starts with the lookup value and can be found by it', () => {
  const email = 'someone@example.com'
  const first = encryptSearchable(email, key, lookupKey)
  const second = encryptSearchable(email, key, lookupKey)
  assert.notEqual(first, second)
  // what the SQL does: split_part(email, ':', 1)
  assert.equal(first.split(':')[0], lookupValue(email, lookupKey))
  assert.equal(second.split(':')[0], lookupValue(email, lookupKey))
  assert.equal(first.split(':').length, 4)
  assert.ok(!first.includes(email))
})

test('keys handed over as ArrayBuffer work the same (that is how the server derives them)', () => {
  const asArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)
  const email = 'someone@example.com'
  const stored = encryptSearchable(email, asArrayBuffer(key), asArrayBuffer(lookupKey))
  assert.equal(decryptSearchable(stored, key), email)
  assert.equal(stored.split(':')[0], lookupValue(email, lookupKey))
  assert.equal(decryptText(encryptText('Alice', key), asArrayBuffer(key)), 'Alice')
})

test('a changed value, a wrong key or another format is refused', () => {
  const stored = encryptText('Alice', key)
  const [iv, encrypted, tag] = stored.split(':')
  const flip = (b64) => {
    const bytes = Buffer.from(b64, 'base64')
    bytes[0] ^= 1
    return bytes.toString('base64')
  }
  assert.throws(() => decryptText([flip(iv), encrypted, tag].join(':'), key))
  assert.throws(() => decryptText([iv, flip(encrypted), tag].join(':'), key))
  assert.throws(() => decryptText([iv, encrypted, flip(tag)].join(':'), key))
  assert.throws(() => decryptText(stored, randomBytes(32)))
  // a tag cut short must not be accepted
  const shortTag = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64')
  assert.throws(() => decryptText([iv, encrypted, shortTag].join(':'), key))
  // values that are not in this format at all (for example rows written by an older version)
  assert.throws(() => decryptText(`${encrypted}:${tag}`, key), /expected encrypted format/)
  assert.throws(() => decryptText('plain text', key), /expected encrypted format/)
  assert.throws(() => decryptSearchable('no separator', key), /expected encrypted format/)
  assert.throws(() => decryptSearchable(`${encrypted}:${tag}`, key), /expected encrypted format/)
})
