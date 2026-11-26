/**
 * POST /upload and GET /download: one stored file over HTTPS.
 *
 * Each handler is made by a function that is given what the handler works with (the upload
 * directory, the upload bookkeeping, the database lookup, the log functions), the same way as
 * in DatabaseBackupRoute.js. Kept free of side-effect imports so the handlers can be tested on
 * their own.
 *
 * The middleware in HttpsServer.js runs before them: `auth` sets req.userId, `checkUpload` and
 * `checkDownload` set req.fileId once the id sent by the client has passed its checks.
 */
import { unlink } from 'node:fs/promises'
import { resolveFilePath } from './UploadPath.js'

/**
 * POST /upload, after multer has stored the file under the user's folder as req.fileId.
 * @param {{
 *   uploadDir: string,
 *   finishUpload: (uploadInfo: { name, id, userId, originOwnerId, size }) => Promise<void>,
 *   logInfo?: (req: object, message: string, meta?: object) => void,
 *   logError?: (req: object, error: Error) => void
 * }} options
 * @returns {(req, res, next) => Promise<void>}
 */
export function createUploadHandler({
  uploadDir,
  finishUpload,
  logInfo = () => {},
  logError = () => {}
}) {
  const uploadFile = async (req, res, next) => {
    try {
      if (req.file) {
        logInfo(req, 'Client uploaded file.', { filename: req.file.originalname })

        await finishUpload({
          name: req.file.originalname,
          id: req.fileId,
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
        // The file multer has just stored, located by the server's own ids
        const storedPath = resolveFilePath(uploadDir, req.userId, req.fileId)
        await unlink(storedPath)
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logError(req, error)
        }
      }
      next(error)
    }
  }
  return uploadFile
}

/**
 * GET /download: sends the file req.fileId if it belongs to the logged-in user.
 * @param {{
 *   uploadDir: string,
 *   getFileInfo: (fileId: string) => Promise<{ id: string, name: string, ownerId: string } | undefined>,
 *   logInfo?: (req: object, message: string) => void,
 *   logWarning?: (req: object, message: string) => void
 * }} options
 * @returns {(req, res, next) => Promise<void>}
 */
export function createDownloadHandler({
  uploadDir,
  getFileInfo,
  logInfo = () => {},
  logWarning = () => {}
}) {
  const downloadFile = async (req, res, next) => {
    try {
      const actionStr = 'Client asks to download file'
      const fileInfo = await getFileInfo(req.fileId)

      if (!fileInfo) {
        logWarning(req, actionStr + ' which does not exist.')
        res.status(404).send('File not found')
      } else if (fileInfo.ownerId !== req.userId) {
        logWarning(req, actionStr + ' which is not owned by the client.')
        res.status(403).send('File not owned.')
      } else {
        logInfo(req, 'Client downloading file.')
        const filePath = resolveFilePath(uploadDir, req.userId, fileInfo.id)
        res.download(filePath, fileInfo.name)
      }
    } catch (error) {
      next(error)
    }
  }
  return downloadFile
}
