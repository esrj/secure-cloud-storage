// /**
//  * This file handles actual file upload and download using SFTP protocol.
//  */
// import ssh2 from 'ssh2'
// import { logger } from './Logger'
// import GlobalValueManager from './GlobalValueManager'
// import { socket } from './MessageManager'
// const { Client } = ssh2

// /**
//  * Uploads a file to an SFTP server.
//  * @param {string} tempEncryptedFilePath - The stream of the file to be uploaded.
//  * @param {string} originalFileName - The path of the file to be uploaded (related to fileStream).
//  * @param {string} fileId
//  * @param {FileUploadCoordinator} fileUploadCoordinator
//  */
// export const uploadFileProcessSftp = async (
//   tempEncryptedFilePath,
//   originalFileName,
//   fileId,
//   fileUploadCoordinator
// ) => {
//   return new Promise((resolve, reject) => {
//     const conn = new Client()
//     conn
//       .on('ready', () => {
//         logger.info('Sftp client ready.')
//         conn.sftp((err, sftp) => {
//           if (err) {
//             return reject(err)
//           }
//           sftp.fastPut(tempEncryptedFilePath, originalFileName, (err) => {
//             if (err) {
//               return reject(err)
//             }
//             logger.info('Upload with sftp succeeded.')
//             conn.end()
//             // Call upload coordinator
//             fileUploadCoordinator.finishUpload(fileId, tempEncryptedFilePath)
//             resolve()
//           })
//         })
//       })
//       .on('error', (err) => {
//         reject(err)
//       })
//       .connect({
//         host: GlobalValueManager.serverConfig.host,
//         port: GlobalValueManager.serverConfig.port.sftp,
//         username: socket.id,
//         password: fileId
//       })
//   })
// }

// /**
//  * Downloads a file from the SFTP server.
//  *
//  * @param {string} fileId - The unique identifier of the file.
//  * @param {WritableStream} writeStream - The stream to write the downloaded file to.
//  * @param {string} filePath - The path to save the downloaded file (related to writeStream).
//  * @return {Promise<void>} A promise that resolves when the download is complete.
//  */
// export const downloadFileProcessSftp = async (fileId, writeStream, filePath) => {
//   return new Promise((resolve, reject) => {
//     const conn = new Client()
//     conn
//       .on('ready', () => {
//         logger.info('Sftp client ready.')
//         conn.sftp((err, sftp) => {
//           if (err) {
//             return reject(err)
//           }
//           const readStream = sftp.createReadStream(fileId)
//           readStream.on('error', (err) => {
//             reject(err)
//           })
//           readStream.on('close', () => {
//             logger.info('Download with sftp succeeded.')
//             conn.end()
//             resolve()
//           })
//           readStream.pipe(writeStream)
//         })
//       })
//       .on('error', (err) => {
//         reject(err)
//       })
//       .connect({
//         host: GlobalValueManager.serverConfig.host,
//         port: GlobalValueManager.serverConfig.port.sftp,
//         username: socket.id,
//         password: fileId
//       })
//   })
// }
import ssh2 from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'
import { socket } from './MessageManager'
const { Client } = ssh2

export const uploadFileProcessSftp = async (
  tempEncryptedFilePath,
  originalFileName,
  fileId,
  fileUploadCoordinator
) => {
  logger.info(`SFTP connect host=${GlobalValueManager.serverConfig.host} port=${GlobalValueManager.serverConfig.port.sftp} socket.id=${socket.id} fileId=${fileId}`);
  return new Promise((resolve, reject) => {
    const conn = new Client()

    const host = GlobalValueManager.serverConfig.host
    const port = GlobalValueManager.serverConfig.port.sftp
    const socketId = socket?.id; // 先抓一次，避免中途變動你還拿到 undefined
    if (!socketId) return reject(new Error("socket.id is empty (socket not connected?)"));


    // ✅ 只用 basename，避免遠端 path 處理/realpath/cwd 問題
    const remoteName = path.basename(originalFileName)

    conn
      .on('ready', () => {
        logger.info('Sftp client ready.')
        conn.sftp((err, sftp) => {
          if (err) return reject(err)

          const rs = fs.createReadStream(tempEncryptedFilePath)

          // ✅ 這個通常只會觸發 OPEN / WRITE / CLOSE
          const ws = sftp.createWriteStream(remoteName, { flags: 'w' })

          rs.on('error', (e) => { try { conn.end() } catch {} ; reject(e) })
          ws.on('error', (e) => { try { conn.end() } catch {} ; reject(e) })

          ws.on('close', () => {
            logger.info('Upload with sftp succeeded.')
            conn.end()
            fileUploadCoordinator.finishUpload(fileId, tempEncryptedFilePath)
            resolve()
          })

          rs.pipe(ws)
        })
      })
      .on('error', (err) => {
        reject(err)
      })
      .connect({
        host: GlobalValueManager.serverConfig.host,
        port: GlobalValueManager.serverConfig.port.sftp, // 確認是 7001
        username: socket.id,
        password: fileId,

        // 不要用本機 agent/key
        agent: undefined,
        tryKeyboard: false,
        authHandler: (methodsLeft, partialSuccess, cb) => cb('password'),

        readyTimeout: 15000,
      });
  })
}
export const downloadFileProcessSftp = async (fileId, writeStream, filePath) => {
  return new Promise((resolve, reject) => {
    const conn = new Client()

    const host = GlobalValueManager.serverConfig.host
    const port = GlobalValueManager.serverConfig.port.sftp
    const socketId = socket?.id; // 先抓一次，避免中途變動你還拿到 undefined
    if (!socketId) return reject(new Error("socket.id is empty (socket not connected?)"));



    conn
      .on('ready', () => {
        logger.info('Sftp client ready.')
        conn.sftp((err, sftp) => {
          if (err) return reject(err)

          // ✅ 固定一個 remoteName，避免 createReadStream 走 realpath/stat
          const remoteName = 'download'

          const rs = sftp.createReadStream(remoteName)
          rs.on('error', (e) => { try { conn.end() } catch {} ; reject(e) })
          writeStream.on('error', (e) => { try { conn.end() } catch {} ; reject(e) })

          rs.on('close', () => {
            logger.info('Download with sftp succeeded.')
            conn.end()
            resolve()
          })

          rs.pipe(writeStream)
        })
      })
      .on('error', (err) => reject(err))
      .connect({
        host: GlobalValueManager.serverConfig.host,
        port: GlobalValueManager.serverConfig.port.sftp, // 確認是 7001
        username: socket.id,
        password: fileId,

        // 不要用本機 agent/key
        agent: undefined,
        tryKeyboard: false,
        authHandler: (methodsLeft, partialSuccess, cb) => cb('password'),

        readyTimeout: 15000,
      });
  })
}