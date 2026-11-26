/**
 * Paths inside the upload directory.
 *
 * Every stored file lives at <uploads>/<user id>/<file id>. Both ids are issued by the server
 * (UUIDs, plus the fixed name database.db), so each of them is a single file name. The
 * functions here take the file-name part of an id with path.basename() and refuse the id if
 * that changed it, so a path built here cannot point outside the upload directory whatever
 * reaches it.
 *
 * Kept free of side-effect imports so the routes that use it can be tested on their own.
 */
import path from 'path'

/**
 * @param {string} name the result of path.basename(id)
 * @param {string} id the id it was taken from
 * @throws {Error} if the id is empty, is "." or "..", or contains a path separator
 */
const assertPlainName = (name, id) => {
  if (name !== id || name === '' || name === '.' || name === '..') {
    throw new Error('Not a plain file name.')
  }
}

/**
 * @param {string} uploadDir the upload directory from the config
 * @param {string} userId
 * @returns {string} absolute path of the user's folder
 */
export const resolveUserDir = (uploadDir, userId) => {
  const userFolder = path.basename(userId)
  assertPlainName(userFolder, userId)
  return path.join(path.resolve(uploadDir), userFolder)
}

/**
 * @param {string} uploadDir the upload directory from the config
 * @param {string} userId
 * @param {string} fileId
 * @returns {string} absolute path of one stored file of the user
 */
export const resolveFilePath = (uploadDir, userId, fileId) => {
  const userFolder = path.basename(userId)
  const fileName = path.basename(fileId)
  assertPlainName(userFolder, userId)
  assertPlainName(fileName, fileId)
  return path.join(path.resolve(uploadDir), userFolder, fileName)
}
