// Run: node --test test/crypto/*.test.mjs   (or: npm run test:crypto)
// AES-256-CBC with a random IV stored in front of the ciphertext, as used for uploaded files,
// the database backup and the recovery shares.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  IV_BYTES,
  createDecryptStream,
  decryptBytes,
  encryptBytes,
  encryptStream
} from '../../src/main/AesCbc.js'

const BLOCK = 16
const paddedLength = (n) => (Math.floor(n / BLOCK) + 1) * BLOCK
const collect = async (readable) => {
  const chunks = []
  for await (const chunk of readable) chunks.push(chunk)
  return Buffer.concat(chunks)
}
/** A readable that hands out `data` in pieces of `size` bytes. */
const inPieces = (data, size) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
    })(),
    { objectMode: false }
  )
const sizes = [0, 1, 15, 16, 17, 31, 32, 1000, 65536, 3 * 65536 + 5]

test('a buffer comes back unchanged, and the stored form is IV + ciphertext', async () => {
  const key = randomBytes(32)
  for (const size of sizes) {
    const plain = randomBytes(size)
    const stored = await encryptBytes(key, plain)
    assert.equal(stored.length, IV_BYTES + paddedLength(size))
    assert.ok(decryptBytes(key, stored).equals(plain), `size ${size}`)
  }
})

test('every encryption uses a new IV, so equal input gives different output', async () => {
  const key = randomBytes(32)
  const plain = Buffer.from('the same content, encrypted many times')
  const seenIvs = new Set()
  const seenOutputs = new Set()
  for (let i = 0; i < 200; i++) {
    const stored = await encryptBytes(key, plain)
    seenIvs.add(stored.subarray(0, IV_BYTES).toString('hex'))
    seenOutputs.add(stored.toString('hex'))
    assert.ok(decryptBytes(key, stored).equals(plain))
  }
  assert.equal(seenIvs.size, 200)
  assert.equal(seenOutputs.size, 200)
})

test('a stream comes back unchanged, whatever the size and the chunking', async () => {
  const key = randomBytes(32)
  for (const size of sizes) {
    const plain = randomBytes(size)
    const stored = await collect(encryptStream(key, inPieces(plain, 4096)))
    assert.equal(stored.length, IV_BYTES + paddedLength(size))
    for (const pieceSize of [1, 7, IV_BYTES, 4096, 1 << 20]) {
      if (pieceSize === 1 && size > 1000) continue // byte-by-byte only for the small ones
      const opened = await collect(inPieces(stored, pieceSize).pipe(createDecryptStream(key)))
      assert.ok(opened.equals(plain), `size ${size}, pieces of ${pieceSize}`)
    }
  }
})

test('however the input arrives in pieces, the stream gives the encryption of the whole', async () => {
  // The stream is encrypted piece by piece (see ivThenEncrypted), so the pieces are tried in
  // sizes below, at and above the block size, and in sizes that leave bytes over each time.
  const key = randomBytes(32)
  for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 1000, 65536, 3 * 65536 + 5]) {
    const plain = randomBytes(size)
    for (const pieceSize of [1, 5, 15, 16, 17, 33, 4096, 65536, 100000]) {
      if (pieceSize < 15 && size > 1000) continue // the smallest pieces only for the small ones
      const stored = await collect(encryptStream(key, inPieces(plain, pieceSize)))
      assert.equal(stored.length, IV_BYTES + paddedLength(size), `size ${size}, pieces of ${pieceSize}`)
      // read back in one go by the buffer form: the same bytes as one encryption of the whole
      assert.ok(decryptBytes(key, stored).equals(plain), `size ${size}, pieces of ${pieceSize}`)
    }
  }
})

test('a key that is not 32 bytes is refused', async () => {
  const plain = randomBytes(100)
  for (const length of [0, 16, 24, 31, 33, 64]) {
    const key = randomBytes(length)
    await assert.rejects(encryptBytes(key, plain), /Invalid key length/, `${length} bytes`)
    assert.throws(() => encryptStream(key, inPieces(plain, 50)), /Invalid key length/, `${length} bytes`)
  }
  await assert.rejects(encryptBytes(undefined, plain), /Invalid key length/)
  assert.throws(() => encryptStream(undefined, inPieces(plain, 50)), /Invalid key length/)
})

test('a 32-byte key handed over as ArrayBuffer works the same (that is how the app holds its keys)', async () => {
  const key = randomBytes(32)
  const asArrayBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.length)
  const plain = randomBytes(5000)
  assert.ok(decryptBytes(key, await encryptBytes(asArrayBuffer, plain)).equals(plain))
  assert.ok(decryptBytes(asArrayBuffer, await collect(encryptStream(asArrayBuffer, inPieces(plain, 999)))).equals(plain))
})

test('an error while reading the input arrives as an error of the encrypted stream', async () => {
  const key = randomBytes(32)
  const failing = Readable.from(
    (function* () {
      yield randomBytes(5000)
      throw new Error('read failed')
    })(),
    { objectMode: false }
  )
  await assert.rejects(collect(encryptStream(key, failing)), /read failed/)
})

test('the stream form and the buffer form are the same format', async () => {
  const key = randomBytes(32)
  const plain = randomBytes(70000)
  const fromStream = await collect(encryptStream(key, inPieces(plain, 9999)))
  assert.ok(decryptBytes(key, fromStream).equals(plain))
  const fromBuffer = await encryptBytes(key, plain)
  assert.ok((await collect(inPieces(fromBuffer, 9999).pipe(createDecryptStream(key)))).equals(plain))
})

test('two streams of the same file do not share an IV', async () => {
  const key = randomBytes(32)
  const plain = randomBytes(5000)
  const first = await collect(encryptStream(key, inPieces(plain, 1024)))
  const second = await collect(encryptStream(key, inPieces(plain, 1024)))
  assert.ok(!first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES)))
  assert.ok(!first.equals(second))
})

test('a wrong key or damaged data is reported as an error, not returned as content', async () => {
  const key = randomBytes(32)
  const plain = randomBytes(4000)
  const stored = await encryptBytes(key, plain)
  const failures = []
  const tryBytes = (k, data) => {
    try {
      const out = decryptBytes(k, data)
      if (out.equals(plain)) failures.push('returned the content')
    } catch {
      return true
    }
    return false
  }
  const tryStream = async (k, data) => {
    try {
      const out = await collect(inPieces(data, 512).pipe(createDecryptStream(k)))
      if (out.equals(plain)) failures.push('returned the content')
    } catch {
      return true
    }
    return false
  }
  // Too short to hold an IV and a block: always an error.
  for (const short of [Buffer.alloc(0), stored.subarray(0, 5), stored.subarray(0, IV_BYTES)]) {
    assert.equal(tryBytes(key, short), true)
    assert.equal(await tryStream(key, short), true)
  }
  // Cut in the middle of a block: always an error.
  assert.equal(tryBytes(key, stored.subarray(0, stored.length - 3)), true)
  assert.equal(await tryStream(key, stored.subarray(0, stored.length - 3)), true)
  // A wrong key fails on the padding check except by chance (about 1 in 256), and even then
  // the content is never the original.
  let rejected = 0
  for (let i = 0; i < 40; i++) {
    const other = randomBytes(32)
    if (tryBytes(other, stored)) rejected++
    if (await tryStream(other, stored)) rejected++
  }
  assert.ok(rejected >= 70, `wrong keys rejected ${rejected} times out of 80`)
  assert.deepEqual(failures, [])
})

test('an error in the decrypt stream arrives as an error event, as FileManager expects', async () => {
  const key = randomBytes(32)
  const stored = await encryptBytes(key, randomBytes(100))
  const decrypt = createDecryptStream(key)
  const seen = new Promise((resolve) => decrypt.once('error', resolve))
  decrypt.resume()
  decrypt.end(stored.subarray(0, stored.length - 1))
  const error = await seen
  assert.ok(error instanceof Error)
})

test('upload and download plumbing: hash of what is stored, then decrypt while hashing', async () => {
  // Upload side, as in FileManager.#uploadProcess: the encrypted stream is split into a hash
  // and the bytes that are sent.
  const key = randomBytes(32)
  const plain = randomBytes(300000)
  const encryptedStream = encryptStream(key, inPieces(plain, 65536))
  const toHash = new PassThrough()
  const toSend = new PassThrough()
  encryptedStream.pipe(toHash)
  encryptedStream.pipe(toSend)
  const [uploadHash, sent] = await Promise.all([
    collect(toHash).then((bytes) => createHash('sha256').update(bytes).digest('hex')),
    collect(toSend)
  ])
  assert.equal(uploadHash, createHash('sha256').update(sent).digest('hex'))
  assert.equal(sent.length, IV_BYTES + paddedLength(plain.length))

  // Download side, as in FileManager.downloadFileProcess2: the stored bytes go to the hash and
  // through the decrypt stream to the file.
  const incoming = new PassThrough()
  const downloadHash = createHash('sha256')
  incoming.pipe(downloadHash)
  const decrypt = createDecryptStream(key)
  const written = collect(incoming.pipe(decrypt))
  await pipeline(inPieces(sent, 16384), incoming)
  assert.ok((await written).equals(plain))
  assert.equal(downloadHash.digest('hex'), uploadHash)
})
