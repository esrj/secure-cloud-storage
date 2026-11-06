/**
 * Admin IPC handlers (main-process side of the admin pages).
 *
 * Channels:
 *   admin:list-users            → { ok, users } | { ok:false, error }
 *   admin:export-conversations  → { ok, canceled? , path?, count? } | { ok:false, error }
 *                                 count is the number of messages written; the
 *                                 file holds one flat, oldest-first list.
 *   admin:user-download-logs    → { ok, logs } | { ok:false, error }
 *
 * The server enforces the admin role on every event; these handlers only
 * relay requests over the existing Socket.IO connection and, for the export,
 * write the JSON file the user picks in a save dialog.
 */
import { ipcMain, dialog, app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { socket } from '../MessageManager'
import GlobalValueManager from '../GlobalValueManager'
import { logger } from '../Logger'

const ACK_TIMEOUT_MS = 15000

/** Emit with ack + timeout; rejects on server errorMsg or no reply. */
export function emitWithAck(event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (timeoutErr, response) => {
      if (timeoutErr) return reject(new Error('Server did not respond.'))
      if (response?.errorMsg) return reject(new Error(response.errorMsg))
      resolve(response ?? {})
    })
  })
}

function safeFilePart(value) {
  return String(value || 'user')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 40)
}

let _registered = false

export function registerAdminIpcOnce() {
  if (_registered) return
  _registered = true

  ipcMain.handle('admin:list-users', async () => {
    try {
      const { users } = await emitWithAck('admin-list-users', {})
      return { ok: true, users: Array.isArray(users) ? users : [] }
    } catch (e) {
      logger.error(`[AdminIpc] list-users: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('admin:export-conversations', async (_event, { userId, userName } = {}) => {
    try {
      const data = await emitWithAck('admin-export-conversations', { userId })
      const date = new Date().toISOString().slice(0, 10)
      const defaultName = `對話紀錄_${safeFilePart(userName || data.user?.name)}_${date}.json`
      const opts = {
        title: '儲存對話紀錄',
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      // Parent the dialog to the main window so it can never open hidden behind it.
      const win = GlobalValueManager.mainWindow
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (canceled || !filePath) return { ok: true, canceled: true }

      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
      const count = Array.isArray(data.messages) ? data.messages.length : 0
      logger.info(`[AdminIpc] exported ${count} message(s) of ${userId} to ${filePath}`)
      return { ok: true, path: filePath, count }
    } catch (e) {
      logger.error(`[AdminIpc] export-conversations: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('admin:user-download-logs', async (_event, { userId } = {}) => {
    try {
      const { logs } = await emitWithAck('admin-user-download-logs', { userId })
      return { ok: true, logs: Array.isArray(logs) ? logs : [] }
    } catch (e) {
      logger.error(`[AdminIpc] user-download-logs: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })
}
