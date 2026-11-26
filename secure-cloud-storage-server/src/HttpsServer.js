/**
 * This file handles actual upload and download for HTTPS protocol.
 */
import { logger, logHttpsError, logHttpsInfo, logHttpsWarning } from './Logger.js'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'path'
import multer from 'multer'
import { getFileInfo, getUserByKey } from './StorageDatabase.js'
import ConfigManager from './ConfigManager.js'
import { finishUpload, hasUpload } from './UploadVerifier.js'
import { app } from './SocketIO.js'
import { FileIdSchema, PublicKeySchema, SocketIDSchema } from './Validation.js'
import { getLoggedInUserIdOfSocket } from './UserLoginInfo.js'
import { fileTypeFromFile } from 'file-type'
import { getFilePath, getUserDir, riskyMimeTypes } from './Utils.js'
import { assertPlainNames } from './UploadPath.js'
import { createDownloadDbHandler } from './DatabaseBackupRoute.js'

// Where a route below builds the path of a stored file from ids on the request, it calls
// path.basename() on each id on that line, after assertPlainNames() has refused an id that
// this would change. UploadPath.js explains why it is written out in the route.

// prepare user directory and stored filename
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Store the uploaded file the user's upload directory
      assertPlainNames(req.userId)
      const folderPath = getUserDir(path.basename(req.userId))
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
 * Check if we can let the client upload file.
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
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * The path for upload
 */
app.post('/upload', auth, checkUpload, upload.single('file'), async (req, res, next) => {
  try {
    if (req.file) {
      logHttpsInfo(req, 'Client uploaded file.', { filename: req.file.originalname })

      await finishUpload({
        name: req.file.originalname,
        id: req.file.filename,
        userId: req.userId,
        originOwnerId: req.userId,
        size: req.file.size
      })
      res.send('File uploaded successfully.')
    } else {
      res.status(400).send('No file uploaded.')
    }
  } catch (error) {
    try {
      // Same file as req.file.path, located by the server's own ids
      assertPlainNames(req.userId, req.file.filename)
      const storedPath = getFilePath(path.basename(req.userId), path.basename(req.file.filename))
      await unlink(storedPath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logHttpsError(req, error)
      }
    }
    next(error)
  }
})

/**
 * The path for download
 */
app.get('/download', auth, async (req, res, next) => {
  try {
    const actionStr = 'Client asks to download file'
    logHttpsInfo(req, actionStr + '.')

    const result = FileIdSchema.safeParse(req.headers.fileid)
    if (!result.success) {
      logHttpsWarning(req, actionStr + ' but fileId is invalid.', { issues: result.issues })
      res.status(400).send('FileId is invalid.')
      return
    }

    const fileId = req.headers.fileid
    const fileInfo = await getFileInfo(fileId)

    if (!fileInfo) {
      logHttpsWarning(req, actionStr + ' which does not exist.')
      res.status(404).send('File not found')
    } else if (fileInfo.ownerId !== req.userId) {
      logHttpsWarning(req, actionStr + ' which is not owned by the client.')
      res.status(403).send('File not owned.')
    } else {
      logHttpsInfo(req, 'Client downloading file.')
      assertPlainNames(req.userId, fileInfo.id)
      const filePath = getFilePath(path.basename(req.userId), path.basename(fileInfo.id))
      res.download(filePath, fileInfo.name)
    }
  } catch (error) {
    next(error)
  }
})

/**
 * The path for upload encrypted database
 */
app.post('/uploadDb', auth, upload.single('file'), async (req, res, next) => {
  try {
    if (req.file) {
      // check mime type
      assertPlainNames(req.userId)
      const filePath = getFilePath(path.basename(req.userId), 'database.db')
      const fileMime = await fileTypeFromFile(filePath)
      if (fileMime && riskyMimeTypes.includes(fileMime.mime)) {
        logHttpsWarning('Client upload a file with risky mime type for encrypted database', fileMime)
        await unlink(filePath)
        res.status(415).send('Risky mime type')
        return
      }
      
      logHttpsInfo(req, 'Client uploaded encrypted database.', { filename: req.file.originalname })
      res.send('File uploaded successfully.')
    } else {
      res.status(400).send('No file uploaded.')
    }
  } catch (error) {
    next(error)
  }
})

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
