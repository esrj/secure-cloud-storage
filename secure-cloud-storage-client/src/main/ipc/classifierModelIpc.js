/**
 * IPC for the Windows smart-classify model manager (download / import /
 * verify / cancel). Registered on Windows only; the preload exposes
 * `electronAPI.classifierModel` on Windows only, so macOS has neither.
 *
 * With the manager switched off (Windows dev mode, SCS_MODEL_MANAGER=0) every
 * handler answers { managed: false } / { ok: false } and the renderer keeps
 * its original behaviour.
 */
import { ipcMain } from 'electron'
import { getWindowsClassifierSupport } from '../services/windowsClassifierModel.js'

const OFF = Object.freeze({ ok: false, code: 'NOT_MANAGED', message: '' })

let registered = false

export function registerClassifierModelIpcOnce() {
  if (registered || process.platform !== 'win32') return
  registered = true

  ipcMain.handle('classifier-model:status', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.status() : { managed: false }
  })
  ipcMain.handle('classifier-model:download', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.startDownload() : OFF
  })
  ipcMain.handle('classifier-model:import', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.startImport() : OFF
  })
  ipcMain.handle('classifier-model:verify-existing', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.verifyExisting() : OFF
  })
  ipcMain.handle('classifier-model:cancel-job', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.cancelJob() : OFF
  })
  // Stops the model load / inference in progress and the requests queued behind it.
  ipcMain.handle('classifier-model:cancel-run', async () => {
    const win = getWindowsClassifierSupport()
    return win ? win.cancelRuns() : OFF
  })
}
