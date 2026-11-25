/**
 * This file handles secret sharing encryption and decryption.
 */
import sss from 'shamirs-secret-sharing'
import { logger } from './Logger'
import { deriveAESKeyFromBuffer } from './Utils'
import { decryptBytes, encryptBytes } from './AesCbc'

/**
 * Encrypt the data string with extra key and split it into shares.
 * The encrypted data starts with its own random IV (see AesCbc.js).
 * @param {string} sk
 * @param {string} dataStr
 * @returns
 */
export async function encryptDataShareKey(sk, dataStr) {
  // Encrypt data and share sk
  const key = await deriveAESKeyFromBuffer(new TextEncoder().encode(sk))
  const encrypted = encryptBytes(key, Buffer.from(dataStr, 'utf8')).toString('hex')

  const secret = Buffer.from(encrypted)
  const shares = sss.split(secret, { shares: 10, threshold: 2 })
  return shares
}

/**
 * Recover shares and decrypt it with the extra key.
 * @param {string} sk
 * @param {Array<Buffer>} shares
 * @returns
 */
export async function recoverDataShareKey(sk, shares) {
  const key = await deriveAESKeyFromBuffer(new TextEncoder().encode(sk))
  const recovered = sss.combine(shares).toString()

  try {
    return decryptBytes(key, Buffer.from(recovered, 'hex')).toString('utf8')
  } catch (error) {
    logger.error(error)
    return null
  }
}
