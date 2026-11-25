/**
 * AES-256-CBC with a new random IV for every encryption.
 *
 * The IV is not secret. It is stored in front of the ciphertext, so the key is all that is
 * needed to decrypt:
 *
 *   stored = IV (16 bytes) + AES-256-CBC(key, IV, plaintext)
 *
 * Used for uploaded files (AESModule), the database backup (DatabaseManager) and the recovery
 * shares (SecretSharing). It imports nothing from the rest of the app, so it can be tested on
 * its own.
 */
import crypto from 'crypto'
import { Readable, Transform } from 'stream'

const ALGORITHM = 'aes-256-cbc'
export const IV_BYTES = 16

async function* ivThenCiphertext(iv, ciphertext) {
  yield iv
  yield* ciphertext
}

/**
 * Encrypt a stream.
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @param {import('stream').Readable} readable the plaintext
 * @returns {import('stream').Readable} the IV followed by the ciphertext
 */
export function encryptStream(key, readable) {
  const iv = crypto.randomBytes(IV_BYTES)
  const encryptor = crypto.createCipheriv(ALGORITHM, key, iv)
  return Readable.from(ivThenCiphertext(iv, readable.pipe(encryptor)))
}

/**
 * The reverse of encryptStream as a transform: write the stored bytes, read the plaintext.
 * A wrong key or damaged data ends in an 'error' event, as it does with crypto's own decipher.
 */
class DecryptStream extends Transform {
  #key
  #head = [] // what arrived before the IV was complete
  #headLength = 0
  #decryptor = null

  constructor(key) {
    super()
    this.#key = key
  }

  _transform(chunk, _encoding, callback) {
    try {
      let data = chunk
      if (this.#decryptor === null) {
        this.#head.push(chunk)
        this.#headLength += chunk.length
        if (this.#headLength < IV_BYTES) {
          callback()
          return
        }
        const head = Buffer.concat(this.#head)
        this.#head = null
        this.#decryptor = crypto.createDecipheriv(ALGORITHM, this.#key, head.subarray(0, IV_BYTES))
        data = head.subarray(IV_BYTES)
      }
      callback(null, this.#decryptor.update(data))
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      if (this.#decryptor === null) throw new Error('Encrypted data is shorter than its IV.')
      callback(null, this.#decryptor.final())
    } catch (error) {
      callback(error)
    }
  }
}

/**
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @returns {import('stream').Transform}
 */
export function createDecryptStream(key) {
  return new DecryptStream(key)
}

/**
 * Encrypt a buffer.
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @param {Buffer} plain
 * @returns {Buffer} the IV followed by the ciphertext
 */
export function encryptBytes(key, plain) {
  const iv = crypto.randomBytes(IV_BYTES)
  const encryptor = crypto.createCipheriv(ALGORITHM, key, iv)
  return Buffer.concat([iv, encryptor.update(plain), encryptor.final()])
}

/**
 * The reverse of encryptBytes.
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @param {Buffer} stored the IV followed by the ciphertext
 * @returns {Buffer} the plaintext
 * @throws {Error} with a wrong key or damaged data
 */
export function decryptBytes(key, stored) {
  if (stored.length <= IV_BYTES) throw new Error('Encrypted data is shorter than its IV.')
  const decryptor = crypto.createDecipheriv(ALGORITHM, key, stored.subarray(0, IV_BYTES))
  return Buffer.concat([decryptor.update(stored.subarray(IV_BYTES)), decryptor.final()])
}
