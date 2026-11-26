/**
 * This file handles upload verification from blockchain.
 */
import { randomUUID } from 'node:crypto'
import EvictingMap from './EvictingMap.js'
import { logger } from './Logger.js'
import { addFileToDatabase, deleteFileOfOwnerId } from './StorageDatabase.js'
import {
  calculateFileHash,
  getFilePath,
  InternalServerErrorMsg,
  bigIntToUuid,
  BigIntToHex,
  riskyMimeTypes
} from './Utils.js'
import BlockchainManager from './BlockchainManager.js'
import { unlink } from 'node:fs/promises'
import ConfigManager from './ConfigManager.js'
import { emitToOnlineUser } from './UserLoginInfo.js'
import { fileTypeFromFile } from 'file-type'

// Map for storing upload info
const uploadInfoMap = new EvictingMap(ConfigManager.settings.uploadExpireTimeMin * 60 * 1000)

/**
 * Store upload related info before actually upload and generate the fileId.
 * @param {string} cipher 
 * @param {string} spk 
 * @param {string} parentFolderId 
 * @returns {string} fileId
 */
export const preUpload = (cipher, spk, parentFolderId) => {
  let fileId = randomUUID()
  while (uploadInfoMap.has(fileId)) {
    fileId = randomUUID()
  }
  uploadInfoMap.set(fileId, { id: fileId, cipher, spk, parentFolderId })
  return fileId
}

/**
 * Store file info in map after upload, and wait for blockchain info
 * @param {{
 * name,
 * id,
 * userId,
 * originOwnerId,
 * size
 * }} uploadInfo
 */
export const finishUpload = async (uploadInfo) => {
  try {
    const userId = uploadInfo.userId
    const fileId = uploadInfo.id
    // Check mime type
    const fileMime = await fileTypeFromFile(getFilePath(userId, fileId))
    if (fileMime && riskyMimeTypes.includes(fileMime.mime)) {
      logger.warn('Client upload file with risky mime type.', { userId, ...fileMime })
      uploadInfoMap.delete(fileId)
      await revertUpload(userId, fileId, 'Upload file is of risky mime type.')
      return
    }
    if (!ConfigManager.blockchain.enabled) {
      // Ignore blockchain and directly accept upload

      uploadInfo = { ...uploadInfo, ...uploadInfoMap.get(uploadInfo.id) }
      uploadInfo.infoBlockNumber = 0
      uploadInfo.verifyBlockNumber = 0
      uploadInfoMap.delete(fileId)
      await addFileToDatabase(uploadInfo)
      emitToOnlineUser(userId, 'upload-file-res', { fileId })
      logger.info('File uploaded.', { fileId, userId })
      return
    }

    const hash = await calculateFileHash(getFilePath(uploadInfo.userId, uploadInfo.id))
    uploadInfoMap.set(uploadInfo.id, {
      uploadInfo: { ...uploadInfo, ...uploadInfoMap.get(uploadInfo.id) },
      hash
    })
    logger.info(`upload info map set.`, { fileId: uploadInfo.id, hash })
  } catch (error) {
    logger.error(error)
    uploadInfoMap.set(uploadInfo.id, { uploadInfo, hash: null })
  }
}

/**
 * Check if certain fileId is in uploadInfoMap
 * @param {string} fileId 
 * @returns 
 */
export const hasUpload = (fileId) => {
  return uploadInfoMap.has(fileId)
}

// revert upload if blockhain information did not come in time
uploadInfoMap.onExpired((key, value) => {
  revertUpload(value.uploadInfo?.userId, key, 'Did not get blockchain info in time.')
})

/**
 * Blockchain fired an upload event which is initiated by client.
 */
BlockchainManager.bindEventListener(
  'FileUploaded',
  /**
   * Check if the information on blockchain is same as what recieved.
   * @param {*} fileId
   * @param {*} uploader
   * @param {*} fileHash
   * @param {*} metadata
   * @param {*} timestamp
   * @param {*} event
   */
  async (fileId, uploader, fileHash, metadata, timestamp, event) => {
    try {
      fileId = bigIntToUuid(fileId)
      logger.debug('Contract event FileUploaded emitted', {
        fileId,
        uploader,
        fileHash,
        metadata,
        timestamp
      })
      // TODO: maybe need to check uploader
      if (uploadInfoMap.has(fileId)) {
        let userId
        let uploadInfoDeleted = false
        try {
          // compare hash. If same, send success message to client. If not, remove file and send fail message to client.
          const value = uploadInfoMap.get(fileId)
          userId = value.uploadInfo.userId
          uploadInfoMap.delete(fileId)
          uploadInfoDeleted = true
          if (BigInt(value.hash) == BigInt(fileHash)) {
            const receipt = await BlockchainManager.setFileVerification(fileId, uploader, 'success')
            value.uploadInfo.infoBlockNumber = event.log.blockNumber
            value.uploadInfo.verifyBlockNumber = (await receipt.getBlock()).number
            await addFileToDatabase(value.uploadInfo)
            emitToOnlineUser(userId, 'upload-file-res', { fileId })
            logger.info('File uploaded and verified.', { fileId, userId })
          } else {
            logger.warn('File hashes do not meet', {
              fileHash: value.hash,
              blockchainHash: BigIntToHex(fileHash, 64), // sha256 have length 64
              fileId,
              userId
            })
            await BlockchainManager.setFileVerification(fileId, uploader, 'fail')
            revertUpload(userId, fileId, 'File hashes do not meet.')
          }
        } catch (error) {
          if (uploadInfoDeleted) revertUpload(userId, fileId, InternalServerErrorMsg)
          throw error
        }
      } else {
        // logger.warn(`Blockchain upload event did not find matching upload info.`, {
        //   fileId
        // })
      }
    } catch (error) {
      logger.error(error, { fileId, uploader: BigIntToHex(uploader, 40) }) // ethernet address have length 40
    }
  }
)

/**
 * Revert the upload and notify user
 * @param {string} userId 
 * @param {string} fileId 
 * @param {string} errorMsg 
 */
const revertUpload = async (userId, fileId, errorMsg) => {
  try {
    logger.info(`reverting upload.`, { userId, fileId, errorMsg })
    // remove file from database
    await deleteFileOfOwnerId(fileId, userId)
    // remove file from disc
    const filePath = getFilePath(userId, fileId)
    await unlink(filePath)
    // send message to client if online
    emitToOnlineUser(userId, 'upload-file-res', { fileId, errorMsg })
  } catch (error) {
    if (error.code != 'ENOENT') {
      logger.error(error)
    }
  }
}
console.debug('UploadVerifier.js loaded.')
