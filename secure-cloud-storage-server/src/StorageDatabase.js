/**
 * This file handles communication with the storage database.
 */
import { Pool } from 'pg'
import ConfigManager from './ConfigManager.js'
import { logger } from './Logger.js'
import { randomUUID } from 'node:crypto'
import { decryptWithAES, deriveAESKeyIvFromBuffer, encryptWithAES } from './Utils.js'
import { readFileSync } from 'node:fs'

//--  Setup --//
export const pool = new Pool(ConfigManager.dbPoolConfig)

// AES key and iv to encrypt user name and email
const material = Buffer.from(readFileSync(ConfigManager.blockchain.walletKeyPath))
const { key, iv } = await deriveAESKeyIvFromBuffer(material)

//- New client connected to database
// pool.on('connect', (client) => {
//   logger.info('New client connected to database')
// })
//- A client is acquired for query
// pool.on('acquire', (client) => {
//   logger.info('Client acquired for query')
// })
//- A client is released for query
// pool.on('release', (client) => {
//   logger.info('Client released for query')
// })
//- Error on idle client
pool.on('error', (err) => {
  logger.error(err)
})

//-- Queries --//
//- User
// Helper function
const parseUserRows = async (rows) => {
  for (const element of rows) {
    element.name = element.name ? await decryptWithAES(element.name, key, iv) : undefined
    element.email = element.email ? await decryptWithAES(element.email, key, iv) : undefined
  }
  return rows
}
/**
 * @typedef {object} User
 * @property {string} id - The user's UUID.
 * @property {string} pk - The user's public key.
 * @property {string} address - The user's blockchain address.
 * @property {string} name - The user's name.
 * @property {string} email - The user's email address.
 * @property {string} status - The user's account status ('activate', 'stopped', 'deleted').
 * @property {number} timestamp - The creation timestamp.
 */

export const userStatusType = Object.freeze({
  activate: 'activate',
  stopped: 'stopped',
  deleted: 'deleted'
})

export const userRoleType = Object.freeze({
  admin: 'admin',
  user: 'user'
})

/**
 * Retrieves a user from the database by their public key.
 * @param {string} pk - The public key of the user.
 * @returns {Promise<User|undefined>} A promise that resolves to the user object if found, otherwise undefined.
 */
export const getUserByKey = async (pk) => {
  const res = await pool.query('SELECT * FROM users WHERE pk = $1', [pk])
  const parsedRows = await parseUserRows(res.rows)
  return parsedRows[0]
}

/**
 * Retrieves a user from the database by their ID.
 * @param {string} id - The UUID of the user.
 * @returns {Promise<User|undefined>} A promise that resolves to the user object if found, otherwise undefined.
 */
export const getUserById = async (id) => {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id])
  const parsedRows = await parseUserRows(res.rows)
  return parsedRows[0]
}

export const getUserByEmail = async (email) => {
  const encryptedEmail = await encryptWithAES(email, key, iv)
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [encryptedEmail])
  const parsedRows = await parseUserRows(res.rows)
  return parsedRows[0]
}

/**
 * Retrieves all users from the database.
 * @returns {Promise<Array<User>>} A promise that resolves to an array of user objects.
 */
export const getAllUsers = async () => {
  const res = await pool.query('SELECT * FROM users')
  const parsedRows = await parseUserRows(res.rows)
  return parsedRows
}

/**
 * Updates the status of a user by their ID.
 * @param {string} id - The UUID of the user.
 * @param {string} status - The new status for the user. Must be one of userStatusType.
 * @returns {Promise<import('pg').QueryResult>} A promise that resolves to the query result.
 * @throws {Error} If the status is invalid.
 */
export const updateUserStatusById = async (id, status) => {
  if (!Object.values(userStatusType).includes(status)) {
    throw new Error('Invalid status')
  }
  return await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, id])
}

/**
 * Updates the name and email of a user by their ID.
 * @param {string} id - The UUID of the user.
 * @param {string} name - The new name for the user.
 * @param {string} email - The new email for the user.
 * @returns {Promise<import('pg').QueryResult>} A promise that resolves to the query result.
 */
export const updateUserInfoById = async (id, name, email) => {
  const encryptedName = await encryptWithAES(name, key, iv)
  const encryptedEmail = await encryptWithAES(email, key, iv)
  return await pool.query('UPDATE users SET name = $1, email = $2 WHERE id = $3', [
    encryptedName,
    encryptedEmail,
    id
  ])
}

/**
 * Deletes a user from the database by their ID.
 * @param {string} id - The UUID of the user.
 * @returns {Promise<import('pg').QueryResult>} A promise that resolves to the query result.
 */
export const deleteUserById = async (id) => {
  return await pool.query('DELETE FROM users WHERE id = $1', [id])
}
/**
 * Adds a user to the database and returns the id of the added user.
 *
 * @param {string} pk The public key of the user.
 * @param {string} blockchainAddress The blockchain address of the user.
 * @param {string} name The name of the user.
 * @param {string} email The email of the user.
 * @returns {Promise<{id: string, info: import('pg').QueryResult}>} A promise that resolves to an object containing the new user's UUID and the query result object.
 */
export const AddUserAndGetId = async (
  pk,
  blockchainAddress,
  name,
  email,
  role = userRoleType.user
) => {
  const id = randomUUID().toString()
  const encryptedName = await encryptWithAES(name, key, iv)
  const encryptedEmail = await encryptWithAES(email, key, iv)
  const info = await pool.query(
    'INSERT INTO users (id, pk, address, name, email, status, role) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, pk, blockchainAddress, encryptedName, encryptedEmail, userStatusType.activate, role]
  )
  return { id, info }
}

//- File
// Helper function
const parseFileRows = (rows) => {
  for (const element of rows) {
    element.ownerId = element.ownerid
    element.originOwnerId = element.originownerid
    element.parentFolderId = element.parentfolderid
    delete element.ownerid
    delete element.originownerid
    delete element.parentfolderid
  }
  return rows
}
/**
 * Adds a file to the database with the given name, ID, user ID, key cipher, IV cipher, size, and description.
 *
 * @param {object} fileData - Object containing file properties.
 * @param {string} fileData.name - The name of the file.
 * @param {string} fileData.id - The UUID of the file.
 * @param {string} fileData.userId - The ID of the user.
 * @param {string} fileData.originOwnerId - The ID of the orignal owner of the file.
 * @param {string} fileData.cipher - The cipher for the key.
 * @param {string} fileData.spk - The cipher for the initialization vector.
 * @param {string} fileData.parentFolderId - The ID of the parent folder.
 * @param {number} fileData.size - The size of the file in bytes.
 * @param {string} fileData.description - The description of the file.
 * @param {number} fileData.infoBlockNumber - The block of file info on blockchain.
 * @param {number} fileData.verifyBlockNumber - The block of verification info on blockchain.
 * @returns {Promise<void>}
 */
export const addFileToDatabase = async ({
  name,
  id,
  userId,
  originOwnerId,
  cipher,
  spk,
  parentFolderId,
  size,
  description,
  infoBlockNumber,
  verifyBlockNumber
}) => {
  const params = [
    id,
    name,
    userId,
    originOwnerId,
    cipher,
    spk,
    parentFolderId,
    0, // permissions default
    size,
    description || '', // Ensure description is a string
    infoBlockNumber,
    verifyBlockNumber
  ]
  await pool.query(
    `
        INSERT INTO files (id, name, ownerId, originOwnerId, cipher, spk, parentFolderId, permissions, size, description, infoblocknumber, verifyblocknumber)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    params
  )
}

/**
 * Update file block numbers
 * @param {{fileId: string, infoBlockNumber: number, verifyBlockNumber:number}} blockInfo
 */
export const updateFileBlockNumber = async ({ fileId, infoBlockNumber, verifyBlockNumber }) => {
  await pool.query(`UPDATE files SET infoblocknumber = $1, verifyblocknumber = $2 WHERE id = $3`, [
    infoBlockNumber,
    verifyBlockNumber,
    fileId
  ])
}

/**
 * Retrieves file information from the database based on the given UUID.
 *
 * @param {string} uuid - The UUID of the file.
 * @returns {Promise<object|undefined>} An object of the file information if found, or undefined if not found.
 */
export const getFileInfo = async (uuid) => {
  const result = await pool.query('SELECT * FROM files WHERE id = $1', [uuid])
  return parseFileRows(result.rows)[0] // Returns the first row or undefined
}

/**
 * Retrieves all files from the database.
 *
 * @returns {Promise<Array<object>>} An array of all file objects.
 */
export const getAllFiles = async () => {
  const result = await pool.query('SELECT * FROM files')
  return parseFileRows(result.rows)
}

/**
 * Retrieves all files owned by a specific user.
 *
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<Array<object>>} An array of file objects owned by the user.
 */
export const getFilesOfOwnerId = async (userId) => {
  const result = await pool.query('SELECT * FROM files WHERE ownerId = $1', [userId])
  return parseFileRows(result.rows)
}

/**
 * Retrieves file information for a specific file ID and owner ID.
 *
 * @param {string} uuid - The UUID of the file.
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<object|undefined>} An object of the file information if found, or undefined if not found.
 */
export const getFileInfoOfOwnerId = async (uuid, userId) => {
  const result = await pool.query('SELECT * FROM files WHERE id = $1 AND ownerId = $2', [
    uuid,
    userId
  ])
  return parseFileRows(result.rows)[0]
}

/**
 * Updates the information of a file in the database.
 *
 * @param {string} uuid - The UUID of the file to be updated.
 * @param {string} cipher - The cipher for the key.
 * @param {string} spk - The cipher for the initialization vector.
 * @param {string} parentFolderId - The ID of the parent folder.
 * @param {number} size - The size of the file in bytes.
 * @returns {Promise<void>}
 */
export const updateFileInDatabase = async (uuid, cipher, spk, parentFolderId, size) => {
  const params = [cipher, spk, parentFolderId, size, '', uuid] // Assuming description is reset to empty string
  await pool.query(
    `
        UPDATE files SET cipher = $1, spk = $2, parentFolderId = $3, size = $4, description = $5 WHERE id = $6
    `,
    params
  )
}

/**
 * Updates the description and permissions of a file.
 *
 * @param {string} uuid - The UUID of the file.
 * @param {string} description - The new description.
 * @param {number} permissions - The new permissions value.
 * @returns {Promise<void>}
 */
export const updateFileDescPermInDatabase = async (uuid, description, permissions) => {
  const params = [description, permissions, uuid]
  await pool.query(
    `
        UPDATE files SET description = $1, permissions = $2 WHERE id = $3
    `,
    params
  )
}

/**
 * Moves a file to a different parent folder.
 *
 * @param {string} uuid - The UUID of the file.
 * @param {string|null} parentFolderId - The ID of the new parent folder, or null for root.
 * @returns {Promise<object>}
 */
export const moveFileToFolder = async (uuid, parentFolderId) => {
  const params = [parentFolderId, uuid]
  return await pool.query(
    `
        UPDATE files SET parentFolderId = $1 WHERE id = $2
    `,
    params
  )
}

/**
 * Deletes a file by its UUID.
 *
 * @param {string} uuid - The UUID of the file to delete.
 * @returns {Promise<void>}
 */
export const deleteFile = async (uuid) => {
  await pool.query('DELETE FROM files WHERE id = $1', [uuid])
}

/**
 * Deletes a file by its UUID and owner ID.
 *
 * @param {string} uuid - The UUID of the file.
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<void>}
 */
export const deleteFileOfOwnerId = async (uuid, userId) => {
  await pool.query('DELETE FROM files WHERE id = $1 AND ownerId = $2', [uuid, userId])
}

/**
 * Retrieves all files within a specific parent folder.
 *
 * @param {string} parentFolderId - The ID of the parent folder.
 * @returns {Promise<Array<object>>} An array of file objects in the specified folder.
 */
export const getAllFilesByParentFolderId = async (parentFolderId) => {
  const result = await pool.query('SELECT * FROM files WHERE parentFolderId = $1', [parentFolderId])
  return parseFileRows(result.rows)
}

/**
 * Retrieves files by parent folder ID and owner ID, or files in the root for a given owner.
 *
 * @param {string|null} parentFolderId - The ID of the parent folder, or null for root files.
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<Array<object>>} An array of file objects.
 */
export const getAllFilesByParentFolderIdUserId = async (parentFolderId, userId) => {
  let queryText
  let params

  if (parentFolderId) {
    queryText = 'SELECT * FROM files WHERE parentFolderId = $1 AND ownerId = $2'
    params = [parentFolderId, userId]
  } else {
    queryText = 'SELECT * FROM files WHERE parentFolderId IS NULL AND ownerId = $1'
    params = [userId]
  }

  const result = await pool.query(queryText, params)
  return parseFileRows(result.rows)
}

/**
 * Retrieves all public files (permissions = 1).
 *
 * @returns {Promise<Array<object>>} An array of public file objects.
 */
export const getAllPublicFiles = async () => {
  const result = await pool.query('SELECT * FROM files WHERE permissions = 1')
  return parseFileRows(result.rows)
}

/**
 * Retrieves all public files not owned by a specific user.
 *
 * @param {string} userId - The ID of the user whose files should be excluded.
 * @returns {Promise<Array<object>>} An array of public file objects not owned by the specified user.
 */
export const getAllPublicFilesNotOwned = async (userId) => {
  const result = await pool.query('SELECT * FROM files WHERE permissions = 1 AND ownerId != $1', [
    userId
  ])
  return parseFileRows(result.rows)
}

/**
 * get public file's info which is not owned by user
 * @param {string} userId
 * @param {string} fileId
 * @returns
 */
export const getPublicFilesNotOwnedByFileId = async (userId, fileId) => {
  const result = await pool.query(
    `SELECT * FROM files WHERE id = $1 AND permissions = 1 AND ownerId != $2`,
    [fileId, userId]
  )
  if (result.rows.length > 0) {
    return parseFileRows(result.rows)[0]
  } else {
    return null
  }
}

//- Folder
// Use camel cases
const parseFolderRows = (rows) => {
  for (const element of rows) {
    element.ownerId = element.ownerid
    element.parentFolderId = element.parentfolderid
    delete element.ownerid
    delete element.parentfolderid
  }
  return rows
}
/**
 * Adds a folder to the database.
 *
 * @param {string} name - The name of the folder.
 * @param {string|null} parentFolderId - The ID of the parent folder, or null for root.
 * @param {string} userId - The ID of the user who owns the folder.
 * @param {number} permissions - The permissions for the folder (default 0).
 * @returns {Promise<string>} The UUID of the newly created folder.
 */
export const addFolderToDatabase = async (name, parentFolderId, userId, permissions = 0) => {
  const id = randomUUID().toString()
  await pool.query(
    'INSERT INTO folders (id, name, parentFolderId, ownerId, permissions) VALUES ($1, $2, $3, $4, $5)',
    [id, name, parentFolderId, userId, permissions]
  )
  return id
}

/**
 * Deletes a folder by its ID.
 *
 * @param {string} folderId - The ID of the folder to delete.
 * @returns {Promise<object>}
 */
export const deleteFolder = async (folderId) => {
  return await pool.query('DELETE FROM folders WHERE id = $1', [folderId])
}

/**
 * Retrieves folder information by its ID.
 *
 * @param {string} folderId - The ID of the folder.
 * @returns {Promise<object|undefined>} The folder information if found, or undefined.
 */
export const getFolderInfo = async (folderId) => {
  const result = await pool.query('SELECT * FROM folders WHERE id = $1', [folderId])
  return parseFolderRows(result.rows)[0]
}

/**
 * Retrieves folder information by its ID and owner ID.
 *
 * @param {string} folderId - The ID of the folder.
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<object|undefined>} The folder information if found, or undefined.
 */
export const getFolderInfoOfOwnerId = async (folderId, userId) => {
  const result = await pool.query('SELECT * FROM folders WHERE id = $1 AND ownerId = $2', [
    folderId,
    userId
  ])
  return parseFolderRows(result.rows)[0]
}

/**
 * Retrieves all folders owned by a specific user.
 *
 * @param {string} userId - The ID of the user.
 * @returns {Promise<Array<object>>} An array of folder objects.
 */
export const getAllFoldersByUserId = async (userId) => {
  const result = await pool.query('SELECT * FROM folders WHERE ownerId = $1', [userId])
  return parseFolderRows(result.rows)
}

/**
 * Retrieves all folders within a specific parent folder.
 *
 * @param {string} parentFolderId - The ID of the parent folder.
 * @returns {Promise<Array<object>>} An array of folder objects.
 */
export const getAllFoldersByParentFolderId = async (parentFolderId) => {
  const result = await pool.query('SELECT * FROM folders WHERE parentFolderId = $1', [
    parentFolderId
  ])
  return parseFolderRows(result.rows)
}

/**
 * Retrieves folders by parent folder ID and owner ID, or folders in the root for a given owner.
 *
 * @param {string|null} parentFolderId - The ID of the parent folder, or null for root folders.
 * @param {string} userId - The ID of the owner.
 * @returns {Promise<Array<object>>} An array of folder objects.
 */
export const getAllFoldersByParentFolderIdUserId = async (parentFolderId, userId) => {
  let queryText
  let params

  if (parentFolderId) {
    queryText = 'SELECT * FROM folders WHERE parentFolderId = $1 AND ownerId = $2'
    params = [parentFolderId, userId]
  } else {
    queryText = 'SELECT * FROM folders WHERE parentFolderId IS NULL AND ownerId = $1'
    params = [userId]
  }

  const result = await pool.query(queryText, params)
  return parseFolderRows(result.rows)
}

//- Request
// Use camel cases
const parseRequestResponseRows = async (rows) => {
  for (const element of rows) {
    element.ownerId = element.ownerid
    element.originOwnerId = element.originownerid
    element.parentFolderId = element.parentfolderid
    element.fileDescription = element.filedescription
    element.fileTimestamp = element.filetimestamp
    element.requestId = element.requestid
    element.fileId = element.fileid
    element.requestDescription = element.requestdescription
    element.requestTime = element.requesttime
    element.responseDescription = element.responsedescription
    element.responseTime = element.responsetime
    element.userName = element.username
      ? await decryptWithAES(element.username, key, iv)
      : undefined
    element.userEmail = element.useremail
      ? await decryptWithAES(element.useremail, key, iv)
      : undefined
    delete element.ownerid
    delete element.originownerid
    delete element.parentfolderid
    delete element.filedescription
    delete element.filetimestamp
    delete element.requestid
    delete element.fileid
    delete element.requestdescription
    delete element.requesttime
    delete element.responsedescription
    delete element.responsetime
    delete element.username
    delete element.useremail
  }
  return rows
}
/**
/**
 * Adds a unique request to the database with the given file ID, UUID, owner, and requester.
 *
 * @param {string} fileId - The ID of the file in the database.
 * @param {string} requester - The ID of the requester.
 * @param {string} description - The description of the request.
 * @return {Promise<string | null>} Returns the requestId if the request was added successfully, null otherwise.
 */
export const addUniqueRequest = async (fileId, requester, description) => {
  const existingRequest = await pool.query(
    `SELECT requests.fileId, requests.requester FROM requests LEFT JOIN responses ON responses.requestId = requests.id
         WHERE requests.fileId = $1 AND requests.requester = $2 AND responses.agreed IS NULL`,
    [fileId, requester]
  )

  if (existingRequest.rows.length > 0) {
    return null // Request already exists and not responded
  }

  const requestId = randomUUID().toString()
  await pool.query(
    'INSERT INTO requests (fileId, id, requester, description) VALUES ($1, $2, $3, $4)',
    [fileId, requestId, requester, description]
  )
  return requestId
}

/**
 * Adds a response to a request.
 *
 * @param {string} requestId - The ID of the request being responded to.
 * @param {boolean} agreed - Whether the request was agreed to.
 * @param {string} description - The description of the response.
 * @returns {Promise<{result: object, responseId: string}>} An object containing the query result and the new responseId.
 */
export const addResponse = async (requestId, agreed, description) => {
  const responseId = randomUUID().toString()
  const result = await pool.query(
    'INSERT INTO responses (id, requestId, agreed, description) VALUES ($1, $2, $3, $4)',
    [responseId, requestId, agreed, description || '']
  )
  return { result, responseId }
}

/**
 * Deletes a response by its ID.
 *
 * @param {string} responseId - The ID of the response to delete.
 * @returns {Promise<void>}
 */
export const deleteResponseById = async (responseId) => {
  await pool.query('DELETE from responses where id = $1', [responseId])
}

/**
 * Retrieves all requests and their responses, along with file and owner information, for a given file owner.
 *
 * @param {string} userId - The ID of the file owner.
 * @returns {Promise<Array<object>>} An array of request/response/file/owner objects.
 */
export const getAllRequestsResponsesFilesByOwner = async (userId) => {
  const result = await pool.query(
    `SELECT requests.id as requestId, requests.fileId, requests.requester, requests.description as requestDescription, requests.timestamp as requestTime,
         responses.agreed, responses.description as responseDescription, responses.timestamp as responseTime,
         files.name, files.ownerId, files.originOwnerId, files.permissions, files.parentFolderId, files.size, files.description , files.timestamp, files.spk,
         requesters.pk, requesters.name as userName, requesters.email as userEmail
         FROM requests LEFT JOIN responses ON responses.requestId = requests.id JOIN files ON requests.fileId = files.id
         JOIN users as owners ON files.ownerId = owners.id JOIN users as requesters ON requests.requester = requesters.id WHERE files.ownerId = $1`,
    [userId]
  )
  const parsedRows = await parseRequestResponseRows(result.rows)
  return parsedRows
}

/**
 * Retrieves all requests and their responses made by a specific requester.
 *
 * @param {string} userId - The ID of the requester.
 * @returns {Promise<Array<object>>} An array of request/response objects.
 */
export const getAllRequestsResponsesByRequester = async (userId) => {
  const result = await pool.query(
    `SELECT requests.id as requestId, requests.fileId, requests.requester, requests.description as requestDescription, requests.timestamp as requestTime,
         responses.agreed, responses.description as responseDescription, responses.timestamp as responseTime,
         users.name as userName, users.email as userEmail
         FROM requests LEFT JOIN responses ON responses.requestId = requests.id JOIN users ON requests.requester = users.id WHERE requests.requester = $1`,
    [userId]
  )
  const parsedRows = await parseRequestResponseRows(result.rows)
  return parsedRows
}

/**
 * Retrieves a request that has not been responded to, identified by request ID and file owner.
 *
 * @param {string} requestId - The ID of the request.
 * @param {string} ownerId - The ID of the file owner.
 * @returns {Promise<object|undefined>} The request information if found, or undefined.
 */
export const getRequestNotRespondedByIdOfFileOwner = async (requestId, ownerId) => {
  const result = await pool.query(
    `SELECT requests.fileId, requests.requester FROM requests LEFT JOIN responses ON responses.requestId = requests.id JOIN files ON requests.fileId = files.id
         WHERE requests.id = $1 AND files.ownerId = $2 AND responses.agreed IS NULL`,
    [requestId, ownerId]
  )
  const parsedRows = await parseRequestResponseRows(result.rows)
  return parsedRows[0]
}

/**
 * Retrieves the requester's public key and file ID for a given request ID.
 *
 * @param {string} requestId - The ID of the request.
 * @returns {Promise<{requester: string, pk: string, fileId: string}|undefined>} The public key of the requester and file ID, or undefined.
 */
export const getRequesterPkFileId = async (requestId) => {
  const result = await pool.query(
    `SELECT users.pk, requests.requester, requests.fileId FROM requests
         JOIN users ON requests.requester = users.id
         WHERE requests.id = $1`,
    [requestId]
  )
  const parsedRows = await parseRequestResponseRows(result.rows)
  return parsedRows[0]
}

/**
 * Retrieves request information by its ID.
 *
 * @param {string} requestId - The ID of the request.
 * @returns {Promise<object|undefined>} The information of the request, or undefined.
 */
export const getRequestById = async (requestId) => {
  const result = await pool.query('SELECT * FROM requests WHERE id = $1', [requestId])
  const parsedRows = await parseRequestResponseRows(result.rows)
  return parsedRows[0]
}

/**
 * Deletes a request from the database based on the given UUID.
 *
 * @param {string} uuid - The UUID of the request to be deleted.
 * @return {Promise<boolean>} Returns true if the request was deleted successfully, false otherwise.
 */
export const deleteRequest = async (uuid) => {
  const result = await pool.query('DELETE FROM requests WHERE id = $1', [uuid])
  return result.rowCount > 0
}

/**
 * Deletes a request from the database by its ID and requester ID.
 *
 * @param {string} requestId - The ID of the request.
 * @param {string} requester - The ID of the requester.
 * @returns {Promise<object>}
 */
export const deleteRequestOfRequester = async (requestId, requester) => {
  return await pool.query('DELETE FROM requests WHERE id = $1 AND requester = $2', [
    requestId,
    requester
  ])
}

//-- ABSE related --//
// Insert encrypted index information to database
export const insertCtw = async (fileId, j, ctw) => {
  return await pool.query(`INSERT INTO ctw_table (fileid, j, ctw) VALUES ($1, $2, $3)`, [
    fileId,
    j,
    ctw
  ])
}
// Insert encrypted index information to database
export const insertCt = async (fileId, i, ct) => {
  return await pool.query(`INSERT INTO ct_table (fileid, i, ct) VALUES ($1, $2, $3)`, [
    fileId,
    i,
    ct
  ])
}
// Insert encrypted index information to database
export const insertCtStar = async (fileId, ctstar) => {
  return await pool.query(`INSERT INTO ctstar_table (fileid, ctstar) VALUES ($1, $2)`, [
    fileId,
    ctstar
  ])
}
// Get encrypted index information to database
export const getCtws = async (fileId) => {
  return (await pool.query(`SELECT * FROM ctw_table WHERE fileid = $1 ORDER BY j ASC`, [fileId]))
    .rows
}
// Get encrypted index information to database
export const getCts = async (fileId) => {
  return (await pool.query(`SELECT * FROM ct_table WHERE fileid = $1 ORDER BY i ASC`, [fileId]))
    .rows
}
// Get encrypted index information to database
export const getCtStars = async () => {
  return (await pool.query(`SELECT * FROM ctstar_table`)).rows
}
// Delete encrypted index information to database
export const deleteCtw = async (fileId) => {
  return await pool.query(`DELETE FROM ctw_table WHERE fileid = $1`, [fileId])
}
// Delete encrypted index information to database
export const deleteCt = async (fileId) => {
  return await pool.query(`DELETE FROM ct_table WHERE fileid = $1`, [fileId])
}
// Delete encrypted index information to database
export const deleteCtStar = async (fileId) => {
  return await pool.query(`DELETE FROM ctstar_table WHERE fileid = $1`, [fileId])
}

//-- Tear down --// Moved to ShutdownHandler.js
// process.on('SIGINT', async () => {
//   logger.info('SIGINT signal received: Closing PostgreSQL pool...')
//   await pool.end()
//   logger.info('PostgreSQL pool closed. Exiting process.')
//   process.exit(0)
// })

// process.on('SIGTERM', async () => {
//   logger.info('SIGTERM signal received: Closing PostgreSQL pool...')
//   await pool.end()
//   logger.info('PostgreSQL pool closed. Exiting process.')
//   process.exit(0)
// })

// ──────────────────────────────────────────────────────
// File tags & attrs  (migrated from client-side SQLite)
// ──────────────────────────────────────────────────────
// Table creation is handled by SchemaInitializer.js at startup.

/**
 * Replace all tags for a file.
 * @param {string} fileId
 * @param {string[]} tags
 */
export const setFileTags = async (fileId, tags) => {
  await pool.query('DELETE FROM file_tags WHERE fileid = $1', [fileId])
  for (const tag of tags) {
    await pool.query('INSERT INTO file_tags (fileid, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      fileId,
      tag
    ])
  }
}

/**
 * Fetch tags for multiple file IDs in one query.
 * @param {string[]} fileIds
 * @returns {Promise<Record<string, string[]>>}  map of fileId → tag[]
 */
export const getTagsForFileIds = async (fileIds) => {
  if (!fileIds.length) return {}
  const result = await pool.query(
    'SELECT fileid, tag FROM file_tags WHERE fileid = ANY($1::text[])',
    [fileIds]
  )
  const map = {}
  for (const row of result.rows) {
    if (!map[row.fileid]) map[row.fileid] = []
    map[row.fileid].push(row.tag)
  }
  return map
}

/**
 * Replace all attribute IDs for a file.
 * @param {string} fileId
 * @param {number[]} attrIds
 */
export const setFileAttrs = async (fileId, attrIds) => {
  await pool.query('DELETE FROM file_attrs WHERE fileid = $1', [fileId])
  for (const attrId of attrIds) {
    await pool.query(
      'INSERT INTO file_attrs (fileid, attrid) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [fileId, attrId]
    )
  }
}

/**
 * Fetch attribute IDs for multiple file IDs in one query.
 * @param {string[]} fileIds
 * @returns {Promise<Record<string, number[]>>}  map of fileId → attrId[]
 */
export const getAttrsForFileIds = async (fileIds) => {
  if (!fileIds.length) return {}
  const result = await pool.query(
    'SELECT fileid, attrid FROM file_attrs WHERE fileid = ANY($1::text[])',
    [fileIds]
  )
  const map = {}
  for (const row of result.rows) {
    if (!map[row.fileid]) map[row.fileid] = []
    map[row.fileid].push(row.attrid)
  }
  return map
}

// ──────────────────────────────────────────────────────
// Download logs
// ──────────────────────────────────────────────────────
// Table creation is handled by SchemaInitializer.js at startup.

/**
 * Insert a download log entry.
 * @param {{ id, fileId, downloaderUserId, ownerId, mode, watermarkVisible, watermarkInvisible, watermarkPayloadHash, requestId }} log
 */
export const addDownloadLog = async ({
  id,
  fileId,
  downloaderUserId,
  ownerId,
  mode,
  watermarkVisible = false,
  watermarkInvisible = false,
  watermarkPayloadHash = null,
  requestId = null
}) => {
  await pool.query(
    `INSERT INTO download_logs
      (id, fileid, downloaderuserid, ownerid, mode, watermarkvisible, watermarkinvisible, watermarkpayloadhash, requestid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      fileId,
      downloaderUserId,
      ownerId,
      mode,
      watermarkVisible,
      watermarkInvisible,
      watermarkPayloadHash,
      requestId
    ]
  )
}


//- Roles (admin / user)
/**
 * Updates the role of a user by their ID.
 * @param {string} id - The UUID of the user.
 * @param {string} role - One of userRoleType.
 */
export const updateUserRoleById = async (id, role) => {
  if (!Object.values(userRoleType).includes(role)) {
    throw new Error('Invalid role')
  }
  return await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id])
}

/**
 * Promote every user whose email is listed to admin (idempotent, never demotes).
 * Emails are stored AES-encrypted with a deterministic IV, so candidates are
 * encrypted and compared as ciphertext. The exact string and its lower-cased
 * form are both tried because registration stores the email as typed.
 * @param {string[]} emails
 * @returns {Promise<number>} number of users promoted by this call
 */
export const ensureAdminRoles = async (emails = []) => {
  let promoted = 0
  for (const raw of emails) {
    const trimmed = String(raw).trim()
    if (!trimmed) continue
    const variants = [...new Set([trimmed, trimmed.toLowerCase()])]
    for (const variant of variants) {
      const encryptedEmail = await encryptWithAES(variant, key, iv)
      const res = await pool.query('UPDATE users SET role = $1 WHERE email = $2 AND role <> $1', [
        userRoleType.admin,
        encryptedEmail
      ])
      promoted += res.rowCount
    }
  }
  if (promoted > 0) logger.info(`[Roles] Promoted ${promoted} user(s) to admin from config.`)
  return promoted
}

/**
 * All users with per-user counters, for the admin user list.
 * @returns {Promise<Array<User & { filecount: number, conversationcount: number }>>}
 */
export const getAllUsersWithStats = async () => {
  const res = await pool.query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM files f WHERE f.ownerid = u.id)::int AS filecount,
       (SELECT COUNT(*) FROM agent_conversations c WHERE c.userid = u.id)::int AS conversationcount
     FROM users u
     ORDER BY u.timestamp ASC`
  )
  return await parseUserRows(res.rows)
}

//- Smart-search agent conversation logs
/**
 * Create the conversation on first use, or bump last_at. The UPDATE only
 * applies when the row belongs to the same user, so rowCount === 0 means the
 * id is owned by someone else.
 */
export const upsertAgentConversation = async (id, userId, provider = null) => {
  return await pool.query(
    `INSERT INTO agent_conversations (id, userid, provider) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET last_at = NOW(),
           provider = COALESCE(excluded.provider, agent_conversations.provider)
       WHERE agent_conversations.userid = excluded.userid`,
    [id, userId, provider]
  )
}

export const addAgentMessage = async (conversationId, role, content, matchedFileIds = []) => {
  return await pool.query(
    `INSERT INTO agent_messages (id, conversationid, role, content, matched_file_ids)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID().toString(), conversationId, role, content, matchedFileIds]
  )
}

/**
 * Conversations of one user, newest first, each with its ordered messages.
 */
export const getAgentHistoryByUserId = async (userId, limit = 20) => {
  const res = await pool.query(
    `SELECT c.id, c.provider, c.started_at AS "startedAt", c.last_at AS "lastAt",
       COALESCE((
         SELECT json_agg(json_build_object(
                  'id', m.id, 'role', m.role, 'content', m.content,
                  'matchedFileIds', m.matched_file_ids, 'timestamp', m.timestamp)
                ORDER BY m.seq ASC)
         FROM agent_messages m WHERE m.conversationid = c.id
       ), '[]'::json) AS messages
     FROM agent_conversations c
     WHERE c.userid = $1
     ORDER BY c.last_at DESC
     LIMIT $2`,
    [userId, limit]
  )
  return res.rows
}

/**
 * Every smart-search message of one user as a single chronological list,
 * flattened across conversations — the shape the admin JSON export uses.
 * `seq` is a global BIGSERIAL, so ordering by it gives true insertion order
 * even when turns from different sessions interleave. When `limit` clips the
 * result it keeps the newest messages, then returns them oldest-first.
 * @param {string} userId
 * @param {number} limit
 */
export const getAgentMessagesByUserId = async (userId, limit = 1000) => {
  const res = await pool.query(
    `SELECT t.id, t.role, t.content, t."matchedFileIds", t.timestamp,
            t."conversationId", t.provider
     FROM (
       SELECT m.seq, m.id, m.role, m.content,
              m.matched_file_ids AS "matchedFileIds", m.timestamp,
              m.conversationid AS "conversationId", c.provider
       FROM agent_messages m
       JOIN agent_conversations c ON c.id = m.conversationid
       WHERE c.userid = $1
       ORDER BY m.seq DESC
       LIMIT $2
     ) t
     ORDER BY t.seq ASC`,
    [userId, limit]
  )
  return res.rows
}

//- Download audit trail
/**
 * Download logs where the given user was the downloader, newest first.
 * File name comes from a LEFT JOIN so deleted files still show their id.
 */
export const getDownloadLogsByUserId = async (userId, limit = 200) => {
  const res = await pool.query(
    `SELECT d.id, d.fileid AS "fileId", f.name AS "fileName", d.ownerid AS "ownerId",
       d.mode, d.watermarkvisible AS "watermarkVisible",
       d.watermarkinvisible AS "watermarkInvisible", d.timestamp
     FROM download_logs d
     LEFT JOIN files f ON f.id = d.fileid
     WHERE d.downloaderuserid = $1
     ORDER BY d.timestamp DESC
     LIMIT $2`,
    [userId, limit]
  )
  return res.rows
}

// logger.info('Database pool initialized')
console.debug('StorageDatabase.js loaded.')
