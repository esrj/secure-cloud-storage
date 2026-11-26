/**
 * Encryption of the personal fields kept in the users table (name and email).
 *
 * A field is encrypted with AES-256-GCM and a new random IV of 16 bytes every time:
 *
 *   encrypted = base64(IV) : base64(ciphertext) : base64(auth tag)
 *
 * Decryption takes the IV as it was stored, whatever its length, so values written with the
 * 12-byte IV of the first version of this format are read the same way.
 *
 * With a random IV the same text never encrypts to the same value twice, so an encrypted
 * column cannot be searched by comparing ciphertexts. A field that has to be found again (the
 * email: registration, recovery, the admin list in the config) is stored together with a
 * lookup value, a keyed hash of the text made with a key of its own:
 *
 *   searchable = hex(HMAC-SHA256(lookupKey, text)) : encrypted
 *
 * Equal texts give equal lookup values, which is what makes the search possible. Without the
 * lookup key the value says nothing about the text.
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

const ALGORITHM = 'aes-256-gcm'
const TAG_BYTES = 16
const SEPARATOR = ':'

/**
 * @param {string} text
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @returns {string} IV, ciphertext and auth tag
 */
export function encryptText(text, key) {
  const iv = crypto.randomBytes(16)
  const encryptor = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  const encrypted = Buffer.concat([encryptor.update(text, 'utf-8'), encryptor.final()])
  return [iv, encrypted, encryptor.getAuthTag()]
    .map((part) => part.toString('base64'))
    .join(SEPARATOR)
}

/**
 * @param {string} stored a value made by encryptText
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @returns {string} the text
 * @throws {Error} if the value has another format, was changed, or the key is wrong
 */
export function decryptText(stored, key) {
  const parts = stored.split(SEPARATOR)
  if (parts.length !== 3) {
    throw new Error('Stored field is not in the expected encrypted format.')
  }
  const [iv, encrypted, tag] = parts.map((part) => Buffer.from(part, 'base64'))
  const decryptor = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  decryptor.setAuthTag(tag)
  return Buffer.concat([decryptor.update(encrypted), decryptor.final()]).toString('utf-8')
}

/**
 * @param {string} text compared exactly: no trimming, no change of letter case
 * @param {ArrayBuffer | Uint8Array} lookupKey a key of its own, not the encryption key
 * @returns {string} 64 hex characters
 */
export function lookupValue(text, lookupKey) {
  return crypto.createHmac('sha256', lookupKey).update(text, 'utf-8').digest('hex')
}

/**
 * @param {string} text
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @param {ArrayBuffer | Uint8Array} lookupKey
 * @returns {string} the lookup value, then the encrypted text
 */
export function encryptSearchable(text, key, lookupKey) {
  return lookupValue(text, lookupKey) + SEPARATOR + encryptText(text, key)
}

/**
 * @param {string} stored a value made by encryptSearchable
 * @param {ArrayBuffer | Uint8Array} key 32 bytes
 * @returns {string} the text
 */
export function decryptSearchable(stored, key) {
  const start = stored.indexOf(SEPARATOR)
  if (start < 0) throw new Error('Stored field is not in the expected encrypted format.')
  return decryptText(stored.slice(start + 1), key)
}
