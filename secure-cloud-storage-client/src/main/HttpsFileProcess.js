/**
 * This file handles actual file upload and download using HTTPS protocol
 */
import { socket } from './MessageManager'
// import { statSync } from 'node:fs'
import { logger } from './Logger'
import { net } from 'electron'
import FormData from 'form-data'
import { basename } from 'node:path'
import GlobalValueManager from './GlobalValueManager'
import { createReadStream, ReadStream } from 'node:fs'
import FileUploadCoordinator from './FileUploadCoordinator'
// import { createPipeProgress } from './util/PipeProgress'

/**
 * Actually upload the file with HTTPS.
 * @param {ReadStream} fileStream
 * @param {string} filePath
 * @param {string} fileId
 * @param {FileUploadCoordinator} fileUploadCoordinator
 * @returns
 */
const uploadFileProcessHttps = async (
  tempEncryptedFilePath,
  originalFileName,
  fileId,
  fileUploadCoordinator
) => {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(tempEncryptedFilePath)
    // const PipeProgress = createPipeProgress({ total: statSync(tempEncryptedFilePath).size }, logger)
    // readStream.pipe(PipeProgress)
    const form = new FormData()
    // form.append('socketId', socket.id)
    form.append('file', readStream, basename(originalFileName))
    const request = net.request({
      method: 'POST',
      url: `${GlobalValueManager.httpsUrl}/upload`,
      headers: { ...form.getHeaders(), socketid: socket.id, fileid: fileId } // TODO: maybe change to other one-time token (remember is case insensitive)
    })
    request.chunkedEncoding = true

    // const PipeProgress = createPipeProgress({ total: statSync(filePath).size }, logger)
    // form.pipe(PipeProgress)
    // PipeProgress.pipe(request)

    form.pipe(request)

    request.on('response', (response) => {
      logger.info(`STATUS: ${response.statusCode}`)
      // logger.info(`HEADERS: ${JSON.stringify(response.headers)}`)
      // console.log(`upload end: ${Date.now()}`)
      response.on('data', (chunk) => {
        logger.debug(`BODY: ${chunk}`)
      })

      response.on('end', () => {
        // logger.info('No more data in response.')
        if (response.statusCode === 200) {
          fileUploadCoordinator.finishUpload(fileId, tempEncryptedFilePath)
          resolve()
        } else {
          reject(
            new Error(
              `Https received status code ${response.statusCode} and status message ${response.statusMessage}.`
            )
          )
        }
      })
    })

    request.on('error', (error) => {
      reject(error)
    })
    form.on('error', (error) => {
      reject(error)
    })
  })
}

/**
 * Actually download the file with HTTPS.
 * @param {*} fileId
 * @param {*} writeStream
 * @param {*} filePath
 * @returns
 */
const downloadFileProcessHttps = (fileId, writeStream, filePath) => {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: `${GlobalValueManager.httpsUrl}/download`,
      headers: { socketid: socket.id, fileid: fileId } // TODO: maybe change to other one-time token (remember is case insensitive)
    })
    request.end()

    request.on('response', (response) => {
      logger.info(`STATUS: ${response.statusCode}`)
      // logger.info(`HEADERS: ${JSON.stringify(response.headers)}`)

      response.on('data', (chunk) => {
        if (response.statusCode === 200) {
          writeStream.write(chunk)
        } else {
          logger.info(`BODY: ${chunk}`)
        }
      })

      response.on('end', () => {
        logger.info('No more data in response.')
        writeStream.end()
        if (response.statusCode === 200) {
          resolve()
        } else {
          reject(
            new Error(
              `Https received status code ${response.statusCode} and status message ${response.statusMessage}.`
            )
          )
        }
      })
    })

    request.on('error', (error) => {
      logger.error(`ERROR: ${error.message}`)
      reject(error)
    })
  })
}

export { uploadFileProcessHttps, downloadFileProcessHttps }
