import { ipcMain } from 'electron'
import { classifyDocuments } from '../services/ClassifyService.js'
import {
  getPreUploadClassifyEntry,
  clearPreUploadClassifyEntry
} from '../services/preUploadClassifyCache.js'
import GlobalValueManager from '../GlobalValueManager.js'

/** @type {null | { batchUpdateFileDescPermProcess: (p: object) => Promise<unknown> }} */
let fileManagerRef = null
let registered = false

/**
 * @param {unknown} fm main FileManager instance (must expose batchUpdateFileDescPermProcess)
 */
export function setFileManagerForUploadPostIpc(fm) {
  fileManagerRef = fm
}

/** Registers IPC for PostUploadDialog + LLM classification (idempotent). */
export function registerUploadPostIpcOnce() {
  if (registered) return
  registered = true

  ipcMain.handle('classify-documents', async (_, input) => classifyDocuments(input))

  ipcMain.handle('preupload-classify-snapshot', async (_, batchKey) => {
    if (typeof batchKey !== 'string' || !batchKey.trim()) return null
    return getPreUploadClassifyEntry(batchKey.trim()) ?? null
  })

  // V7: renderer calls this when the PostUploadDialog closes so the cached
  // result (which can be large) is released promptly instead of lingering
  // until TTL/LRU eviction.
  ipcMain.handle('preupload-classify-clear', async (_, batchKey) => {
    if (typeof batchKey !== 'string' || !batchKey.trim()) return false
    clearPreUploadClassifyEntry(batchKey.trim())
    return true
  })

  ipcMain.handle('file-manager:start-upload', async (_, folderId) => {
    if (!fileManagerRef || typeof fileManagerRef.uploadFileProcess !== 'function') {
      throw new Error('FileManager is not ready for upload')
    }
    const fid =
      folderId != null && folderId !== ''
        ? folderId
        : GlobalValueManager.curFolderId
    await fileManagerRef.uploadFileProcess(fid)
  })

  ipcMain.handle('file-manager:refresh-list', (_, folderId) => {
    if (!fileManagerRef || typeof fileManagerRef.getFileListProcess !== 'function') {
      throw new Error('FileManager is not ready for file list')
    }
    const fid =
      folderId != null && folderId !== ''
        ? folderId
        : GlobalValueManager.curFolderId
    fileManagerRef.getFileListProcess(fid)
    return true
  })

  ipcMain.handle('ask-batch-update-file-desc-perm', async (_, payload) => {
    if (!fileManagerRef || typeof fileManagerRef.batchUpdateFileDescPermProcess !== 'function') {
      throw new Error('FileManager is not ready for batch update')
    }
    return fileManagerRef.batchUpdateFileDescPermProcess(payload)
  })
}
