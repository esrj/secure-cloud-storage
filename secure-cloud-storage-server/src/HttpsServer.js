/**
 * This file handles actual upload and download for HTTPS protocol.
 */
import { logger, logHttpsError, logHttpsInfo, logHttpsWarning } from './Logger.js'
import { mkdir } from 'node:fs/promises'
import multer from 'multer'
import { getFileInfo, getUserByKey } from './StorageDatabase.js'
import ConfigManager from './ConfigManager.js'
import { finishUpload, hasUpload } from './UploadVerifier.js'
import { app } from './SocketIO.js'
import { FileIdSchema, PublicKeySchema, SocketIDSchema } from './Validation.js'
import { getLoggedInUserIdOfSocket } from './UserLoginInfo.js'
import { getUserDir, riskyMimeTypes } from './Utils.js'
import { createDownloadHandler, createUploadHandler } from './FileTransferRoute.js'
import { createDownloadDbHandler, createUploadDbHandler } from './DatabaseBackupRoute.js'

// The middleware in this file decides who is asking (auth) and which file is meant
// (checkUpload, checkDownload) and leaves both ids on the request. The handlers that touch the
// stored files are in FileTransferRoute.js and DatabaseBackupRoute.js.

// prepare user directory and stored filename
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Store the uploaded file the user's upload directory
      const folderPath = getUserDir(req.userId)
      await mkdir(folderPath, { recursive: true })
      cb(null, folderPath)
    } catch (error) {
      logHttpsError(req, error)
      cb(error)
    }
  },
  filename: (req, file, cb) => {
    if (req.path === '/uploadDb') cb(null, 'database.db')
    else cb(null, req.headers.fileid)
  },
  limits: {
    fileSize: 8000000
  }
})
// Fix original name encoding problem
const checkFileType = (req, file, cb) => {
  file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')

  cb(null, true)
}
const upload = multer({
  storage: storage,
  fileFilter: checkFileType,
  limits: { fileSize: 8000000 }
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
  upload.single('file'),
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
  upload.single('file'),
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
