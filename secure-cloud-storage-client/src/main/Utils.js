import { subtle } from 'node:crypto'
/**
 * Converts a UUID string to a BigInt for use in smart contracts.
 * The UUID string should be in the standard format (e.g., "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").
 *
 * @param {string} uuidString The UUID string to convert.
 * @returns {bigint} The BigInt representation of the UUID.
 * @throws {Error} If the UUID string format is invalid.
 */
export function uuidToBigInt(uuidString) {
  // Basic validation for UUID format
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRegex.test(uuidString)) {
    throw new Error(`Invalid UUID string format: ${uuidString}`)
  }

  // Remove hyphens and convert to BigInt
  const hexString = uuidString.replace(/-/g, '')
  return BigInt('0x' + hexString)
}

/**
 * Converts a BigInt (representing a UUID) back to a standard UUID string.
 * This assumes the BigInt was originally derived from a 128-bit UUID.
 *
 * @param {bigint} uuidBigInt The BigInt to convert back to a UUID string.
 * @returns {string} The UUID string in standard format.
 * @throws {Error} If the BigInt is too large to be a 128-bit UUID.
 */
export function bigIntToUuid(uuidBigInt) {
  // A 128-bit number's maximum value in hexadecimal is 16^32 - 1.
  // The maximum BigInt for a 128-bit UUID is 2^128 - 1, which is (2^64)^2 - 1.
  // This translates to 'ffffffffffffffffffffffffffffffff' in hex.
  const max128BitBigInt = (1n << 128n) - 1n // Calculate 2^128 - 1n

  if (uuidBigInt < 0n || uuidBigInt > max128BitBigInt) {
    throw new Error(`BigInt ${uuidBigInt} is out of the valid range for a 128-bit UUID.`)
  }

  // Convert BigInt to hexadecimal string, then pad with leading zeros if necessary
  let hexString = uuidBigInt.toString(16)

  // Ensure the hex string is 32 characters long (128 bits = 32 hex chars)
  hexString = hexString.padStart(32, '0')

  // Insert hyphens to format as a UUID
  return [
    hexString.substring(0, 8),
    hexString.substring(8, 12),
    hexString.substring(12, 16),
    hexString.substring(16, 20),
    hexString.substring(20, 32)
  ].join('-')
}

/**
 *
 * @param {BigInt} hashBigInt
 * @param {number} maxLength The length to pad to without '0x'
 */
export function bigIntToHex(hashBigInt, maxLength = 0) {
  return '0x' + hashBigInt.toString(16).padStart(maxLength, '0')
}

/**
 * Derive AES key and iv from the provided base buffer.
 * @param {ArrayBufferLike} baseMaterial The base buffer for derivation.
 * @returns The derive AES key and iv.
 */
export async function deriveAESKeyIvFromBuffer(baseMaterial) {
  const baseKey = await subtle.importKey('raw', baseMaterial, 'HKDF', false, ['deriveBits'])
  const derivedBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'sha-256',
      info: new Uint8Array(),
      salt: new Uint8Array()
    },
    baseKey,
    48 * 8
  )
  const key = derivedBits.slice(0, 32)
  const iv = derivedBits.slice(32, 48)
  return { key, iv }
}

export const TryAgainMsg = 'Please try again.'
export const ContactManagerOrTryAgainMsg = 'Please contact the manager or try again.'
export const CheckDiskSizePermissionTryAgainMsg =
  'Please check disk size or permission and try again.'
export const CheckLogForDetailMsg = 'Please check log for details.'
export const UnexpectedErrorMsg = 'Unexpected error.'
