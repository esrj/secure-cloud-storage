/**
 * This file handles actual upload and download for using FTPS protocol.
 */
import { socket } from './MessageManager'
import { logger } from './Logger'
import { Client } from 'basic-ftp'
import { basename } from 'node:path'
import GlobalValueManager from './GlobalValueManager'
import FileUploadCoordinator from './FileUploadCoordinator'
import { createPipeProgress } from './util/PipeProgress'
import { statSync } from 'node:fs'

/**
 * Uploads a file to an FTPS server.
 * @param {string} tempEncryptedFilePath - The stream of the file to be uploaded.
 * @param {string} originalFileName - The path of the file to be uploaded (related to fileStream).
 * @param {string} uploadId
 * @param {FileUploadCoordinator} fileUploadCoordinator
 */
const uploadFileProcessFtps = async (
  tempEncryptedFilePath,
  originalFileName,
  uploadId,
  fileUploadCoordinator
) => {
  const client = new Client()
  client.ftp.verbose = true
  try {
    let response = await client.access({
      host: GlobalValueManager.serverConfig.host,
      port: GlobalValueManager.serverConfig.port.ftps,
      user: socket.id,
      password: uploadId,
      secure: true,
      // TODO: remove insecure option in production
      // secureOptions: { rejectUnauthorized: process.env.NODE_ENV !== 'production' ? false : true }
      secureOptions: { rejectUnauthorized: false }
    })
    logger.info(`ftp upload access response: ${response.message}`)
    // const pipeProgress = createPipeProgress({ total: statSync(filePath).size }, logger)

    response = await client.uploadFrom(tempEncryptedFilePath, originalFileName)
    // console.log(`upload end: ${Date.now()}`)
    logger.info(`ftp upload response: ${response.message}`)
    logger.info(`upload with ftps succeeded`)
    fileUploadCoordinator.finishUpload(uploadId, tempEncryptedFilePath)
  } finally {
    // Error will be caught by upper layer
    client.close()
  }
}

/**
 * Downloads a file from the FTPS server.
 *
 * @param {string} uuid - The unique identifier of the file.
 * @param {WritableStream} writeStream - The stream to write the downloaded file to.
 * @param {string} filePath - The path to save the downloaded file (related to writeStream).
 * @return {Promise<void>} A promise that resolves when the download is complete.
 */
const downloadFileProcessFtps = async (uuid, writeStream, filePath) => {
  const client = new Client()
  try {
    let response = await client.access({
      host: GlobalValueManager.serverConfig.host,
      port: GlobalValueManager.serverConfig.port.ftps,
      user: socket.id,
      secure: true,
      // TODO: remove insecure option in production
      // secureOptions: { rejectUnauthorized: process.env.NODE_ENV !== 'production' ? false : true }
      secureOptions: { rejectUnauthorized: false }
    })
    logger.info(`ftp download access response: ${response.message}`)
    response = await client.downloadTo(writeStream, uuid) // TODO: make sure the directory is created
    logger.info(`ftp download response: ${response.message}`)
    logger.info(`download with ftps succeeded.`)
  } finally {
    // Error will be caught by upper layer
    client.close()
  }
}

export { uploadFileProcessFtps, downloadFileProcessFtps }
