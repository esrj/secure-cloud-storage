/**
 * POST /uploadDb and GET /downloadDb: the logged-in user's encrypted client database backup,
 * kept as database.db in the user's folder.
 * Kept free of side-effect imports so it can be tested on its own.
 */
import { stat, unlink } from 'node:fs/promises'
import { fileTypeFromFile } from 'file-type'
import { resolveFilePath } from './UploadPath.js'

export const NoDatabaseBackupMsg = 'No database backup.'

/**
 * POST /uploadDb, after multer has stored the backup.
 * @param {{
 *   uploadDir: string,
 *   riskyMimeTypes: string[],
 *   logInfo?: (req: object, message: string, meta?: object) => void,
 *   logWarning?: (...args: any[]) => void
 * }} options
 * @returns {(req, res, next) => Promise<void>} expects req.userId from the auth middleware
 */
export function createUploadDbHandler({
  uploadDir,
  riskyMimeTypes,
  logInfo = () => {},
  logWarning = () => {}
}) {
  const uploadDatabase = async (req, res, next) => {
    try {
      if (req.file) {
        // check mime type
        const filePath = resolveFilePath(uploadDir, req.userId, 'database.db')
        const fileMime = await fileTypeFromFile(filePath)
        if (fileMime && riskyMimeTypes.includes(fileMime.mime)) {
          // Called without req, as this line always has been: the entry carries the detected
          // type and no client details.
          logWarning('Client upload a file with risky mime type for encrypted database', fileMime)
          await unlink(filePath)
          res.status(415).send('Risky mime type')
          return
        }

        logInfo(req, 'Client uploaded encrypted database.', { filename: req.file.originalname })
        res.send('File uploaded successfully.')
      } else {
        res.status(400).send('No file uploaded.')
      }
    } catch (error) {
      next(error)
    }
  }
  return uploadDatabase
}

/**
 * @param {{ uploadDir: string, logInfo?: (req: object, message: string) => void }} options
 * @returns {(req, res, next) => Promise<void>} expects req.userId from the auth middleware
 */
export function createDownloadDbHandler({ uploadDir, logInfo = () => {} }) {
  const downloadDatabase = async (req, res, next) => {
    try {
      const actionStr = 'Client asks to download encrypted database'
      logInfo(req, actionStr + '.')

      const dbPath = resolveFilePath(uploadDir, req.userId, 'database.db')
      let exists = false
      try {
        exists = (await stat(dbPath)).isFile()
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (!exists) {
        // A new account has no backup until its client uploads one when it quits.
        logInfo(req, actionStr + ' but there is no backup yet.')
        res.status(404).json({ errorMsg: NoDatabaseBackupMsg })
        return
      }
      res.download(dbPath)
    } catch (error) {
      next(error)
    }
  }
  return downloadDatabase
}
