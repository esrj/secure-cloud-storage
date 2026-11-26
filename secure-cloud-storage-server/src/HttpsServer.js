/**
 * This file handles actual upload and download for HTTPS protocol.
 */
import { logger, logHttpsError, logHttpsInfo, logHttpsWarning } from './Logger.js'
import { getFileInfo, getUserByKey } from './StorageDatabase.js'
import ConfigManager from './ConfigManager.js'
import { finishUpload, hasUpload } from './UploadVerifier.js'
import { app } from './SocketIO.js'
import { FileIdSchema, PublicKeySchema, SocketIDSchema } from './Validation.js'
import { getLoggedInUserIdOfSocket } from './UserLoginInfo.js'
import { riskyMimeTypes } from './Utils.js'
import { createDownloadHandler, createUploadHandler } from './FileTransferRoute.js'
import { createDownloadDbHandler, createUploadDbHandler } from './DatabaseBackupRoute.js'
import { createUploader } from './UploadStorage.js'

// The middleware in this file decides who is asking (auth) and which file is meant
// (checkUpload, checkDownload) and leaves both ids on the request. The handlers that touch the
// stored files are in FileTransferRoute.js and DatabaseBackupRoute.js; UploadStorage.js is where
// multer puts an uploaded body.

// One uploader per route. The stored name is given here by the server: the checked file id for
// /upload, the fixed name database.db for /uploadDb. See UploadStorage.js.
const uploadFileBody = createUploader({
  uploadDir: ConfigManager.uploadDir,
  storedName: (req) => req.fileId,
  logError: logHttpsError
})
const uploadBackupBody = createUploader({
  uploadDir: ConfigManager.uploadDir,
  storedName: () => 'database.db',
  logError: logHttpsError
})

/**
 * Check authentication of the user based on the provided socket ID.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @param {Function} next - The next middleware function.
 * @return {void} This function does not return a value.
 */
const auth = (req, res, next) => {
  try {
    const result = SocketIDSchema.safeParse(req.headers.socketid)
    if (!result.success) {
      logHttpsWarning(req, 'SocketId not found or invalid', { issues: result.issues })
      res.status(400).send('SocketId not found or invalid')
      return
    }

    const userId = getLoggedInUserIdOfSocket(req.headers.socketid)
    // logger.debug(`User with socket id ${req.headers.socketid} is authenticating`)
    if (!userId) {
      logHttpsWarning(req, 'Client is not logged in.')
      res.sendStatus(401)
      return
    }

    logHttpsInfo(req, 'Client is logged in.')
    req.userId = userId
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Check if we can let the client upload file. Sets req.fileId when it can.
 * @param {*} req
 * @param {*} res
 * @param {*} next
 * @returns
 */
const checkUpload = async (req, res, next) => {
  try {
    const actionStr = 'Client asks to upload file'
    logHttpsInfo(req, actionStr + '.')

    const result = FileIdSchema.safeParse(req.headers.fileid)
    if (!result.success) {
      logHttpsWarning(req, actionStr + ' but fileId is invalid.', { issues: result.issues })
      res.status(400).send('FileId is invalid.')
      return
    }
    if (!hasUpload(req.headers.fileid)) {
      logHttpsWarning(req, actionStr + ' but upload info does not exist.')
      res.status(400).send('Upload info not found.')
      return
    }
    req.fileId = req.headers.fileid
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Check the file id of a download request. Sets req.fileId when it is a valid id.
 * @param {*} req
 * @param {*} res
 * @param {*} next
 * @returns
 */
const checkDownload = (req, res, next) => {
  try {
    const actionStr = 'Client asks to download file'
    logHttpsInfo(req, actionStr + '.')

    const result = FileIdSchema.safeParse(req.headers.fileid)
    if (!result.success) {
      logHttpsWarning(req, actionStr + ' but fileId is invalid.', { issues: result.issues })
      res.status(400).send('FileId is invalid.')
      return
    }
    req.fileId = req.headers.fileid
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * The path for upload
 */
app.post(
  '/upload',
  auth,
  checkUpload,
  uploadFileBody.single('file'),
  createUploadHandler({
    uploadDir: ConfigManager.uploadDir,
    finishUpload,
    logInfo: logHttpsInfo,
    logError: logHttpsError
  })
)

/**
 * The path for download
 */
app.get(
  '/download',
  auth,
  checkDownload,
  createDownloadHandler({
    uploadDir: ConfigManager.uploadDir,
    getFileInfo,
    logInfo: logHttpsInfo,
    logWarning: logHttpsWarning
  })
)

/**
 * The path for upload encrypted database
 */
app.post(
  '/uploadDb',
  auth,
  uploadBackupBody.single('file'),
  createUploadDbHandler({
    uploadDir: ConfigManager.uploadDir,
    riskyMimeTypes,
    logInfo: logHttpsInfo,
    logWarning: logHttpsWarning
  })
)

/**
 * The path for download encrypted database
 */
app.get(
  '/downloadDb',
  auth,
  createDownloadDbHandler({ uploadDir: ConfigManager.uploadDir, logInfo: logHttpsInfo })
)

/**
 * The path for getting userId. Used by trusted authority.
 */
app.get('/userId', async (req, res, next) => {
  try {
    // logHttpsInfo(req, 'UserId of pk is asked.')
    const result = PublicKeySchema.safeParse(req.query.pk)
    if (!result.success) {
      logHttpsWarning(req, 'UserId of pk is asked but pk is invalid.', { issues: result.issues })
      res.status(400).json({ errorMsg: 'pk is invalid.' })
      return
    }
    const pk = result.data
    const userInfo = await getUserByKey(pk)
    if (!userInfo) {
      logHttpsWarning(req, 'UserId of pk is asked but user does not exist.', {
        issues: result.issues
      })
      res.status(404).json({ errorMsg: 'User does not exist.' })
      return
    }
    res.json({ userId: userInfo.id })
  } catch (error) {
    next(error)
  }
})

// Error handler
app.use((err, req, res, next) => {
  logHttpsError(req, err)
  res.sendStatus(500)
})

logger.info(`Https POST GET path set.`)
console.debug('HttpsServer.js loaded.')
