/**
 * This file handles secret sharing encryption and decryption.
 */
import sss from 'shamirs-secret-sharing'
import crypto from 'crypto'
import { logger } from './Logger'
import { deriveAESKeyIvFromBuffer } from './Utils'

const algorithm = 'aes-256-cbc'

/**
 * Encrypt the data string with extra key and split it into shares.
 * @param {string} sk
 * @param {string} dataStr
 * @returns
 */
export async function encryptDataShareKey(sk, dataStr) {
  // Encrypt data and share sk
  const { key, iv } = await deriveAESKeyIvFromBuffer(new TextEncoder().encode(sk))
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  let encrypted = cipher.update(dataStr, 'utf8', 'hex')
  encrypted += cipher.final('hex')

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
  const { key, iv } = await deriveAESKeyIvFromBuffer(new TextEncoder().encode(sk))
  const recovered = sss.combine(shares).toString()

  try {
    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    let decryptedStr = decipher.update(recovered, 'hex', 'utf8')
    decryptedStr += decipher.final('utf8')
    return decryptedStr
  } catch (error) {
    logger.error(error)
    return null
  }
}
