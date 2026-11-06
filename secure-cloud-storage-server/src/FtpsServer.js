/**
 * This file handles actual upload and download with FTPS protocol
 */
import { FtpSrv, FileSystem } from 'ftp-srv'
import { readFileSync } from 'node:fs'
import { stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import ConfigManager from './ConfigManager.js'
import { logFtpsError, logFtpsInfo, logFtpsWarning, logger } from './Logger.js'
import { emitToSocket } from './SocketIO.js'
import { finishUpload, hasUpload } from './UploadVerifier.js'
import { InternalServerErrorMsg, NotLoggedInErrorMsg } from './Utils.js'
import { getLoggedInUserIdOfSocket } from './UserLoginInfo.js'

/**
 * Custom filesystem to write to file as name <fileid>
 */
class CustomFileSystem extends FileSystem {
  constructor(connection, { root, cwd }, fileId) {
    super(connection, { root, cwd })
    this.fileId = fileId
  }
  // write to file as name <fileId>, and record the original name.
  write(fileName, { append, start }) {
    this.connection.originalFileName = fileName
    return super.write(this.fileId, { append, start })
  }
}

// Create new FTPS server
const ftpServer = new FtpSrv({
  url: `ftp://${ConfigManager.serverHost}:${ConfigManager.ftps.controlPort}`,
  pasv_url: `ftp://${ConfigManager.ftps.pasv_url}`,
  pasv_min: ConfigManager.ftps.dataPort,
  pasv_max: ConfigManager.ftps.dataPort,
  blacklist: ['MKD', 'DELE', 'RNFR', 'RNTO', 'RMD'],
  tls: {
    key: readFileSync(ConfigManager.serverKeyPath),
    cert: readFileSync(ConfigManager.serverCertPath),
    minVersion: 'TLSv1.2'
  }
})

ftpServer.on('client-error', ({ connection, context, error }) => {
  logFtpsError({ connection }, error)
})

ftpServer.on('server-error', ({ error }) => {
  logFtpsError({ connection: {} }, error)
})

/**
 * Let client login with its socketId and fileId if wanting to upload.
 */
ftpServer.on('login', async (data, resolve, reject) => {
  try {
    const { connection, username: socketId, password: fileId } = data // use password as file id
    let actionStr = 'Client tries to authenticate'
    logFtpsInfo(data, actionStr + '.', { socketId })

    const userId = getLoggedInUserIdOfSocket(socketId)
    if (!userId) {
      logFtpsWarning(data, actionStr + ' but is not logged in.')
      reject(new Error(NotLoggedInErrorMsg))
      return
    }
    data.userId = userId
    logFtpsInfo(data, 'Client is logged in.')

    const rootPath = path.resolve(ConfigManager.uploadDir, userId.userId)
    await mkdir(rootPath, { recursive: true })

    if (fileId !== 'guest') {
      // meaning this is upload
      actionStr = 'Client tries to upload file'
      logFtpsInfo(data, actionStr + '.')

      if (!hasUpload(fileId)) {
        logFtpsWarning(data, actionStr + ' but upload info does not exist.')
        reject(new Error('Upload info not found.'))
        return
      }
    }
    connectionBinder(data, socketId)
    resolve({
      root: rootPath,
      fs: new CustomFileSystem(connection, { root: rootPath, cwd: '/' }, fileId)
    })
  } catch (error) {
    logFtpsError(data, error)
    reject(new Error(InternalServerErrorMsg))
  }
})

const connectionBinder = (data, socketId) => {
  // Download file
  data.connection.on('RETR', (error, filePath) => {
    if (error) {
      logFtpsError(data, error, { fileId: path.basename(filePath) })
      return
    }
    logFtpsInfo(data, 'Client downloaded file.', { fileId: path.basename(filePath) })
  })

  // Upload file
  data.connection.on('STOR', async (error, fileName) => {
    try {
      if (error) {
        logFtpsError(data, error)
        return
      }

      const fileSize = (await stat(fileName)).size
      await finishUpload({
        name: data.connection.originalFileName,
        id: path.basename(fileName),
        userId: data.userId,
        originOwnerId: data.userId,
        size: fileSize
      })
      logFtpsInfo(data, 'Client uploaded file.', {
        fileName: data.connection.originalFileName,
        userId: data.userId
      })
    } catch (error) {
      logFtpsError(data, error)
      emitToSocket(socketId, 'upload-file-res', { errorMsg: InternalServerErrorMsg })
    }
  })
}

logger.info('FTP server initialized.')
export default ftpServer
console.debug('FtpsServer.js loaded.')
