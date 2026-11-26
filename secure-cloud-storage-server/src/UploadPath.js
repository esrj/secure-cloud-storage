/**
 * Paths inside the upload directory.
 *
 * Every stored file lives at <uploads>/<user id>/<file id>. Both ids are issued by the server
 * (UUIDs, plus the fixed name database.db), so each of them is a single file name. The
 * functions here take the file-name part of an id with path.basename() and refuse the id if
 * that changed it, so a path built here cannot point outside the upload directory whatever
 * reaches it.
 *
 * A route that takes an id from the request also calls path.basename() on it itself, on the
 * line that builds the path for the disk call, after assertPlainNames() has refused an id that
 * path.basename() would change. The result is the same path as before. It is written out in
 * the route because a source-code scanner follows the value from the request to the disk call
 * and looks for path.basename() on that way; it does not look inside the functions here.
 *
 * Kept free of side-effect imports so the routes that use it can be tested on their own.
 */
// Imported as plain 'path' and called as path.basename() / path.join() on purpose: this is the
// form source-code scanners recognise as the remedy for path traversal.
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
 * Refuses ids that are not single file names, exactly as resolveUserDir() and
 * resolveFilePath() do. For a route that calls path.basename() on the ids itself.
 * @param {...string} ids
 * @throws {Error} if an id is empty, is "." or "..", or contains a path separator
 */
export const assertPlainNames = (...ids) => {
  const names = ids.map((id) => path.basename(id))
  names.forEach((name, i) => assertPlainName(name, ids[i]))
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
