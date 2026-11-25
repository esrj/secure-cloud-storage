import { createReadStream } from 'node:fs'
import { logSocketWarning } from './Logger.js'
import { getFolderInfoOfOwnerId, getUserById, userStatusType } from './StorageDatabase.js'
import crypto, { subtle } from 'node:crypto'
import ConfigManager from './ConfigManager.js'
import { resolveFilePath, resolveUserDir } from './UploadPath.js'

const keyFormatRe = /^[a-zA-Z0-9+/=]+$/
const emailFormatRe = /^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/
const uuidFormatRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export const InvalidArgumentErrorMsg = 'Invalid arguments.'
export const InternalServerErrorMsg = 'Internal server error.'
export const NotLoggedInErrorMsg = 'Not logged in.'
export const NotAdminErrorMsg = 'Admin only.'
export const FileNotFoundErrorMsg = 'File not found.'
export const EmailNotRegisteredErrorMsg = 'Email not registered.'
export const EmailAlreadyRegisteredErrorMsg = 'Email already registered.'
export const NoEmailAuthFirstErrorMsg = 'Did not ask for email authentication first.'
export const EmailAuthExpiredErrorMsg = 'Email authentication code is expired.'
export const EmailAuthNotMatchErrorMsg = 'Email authentication code did not match.'
export const ShouldNotReachErrorMsg = 'Should not reach.'

// Risky MIME types (based on mimetype.io).
export const riskyMimeTypes = [
  // Executables / install packages
  'application/x-msdownload', // .exe, .dll, .msi, .bat, .com (listed on mimetype.io)
  'application/octet-stream', // generic binary (often used for executables / unknown)
  'application/java-archive', // .jar
  'application/x-debian-package', // .deb
  'application/x-rpm', // .rpm
  'application/vnd.android.package-archive', // .apk

  // Script files
  'text/javascript', // .js
  'application/x-sh', // .sh
  'application/x-shellscript', // .sh
  'application/x-csh', // .csh
  'application/x-tcl', // .tcl
  'application/x-perl', // .pl
  // note: some script types may be represented as text/plain for certain servers.

  // Macro-capable / Office (macro-enabled) documents
  'application/msword', // .doc (older Word)
  'application/vnd.ms-word.document.macroenabled.12', // .docm
  'application/vnd.ms-excel', // .xls, .xlt, ...
  'application/vnd.ms-excel.sheet.macroenabled.12', // .xlsm
  'application/vnd.ms-powerpoint', // .ppt, .pps, ...
  'application/vnd.ms-powerpoint.presentation.macroenabled.12', // .pptm
  'application/vnd.ms-excel.addin.macroenabled.12', // .xlam
  'application/vnd.ms-powerpoint.addin.macroenabled.12', // .ppam

  // Archives / containers (must be recursively inspected if allowed)
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-bzip2',
  'application/x-tar',

  // Disk / image / installer formats
  'application/x-iso9660-image', // .iso

  // Historically risky/active-content types
  'application/x-shockwave-flash', // .swf (Flash)
  'application/x-xpinstall', // .xpi (Firefox extensions)

  // PDFs and other document types that can carry active content
  'application/pdf',

  // Active image formats (SVG can contain scripts)
  'image/svg+xml'
]

/**
 * Check socket login status
 * @param {*} socket
 * @returns
 */
const checkLoggedIn = (socket) => {
  if (!socket.authed) {
    logSocketWarning(socket, 'Unauthorized attempt', { ip: socket.ip })
    // socket.emit('message', 'not logged in')
    return false
  }
  // Check for account status in database, in case CLI stop the account
  getUserById(socket.userId).then((userInfo) => {
    if (userInfo.status !== userStatusType.activate) {
      socket.emit(`Account is ${userInfo.status}`)
      socket.disconnect(true)
    }
  })

  return true
}

/**
 * Check that the socket's login carries the admin role (set from users.role at login).
 * Callers must check login first; this only inspects the role.
 * @param {*} socket
 * @returns {boolean}
 */
const checkAdmin = (socket) => {
  if (socket.role !== 'admin') {
    logSocketWarning(socket, 'Admin-only action attempted by non-admin', { ip: socket.ip })
    return false
  }
  return true
}

/**
 * Check if certain folder id exist for certain user
 * @param {string} folderId
 * @param {string} userId
 * @returns
 */
const checkFolderExistsForUser = async (folderId, userId) => {
  if (!folderId) {
    return true
  }
  return await getFolderInfoOfOwnerId(folderId, userId)
}

/**
 * Get the upload folder of certain user
 * @param {string} userId
 * @returns {string}
 */
const getUserDir = (userId) => {
  return resolveUserDir(ConfigManager.uploadDir, userId)
}

/**
 * Get file path for certain user and fileId
 * @param {string} userId
 * @param {string} fileId
 * @returns {string}
 */
const getFilePath = (userId, fileId) => {
  return resolveFilePath(ConfigManager.uploadDir, userId, fileId)
}

/**
 * Calcluate file hash from file path
 * @param {string} filePath
 * @param {string} algorithm default sha256
 * @returns {Promise<string>} File hash
 */
const calculateFileHash = async (filePath, algorithm = 'sha256') => {
  const hash = crypto.createHash(algorithm)
  const stream = createReadStream(filePath)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  return '0x' + hash.digest('hex')
}

/**
 *
 * @param {BigInt} value
 * @param {number} maxLength The length to pad to without '0x'
 * @returns Hex representation of the value.
 */
export const BigIntToHex = (value, maxLength = 0) => {
  return '0x' + value.toString(16).padStart(maxLength, '0')
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
 * Derive the keys for the personal fields of the users table from the provided base buffer:
 * the AES key, and a separate key for lookup values (see UserFieldCrypto.js). The two are
 * different parts of one HKDF output, so knowing one says nothing about the other.
 * @param {ArrayBufferLike} baseMaterial The base buffer for derivation.
 * @returns The derived AES key and lookup key, 32 bytes each.
 */
export async function deriveFieldKeysFromBuffer(baseMaterial) {
  const baseKey = await subtle.importKey('raw', baseMaterial, 'HKDF', false, ['deriveBits'])
  const derivedBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'sha-256',
      info: new Uint8Array(),
      salt: new Uint8Array()
    },
    baseKey,
    80 * 8
  )
  const key = derivedBits.slice(0, 32)
  const lookupKey = derivedBits.slice(48, 80)
  return { key, lookupKey }
}

export {
  checkLoggedIn,
  checkAdmin,
  checkFolderExistsForUser,
  getUserDir,
  getFilePath,
  calculateFileHash,
  keyFormatRe,
  emailFormatRe,
  uuidFormatRe
}
