/**
 * This file handles communications with client related to requests.
 * Including requesting file, responding to request, deleting request, getting request lists.
 */
import {
  calculateFileHash,
  checkLoggedIn,
  FileNotFoundErrorMsg,
  InternalServerErrorMsg,
  InvalidArgumentErrorMsg,
  NotLoggedInErrorMsg
} from './Utils.js'
import {
  getFileInfo,
  addFileToDatabase,
  addUniqueRequest,
  getAllRequestsResponsesByRequester,
  getAllRequestsResponsesFilesByOwner,
  deleteRequestOfRequester,
  getRequestNotRespondedByIdOfFileOwner,
  addResponse,
  getUserById,
  deleteFile,
  deleteResponseById,
  updateFileBlockNumber
} from './StorageDatabase.js'
import CryptoHandler from './CryptoHandler.js'
import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  logInvalidSchemaWarning,
  logSocketError,
  logSocketInfo,
  logSocketWarning
} from './Logger.js'
import ConfigManager from './ConfigManager.js'
import {
  DeleteRequestRequestSchema,
  ReqeustFileRequestSchema,
  RespondRequestRequestSchema
} from './Validation.js'
import BlockchainManager from './BlockchainManager.js'
import { emitToOnlineUser } from './UserLoginInfo.js'

// Reqeust related events
const requestBinder = (socket) => {
  /**
   * Client asks to request file
   */
  socket.on('request-file', async (request, cb) => {
    let requestId
    try {
      const actionStr = 'Client asks to request file'
      logSocketInfo(socket, actionStr + '.', request)

      const result = ReqeustFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId, description } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const fileInfo = await getFileInfo(fileId)
      if (!fileInfo) {
        logSocketWarning(socket, actionStr + ' which does not exist.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }
      if (fileInfo.ownerId === socket.userId) {
        logSocketWarning(socket, actionStr + ' which is owned by the client.', request)
        cb({ errorMsg: 'File is owned.' })
        return
      }
      if (fileInfo.permissions === 0) {
        logSocketWarning(socket, actionStr + ' which is not public.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }
      requestId = await addUniqueRequest(fileId, socket.userId, description)
      if (!requestId) {
        logSocketWarning(socket, actionStr + ' which is already requested.', request)
        cb({ errorMsg: 'File already requested.' })
        return
      }
      // Add record to blockchain
      const requestorInfo = await getUserById(socket.userId)
      const authorizerInfo = await getUserById(fileInfo.ownerId)
      await BlockchainManager.addAuthRecord(
        fileId,
        requestorInfo.address,
        authorizerInfo.address,
        'not-replied'
      )
      logSocketInfo(socket, 'Request added to database.', request)
      cb({})

      // Forward request to file owner
      emitToOnlineUser(fileInfo.ownerId, 'new-request')
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
      // Revert request
      if (requestId) await deleteRequestOfRequester(requestId, socket.userId)
    }
  })

  /**
   * Client asks to delete request
   */
  socket.on('delete-request', async (request, cb) => {
    try {
      const actionStr = 'Client asks to delete request'
      logSocketInfo(socket, actionStr + '.', request)

      const result = DeleteRequestRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { requestId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      if ((await deleteRequestOfRequester(requestId, socket.userId)).rowCount <= 0) {
        logSocketWarning(socket, actionStr + ' which does not exist.', request)
        cb({ errorMsg: 'Request not found.' })
        return
      }
      logSocketInfo(socket, 'Request deleted.', request)
      cb({})
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Client responds to request
   */
  socket.on('respond-request', async (request, cb) => {
    let responseId
    try {
      const actionStr = 'Client asks to respond to request'
      logSocketInfo(socket, actionStr + '.', request)

      const result = RespondRequestRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }

      const { requestId, agreed, description, rekey } = request

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const requestInfo = await getRequestNotRespondedByIdOfFileOwner(requestId, socket.userId)
      if (requestInfo === undefined) {
        logSocketWarning(socket, actionStr + ' which does not exist or already responded.', request)
        cb({ errorMsg: 'Request not exist or already responded.' })
        return
      }
      ;({ responseId } = await addResponse(requestId, agreed ? 1 : 0, description))

      const authorizerInfo = await getUserById(socket.userId)
      const requestorInfo = await getUserById(requestInfo.requester)
      const fileInfo = await getFileInfo(requestInfo.fileId)
      if (agreed) {
        const newFileId = await reencryptFile(
          rekey,
          fileInfo,
          requestInfo,
          authorizerInfo,
          requestorInfo
        )
        logSocketInfo(socket, 'File reencrypted.', { newFileId })
      } else {
        await BlockchainManager.addAuthRecord(
          fileInfo.id,
          requestorInfo.address,
          authorizerInfo.address,
          'rejected'
        )
      }
      logSocketInfo(socket, 'Request responded.', request)
      cb({})
      // Forward response to requesting client
      emitToOnlineUser(requestInfo.requester, 'new-response')
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
      // Revert response
      if (responseId) await deleteResponseById(responseId)
    }
  })

  /**
   * Client asks to get request list (client is requester)
   */
  socket.on('get-request-list', async (cb) => {
    try {
      const actionStr = 'Client asks to get request list requested by this client'
      logSocketInfo(socket, actionStr + '.')

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const requests = await getAllRequestsResponsesByRequester(socket.userId)
      // console.log({ files, folders })
      logSocketInfo(socket, 'Responding request list to client.')
      cb({ requests: JSON.stringify(requests) })
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Client asks to get requested list (client is file owner)
   */
  socket.on('get-requested-list', async (cb) => {
    try {
      const actionStr = 'Client asks to get request list requested by other clients'
      logSocketInfo(socket, actionStr + '.')

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const requests = await getAllRequestsResponsesFilesByOwner(socket.userId)
      for (const request of requests) {
        if (request.agreed != null) {
          delete request.pk
        }
      }
      // console.log({ files, folders })
      logSocketInfo(socket, 'Responding requested list to client.')
      cb({ requests: JSON.stringify(requests) })
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

/**
 * Actually reencrypt the file
 * @param {*} rekey
 * @param {*} fileInfo
 * @param {*} requestInfo
 * @param {*} authorizerInfo
 * @param {*} requestorInfo
 * @returns
 */
const reencryptFile = async (rekey, fileInfo, requestInfo, authorizerInfo, requestorInfo) => {
  // Reencrypt file
  let newUUID
  let hasAddToDatabase = false
  let copiedFilePath
  let hasCopiedFile = false
  try {
    const { recipher: newcipher, spk: newspk } = await CryptoHandler.reencrypt(
      rekey,
      fileInfo.cipher,
      fileInfo.spk,
      requestorInfo.pk
    )
    newUUID = randomUUID()
    await addFileToDatabase({
      name: fileInfo.name,
      id: newUUID,
      userId: requestInfo.requester,
      originOwnerId: fileInfo.ownerId,
      cipher: newcipher,
      spk: newspk,
      parentFolderId: null, // null for root
      size: fileInfo.size,
      description: fileInfo.description,
      infoBlockNumber: 0,
      verifyBlockNumber: 0
    })
    hasAddToDatabase = true
    // Copy the file from original owner to requester, as we only reencrypts its AES key
    copiedFilePath = join(ConfigManager.uploadDir, requestInfo.requester, newUUID)
    await copyFile(join(ConfigManager.uploadDir, fileInfo.ownerId, fileInfo.id), copiedFilePath)
    hasCopiedFile = true

    // Add new file information to blockchain
    const fileHash = await calculateFileHash(copiedFilePath)
    const receipt = await BlockchainManager.reencryptFile(
      newUUID,
      fileHash,
      JSON.stringify({ filename: fileInfo.name }),
      requestorInfo.address,
      authorizerInfo.address
    )
    const blockNumber = (await receipt.getBlock()).number
    await updateFileBlockNumber({
      fileId: newUUID,
      infoBlockNumber: blockNumber,
      verifyBlockNumber: blockNumber
    })
    return newUUID
  } catch (error) {
    // Revert reencrypt
    if (hasAddToDatabase && newUUID) await deleteFile(newUUID)
    if (hasCopiedFile && copiedFilePath) await unlink(copiedFilePath)
    throw error
  }
}

export { requestBinder }
console.debug('RequestManager.js loaded.')
