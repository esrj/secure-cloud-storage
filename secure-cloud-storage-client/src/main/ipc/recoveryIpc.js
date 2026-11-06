/**
 * Security-key (fingerprint) recovery IPC, main-process side (指紋復原計劃，階段 3).
 *
 * Invoke channels, all answering { ok: true, ... } or { ok: false, error, code }:
 *   recovery:list-methods                         -> { methods }       logged in
 *   recovery:bind-key          { label? }         -> { method }        logged in
 *   recovery:delete-method     { methodId }       -> {}                logged in
 *   recovery:recover-with-key  { methodId }       -> {}                after the recovery email code
 *   recovery:key-info                             -> { info }          PIN / fingerprint state
 *   recovery:set-pin           { pin }            -> {}
 *   recovery:enroll-fingerprint { name? }         -> { templateId, enrolledCount }
 * Send channels:
 *   recovery:cancel                               abort the running key operation
 *   recovery:pin-response      { requestId, pin } answer to recovery:pin-request (pin null = cancel)
 * Main -> renderer:
 *   recovery:fido-event        { event, ... }     progress, see FidoProvider FidoHandlers
 *   recovery:pin-request       { requestId, retries }
 *
 * `code` comes from FidoProvider (e.g. NO_DEVICE, PIN_INVALID, UV_FAILED, WRONG_KEY, CANCELLED,
 * TIMEOUT, HELPER_START_FAILED), RecoveryManager (NOT_ENOUGH_SHARES, RESTORE_FAILED,
 * LOGIN_FAILED, BAD_SERVER_RESPONSE), or is SERVER when the server rejected the request.
 */
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import FidoProvider, { FidoError, resolveHelperPath } from '../FidoProvider.js'
import RecoveryManager, { RecoveryFlowError } from '../RecoveryManager.js'
import { encryptDataShareKey } from '../SecretSharing'
import GlobalValueManager from '../GlobalValueManager'
import { logger } from '../Logger'
import { emitWithAck } from './adminIpc.js'

const PIN_REQUEST_TIMEOUT_MS = 120000

/** @type {Map<string, (pin: string|null) => void>} */
const pendingPinRequests = new Map()

function sendToRenderer(channel, payload) {
  const win = GlobalValueManager.mainWindow
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Ask the renderer for the FIDO2 PIN. Resolves null when cancelled or unanswered. */
function requestPinFromRenderer({ retries }) {
  const win = GlobalValueManager.mainWindow
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const finish = (pin) => {
      clearTimeout(timer)
      pendingPinRequests.delete(requestId)
      resolve(pin)
    }
    const timer = setTimeout(() => finish(null), PIN_REQUEST_TIMEOUT_MS)
    pendingPinRequests.set(requestId, finish)
    win.webContents.send('recovery:pin-request', { requestId, retries })
  })
}

const keyHandlers = {
  onEvent: (evt) => sendToRenderer('recovery:fido-event', evt),
  requestPin: requestPinFromRenderer
}

function toFailure(error) {
  if (error instanceof FidoError || error instanceof RecoveryFlowError) {
    return { ok: false, code: error.code, error: error.message }
  }
  return { ok: false, code: 'SERVER', error: error?.message || 'Unexpected error.' }
}

/** Wrap a handler: never throw across IPC, never log PINs or request bodies. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, values = {}) => {
    try {
      return { ok: true, ...((await fn(values ?? {})) ?? {}) }
    } catch (error) {
      logger.error(`[RecoveryIpc] ${channel}: ${error?.code ?? ''} ${error?.message}`)
      return toFailure(error)
    }
  })
}

let _registered = false

/**
 * @param {import('../LoginManager').default} loginManager
 */
export function registerRecoveryIpcOnce(loginManager) {
  if (_registered) return
  _registered = true

  const fido = new FidoProvider({
    helperPath: resolveHelperPath({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    }),
    logger
  })
  const recovery = new RecoveryManager({
    emit: emitWithAck,
    fido,
    getSecretKeys: () => loginManager.getSecretKeys(),
    encryptShares: encryptDataShareKey,
    restoreFromShares: (extraKey, shares) => loginManager.restoreFromShares(extraKey, shares)
  })

  handle('recovery:list-methods', async () => ({ methods: await recovery.listMethods() }))
  handle('recovery:bind-key', async ({ label }) => ({
    method: await recovery.bindSecurityKey({ label }, keyHandlers)
  }))
  handle('recovery:delete-method', async ({ methodId }) => {
    await recovery.deleteMethod({ methodId })
  })
  handle('recovery:recover-with-key', async ({ methodId }) => {
    await recovery.recoverWithSecurityKey({ methodId }, keyHandlers)
  })
  handle('recovery:key-info', async () => ({ info: await recovery.getKeyInfo() }))
  handle('recovery:set-pin', async ({ pin }) => {
    await recovery.setPin({ pin })
  })
  handle('recovery:enroll-fingerprint', async ({ name }) =>
    recovery.enrollFingerprint({ name }, keyHandlers)
  )

  ipcMain.on('recovery:cancel', () => {
    for (const finish of pendingPinRequests.values()) finish(null)
    recovery.cancel()
  })
  ipcMain.on('recovery:pin-response', (_event, { requestId, pin } = {}) => {
    pendingPinRequests.get(requestId)?.(typeof pin === 'string' && pin.length > 0 ? pin : null)
  })

  logger.info(`[RecoveryIpc] registered, helper: ${fido.helperPath}`)
}
