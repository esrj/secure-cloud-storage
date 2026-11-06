/**
 * This file handles communications with client related to files.
 * Including upload request, download request, description and index update, deleting file, adding and deleting folder.
 */
import {
  logger,
  logInvalidSchemaWarning,
  logSocketError,
  logSocketInfo,
  logSocketWarning
} from './Logger.js'
import {
  getFileInfo,
  deleteFile,
  addFolderToDatabase,
  deleteFolder,
  getAllFilesByParentFolderIdUserId,
  getAllFoldersByParentFolderIdUserId,
  moveFileToFolder,
  getAllFoldersByUserId,
  getFileInfoOfOwnerId,
  updateFileDescPermInDatabase,
  getPublicFilesNotOwnedByFileId,
  addDownloadLog,
  setFileTags,
  setFileAttrs,
  getTagsForFileIds,
  getAttrsForFileIds,
  getAllUsers,
  getUserById,
  getFilesOfOwnerId,
  getAllPublicFilesNotOwned
} from './StorageDatabase.js'
import {
  encodeTrackedUid,
  decodeTrackedUid,
  isFullTrackedUid,
  findUserIdsByShortPrefix
} from './WatermarkTracker.js'
import { unlink } from 'node:fs/promises'
import {
  checkFolderExistsForUser,
  checkAdmin,
  checkLoggedIn,
  FileNotFoundErrorMsg,
  NotAdminErrorMsg,
  getFilePath,
  InternalServerErrorMsg,
  InvalidArgumentErrorMsg,
  NotLoggedInErrorMsg
} from './Utils.js'
import ConfigManager from './ConfigManager.js'
import { randomUUID } from 'node:crypto'
import crypto from 'node:crypto'
import {
  AddFolderRequestSchema,
  DeleteFileRequestSchema,
  DeleteFolderRequestSchema,
  DownloadFileRequestSchema,
  DownloadWithWatermarkRequestSchema,
  ConfirmWatermarkDownloadRequestSchema,
  GetFileListRequestSchema,
  MoveFileRequestSchema,
  SearchFileRequestSchema,
  UpdateFileRequestSchema,
  UploadFileRequestSchema
} from './Validation.js'
import { preUpload } from './UploadVerifier.js'
import ABSEManeger from './ABSEManager.js'

// Download file related events
const downloadFileBinder = (socket) => {
  /**
   * Client ask to download certain file. Will return file info.
   */
  socket.on('download-file-pre', async (request, cb) => {
    try {
      const actionStr = 'Client asks to download file'
      logSocketInfo(socket, actionStr + '.', request)

      const result = DownloadFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const fileInfo = await getFileInfo(fileId)
      if (!fileInfo) {
        logSocketWarning(socket, actionStr + ' which does not exist.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }

      if (fileInfo.ownerId !== socket.userId) {
        logSocketWarning(socket, actionStr + ' which is not owned by the client.', request)
        cb({ errorMsg: 'File not owned.' })
        return
      }

      logSocketInfo(socket, 'Responding file info to client.', request)
      cb({ fileInfo })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  socket.on('download-file-hash-error', (request) => {
    logSocketWarning(socket, 'Client reports download file hash error.', request)
  })
}

// Upload file related events
const uploadFileBinder = (socket) => {
  /**
   * Client aks to upload file, will return generated fileId
   */
  socket.on('upload-file-pre', async (request, cb) => {
    try {
      const actionStr = 'Client asks to upload file'
      // cipher and spk do not need to be logged
      logSocketInfo(socket, actionStr + '.', { parentFolderId: request.parentFolderId })

      const result = UploadFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { cipher, spk, parentFolderId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      if (!(await checkFolderExistsForUser(parentFolderId, socket.userId))) {
        logSocketWarning(socket, actionStr + ' to a non-existing folder.', request)
        cb({ errorMsg: 'Parent folder not found.' })
        return
      }
      // Create random id as fileId
      const fileId = preUpload(cipher, spk, parentFolderId)
      logSocketInfo(socket, 'Pre-upload information stored in upload database.', {
        parentFolderId: request.parentFolderId,
        fileId
      })
      cb({ fileId })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

// Delete file event
const deleteFileBinder = (socket) => {
  /**
   * Client ask to delete file
   */
  socket.on('delete-file', async (request, cb) => {
    try {
      const actionStr = 'Client asks to delete file'
      logSocketInfo(socket, actionStr + '.', request)

      const result = DeleteFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const fileInfo = await getFileInfo(fileId)
      if (!fileInfo) {
        logSocketWarning(socket, actionStr + ' which does not exist.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }

      if (fileInfo.ownerId !== socket.userId) {
        logSocketWarning(socket, actionStr + ' which is not owned by the client.', request)
        cb({ errorMsg: 'File not owned.' })
        return
      }
      try {
        await deleteFile(fileId)
        await unlink(getFilePath(socket.userId, fileId))
      } catch (error) {
        if (error.code != 'ENOENT') throw error
      }
      logSocketInfo(socket, 'File deleted.', request)
      cb({})
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

// Get file list event
const getFileListBinder = (socket) => {
  socket.on('get-file-list', async (request, cb) => {
    try {
      const actionStr = 'Client asks to get file list'
      logSocketInfo(socket, actionStr + '.', request)

      const result = GetFileListRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { parentFolderId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const files = await getAllFilesByParentFolderIdUserId(parentFolderId, socket.userId)
      const folders = await getAllFoldersByParentFolderIdUserId(parentFolderId, socket.userId)

      // Attach tags and attrIds from PostgreSQL (batch query, no N+1)
      const fileIds = files.map((f) => f.id)
      const tagsMap = await getTagsForFileIds(fileIds)
      const attrsMap = await getAttrsForFileIds(fileIds)
      files.forEach((f) => {
        f.tags = tagsMap[f.id] ?? []
        f.attrIds = attrsMap[f.id] ?? []
      })

      logSocketInfo(socket, 'Responding file list to client.', request)
      cb({ files: JSON.stringify(files), folders: JSON.stringify(folders) })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Smart-search scope: every file the caller owns (all folders) plus every
   * public file owned by someone else. Metadata only — same row shape as
   * `get-file-list`, plus `ownerName` (names are encrypted at rest, so only the
   * server can attach them) and the caller's folder list for path display.
   * Crypto material of files the caller does not own is stripped.
   */
  socket.on('get-agent-file-scope', async (request, cb) => {
    try {
      const actionStr = 'Client asks for smart-search file scope'
      logSocketInfo(socket, actionStr + '.')

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const [own, publicOthers, folders, users] = await Promise.all([
        getFilesOfOwnerId(socket.userId),
        getAllPublicFilesNotOwned(socket.userId),
        getAllFoldersByUserId(socket.userId),
        getAllUsers()
      ])
      const files = [...own, ...publicOthers]
      const fileIds = files.map((f) => f.id)
      const tagsMap = fileIds.length ? await getTagsForFileIds(fileIds) : {}
      const attrsMap = fileIds.length ? await getAttrsForFileIds(fileIds) : {}
      const nameById = new Map(users.map((u) => [u.id, u.name]))
      files.forEach((f) => {
        f.tags = tagsMap[f.id] ?? []
        f.attrIds = attrsMap[f.id] ?? []
        f.ownerName = nameById.get(f.ownerId) ?? ''
        if (f.ownerId !== socket.userId) {
          delete f.cipher
          delete f.spk
        }
      })

      logSocketInfo(socket, 'Responding smart-search file scope to client.', {
        own: own.length,
        publicOthers: publicOthers.length
      })
      cb({ files: JSON.stringify(files), folders: JSON.stringify(folders) })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

// Folder related events
const folderBinder = (socket) => {
  /**
   * Client ask to add folder
   */
  socket.on('add-folder', async (request, cb) => {
    try {
      const actionStr = 'Client asks to add folder'
      logSocketInfo(socket, actionStr + '.', request)

      const result = AddFolderRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { parentFolderId, folderName } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      await addFolderToDatabase(folderName, parentFolderId, socket.userId)
      logSocketInfo(socket, 'Folder added to database.', request)
      cb({})
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Client ask to delete folder
   */
  socket.on('delete-folder', async (request, cb) => {
    try {
      const actionStr = 'Client asks to delete folder'
      logSocketInfo(socket, actionStr + '.', request)

      const result = DeleteFolderRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { folderId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const files = await getAllFilesByParentFolderIdUserId(folderId, socket.userId)
      const folders = await getAllFoldersByParentFolderIdUserId(folderId, socket.userId)
      if (files.length > 0 || folders.length > 0) {
        logSocketWarning(socket, actionStr + ' which is not empty.', request)
        cb({ errorMsg: 'Folder not empty.' })
        return
      }
      if ((await deleteFolder(folderId)).rowCount <= 0) {
        logSocketWarning(socket, actionStr + ' which does not exist.', request)
        cb({ errorMsg: 'Folder not found.' })
        return
      }
      logSocketInfo(socket, 'Folder deleted.', request)
      cb({})
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  // Get all folder
  socket.on('get-all-folders', async (cb) => {
    try {
      const actionStr = 'Client asks to get all folders'
      logSocketInfo(socket, actionStr + '.')

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const folders = await getAllFoldersByUserId(socket.userId)
      logSocketInfo(socket, 'Responding all folders to client.')
      cb({ folders: JSON.stringify(folders) })
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

const moveFileBinder = (socket) => {
  /**
   * Client asks to move file to other folders
   */
  socket.on('move-file', async (request, cb) => {
    try {
      const actionStr = 'Client asks to move file to target folder'
      logSocketInfo(socket, actionStr + '.', request)

      const result = MoveFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId, targetFolderId } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      if (!(await checkFolderExistsForUser(targetFolderId, socket.userId))) {
        logSocketWarning(socket, actionStr + ' but target folder does not exist.', request)
        cb({ errorMsg: 'Target folder not found.' })
        return
      }
      if ((await moveFileToFolder(fileId, targetFolderId).rowCount) === 0) {
        logSocketWarning(socket, actionStr + ' but file does not exist.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }
      logSocketInfo(socket, 'File moved to target folder.', request)
      cb({})
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

// const getPublicFilesBinder = (socket) => {
//   /**
//    * Client asks to search files
//    */
//   socket.on('search-files', async (request, cb) => {
//     try {
//       const actionStr = 'Client asks to search for files'
//       logSocketInfo(socket, actionStr + '.', { tags: request.tags })

//       const result = SearchFileRequestSchema.safeParse(request)
//       if (!result.success) {
//         logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
//         cb({ errorMsg: InvalidArgumentErrorMsg })
//         return
//       }
//       const { TK, tags } = result.data

//       if (!checkLoggedIn(socket)) {
//         logSocketWarning(socket, actionStr + ' but is not logged in.')
//         cb({ errorMsg: NotLoggedInErrorMsg })
//         return
//       }
//       // Check if tags match TK
//       if (!(await ABSEManeger.checkTKTags(TK, tags))) {
//         logSocketWarning(socket, actionStr + ' but submitted tags do not match trapdoor.')
//         cb({ errorMsg: 'Trapdoor do not match tags.' })
//         return
//       }

//       // Search for matching files
//       const searchGen = ABSEManeger.Search(TK)
//       const fileIds = []
//       for await (const matchFileId of searchGen) {
//         const fileInfo = await getPublicFilesNotOwnedByFileId(socket.userId, matchFileId)
//         if (fileInfo) {
//           // Return partial on search in case of searching for too long
//           socket.emit('partial-search-files', { files: [fileInfo] })
//           fileIds.push(matchFileId)
//         }
//       }
//       logSocketInfo(socket, 'Responding searched end to client.', { fileIds })
//       cb({ files: [] })
//     } catch (error) {
//       logSocketError(socket, error)
//       cb({ errorMsg: InternalServerErrorMsg })
//     }
//   })
// }
const getPublicFilesBinder = (socket) => {
  socket.on('search-files', async (request, cb) => {
    try {
      const actionStr = 'Client asks to search for files'
      logSocketInfo(socket, actionStr + '.', { tags: request.tags })

      // ✅ 你原本是 {TK, tags}，現在改成 {TKs, tags}
      // 你要記得同步改你的 schema
      const result = SearchFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }

      const { TKs, tags } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      // ✅ 基本防呆：tags 跟 TKs 長度要一致
      if (!Array.isArray(TKs) || TKs.length !== tags.length) {
        cb({ errorMsg: 'Trapdoor count does not match tags.' })
        return
      }

      // ✅ check 每個 tag 的 trapdoor 是否對得上
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i]
        const tk = TKs[i]
        if (!(await ABSEManeger.checkTKTags(tk, [tag]))) {
          logSocketWarning(socket, actionStr + ' but submitted tags do not match trapdoor.', {
            tag
          })
          cb({ errorMsg: 'Trapdoor do not match tags.' })
          return
        }
      }

      // ✅ OR 搜尋 + 去重
      const seen = new Set()       // fileId 去重
      const files = []             // 最終回傳用（可選）
      const emitted = new Set()    // 避免 partial 重複 emit（可選）

      for (let i = 0; i < tags.length; i++) {
        const tk = TKs[i]
        const searchGen = ABSEManeger.Search(tk)

        for await (const matchFileId of searchGen) {
          if (seen.has(matchFileId)) continue
          seen.add(matchFileId)

          const fileInfo = await getPublicFilesNotOwnedByFileId(socket.userId, matchFileId)
          if (fileInfo) {
            files.push(fileInfo)

            // ✅ partial 推回去前也做一次去重（避免 UI 重複渲染）
            if (!emitted.has(matchFileId)) {
              emitted.add(matchFileId)
              socket.emit('partial-search-files', { files: [fileInfo] })
            }
          }
        }
      }

      logSocketInfo(socket, 'Responding searched end to client.', { fileIds: [...seen] })
      cb({ files }) // ✅ 不要回空了，回完整結果（前端也能一次 setState）
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}
const updateFileBinder = (socket) => {
  /**
   * Client ask to update file description, permission or index
   */
  socket.on('update-file-desc-perm', async (request, cb) => {
    try {
      const actionStr = 'Client asks to update description, permission and index for file'
      logSocketInfo(socket, actionStr + '.', request)

      const result = UpdateFileRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId, description, permission, CTw, tags, attrIds } = result.data

      logger.debug(
        `[update-file-desc-perm] received: fileId=${fileId}, permission=${permission}, description.length=${description?.length}, hasCTw=${!!CTw}, tags=${JSON.stringify(tags)}, attrIds=${JSON.stringify(attrIds)}`
      )

      if (CTw && CTw.ct.length != (await ABSEManeger.getPP()).h_i.length) {
        logger.warn(
          `[update-file-desc-perm] CTw length mismatch for fileId=${fileId}: CTw.ct.length=${CTw.ct.length}`
        )
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      if (!(await getFileInfoOfOwnerId(fileId, socket.userId))) {
        logSocketWarning(socket, actionStr + ' but file does not exist.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }

      let desc = description
      if (description.length > ConfigManager.databaseLengthLimit) {
        desc = description.substring(0, ConfigManager.databaseLengthLimit)
      }
      await updateFileDescPermInDatabase(fileId, desc, permission)
      // Insert ABSE encrypted index
      if (CTw) await ABSEManeger.insertFileIndex(CTw, fileId)
      // Store plaintext tags and attrIds in PostgreSQL (migrated from client SQLite)
      await setFileTags(fileId, tags)
      await setFileAttrs(fileId, attrIds)

      logSocketInfo(socket, 'Description, permission, index, tags and attrs updated for file.', request)
      logger.debug(
        `[update-file-desc-perm] success: fileId=${fileId}, permission=${permission}, tags=${JSON.stringify(tags)}`
      )
      cb({})
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

// ─── Pending watermark-download requests (two-phase commit) ──────────────────
//
// Why two phases:
//
// The watermark download flow has *four* failure points after the server says
// "OK":
//   (1) client downloads the encrypted blob (network / SFTP failure)
//   (2) client decrypts (key / IV mismatch)
//   (3) client applies the watermark (PDF/DOCX/image processing crash)
//   (4) client writes the final file to disk (full disk, permission denied)
//
// If the server writes `download_logs` immediately on request, the audit log
// claims "user X downloaded file Y at time T" even when none of (1)–(4)
// actually succeeded. That's bad for two reasons:
//   • False positives drown out the real forensic signal.
//   • Users get blamed for downloads they never received.
//
// Fix: server holds the log entry in a `Map<requestId, pending>` and only
// flushes to the DB when the client confirms a successful write. If the
// client crashes, gets disconnected, or fails to confirm within the TTL, the
// entry is dropped — no log, which truthfully reflects "we have no evidence
// of a successful download".
//
// `requestId` is server-issued (the client cannot forge or replay one for a
// different user / file), socket-bound (only the originating socket can
// confirm it), and single-use (popped on the first confirm/cancel).
//
// TTL is generous (10 minutes) to accommodate slow downloads + large file
// watermark processing. The sweep runs every minute.

const PENDING_WM_DOWNLOAD_TTL_MS = 10 * 60 * 1000
const PENDING_WM_DOWNLOAD_SWEEP_MS = 60 * 1000

/** @type {Map<string, {
 *   socketId: string,
 *   fileId: string,
 *   downloaderUserId: string,
 *   ownerId: string,
 *   mode: string,
 *   watermarkVisible: boolean,
 *   watermarkInvisible: boolean,
 *   watermarkPayloadHash: string,
 *   ts: string,
 *   expiresAt: number
 * }>} */
const pendingWatermarkDownloads = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of pendingWatermarkDownloads) {
    if (entry.expiresAt <= now) {
      pendingWatermarkDownloads.delete(id)
      logger.warn(`Pending watermark download ${id} expired (no client confirm within TTL).`)
    }
  }
}, PENDING_WM_DOWNLOAD_SWEEP_MS).unref?.()

// ─── Download with watermark (logging + auth metadata) ───────────────────────
const downloadWithWatermarkBinder = (socket) => {
  /**
   * Client requests a watermark download. Phase 1 of two:
   *
   * - Validate auth + file ownership.
   * - Build the watermark meta and payload hash.
   * - Stash the would-be `download_logs` row in `pendingWatermarkDownloads`
   *   keyed by a fresh `requestId`.
   * - Return `{ requestId, watermarkMeta }` to the client.
   *
   * The DB write happens later, on `confirm-watermark-download`. See the
   * comment block above `pendingWatermarkDownloads` for rationale.
   *
   * Actual watermarking is done client-side (E2E encryption means server has
   * no plain file).
   */
  socket.on('download-file-with-watermark', async (request, cb) => {
    try {
      const actionStr = 'Client requests watermark download'
      logSocketInfo(socket, actionStr + '.', { fileId: request.fileId, mode: request.mode })

      const result = DownloadWithWatermarkRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { fileId, mode, watermark } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      // Check file exists and is accessible by this user
      const fileInfo = await getFileInfo(fileId)
      if (!fileInfo) {
        logSocketWarning(socket, actionStr + ' but file not found.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }
      if (fileInfo.ownerId !== socket.userId) {
        logSocketWarning(socket, actionStr + ' but file not owned by user.', request)
        cb({ errorMsg: FileNotFoundErrorMsg })
        return
      }

      // Build authenticated watermark payload hash (server-side, tamper-proof)
      const ts = new Date().toISOString()
      const payloadStr = `userId=${socket.userId}|fileId=${fileId}|ts=${ts}|note=${watermark?.customNote ?? ''}`
      const watermarkPayloadHash = crypto
        .createHash('sha256')
        .update(payloadStr)
        .digest('hex')

      // Encode the userId with the server-only watermark tracking key BEFORE
      // returning it. The client will embed this opaque value in the watermark.
      // An attacker who tampers with an invisible watermark can only insert
      // arbitrary uid strings — without the key they cannot synthesize the
      // correct tracked uid for a different user, so frame attempts collapse
      // (decoding will fail or return an unrecognized id).
      let trackedUserId
      try {
        trackedUserId = encodeTrackedUid(socket.userId)
      } catch (e) {
        logger.error('Failed to encode tracked uid:', e)
        cb({ errorMsg: InternalServerErrorMsg })
        return
      }

      // Stash the would-be log row; commit happens in `confirm-watermark-download`.
      const requestId = randomUUID()
      pendingWatermarkDownloads.set(requestId, {
        socketId: socket.id,
        fileId,
        downloaderUserId: socket.userId,
        ownerId: fileInfo.ownerId,
        mode,
        watermarkVisible: watermark?.visible ?? false,
        watermarkInvisible: watermark?.invisible ?? false,
        watermarkPayloadHash,
        ts,
        expiresAt: Date.now() + PENDING_WM_DOWNLOAD_TTL_MS
      })

      cb({
        requestId,
        watermarkMeta: {
          userId: trackedUserId,
          fileId,
          ts,
          payloadHash: watermarkPayloadHash
        }
      })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Phase 2: client tells us whether the download landed on disk.
   *
   * - `success === true`  → flush the pending row into `download_logs`.
   * - `success === false` → discard (no log, with a warn so ops can correlate
   *   client-side errors against server state).
   *
   * Single-use: the entry is popped before we touch the DB, so a replayed
   * confirm is a no-op (and logged at warn for visibility).
   *
   * Socket-bound: a confirm from a different socket than the one that
   * requested the download is rejected — prevents one logged-in user from
   * committing or cancelling another's pending entry by guessing requestIds.
   */
  socket.on('confirm-watermark-download', async (request, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {}
    try {
      const actionStr = 'Client confirms watermark download outcome'

      const result = ConfirmWatermarkDownloadRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        ack({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { requestId, success, errorMsg: clientErrMsg } = result.data

      if (!checkLoggedIn(socket)) {
        ack({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      const entry = pendingWatermarkDownloads.get(requestId)
      if (!entry) {
        logSocketWarning(socket, actionStr + ' but requestId unknown or expired.', { requestId })
        ack({ ok: false, reason: 'unknown_or_expired' })
        return
      }
      // Single-use: pop immediately so retries/replays don't double-commit.
      pendingWatermarkDownloads.delete(requestId)

      if (entry.socketId !== socket.id) {
        logSocketWarning(socket, actionStr + ' but socket mismatch — possible replay.', {
          requestId,
          owningSocket: entry.socketId
        })
        ack({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      if (!success) {
        logSocketInfo(socket, actionStr + ': failure reported, dropping pending log.', {
          requestId,
          fileId: entry.fileId,
          reason: clientErrMsg
        })
        ack({ ok: true, committed: false })
        return
      }

      try {
        await addDownloadLog({
          id: randomUUID(),
          fileId: entry.fileId,
          downloaderUserId: entry.downloaderUserId,
          ownerId: entry.ownerId,
          mode: entry.mode,
          watermarkVisible: entry.watermarkVisible,
          watermarkInvisible: entry.watermarkInvisible,
          watermarkPayloadHash: entry.watermarkPayloadHash
        })
        logSocketInfo(socket, 'Download logged (after client confirm).', {
          requestId,
          fileId: entry.fileId,
          mode: entry.mode
        })
        ack({ ok: true, committed: true })
      } catch (logErr) {
        logger.error('Failed to write download_log on confirm:', logErr)
        // We've already popped the entry; nothing to roll back. Tell the
        // client so it can surface the issue if it cares — but the download
        // itself was successful.
        ack({ ok: false, reason: 'log_write_failed' })
      }
    } catch (error) {
      logSocketError(socket, error, request)
      ack({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Forensic trace endpoint: given a tracked uid (full v1... ciphertext) or a
   * short hex prefix (as embedded in visible watermarks), return the matching
   * user(s).
   *
   * Auth: caller must be logged in. This endpoint reveals user identity, so
   * production deployments SHOULD restrict it to admin/manager roles. Marked
   * with a TODO until the role system lands.
   */
  socket.on('decode-watermark-uid', async (request, cb) => {
    try {
      const actionStr = 'Client requests watermark uid decode'
      logSocketInfo(socket, actionStr + '.', { value: request?.value?.slice?.(0, 16) })

      if (!checkLoggedIn(socket)) {
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }
      // Admin-only: decoding a watermark to a person is a forensic action (README #9).
      if (!checkAdmin(socket)) {
        cb({ errorMsg: NotAdminErrorMsg })
        return
      }
      const value = typeof request?.value === 'string' ? request.value.trim() : ''
      if (value.length === 0) {
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }

      let candidateIds = []
      if (isFullTrackedUid(value)) {
        // Direct decryption — most precise path, used when the invisible
        // watermark survived intact.
        try {
          const plain = decodeTrackedUid(value)
          candidateIds = [plain]
        } catch (e) {
          logSocketWarning(socket, actionStr + ' but decode failed.', { error: e?.message })
          cb({ matches: [], reason: 'decode_failed' })
          return
        }
      } else {
        // Short prefix lookup (e.g. 8 hex chars from the visible watermark).
        // O(N) over user table; fine for the expected scale of this system.
        const allUsers = await getAllUsers()
        candidateIds = findUserIdsByShortPrefix(allUsers, value)
      }

      const matches = []
      for (const id of candidateIds) {
        const u = await getUserById(id)
        if (u) {
          matches.push({
            id: u.id,
            name: u.name,
            email: u.email,
            status: u.status
          })
        }
      }
      cb({ matches })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

const allFileBinder = (socket) => {
  uploadFileBinder(socket)
  downloadFileBinder(socket)
  deleteFileBinder(socket)
  getFileListBinder(socket)
  folderBinder(socket)
  moveFileBinder(socket)
  getPublicFilesBinder(socket)
  updateFileBinder(socket)
  downloadWithWatermarkBinder(socket)
}

export { allFileBinder }
console.debug('FileManager.js loaded.')
