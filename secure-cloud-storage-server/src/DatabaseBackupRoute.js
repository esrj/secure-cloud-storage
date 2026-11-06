/**
 * GET /downloadDb: the logged-in user's encrypted client database backup.
 * Kept free of side-effect imports so it can be tested on its own.
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const NoDatabaseBackupMsg = 'No database backup.'

/**
 * @param {{ uploadDir: string, logInfo?: (req: object, message: string) => void }} options
 * @returns {(req, res, next) => Promise<void>} expects req.userId from the auth middleware
 */
export function createDownloadDbHandler({ uploadDir, logInfo = () => {} }) {
  return async (req, res, next) => {
    try {
      const actionStr = 'Client asks to download encrypted database'
      logInfo(req, actionStr + '.')

      const dbPath = resolve(uploadDir, req.userId, 'database.db')
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
}
