/**
 * This file handles operations and communication with server related to files.
 * Including upload, download, delete, search.
 */
import { dialog } from 'electron'
import { socket } from './MessageManager'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { unlink, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  applyVisibleWatermark,
  applyInvisibleWatermark,
  applyImageWatermarkMarkers,
  getMimeFromFilename,
  getMimeFromBuffer,
  isWatermarkSupported
} from './WatermarkProcessor'
import { logger } from './Logger'
import { uploadFileProcessHttps, downloadFileProcessHttps } from './HttpsFileProcess'
import { uploadFileProcessFtps, downloadFileProcessFtps } from './FtpsFileProcess'
import { basename, resolve } from 'node:path'
import { createPipeProgress } from './util/PipeProgress'
import cq from 'concurrent-queue'
import GlobalValueManager from './GlobalValueManager'
import AESModule from './AESModule'
import BlockchainManager from './BlockchainManager'
import FileUploadCoordinator from './FileUploadCoordinator'
import {
  bigIntToHex,
  CheckDiskSizePermissionTryAgainMsg,
  CheckLogForDetailMsg,
  ContactManagerOrTryAgainMsg,
  TryAgainMsg
} from './Utils'
import { downloadFileProcessSftp, uploadFileProcessSftp } from './SftpFileProcess'
import ABSEManager from './ABSEManager'
import DatabaseManager from './DatabaseManager'
import {
  runPreUploadClassification,
  makeUploadBatchClassifyKey,
  snapshotForPostUploadDialog
} from './services/preUploadClassifyCache.js'
import {
  getUploadBatchSmartClassifyWanted,
  getAppClassifierEnabled,
  getSmartClassifyMode
} from './services/classifierRuntime.js'

// ──────────────────────────────────────────────────────────────────────
// Watermark text composition
//
// We embed two distinct payloads:
//
//   • Visible watermark — a short, human-readable line shown on the document.
//     Only the first 8 hex chars of the (server-keyed) tracked uid are used,
//     mirroring the historical "uid:abc12345" format. This is enough for an
//     operator to recognize "yep, this came from someone whose tracked uid
//     starts with abc12345" but never reveals the plain user id.
//     User-supplied `customNote` IS included here because the user can already
//     see the visible watermark — there's no extra information leak.
//
//   • Invisible watermark — full machine-readable payload carrying the entire
//     tracked uid. Decoding it server-side yields the exact plain user id
//     directly, no DB lookup required. This is the forensic primary.
//     We deliberately do NOT embed customNote here because:
//       (1) The user-typed note may contain PII / classified annotations that
//           shouldn't follow the file silently — uid/fid/ts is already enough
//           to identify the source download event.
//       (2) Notes can be CJK, which the bundled StandardFonts.Helvetica cannot
//           encode and would throw on _invisiblePDF. By restricting the
//           invisible payload to ASCII-only fields (hex uid, uuid fid, ISO ts)
//           we side-step the throw entirely.
//
// Both share the same authenticated meta (server `download-file-with-watermark`
// reply), so an attacker who tampers with one has to fake them consistently —
// and without the server's watermark key they can't compute correct ciphertext
// for someone else's uid.
// ──────────────────────────────────────────────────────────────────────

/** Strip the version prefix (e.g. "v1") and take the first 8 hex chars. */
function _shortTrackedUid(trackedUid) {
  return String(trackedUid || '').replace(/^v\d+/, '').slice(0, 8)
}

function _buildVisibleWmText(watermarkMeta, customNote) {
  const shortUid = _shortTrackedUid(watermarkMeta?.userId)
  const shortFid = String(watermarkMeta?.fileId || '').slice(0, 8)
  const ts = watermarkMeta?.ts || new Date().toISOString()
  const note = (customNote || '').trim()
  return `uid:${shortUid} | fid:${shortFid} | ${ts}${note ? ' | ' + note : ''}`
}

function _buildInvisibleWmText(watermarkMeta /* , customNote — intentionally unused */) {
  const fullUid = String(watermarkMeta?.userId || '')
  const fid = String(watermarkMeta?.fileId || '')
  const ts = watermarkMeta?.ts || new Date().toISOString()
  // ASCII-only by construction (hex uid + uuid fid + ISO ts).
  return `uid:${fullUid} | fid:${fid} | ts:${ts}`
}

class FileManager {
  aesModule
  blockchainManager
  uploadQueue
  /**
   * Active upload batches keyed by batchId. Each call to `uploadFileProcess()`
   * creates a new entry; entries are removed when their `expected` slot count
   * reaches zero (whether by success or failure).
   *
   * Previously this was a single private field shared across all batches,
   * which caused two foot-guns when the user kicked off uploads in quick
   * succession:
   *   1) The second uploadFileProcess() overwrote the first batch's state, so
   *      the first batch's `expected` could never reach zero and its
   *      post-upload dialog never fired.
   *   2) Errors before the server reply (encryption failure, pre-upload
   *      socket error) returned out of #uploadProcess without decrementing
   *      `expected` at all, leaving the batch stuck forever.
   *
   * Per-batch state plus an explicit #markBatchSlotDone() call in every
   * error path fix both.
   *
   * @type {Map<string, {
   *   batchId: string,
   *   expected: number,
   *   fileIds: string[],
   *   pathsByFileId: Record<string, string>,
   *   classifyBatchKey: string | null,
   *   classifierWanted: boolean
   * }>}
   */
  #uploadBatches = new Map()
  /**
   * fileId → batchId routing table, populated when pre-upload returns a
   * fileId and consumed when the corresponding upload-file-res arrives. Lets
   * us deliver server replies to the right batch even when several batches
   * are in flight.
   * @type {Map<string, string>}
   */
  #fileIdToBatchId = new Map()
  /**
   * @param {AESModule} aesModule
   * @param {BlockchainManager} blockchainManager
   * @param {ABSEManager} abseManager
   * @param {DatabaseManager} databaseManager
   * @param {number} queueConcurrency
   */
  constructor(aesModule, blockchainManager, abseManager, databaseManager, queueConcurrency = 3) {
    this.aesModule = aesModule
    this.blockchainManager = blockchainManager
    this.abseManager = abseManager
    this.databaseManager = databaseManager
    this.uploadQueue = cq()
      .limit({ concurrency: queueConcurrency })
      .process(this.#uploadProcess.bind(this))
    // Blockchain transactions must be serialized to avoid nonce collisions
    this.blockchainQueue = cq()
      .limit({ concurrency: 1 })
      .process(async ({ coordinator }) => {
        await coordinator.uploadToBlockchainWhenReady()
      })

    /**
     * A message from server when upload verification finished.
     *
     * Server replies are routed back to their originating batch via
     * #fileIdToBatchId. An orphaned reply (no batch entry — e.g. stale
     * message after a client restart) is logged and dropped to avoid
     * corrupting unrelated state.
     */
    socket.on('upload-file-res', (response) => {
      const fileId = response?.fileId
      const batchId = fileId ? this.#fileIdToBatchId.get(fileId) : undefined
      if (fileId) this.#fileIdToBatchId.delete(fileId)

      if (response?.errorMsg) {
        logger.error(
          `Failed to upload file ${fileId}: ${response.errorMsg}. Upload aborted.`
        )
        this.#sendUploadErrorNotice(response.errorMsg)
        this.#markBatchSlotDone(batchId, null)
      } else {
        GlobalValueManager.sendNotice(`Success to upload file ${fileId}`, 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
        this.#markBatchSlotDone(batchId, fileId)
      }
    })

    /**
     * Send the partial search result to renderer when receiving from server.
     */
    socket.on('partial-search-files', (response) => {
      const { files } = response
      // logger.debug('get file', files)
      GlobalValueManager.mainWindow?.webContents.send('partial-search-files', files)
    })
  }

  /**
   * Send upload error notice to renderer
   * @param {String} errorMsg
   * @param {String} treatmentMsg
   * @example this.#sendUploadErrorNotice('File encryption failed.', TryAgainMsg)
   */
  #sendUploadErrorNotice(errorMsg, treatmentMsg = TryAgainMsg) {
    GlobalValueManager.sendNotice(`Failed to upload file: ${errorMsg} ${treatmentMsg}`, 'error')
  }

  /**
   * Send download error notice to renderer
   * @param {String} errorMsg
   * @param {String} treatmentMsg
   * @example this.#sendDownloadErrorNotice('File decryption failed.', TryAgainMsg)
   */
  #sendDownloadErrorNotice(errorMsg, treatmentMsg = TryAgainMsg) {
    GlobalValueManager.sendNotice(`Failed to download file: ${errorMsg} ${treatmentMsg}`, 'error')
  }

  /**
   * Check if all files in the current upload batch have received a response.
   * If so, notify the renderer to open the post-upload settings dialog.
   */
  /**
   * Decrement the given batch's remaining slot count by 1, record the fileId
   * if it succeeded, and fire the post-upload dialog (then remove the batch)
   * if no slots remain.
   *
   * Tolerates an undefined batchId — that happens when an `upload-file-res`
   * arrives for a fileId we no longer track (server-late reply, batch already
   * cleaned up, etc).
   *
   * @param {string | undefined} batchId
   * @param {string | null} fileId  null ⇒ this slot failed; non-null ⇒ success
   */
  #markBatchSlotDone(batchId, fileId) {
    if (!batchId) return
    const batch = this.#uploadBatches.get(batchId)
    if (!batch) return
    batch.expected = Math.max(0, batch.expected - 1)
    if (fileId) batch.fileIds.push(fileId)
    this.#checkUploadBatchDone(batchId)
  }

  #checkUploadBatchDone(batchId) {
    const batch = this.#uploadBatches.get(batchId)
    if (!batch) return
    if (batch.expected > 0) return

    // All slots in this batch have resolved (success or fail). Fire the
    // post-upload dialog only if at least one file actually made it to the
    // server — there's nothing useful to show otherwise.
    if (batch.fileIds.length > 0) {
      const { classifyBatchKey, classifierWanted, fileIds, pathsByFileId } = batch
      const sourcePaths = fileIds.map((id) => pathsByFileId[id]).filter(Boolean)
      const { classificationPreview } = snapshotForPostUploadDialog(
        classifierWanted,
        getAppClassifierEnabled(),
        classifyBatchKey
      )
      GlobalValueManager.mainWindow?.webContents.send('upload-batch-done', {
        fileIds: [...fileIds],
        sourcePaths,
        classificationPreview,
        classifyBatchKey
      })
    }
    this.#uploadBatches.delete(batchId)
  }

  /**
   * The process of actually uploading the file.
   * Properly awaits each stage so concurrent-queue concurrency control works correctly.
   *
   * Batch-tracking contract:
   *   • Each invocation owns exactly one slot in `batch.expected`.
   *   • If we reach Step 5 and enqueue successfully, the slot is closed later
   *     by `socket.on('upload-file-res')` when the server confirms.
   *   • Any earlier failure (encryption, pre-upload, write, transport) MUST
   *     call `#markBatchSlotDone(batchId, null)` before returning — otherwise
   *     the batch never reaches expected=0 and the post-upload dialog never
   *     fires (regression A2).
   *
   * @param {{ filePath: string, parentFolderId: string, batchId: string }} info
   */
  async #uploadProcess({ filePath, parentFolderId, batchId }) {
    let cipher = null
    let spk = null
    let encryptedStream = null
    let fileStream = null
    const originalFileName = basename(filePath)

    // Step 1: Read the file and create an encrypted stream
    try {
      fileStream = createReadStream(filePath)
      logger.info('Encrypting file...')
      ;({ cipher, spk, encryptedStream } = await this.aesModule.encrypt(fileStream))
      encryptedStream.on('error', (err) => {
        logger.error(err)
        this.#sendUploadErrorNotice('File encryption failed.')
      })
    } catch (error) {
      logger.error(`Failed to create stream or encrypt file: ${error}. Upload aborted.`)
      this.#sendUploadErrorNotice(
        'File stream creation failed.',
        'Please check if file exists and try again.'
      )
      this.#markBatchSlotDone(batchId, null)
      return
    }

    // Step 2: Pre-upload — send encrypted AES key to server and get fileId
    logger.info('Sending key and iv to server...')
    let fileId
    try {
      fileId = await new Promise((resolve, reject) => {
        socket.emit('upload-file-pre', { cipher, spk, parentFolderId }, (response) => {
          if (response.errorMsg) reject(new Error(response.errorMsg))
          else resolve(response.fileId)
        })
      })
    } catch (error) {
      logger.error(`Failed to pre-upload: ${error.message}. Upload aborted.`)
      this.#sendUploadErrorNotice(error.message)
      this.#markBatchSlotDone(batchId, null)
      return
    }

    // Wire this fileId back to its batch so upload-file-res routes correctly,
    // and keep the source path for the post-upload dialog + retry classify flow.
    this.#fileIdToBatchId.set(fileId, batchId)
    const batch = this.#uploadBatches.get(batchId)
    if (batch) {
      batch.pathsByFileId[fileId] = filePath
    }

    // Step 3: Set up tee — split encryptedStream into hash stream and write stream
    const tempEncryptedFilePath = resolve(GlobalValueManager.tempPath, fileId)
    const writeStream = createWriteStream(tempEncryptedFilePath)
    const fileUploadCoordinator = new FileUploadCoordinator(
      this.blockchainManager,
      JSON.stringify({ filename: originalFileName })
    )
    const hashPassThrough = new PassThrough()
    const writePassThrough = new PassThrough()
    encryptedStream.pipe(hashPassThrough)
    encryptedStream.pipe(writePassThrough)

    // Hash calculation runs concurrently with disk write
    this.aesModule
      .makeHashPromise(hashPassThrough)
      .then((digest) => {
        fileUploadCoordinator.finishHash(digest)
      })
      .catch((error) => {
        logger.error(error)
        this.#sendUploadErrorNotice('File hash calculation failed.')
      })

    // Step 4: Write to disk then upload to server (awaited)
    try {
      await new Promise((resolve, reject) => {
        writeStream.on('close', async () => {
          logger.info(`Encrypted file finished writing.`, { tempEncryptedFilePath })
          const protocol = GlobalValueManager.serverConfig.protocol
          logger.info(`Uploading file ${basename(filePath)} with protocol ${protocol}`)
          try {
            switch (protocol) {
              case 'https':
                await uploadFileProcessHttps(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              case 'ftps':
                await uploadFileProcessFtps(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              case 'sftp':
                await uploadFileProcessSftp(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              default:
                throw new Error('Invalid file protocol')
            }
            resolve()
          } catch (err) {
            reject(err)
          }
        })
        writeStream.on('error', (error) => {
          logger.error(error)
          this.#sendUploadErrorNotice(
            'Encrypted file failed to write.',
            CheckDiskSizePermissionTryAgainMsg
          )
          reject(error)
        })
        writePassThrough.pipe(writeStream)
      })
    } catch (error) {
      logger.error(error)
      this.#sendUploadErrorNotice(
        `Upload with ${GlobalValueManager.serverConfig.protocol} failed.`,
        CheckLogForDetailMsg
      )
      // The server never received the file → no upload-file-res will come.
      // Drop the routing entry and close the slot ourselves.
      this.#fileIdToBatchId.delete(fileId)
      this.#markBatchSlotDone(batchId, null)
      return
    }

    // Step 5: Enqueue blockchain upload to serialized queue (non-blocking for upload slots)
    // blockchainQueue has concurrency: 1 to prevent Ethereum nonce collisions.
    // From here on the batch slot will be closed by socket.on('upload-file-res'),
    // not by us — the server is now the authority on this fileId's outcome.
    this.blockchainQueue({ coordinator: fileUploadCoordinator }).catch((error) => {
      logger.error(error)
      this.#sendUploadErrorNotice('Blockchain upload failed.', ContactManagerOrTryAgainMsg)
    })
  }

  /**
   * Browse and select files to upload, and push to an upload queue for concurrent upload process.
   * @param {string} parentFolderId
   */
  async uploadFileProcess(parentFolderId) {
    logger.info('Browsing file...')
    const { filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (filePaths.length > 0) {
      const classifierWanted = getUploadBatchSmartClassifyWanted()
      const classifierEnabled = getAppClassifierEnabled()
      // V11: snapshot the mode NOW (at pick time) so a later dropdown change
      // can't alter how this batch is classified.
      const classifyMode = getSmartClassifyMode()
      const classifyBatchKey =
        classifierWanted && classifierEnabled ? makeUploadBatchClassifyKey(filePaths) : null

      // Each call to this method spawns a fresh batch; old batches keep
      // running independently until their own slots drain (fix A1).
      const batchId = randomUUID()
      this.#uploadBatches.set(batchId, {
        batchId,
        expected: filePaths.length,
        fileIds: [],
        pathsByFileId: {},
        classifyBatchKey,
        classifierWanted
      })

      // Fire LM classification in background; upload continues concurrently
      if (classifierWanted && classifierEnabled && classifyBatchKey) {
        void runPreUploadClassification(
          (payload) =>
            GlobalValueManager.mainWindow?.webContents.send('preupload-classify-status', payload),
          classifyBatchKey,
          filePaths,
          classifyMode
        )
      }

      for (const filePath of filePaths) {
        this.uploadQueue({ filePath, parentFolderId, batchId })
      }
    } else {
      GlobalValueManager.sendNotice('File upload canceled.', 'error')
    }
  }

  /**
   * Get the file list under current folder.
   * @param {string} parentFolderId
   */
  getFileListProcess(parentFolderId) {
    logger.info(`Getting file list for ${parentFolderId || 'home'}...`)
    socket.emit('get-file-list', { parentFolderId }, async (response) => {
      try {
        const { files, folders, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get file list: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get file list', 'error')
        } else {
          logger.info('Sucess to get file list')
          const globalAttrs = (await this.abseManager.getPP())?.U || []
          // tags and attrIds now come directly from the server (PostgreSQL)
          const filesObj = JSON.parse(files)
          filesObj.forEach((file) => {
            file.tags = Array.isArray(file.tags) ? file.tags : []
            file.attrs = Array.isArray(file.attrIds)
              ? file.attrIds.map((id) => globalAttrs.at(id)).filter(Boolean)
              : []
            logger.debug(`attrs for file ${file.id}`, { attrs: file.attrs })
          })
          GlobalValueManager.mainWindow?.webContents.send('file-list-res', {
            files: filesObj,
            folders
          })
        }
      } catch (error) {
        logger.error(error)
        GlobalValueManager.sendNotice('Failed to get file list', 'error')
      }
    })
  }

  /**
   * Smart-search scope: all of the user's own files (every folder) plus all
   * public files of other users, metadata only. Resolves with parsed arrays
   * and deliberately does NOT broadcast `file-list-res`, so the file list
   * page keeps showing the folder the user is browsing.
   * @returns {Promise<{ files: object[], folders: object[] }>}
   */
  async getAgentFileScopeProcess() {
    const response = await new Promise((resolve, reject) => {
      socket.timeout(15000).emit('get-agent-file-scope', {}, (timeoutErr, res) => {
        if (timeoutErr) return reject(new Error('Server did not respond.'))
        if (res?.errorMsg) return reject(new Error(res.errorMsg))
        resolve(res)
      })
    })
    const globalAttrs = (await this.abseManager.getPP())?.U || []
    const files = JSON.parse(response.files)
    const folders = JSON.parse(response.folders)
    files.forEach((file) => {
      file.tags = Array.isArray(file.tags) ? file.tags : []
      file.attrs = Array.isArray(file.attrIds)
        ? file.attrIds.map((id) => globalAttrs.at(id)).filter(Boolean)
        : []
    })
    logger.info(`[Agent] file scope: ${files.length} file(s), ${folders.length} folder(s)`)
    return { files, folders }
  }

  /**
   * Ask the server to download file (legacy entry, no UI options).
   *
   * Routed through the unified `_performInteractiveDownload` so that callers
   * such as the smart-search agent's "download" button still get an invisible
   * watermark silently embedded when the format supports it. The user is
   * never asked or notified about this — that's by design.
   *
   * @param {string} fileId the file to download
   */
  downloadFileProcess(fileId) {
    logger.info(`Asking for file ${fileId}...`)
    void this._performInteractiveDownload(fileId, 'original', null).catch((e) => {
      logger.error(`[Download] interactive (legacy) failed: ${e?.message || e}`)
    })
  }

  /**
   * Legacy implementation kept around for the rare path that wants the raw
   * server flow (no watermark, no extra round-trip). Currently unused — every
   * UI entry point goes through `_performInteractiveDownload`.
   *
   * @deprecated Prefer `_performInteractiveDownload` for new callers.
   * @param {string} fileId the file to download
   */
  _downloadFileProcessLegacy(fileId) {
    logger.info(`Asking for file ${fileId} (legacy path)...`)
    /**
     * Pre-download request to get the fileInfo
     */
    socket.emit('download-file-pre', { fileId }, async (response) => {
      try {
        if (response.errorMsg) {
          logger.error(`Failed to download file: ${response.errorMsg}`)
          this.#sendDownloadErrorNotice(response.errorMsg, ContactManagerOrTryAgainMsg)
          return
        }
        if (!response.fileInfo) {
          //! This should not happen
          logger.error(`File ${fileId} not found`)
          this.#sendDownloadErrorNotice('File not found', ContactManagerOrTryAgainMsg)
          return
        }
        // console.log(fileInfo)
        // Get the verification info of this file from blockchain.
        try {
          const blockchainVerification = await this.blockchainManager.getFileVerification(
            fileId,
            response.fileInfo.verifyblocknumber
          )
          if (!blockchainVerification || blockchainVerification.verificationInfo != 'success') {
            logger.error(`File ${fileId} not verified.`)
            this.#sendDownloadErrorNotice(
              'File not verified on blockchain.',
              ContactManagerOrTryAgainMsg
            )
            return
          }
        } catch (error) {
          logger.error(error)
          this.#sendDownloadErrorNotice(
            'Failed to get file verification from blockchain.',
            ContactManagerOrTryAgainMsg
          )
          return
        }
        logger.info(`File ${fileId} is verified.`)

        const proxied = response.fileInfo.ownerId !== response.fileInfo.originOwnerId

        // Get file information from blockchain. Will be used later to chekc for hash.
        let blockchainFileInfo = null
        try {
          blockchainFileInfo = await this.blockchainManager.getFileInfo(
            fileId,
            response.fileInfo.infoblocknumber
          )
          logger.debug(blockchainFileInfo)
          if (!blockchainFileInfo) {
            logger.error(`File ${fileId} info not on blockchain.`)
            this.#sendDownloadErrorNotice(
              'File info not on blockchain.',
              ContactManagerOrTryAgainMsg
            )
            return
          }
        } catch (error) {
          logger.error(error)
          this.#sendDownloadErrorNotice(
            'Failed to get file info from blockchain.',
            ContactManagerOrTryAgainMsg
          )
          return
        }

        const { id, name, cipher, spk, size } = response.fileInfo
        // Second download process for actually downloading the file.
        this.downloadFileProcess2(id, name, cipher, spk, size, proxied, blockchainFileInfo)
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
      }
    })
  }

  /**
   * The second dowload process for actually downloading the file.
   * @param {*} fileId
   * @param {*} filename
   * @param {*} cipher
   * @param {*} spk
   * @param {*} size
   * @param {*} proxied
   * @param {*} blockchainFileInfo
   * @returns
   */
  async downloadFileProcess2(fileId, filename, cipher, spk, size, proxied, blockchainFileInfo) {
    try {
      // Let the user select where to store the file. TODO: move to process 1.
      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: filename,
        properties: ['showOverwriteConfirmation', 'createDirectory']
      })
      if (canceled) {
        logger.info('Download canceled.')
        GlobalValueManager.sendNotice('Download canceled.', 'error')
        return
      }

      //-- Write stream for writing file later --//
      let writeStream
      try {
        writeStream = createWriteStream(filePath)
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice(
          'Failed to create write stream.',
          CheckDiskSizePermissionTryAgainMsg
        )
      }
      let writeCompleteResolve, writeCompleteReject
      const writeCompletePromise = new Promise((resolve, reject) => {
        writeCompleteResolve = resolve
        writeCompleteReject = reject
      })
      writeStream.on('error', (err) => {
        logger.error(`Failed to write file ${filename}: ${err}. Download aborted.`)
        this.#sendDownloadErrorNotice('Failed to write file.', CheckDiskSizePermissionTryAgainMsg)
        try {
          unlinkSync(filePath)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.error(error)
          }
        } finally {
          writeCompleteReject()
        }
      })
      writeStream.on('finish', () => {
        logger.info(`Downloaded file ${filename} to ${filePath}`)
        GlobalValueManager.sendNotice('File downloaded. Verifying hash...', 'normal')
        writeCompleteResolve()
      })
      // Test write error
      // writeStream.emit('error')

      //-- Decrypt file --//
      const decipher = await this.aesModule.decrypt(cipher, spk, proxied)
      decipher.on('error', (err) => {
        logger.error(err)
        this.#sendDownloadErrorNotice(
          'Failed to decrypt file. The file could be corrupted or modified.',
          ContactManagerOrTryAgainMsg
        )
        try {
          unlinkSync(filePath)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.error(error)
          }
        }
      })
      // Test decrypt error
      // decipher.emit('error')

      logger.info(
        `Downloading file ${fileId} with protocol ${GlobalValueManager.serverConfig.protocol}...`
      )
      // download progress
      const pipeProgress = createPipeProgress({ total: size }, logger)

      //-- Caculate hash --//
      const hashPromise = this.aesModule.makeHashPromise(pipeProgress)

      pipeProgress.pipe(decipher)
      decipher.pipe(writeStream)

      //-- Download file with protocol --//
      const protocol = GlobalValueManager.serverConfig.protocol
      try {
        logger.info(`Downloading file ${fileId} with protocol ${protocol}`)
        switch (protocol) {
          case 'https':
            await downloadFileProcessHttps(fileId, pipeProgress, filePath)
            break
          case 'ftps':
            await downloadFileProcessFtps(fileId, pipeProgress, filePath)
            break
          case 'sftp':
            await downloadFileProcessSftp(fileId, pipeProgress, filePath)
            break
          default:
            logger.error('Invalid file protocol')
            this.#sendDownloadErrorNotice('Invalid file protocol.')
            break
        }
        await writeCompletePromise
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice(`Download with ${protocol} failed.`, CheckLogForDetailMsg)
        return
      }

      //-- Verify hash --//
      try {
        const fileHash = await hashPromise
        const blockchainHash = bigIntToHex(blockchainFileInfo.fileHash, 64) // sha256 have length 64
        if (fileHash !== blockchainHash) {
          try {
            logger.debug('File Hash different', {
              fileHash,
              blockchainHash
            })
            logger.error(`File hash did not meet for file ${fileId}`)
            this.#sendDownloadErrorNotice(
              'File hash did not meet. The file could be modified.',
              ContactManagerOrTryAgainMsg
            )
            socket.emit('download-file-hash-error', {
              fileId,
              fileHash,
              blockchainHash
            })
          } catch (error1) {
            logger.error(error1)
          } finally {
            try {
              await unlink(filePath)
            } catch (error2) {
              if (error2.code !== 'ENOENT') {
                logger.error(error2)
              }
            }
          }
          return
        }
        logger.info(`File hash verified for file ${fileId}.`)
        GlobalValueManager.sendNotice('Success to download file', 'success')
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('File hash calculation failed.')
      }
    } catch (error) {
      logger.error(`Failed to download file: ${error}. Download aborted.`)
      this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
    }
  }

  /**
   * Download a file with options (original or watermark).
   * Called by the IPC handler for 'download-with-options'.
   *
   * Both modes silently embed an invisible watermark when the file format
   * supports it. The user-facing dialog only exposes original vs visible
   * watermark; the invisible part is intentionally not surfaced.
   *
   * @param {{ fileId: string, mode: 'original'|'watermark', watermarkOptions: object|null }} opts
   */
  downloadFileWithOptionsProcess({ fileId, mode, watermarkOptions }) {
    void this._performInteractiveDownload(fileId, mode, watermarkOptions).catch((e) => {
      logger.error(`[Download] interactive failed: ${e?.message || e}`)
    })
  }

  /**
   * Unified single-file interactive download:
   *   1. Resolve auth meta (server + blockchain)
   *   2. Ask the user where to save the file
   *   3. Build effective watermark options
   *      - Format supports watermark → always invisible=true,
   *        visible = (mode === 'watermark')
   *      - Format does not          → no watermark at all (plain download)
   *   4. Run the appropriate helper and emit a user-friendly notice that
   *      never mentions the invisible watermark.
   *
   * @param {string} fileId
   * @param {'original'|'watermark'} mode
   * @param {object|null} userOptions visible-watermark style options from UI
   */
  async _performInteractiveDownload(fileId, mode, userOptions) {
    // 1. Resolve metadata
    let meta
    try {
      meta = await this.getDownloadMeta(fileId)
    } catch (e) {
      this.#sendDownloadErrorNotice(e?.message || 'Failed to fetch file metadata.', ContactManagerOrTryAgainMsg)
      return
    }

    // 2. Save dialog (parented to the main window so it can never open hidden
    //    behind the app and leave this await hanging)
    const saveOpts = {
      defaultPath: meta.name,
      properties: ['showOverwriteConfirmation', 'createDirectory']
    }
    const { filePath, canceled } = GlobalValueManager.mainWindow
      ? await dialog.showSaveDialog(GlobalValueManager.mainWindow, saveOpts)
      : await dialog.showSaveDialog(saveOpts)
    if (canceled) {
      logger.info('Download canceled.')
      GlobalValueManager.sendNotice('Download canceled.', 'error')
      return
    }

    const supportsWatermark = isWatermarkSupported(meta.name)
    // [diag] Surfaces exactly what the main process decided at download time.
    // If a watermark-supported file ends up un-watermarked, this line tells us
    // whether `meta.name` (the server-side filename) failed mime detection.
    logger.info(
      `[Download][diag] fileId=${fileId} serverName="${meta.name}" mode=${mode} ` +
        `mime=${getMimeFromFilename(meta.name) || 'null'} supportsWatermark=${supportsWatermark}`
    )

    // 3a. Format does not support any watermark → plain download.
    if (!supportsWatermark) {
      logger.warn(
        `[Download][diag] NO watermark embedded — server filename "${meta.name}" did not ` +
          `resolve to a supported mime, so this download skips the (silent) invisible watermark.`
      )
      try {
        await this.downloadOriginalToPath(meta, filePath)
        GlobalValueManager.sendNotice('Success to download file', 'success')
      } catch (_e) {
        // helper has already surfaced an error notice
      }
      return
    }

    // 3b. Build effective watermark options.
    //
    // visible  — only when the user explicitly chose 'watermark' mode
    // invisible — ALWAYS, regardless of mode (silent forensic marker)
    const effectiveOptions = {
      visible: mode === 'watermark',
      invisible: true,
      customNote: userOptions?.customNote ?? '',
      position: userOptions?.position ?? 'bottomRight',
      opacity: userOptions?.opacity ?? 0.3,
      fontSize: userOptions?.fontSize ?? 14,
      mimeType: userOptions?.mimeType ?? getMimeFromFilename(meta.name)
    }

    try {
      await this.downloadWatermarkedToPath(fileId, meta, filePath, effectiveOptions)
      GlobalValueManager.sendNotice(
        // Notice text intentionally never mentions invisible — it's silent.
        mode === 'watermark' ? 'File downloaded with watermark.' : 'Success to download file',
        'success'
      )
    } catch (_e) {
      // downloadWatermarkedToPath writes to a temp file and only copies it to
      // the user's chosen path AFTER watermarking succeeds. If watermarking
      // throws, NO file lands at the destination — so we must NOT fail silently
      // here (the user would otherwise see neither success nor a saved file).
      // Surface a clear error. (Batch downloads use BatchDownloadManager's own
      // per-item error UI, so this caller-side notice won't spam in batch mode.)
      logger.error(`[Download] watermarked download failed: ${_e?.message || _e}`)
      this.#sendDownloadErrorNotice(
        _e?.message === 'WATERMARK_UNSUPPORTED_FORMAT'
          ? 'This file format does not support watermarking.'
          : 'Failed to apply watermark; the file was not saved.',
        ContactManagerOrTryAgainMsg
      )
    }
  }

  /**
   * Full watermark download flow.
   * 1) Server logs download event + returns authenticated metadata
   * 2) Pre-download to get file info + blockchain verify
   * 3) Download + decrypt to temp file
   * 4) Apply watermark
   * 5) Save to user's chosen path
   */
  async #downloadWithWatermark(fileId, watermarkOptions) {
    // Step 1: get auth metadata from server (logs the download event)
    let watermarkMeta
    try {
      watermarkMeta = await new Promise((resolve, reject) => {
        socket.emit(
          'download-file-with-watermark',
          {
            fileId,
            mode: 'watermark',
            watermark: {
              visible: watermarkOptions?.visible === true,
              invisible: watermarkOptions?.invisible === true,
              customNote: watermarkOptions?.customNote ?? '',
              position: watermarkOptions?.position ?? 'bottomRight',
              opacity: watermarkOptions?.opacity ?? 0.3,
              fontSize: watermarkOptions?.fontSize ?? 14
            }
          },
          (response) => {
            if (response.errorMsg) reject(new Error(response.errorMsg))
            else resolve(response.watermarkMeta)
          }
        )
      })
    } catch (e) {
      logger.error(`[WM] get watermark meta failed: ${e.message}`)
      this.#sendDownloadErrorNotice(e.message, ContactManagerOrTryAgainMsg)
      return
    }

    // Step 2: pre-download → file info + blockchain verification
    socket.emit('download-file-pre', { fileId }, async (response) => {
      try {
        if (response.errorMsg) {
          this.#sendDownloadErrorNotice(response.errorMsg, ContactManagerOrTryAgainMsg)
          return
        }
        if (!response.fileInfo) {
          this.#sendDownloadErrorNotice('File not found', ContactManagerOrTryAgainMsg)
          return
        }

        // Blockchain verify
        try {
          const bv = await this.blockchainManager.getFileVerification(
            fileId,
            response.fileInfo.verifyblocknumber
          )
          if (!bv || bv.verificationInfo !== 'success') {
            this.#sendDownloadErrorNotice('File not verified on blockchain.', ContactManagerOrTryAgainMsg)
            return
          }
        } catch (e) {
          logger.error(e)
          this.#sendDownloadErrorNotice('Blockchain verification failed.', ContactManagerOrTryAgainMsg)
          return
        }

        let blockchainFileInfo = null
        try {
          blockchainFileInfo = await this.blockchainManager.getFileInfo(
            fileId,
            response.fileInfo.infoblocknumber
          )
          if (!blockchainFileInfo) {
            this.#sendDownloadErrorNotice('File info not on blockchain.', ContactManagerOrTryAgainMsg)
            return
          }
        } catch (e) {
          logger.error(e)
          this.#sendDownloadErrorNotice('Failed to get blockchain file info.', ContactManagerOrTryAgainMsg)
          return
        }

        const { id, name, cipher, spk, size } = response.fileInfo
        const proxied = response.fileInfo.ownerId !== response.fileInfo.originOwnerId
        const mimeType = watermarkOptions?.mimeType ?? getMimeFromFilename(name)

        // Sanity check: confirm format is still supported server-side
        if (!isWatermarkSupported(name)) {
          this.#sendDownloadErrorNotice(
            `${name} 格式不支援浮水印，改以原檔下載。`
          )
          this.downloadFileProcess(fileId)
          return
        }

        // Step 3: show save dialog
        const { filePath, canceled } = await dialog.showSaveDialog({
          defaultPath: name,
          properties: ['showOverwriteConfirmation', 'createDirectory']
        })
        if (canceled) {
          GlobalValueManager.sendNotice('Download canceled.', 'error')
          return
        }

        // Step 4: download + decrypt to temp path
        const tempPath = resolve(
          GlobalValueManager.tempPath,
          `${id}_wm_${Date.now()}`
        )
        try {
          await this.#downloadDecryptToPath(id, name, cipher, spk, size, proxied, blockchainFileInfo, tempPath)
        } catch (e) {
          logger.error(e)
          // cleanup will happen inside #downloadDecryptToPath on error
          return
        }

        // Step 5: apply watermark
        GlobalValueManager.sendNotice('Applying watermark...', 'normal')
        try {
          const decryptedBuffer = await readFile(tempPath)

          // Build visible/invisible texts from server-authenticated metadata.
          // (See module-level comments for why the two texts differ.)
          const note = watermarkOptions?.customNote
          const visibleText = _buildVisibleWmText(watermarkMeta, note)
          // Invisible payload intentionally omits the user note (see _buildInvisibleWmText).
          const invisibleText = _buildInvisibleWmText(watermarkMeta)

          // Apply visible watermark first (if requested), then invisible on top
          let processedBuffer = decryptedBuffer

          if (watermarkOptions?.visible === true) {
            processedBuffer = await applyVisibleWatermark(processedBuffer, mimeType, {
              text: visibleText,
              position: watermarkOptions?.position ?? 'bottomRight',
              opacity: watermarkOptions?.opacity ?? 0.3,
              fontSize: watermarkOptions?.fontSize ?? 14
            })
          }

          if (watermarkOptions?.invisible === true) {
            processedBuffer = await applyInvisibleWatermark(processedBuffer, mimeType, {
              text: invisibleText
            })
          }

          await writeFile(filePath, processedBuffer)
          const modes = [
            watermarkOptions?.visible === true && '可視',
            watermarkOptions?.invisible === true && '不可視'
          ]
            .filter(Boolean)
            .join(' + ')
          GlobalValueManager.sendNotice(`File downloaded with ${modes} watermark.`, 'success')
        } catch (e) {
          logger.error(e)
          const code = e.message === 'WATERMARK_UNSUPPORTED_FORMAT' ? e.message : 'Watermark failed.'
          this.#sendDownloadErrorNotice(code, TryAgainMsg)
        } finally {
          try { await unlink(tempPath) } catch (_) { /* ignore */ }
        }
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
      }
    })
  }

  /**
   * Download + decrypt a file to an explicit output path, then verify hash.
   * Used by watermark flow to get decrypted file before applying watermark.
   */
  async #downloadDecryptToPath(fileId, filename, cipher, spk, size, proxied, blockchainFileInfo, outputPath) {
    const writeStream = createWriteStream(outputPath)
    let writeCompleteResolve, writeCompleteReject
    const writeCompletePromise = new Promise((resolve, reject) => {
      writeCompleteResolve = resolve
      writeCompleteReject = reject
    })
    writeStream.on('finish', () => writeCompleteResolve())
    writeStream.on('error', async (err) => {
      logger.error(err)
      try { await unlink(outputPath) } catch (_) { /* ignore */ }
      writeCompleteReject(err)
    })

    const decipher = await this.aesModule.decrypt(cipher, spk, proxied)
    decipher.on('error', async (err) => {
      logger.error(err)
      this.#sendDownloadErrorNotice('File decryption failed.', ContactManagerOrTryAgainMsg)
      try { await unlink(outputPath) } catch (_) { /* ignore */ }
    })

    const pipeProgress = createPipeProgress({ total: size }, logger)
    const hashPromise = this.aesModule.makeHashPromise(pipeProgress)
    pipeProgress.pipe(decipher)
    decipher.pipe(writeStream)

    const protocol = GlobalValueManager.serverConfig.protocol
    try {
      switch (protocol) {
        case 'https':
          await downloadFileProcessHttps(fileId, pipeProgress, outputPath)
          break
        case 'ftps':
          await downloadFileProcessFtps(fileId, pipeProgress, outputPath)
          break
        case 'sftp':
          await downloadFileProcessSftp(fileId, pipeProgress, outputPath)
          break
        default:
          throw new Error('Invalid file protocol')
      }
      await writeCompletePromise
    } catch (error) {
      logger.error(error)
      this.#sendDownloadErrorNotice(`Download failed.`, CheckLogForDetailMsg)
      throw error
    }

    // Verify hash
    try {
      const fileHash = await hashPromise
      const blockchainHash = bigIntToHex(blockchainFileInfo.fileHash, 64)
      if (fileHash !== blockchainHash) {
        logger.error(`Hash mismatch for ${fileId}`)
        this.#sendDownloadErrorNotice('File hash mismatch. File may be modified.', ContactManagerOrTryAgainMsg)
        socket.emit('download-file-hash-error', { fileId, fileHash, blockchainHash })
        try { await unlink(outputPath) } catch (_) { /* ignore */ }
        throw new Error('Hash mismatch')
      }
      logger.info(`[WM] Hash verified for ${fileId}`)
    } catch (error) {
      if (error.message !== 'Hash mismatch') {
        logger.error(error)
        this.#sendDownloadErrorNotice('Hash verification failed.')
      }
      throw error
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public helpers used by BatchDownloadManager.
  //
  // These mirror the per-file logic from `downloadFileProcess` /
  // `#downloadWithWatermark` but accept an explicit output path, return a
  // promise, and never spawn save/folder dialogs. Every helper throws on
  // failure so the batch loop can record per-item errors.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Resolve the per-file metadata required for a download:
   *  - server-side fileInfo (cipher, spk, size, owner)
   *  - blockchain verification + canonical fileInfo (for hash check)
   * Throws on any failure with a human-readable message.
   *
   * Used by BatchDownloadManager so each file in a batch only goes through
   * the verification dance once, regardless of mode (original/watermark).
   *
   * @param {string} fileId
   * @returns {Promise<{
   *   id: string, name: string, cipher: any, spk: any, size: number,
   *   proxied: boolean, blockchainFileInfo: any
   * }>}
   */
  async getDownloadMeta(fileId) {
    const fileInfo = await new Promise((resolve, reject) => {
      // 15s ack timeout: a dead/reconnecting socket would otherwise buffer the
      // emit forever and hang the download (and any batch) with no error.
      socket.timeout(15000).emit('download-file-pre', { fileId }, (timeoutErr, response) => {
        if (timeoutErr) return reject(new Error('Server did not respond (connection lost?).'))
        if (response?.errorMsg) return reject(new Error(response.errorMsg))
        if (!response?.fileInfo) return reject(new Error('File not found'))
        resolve(response.fileInfo)
      })
    })

    const bv = await this.blockchainManager.getFileVerification(
      fileId,
      fileInfo.verifyblocknumber
    )
    if (!bv || bv.verificationInfo !== 'success') {
      throw new Error('File not verified on blockchain.')
    }

    const blockchainFileInfo = await this.blockchainManager.getFileInfo(
      fileId,
      fileInfo.infoblocknumber
    )
    if (!blockchainFileInfo) {
      throw new Error('File info not on blockchain.')
    }

    const proxied = fileInfo.ownerId !== fileInfo.originOwnerId
    const { id, name, cipher, spk, size } = fileInfo
    return { id, name, cipher, spk, size, proxied, blockchainFileInfo }
  }

  /**
   * Download + decrypt + verify hash, writing the plaintext bytes to
   * `outputPath`. No watermark is applied; this is the batch-friendly
   * counterpart of `downloadFileProcess2` minus the save dialog.
   *
   * @param {Awaited<ReturnType<FileManager['getDownloadMeta']>>} meta
   * @param {string} outputPath
   */
  async downloadOriginalToPath(meta, outputPath) {
    await this.#downloadDecryptToPath(
      meta.id,
      meta.name,
      meta.cipher,
      meta.spk,
      meta.size,
      meta.proxied,
      meta.blockchainFileInfo,
      outputPath
    )
  }

  /**
   * Download + decrypt to a temp path, apply visible/invisible watermark
   * using the server-authenticated metadata, then write the result to
   * `outputPath`. The temp file is cleaned up regardless of success.
   *
   * @param {string} fileId
   * @param {Awaited<ReturnType<FileManager['getDownloadMeta']>>} meta
   * @param {string} outputPath
   * @param {object} watermarkOptions  same shape as DownloadOptionsDialog
   */
  async downloadWatermarkedToPath(fileId, meta, outputPath, watermarkOptions) {
    // ── Phase 1 of two-phase commit ─────────────────────────────────
    // Ask the server for authenticated watermark meta. Server stashes a
    // pending download_logs row keyed by `requestId`; it won't be flushed
    // to the DB until we send back `confirm-watermark-download` with
    // success=true. See server FileManager.js pendingWatermarkDownloads
    // comment for the full rationale.
    const { requestId, watermarkMeta } = await new Promise((resolve, reject) => {
      socket.emit(
        'download-file-with-watermark',
        {
          fileId,
          mode: 'watermark',
          watermark: {
            visible: watermarkOptions?.visible === true,
            invisible: watermarkOptions?.invisible === true,
            customNote: watermarkOptions?.customNote ?? '',
            position: watermarkOptions?.position ?? 'bottomRight',
            opacity: watermarkOptions?.opacity ?? 0.3,
            fontSize: watermarkOptions?.fontSize ?? 14
          }
        },
        (response) => {
          if (response?.errorMsg) {
            reject(new Error(response.errorMsg))
          } else {
            resolve({
              requestId: response?.requestId,
              watermarkMeta: response?.watermarkMeta
            })
          }
        }
      )
    })

    const mimeType = watermarkOptions?.mimeType ?? getMimeFromFilename(meta.name)
    const tempPath = resolve(
      GlobalValueManager.tempPath,
      `${meta.id}_wmbatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    )

    try {
      // 2. Download + decrypt to temp path (with hash verify).
      await this.#downloadDecryptToPath(
        meta.id,
        meta.name,
        meta.cipher,
        meta.spk,
        meta.size,
        meta.proxied,
        meta.blockchainFileInfo,
        tempPath
      )

      try {
        // 3. Apply watermarks. Visible and invisible payloads are different on
        // purpose — see comment block above _buildVisibleWmText / _buildInvisibleWmText.
        const decryptedBuffer = await readFile(tempPath)
        const note = watermarkOptions?.customNote
        const visibleText = _buildVisibleWmText(watermarkMeta, note)
        // Invisible payload intentionally omits the user note (see _buildInvisibleWmText).
        const invisibleText = _buildInvisibleWmText(watermarkMeta)

        // Route by the ACTUAL content type, not the filename extension. A file
        // stored under a mismatched name (e.g. PDF content with a .png name)
        // would otherwise be fed to the wrong engine and crash — Jimp throws
        // "Mime type application/pdf does not support decoding".
        const sniffedMime = getMimeFromBuffer(decryptedBuffer)
        const effectiveMime = sniffedMime || mimeType
        if (sniffedMime && sniffedMime !== mimeType) {
          logger.warn(
            `[Download] content type ${sniffedMime} differs from filename type ${mimeType} for "${meta.name}" — watermarking as ${sniffedMime}.`
          )
        }

        let processedBuffer = decryptedBuffer
        // [diag] Confirms whether each watermark layer actually ran at runtime.
        logger.info(
          `[Download][diag] watermarking fileId=${fileId} mime=${effectiveMime || 'null'} ` +
            `visible=${watermarkOptions?.visible === true} invisible=${watermarkOptions?.invisible === true} ` +
            `decryptedBytes=${decryptedBuffer.length}`
        )
        if (watermarkOptions?.visible === true) {
          processedBuffer = await applyVisibleWatermark(processedBuffer, effectiveMime, {
            text: visibleText,
            position: watermarkOptions?.position ?? 'bottomRight',
            opacity: watermarkOptions?.opacity ?? 0.3,
            fontSize: watermarkOptions?.fontSize ?? 14
          })
        }
        if (watermarkOptions?.invisible === true) {
          processedBuffer = await applyInvisibleWatermark(processedBuffer, effectiveMime, {
            text: invisibleText
          })
          logger.info(
            `[Download][diag] invisible watermark applied — bytes ${decryptedBuffer.length} → ${processedBuffer.length}`
          )
        }
        // For images, (re)write the watermark metadata markers so they reflect
        // EXACTLY what this download applied — invisible always, visible only
        // when chosen — stripping any marker inherited from the source file.
        if (effectiveMime === 'image/png' || effectiveMime === 'image/jpeg') {
          processedBuffer = applyImageWatermarkMarkers(processedBuffer, effectiveMime, {
            invisibleText: watermarkOptions?.invisible === true ? invisibleText : null,
            visibleText: watermarkOptions?.visible === true ? visibleText : null
          })
        }
        // 4. Final writeFile — this is the moment the user actually has the
        //    file. If it throws, the catch below will cancel the log entry.
        await writeFile(outputPath, processedBuffer)
      } finally {
        try { await unlink(tempPath) } catch (_) { /* ignore */ }
      }

      // ── Phase 2: commit ───────────────────────────────────────────
      // We reached here ⇒ the file is on disk. Fire-and-forget: if the
      // confirm RPC fails we still keep the file (it's already written),
      // and the pending entry will eventually TTL-expire on the server.
      void this.#confirmWatermarkDownload(requestId, true)
    } catch (err) {
      // Phase 2: cancel. Best-effort tell the server to drop the pending
      // log row immediately rather than waiting for TTL — keeps the audit
      // log clean.
      void this.#confirmWatermarkDownload(requestId, false, err?.message)
      throw err
    }
  }

  /**
   * Send the two-phase commit confirmation. Resolves silently on any error
   * — caller is fire-and-forget. See server's `confirm-watermark-download`
   * handler for behaviour.
   * @param {string | undefined} requestId
   * @param {boolean} success
   * @param {string} [errorMsg]
   */
  async #confirmWatermarkDownload(requestId, success, errorMsg) {
    if (!requestId) return  // legacy server, nothing to confirm
    try {
      await new Promise((resolve) => {
        // We don't propagate timeouts here — even if the ack never comes,
        // the server-side TTL sweep will eventually reclaim the pending row.
        socket.emit(
          'confirm-watermark-download',
          { requestId, success, errorMsg: errorMsg?.slice?.(0, 500) },
          () => resolve()
        )
      })
    } catch (e) {
      logger.warn(`Failed to confirm watermark download ${requestId}: ${e?.message}`)
    }
  }

  /**
   * Ask to delete a file on server.
   * @param {string} fileId
   */
  deleteFileProcess(fileId) {
    logger.info(`Asking to delete file ${fileId}...`)
    socket.emit('delete-file', { fileId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to delete file ${fileId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to delete file', 'error')
      } else {
        logger.info(`Success to delete file ${fileId}`)
        GlobalValueManager.sendNotice('Success to delete file', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to add a folder.
   * @param {*} parentFolderId
   * @param {*} folderName
   */
  addFolderProcess(parentFolderId, folderName) {
    logger.info(`Asking to add folder ${folderName}...`)
    socket.emit('add-folder', { parentFolderId, folderName }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to add folder ${folderName}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to add folder', 'error')
      } else {
        logger.info(`Success to add folder ${folderName}`)
        GlobalValueManager.sendNotice('Success to add folder', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to delete a folder
   * @param {*} folderId
   */
  deleteFolderProcess(folderId) {
    logger.info(`Asking to delete folder ${folderId}...`)
    socket.emit('delete-folder', { folderId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to delete folder: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to delete folder', 'error')
      } else {
        logger.info(`Success to delete folder ${folderId}`)
        GlobalValueManager.sendNotice('Success to delete folder', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to get all folders. Used for selecting destination for moving files.
   * @returns
   */
  getAllFoldersProcess() {
    logger.info('Asking for all folders...')
    return new Promise((resolve) => {
      socket.emit('get-all-folders', (response) => {
        const { folders, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get all folders: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get all folders', 'error')
          resolve(null)
        } else {
          resolve(folders)
        }
      })
    })
  }

  /**
   * Ask to move file to a certain folder.
   * @param {*} fileId
   * @param {*} targetFolderId
   */
  moveFileProcess(fileId, targetFolderId) {
    logger.info(`Asking to move file ${fileId} to ${targetFolderId}...`)
    socket.emit('move-file', { fileId, targetFolderId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to move file ${fileId} to ${targetFolderId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to move file', 'error')
      } else {
        logger.info(`Moved file ${fileId} to ${targetFolderId}`)
        GlobalValueManager.sendNotice('Success to move file', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to get all public files. Should not be called.
   * @returns
   */
  getAllPublicFilesProcess() {
    logger.info('Asking for all public files...')
    return new Promise((resolve) => {
      socket.emit('get-public-files', (response) => {
        const { files, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get all public files: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get all public files', 'error')
          resolve(null)
        } else {
          resolve(files)
        }
      })
    })
  }

  /**
   * Ask to search files with the provided tags.
   * @param {*} param0
   * @returns
   */
  // async searchFilesProcess({ tags }) {
  //   logger.info(`Searching with tags ${tags}`)
  //   try {
  //     tags = tags.filter((tag) => tag != '').slice(0, 5)
  //     // Calculate the trapdoor
  //     let TK = this.TK
  //     if (!TK) TK = await this.abseManager.Trapdoor(tags)
  //     // const TK = await this.abseManager.Trapdoor(tags)


  //     return new Promise((resolve, reject) => {
  //       console.log('tags=', tags.join(','))
  //       console.log('TStar head=', TK.TStar?.slice(0, 12))
  //       console.log('sky head=', TK.sky?.slice(0, 12))
  //       const nonZeroIdx = TK.T?.map((x,i)=> x !== '0'.repeat(x.length) ? i : -1).filter(i=>i>=0)
  //       console.log('nonZeroIdx=', nonZeroIdx)
  //       socket.emit('search-files', { TK, tags }, (response) => {
  //         logger.debug(`Server respond search`, response)
  //         const { errorMsg, files } = response
  //         if (errorMsg) {
  //           logger.error(`Failed to search files: ${errorMsg}`)
  //           GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
  //           reject(errorMsg)
  //         } else {
  //           resolve(files)
  //         }
  //       })
  //     })
  //   } catch (error) {
  //     logger.error(error)
  //     GlobalValueManager.sendNotice(
  //       'Failed to search file because of trapdoor calculation',
  //       'error'
  //     )
  //   }
  // }

//   async searchFilesProcess({ tags }) {
//   logger.info(`Searching with tags ${tags}`)
//   try {
//     tags = tags.filter((tag) => tag != '').slice(0, 5)

//     // ✅ 每個 tag 各自做 trapdoor => OR 搜尋
//     const TKs = []
//     for (const tag of tags) {
//       const tk = await this.abseManager.Trapdoor([tag]) // 注意：這裡只放單一 tag
//       TKs.push(tk)
//     }

//     return new Promise((resolve, reject) => {
//       logger.info('Search payload', { tags, TKsCount: TKs.length })
//       socket.emit('search-files', { TKs, tags }, (response) => {
//         const { errorMsg, files } = response
//         if (errorMsg) {
//           logger.error(`Failed to search files: ${errorMsg}`)
//           GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
//           reject(errorMsg)
//         } else {
//           resolve(files)
//         }
//       })
//     })
//   } catch (error) {
//     logger.error(error)
//     GlobalValueManager.sendNotice('Failed to search file because of trapdoor calculation', 'error')
//   }
// }
async searchFilesProcess({ tags }) {
  logger.info(`Searching with tags ${tags}`)
  try {
    tags = tags
      .filter((t) => t != null && t !== '')
      .map((t) => t.trim().normalize('NFC'))
      .filter((t) => t.length > 0)
      .slice(0, 5)

    if (tags.length === 0) {
      return []
    }

    // 每個 tag 各自做 trapdoor → 後端逐 tag OR 搜尋並去重
    // (server 的 SearchFileRequestSchema 已改為 { TKs, tags }，
    //  舊的 { TK, tags } 會被驗收但走不到搜尋分支，導致
    //  "Trapdoor count does not match tags." 錯誤)
    const TKs = []
    for (const tag of tags) {
      const tk = await this.abseManager.Trapdoor([tag])
      TKs.push(tk)
    }

    return new Promise((resolve, reject) => {
      logger.info('Search payload', { tags, TKsCount: TKs.length })
      socket.emit('search-files', { TKs, tags }, (response) => {
        const { errorMsg, files } = response
        if (errorMsg) {
          logger.error(`Failed to search files: ${errorMsg}`)
          GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
          reject(errorMsg)
        } else {
          resolve(files)
        }
      })
    })
  } catch (error) {
    logger.error(error)
    GlobalValueManager.sendNotice('Failed to search file because of trapdoor calculation', 'error')
  }
}

  /**
   * Forensic helper: ask the server to decode a tracked watermark uid back to
   * the original user (or list candidates when the value is only a short
   * prefix from a visible watermark). Used by the WatermarkDetectPage.
   *
   * The server holds the watermark tracking key — without it nobody, including
   * this client, can decode tracked uids. That's the whole point: an attacker
   * who tampers with an invisible watermark can't fabricate a value that maps
   * to a different real user.
   *
   * @param {string} value tracked uid (`v1...`) or short hex prefix
   * @returns {Promise<{ matches?: Array<{id,name,email,status}>, errorMsg?: string, reason?: string }>}
   */
  decodeWatermarkUidProcess(value) {
    return new Promise((resolve) => {
      socket.emit('decode-watermark-uid', { value }, (response) => {
        resolve(response || {})
      })
    })
  }

  /**
   * Batch update permission/description/tags/attrs for multiple files at once.
   * Computes CTw once and applies it to all fileIds in parallel.
   * @returns {{ succeeded: string[], failed: string[] }}
   */
  async batchUpdateFileDescPermProcess({ fileIds, desc, perm, selectedAttrs, tags }) {
    const succeeded = []
    const failed = []
    try {
      tags = tags.filter((t) => t !== '').slice(0, 5)
      const pp = await this.abseManager.getPP()
      const globalAttrs = pp ? pp.U : []
      selectedAttrs = selectedAttrs.filter((attr) => globalAttrs.includes(attr))
      const attrIds = selectedAttrs.map((attr) => globalAttrs.indexOf(attr))

      logger.debug(
        `[batchUpdate] Starting batch update: fileIds=${JSON.stringify(fileIds)}, perm=${perm}, tags=${JSON.stringify(tags)}, selectedAttrs=${JSON.stringify(selectedAttrs)}, attrIds=${JSON.stringify(attrIds)}, desc.length=${desc?.length}`
      )

      // Compute CTw once for all files (same tags/attrs for the whole batch)
      let CTw = null
      if (perm == 1 && tags.length > 0) {
        CTw = await this.abseManager.Enc(tags, selectedAttrs)
        logger.debug(`[batchUpdate] CTw computed for tags=${JSON.stringify(tags)}`)
      } else {
        logger.debug(
          `[batchUpdate] CTw skipped: perm=${perm}, tags.length=${tags.length}`
        )
      }

      await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            await new Promise((resolve, reject) => {
              logger.debug(
                `[batchUpdate] Emitting update-file-desc-perm for fileId=${fileId}, permission=${perm}, tags=${JSON.stringify(tags)}, hasCTw=${!!CTw}`
              )
              socket.emit(
                'update-file-desc-perm',
                { fileId, description: desc, permission: perm, CTw, tags, attrIds },
                (response) => {
                  if (response.errorMsg) {
                    logger.error(
                      `[batchUpdate] Server returned error for fileId=${fileId}: ${response.errorMsg}`
                    )
                    reject(new Error(response.errorMsg))
                  } else {
                    logger.debug(
                      `[batchUpdate] Server OK for fileId=${fileId}. tags/attrIds stored in PostgreSQL.`
                    )
                    resolve()
                  }
                }
              )
            })
            succeeded.push(fileId)
          } catch (e) {
            logger.error(`[batchUpdate] Failed to update fileId=${fileId}: ${e.message}`)
            failed.push(fileId)
          }
        })
      )

      logger.debug(
        `[batchUpdate] Done. succeeded=${JSON.stringify(succeeded)}, failed=${JSON.stringify(failed)}`
      )
      // Refresh file list once after all local DB writes are complete
      this.getFileListProcess(GlobalValueManager.curFolderId)
    } catch (error) {
      logger.error(`[batchUpdate] Outer error: ${error}`)
    }
    return { succeeded, failed }
  }

  /**
   * Ask to update file description, permission, attribute and tags.
   * @param {*} param0
   */
  async updateFileDescPermProcess({ fileId, desc, perm, selectedAttrs, tags }) {
    const actionStr = `update file ${fileId} description, permission and index`
    try {
      // Filter tags to remove empty and keep first five
      tags = tags.filter((tag) => tag != '').slice(0, 5)
      // Filter selectedAttrs to only keep those in pp.U
      const globalAttrs = (await this.abseManager.getPP()).U
      selectedAttrs = selectedAttrs.filter((attr) => globalAttrs.includes(attr))
      // Calculate TK if perm is public(1) and tags is not empty
      let CTw = null
      if (perm == 1 && tags.length > 0) {
        CTw = await this.abseManager.Enc(tags, selectedAttrs)
        // Testing if can be searched correctly
        // const TK = await this.abseManager.Trapdoor(tags)
        // this.TK = TK
        // const matchedFiles = await this.abseManager.Search(TK, [{ ...CTw, fileid: fileId }])
        // logger.debug(`matched files when update index: ${matchedFiles}`)
        logger.debug(`Selected tags: ${tags}, selected attrs: ${selectedAttrs}`)
      }
      const attrIds = selectedAttrs.map((attr) => globalAttrs.indexOf(attr))
      logger.info(`Asking to ${actionStr}...`)
      socket.emit(
        'update-file-desc-perm',
        { fileId, description: desc, permission: perm, CTw, tags, attrIds },
        (response) => {
          const { errorMsg } = response
          if (errorMsg) {
            logger.error(`Failed to ${actionStr}: ${errorMsg}`)
            GlobalValueManager.sendNotice(`Failed to ${actionStr}`, 'error')
          } else {
            // tags and attrIds are now stored in PostgreSQL by the server
            logger.info(`Success to ${actionStr}`)
            GlobalValueManager.sendNotice(`Success to ${actionStr}`, 'success')
            this.getFileListProcess(GlobalValueManager.curFolderId)
          }
        }
      )
    } catch (error) {
      logger.error(error)
      GlobalValueManager.sendNotice(`Failed to ${actionStr}`, 'error')
    }
  }
}

export default FileManager
