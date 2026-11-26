/**
 * Where multer stores the body of POST /upload and POST /uploadDb:
 * <uploads>/<user id>/<stored name>.
 *
 * multer writes the file before the route's handler runs, so the stored name is decided here
 * and by the server alone. Each route has its own uploader and tells it the name through
 * `storedName`: the file id that passed `checkUpload` for /upload, the fixed name database.db
 * for /uploadDb. The name is never read from the request line or from a header here, and a
 * name that is not a plain file name is refused before anything is written.
 *
 * Kept free of side-effect imports so it can be tested on its own.
 */
import { mkdir } from 'node:fs/promises'
import path from 'path'
import multer from 'multer'
import { resolveFilePath, resolveUserDir } from './UploadPath.js'

// Fix original name encoding problem
const checkFileType = (req, file, cb) => {
  file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')

  cb(null, true)
}

/**
 * @param {{
 *   uploadDir: string,
 *   storedName: (req: object) => string,
 *   logError?: (req: object, error: Error) => void
 * }} options
 * @returns {import('multer').Multer} expects req.userId from the auth middleware
 */
export function createUploader({ uploadDir, storedName, logError = () => {} }) {
  // prepare user directory and stored filename
  const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        // Store the uploaded file the user's upload directory
        const folderPath = resolveUserDir(uploadDir, req.userId)
        await mkdir(folderPath, { recursive: true })
        cb(null, folderPath)
      } catch (error) {
        logError(req, error)
        cb(error)
      }
    },
    filename: (req, file, cb) => {
      try {
        // Throws unless the name is a single file name inside the user's folder
        const storedPath = resolveFilePath(uploadDir, req.userId, storedName(req))
        cb(null, path.basename(storedPath))
      } catch (error) {
        cb(error)
      }
    }
  })
  return multer({
    storage: storage,
    fileFilter: checkFileType,
    limits: { fileSize: 8000000 }
  })
}
