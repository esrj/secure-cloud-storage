/**
 * This file handles actual upload and download for SFTP protocol
 */
import ConfigManager from './ConfigManager.js'
import { logger, logSftpError, logSftpInfo, logSftpWarning } from './Logger.js'
import fs from 'node:fs'
import pkg from 'ssh2'
import { FileIdSchema } from './Validation.js'
import { finishUpload, hasUpload } from './UploadVerifier.js'
import { getFilePath } from './Utils.js'
import { getLoggedInUserIdOfSocket } from './UserLoginInfo.js'
const { Server, utils } = pkg

// Create a new SFTP server
new Server({ hostKeys: [fs.readFileSync(ConfigManager.sshKeyPath)] }, (client, info) => {
  const ip = info.ip
  logger.info('Sftp Client connected.')
  let userId
  let fileId
  client
    .on('authentication', (ctx) => {
      // Client authenticates with socketId as username and fileId as password
      if (ctx.method !== 'password') return ctx.reject()
      let actionStr = 'Client tries to authenticate'
      fileId = ctx.password
      logSftpInfo(ip, userId, fileId, actionStr + '.', { socketId: ctx.username })

      const result = FileIdSchema.safeParse(ctx.password)
      if (!result.success) {
        logSftpWarning(ip, userId, fileId, actionStr + ' with invalid fileId.')
        return ctx.reject()
      }
      fileId = result.data

      userId = getLoggedInUserIdOfSocket(ctx.username)
      if (!userId) {
        logSftpWarning(ip, userId, fileId, actionStr + ' but is not logged in.')
        return ctx.reject()
      }
      // check login and fileId
      ctx.accept()
    })
    .on('ready', () => {
      logger.debug('Sftp client ready.')

      client.on('session', (accept, reject) => {
        const session = accept()
        session.on('sftp', (accept, reject) => {
          const sftp = accept()
          const openFiles = new Map()
          let isWrite = false
          let openedFileName
          sftp
            .on('OPEN', (reqId, filename, flags, attrs) => {
              // Opens the file to write/read
              logger.debug('Sftp client OPEN.')
              isWrite = flags & utils.sftp.OPEN_MODE.WRITE
              if (isWrite) logSftpInfo(ip, userId, fileId, 'Client tries to write file.')
              else if (flags & utils.sftp.OPEN_MODE.READ)
                logSftpInfo(ip, userId, fileId, 'Client tries to read file.')
              else {
                logSftpWarning(
                  ip,
                  userId,
                  fileId,
                  'Client tries to do unsupported file operation.',
                  { flags: utils.sftp.flagsToString(flags) }
                )
                return sftp.status(reqId, utils.sftp.STATUS_CODE.OP_UNSUPPORTED)
              }

              // Check if have asked to upload
              if (isWrite && !hasUpload(fileId)) {
                logSftpWarning(
                  ip,
                  userId,
                  fileId,
                  'Client tries to upload file but upload info does not exist.'
                )
              }
              openedFileName = filename
              // Actually open the file and store the file descriptor 
              fs.open(getFilePath(userId, fileId), utils.sftp.flagsToString(flags), (err, fd) => {
                if (err) {
                  logSftpError(ip, userId, fileId, err)
                  return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
                }
                const handle = Buffer.alloc(4)
                openFiles.set(fd, true)
                handle.writeUInt32BE(fd, 0)
                sftp.handle(reqId, handle)
              })
            })
            .on('WRITE', (reqId, handle, offset, data) => {
              // Writing file content to the opened file.
              logger.debug('Sftp client WRITE.')
              let fnum = handle.readUInt32BE(0)
              if (handle.length !== 4 || !openFiles.has(fnum)) {
                logSftpWarning(ip, userId, fileId, 'Client tried to write to non-opened file.')
                return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
              }
              fs.write(fnum, data, 0, data.length, offset, (err) => {
                if (err) {
                  logSftpError(ip, userId, fileId, err)
                  return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
                }
                sftp.status(reqId, utils.sftp.STATUS_CODE.OK)
              })
            })
            .on('READ', (reqId, handle, offset, len) => {
              // Reading file content from the opened file
              logger.debug('Sftp client READ.')
              let fnum = handle.readUInt32BE(0)
              if (handle.length !== 4 || !openFiles.has(fnum)) {
                logSftpWarning(ip, userId, fileId, 'Client tried to read non-opened file.')
                return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
              }
              fs.read(fnum, Buffer.alloc(len), 0, len, offset, (err, bytesRead, buffer) => {
                if (err) {
                  logSftpError(ip, userId, fileId, err)
                  return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
                }
                if (bytesRead > 0) {
                  sftp.data(reqId, buffer.subarray(0, bytesRead))
                } else {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.EOF)
                }
              })
            })
            .on('CLOSE', (reqId, handle) => {
              // Closing the opened file
              logger.debug('Sftp client CLOSE.')
              let fnum = handle.readUInt32BE(0)
              if (handle.length !== 4 || !openFiles.has(fnum)) {
                logSftpWarning(ip, userId, fileId, 'Client tried to close non-opened file.')
                return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
              }
              openFiles.delete(fnum)
              fs.close(fnum, (err) => {
                if (err) {
                  logSftpError(ip, userId, fileId, err)
                  return sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE)
                }
                sftp.status(reqId, utils.sftp.STATUS_CODE.OK)
                if (isWrite) {
                  // Finish upload if is write
                  const fileSize = fs.statSync(getFilePath(userId, fileId)).size
                  finishUpload({
                    name: openedFileName,
                    id: fileId,
                    userId: userId,
                    originOwnerId: userId,
                    size: fileSize
                  })
                }
              })
            })
        })
      })
    })
    .on('close', () => {
      logSftpInfo(ip, userId, fileId, 'Client disconnected from sftp server.')
    })
    .on('error', (err) => {
      logSftpError(ip, userId, fileId, err)
    })
}).listen(ConfigManager.sftpPort, ConfigManager.serverHost, function () {
  logger.info(`SFTP server listening on port ${this.address().port}`)
})
console.debug('SftpServer.js loaded.')
