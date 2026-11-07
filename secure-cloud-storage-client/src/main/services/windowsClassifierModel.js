/**
 * Windows model manager for smart classify.
 *
 * The Windows installer ships without the ~5 GB model (NSIS caps a single
 * installer at about 2 GB), so the user downloads or imports it the first time
 * smart classify is switched on. This module owns that flow plus the Windows-
 * only runtime rules used by LlamaCppClient / ClassifyService:
 *   - model search order with the managed folder (classifierModelLocator.js);
 *   - status, download (resume + SHA-256), offline import, in-place verify;
 *   - cancelling a model load or inference, load timeout, longer inference
 *     timeout, and progress events on the `classifier-llm-progress` channel.
 *
 * getWindowsClassifierSupport() returns null on macOS / Linux, in Windows dev
 * mode and when SCS_MODEL_MANAGER=0. Callers then keep their original code
 * path, so macOS never runs anything in here. Nothing runs at import time.
 */
import { app, BrowserWindow, dialog, net } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { totalmem } from 'node:os'
import nodePath from 'node:path'
import { logger } from '../Logger.js'
import { CLASSIFY_MODEL } from './classifierModelManifest.js'
import {
  getManagedModelDir,
  isModelManagerEnabled,
  resolveModelPath
} from './classifierModelLocator.js'
import { ClassifierModelError, MODEL_ERROR } from './classifierModelErrors.js'
import {
  DISK_MARGIN_BYTES,
  STORE_ERROR,
  downloadModel,
  getFreeBytes,
  getModelFileState,
  importModel,
  partPathFor,
  sizeOrZero,
  verifyInPlace
} from './classifierModelStore.js'

/**
 * Windows-only timeouts (fix plan §4.5). Stage-0 measurements on Windows 11,
 * i7-8700K (6C), RTX 2080 Ti, 2026-11-06: one inference took 61–65 s on the
 * CPU backend and 50 s on the first Vulkan run (one-off shader compile; later
 * runs 2–4 s). 90 s leaves too little room for slower laptop CPUs, so Windows
 * allows 180 s. macOS keeps the shared 90 s.
 */
export const WINDOWS_GENERATE_TIMEOUT_MS = 180_000
/** Model load measured at 5–9 s from the file cache; generous for HDDs and AV scans. */
export const WINDOWS_LOAD_TIMEOUT_MS = 300_000
/** Peak working set measured at 5.6 GB (CPU) / 3.8–4.0 GB (Vulkan) with the 4096 context. */
export const RECOMMENDED_RAM_BYTES = 16 * 1024 ** 3

const PROGRESS_CHANNEL = 'classifier-llm-progress'
const PROGRESS_INTERVAL_MS = 250

/** @type {undefined | null | ReturnType<typeof createSupport>} */
let support

/** @returns {null | ReturnType<typeof createSupport>} */
export function getWindowsClassifierSupport() {
  if (support === undefined) {
    const enabled = isModelManagerEnabled({
      platform: process.platform,
      isPackaged: app.isPackaged,
      env: process.env
    })
    support = enabled ? createSupport() : null
    if (support) logger.info(`[ModelManager] enabled; model folder: ${support.modelDir}`)
  }
  return support
}

function emit(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, payload)
  }
}

/** statfs needs an existing directory; the model folder may not exist yet. */
async function nearestExistingDir(dir) {
  let cur = dir
  for (;;) {
    try {
      if ((await stat(cur)).isDirectory()) return cur
    } catch {
      /* keep walking up */
    }
    const parent = nodePath.dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

const GB = 1024 ** 3
const fmtGB = (n) => `${(n / GB).toFixed(1)} GB`

/** User-facing text for a failed job (no paths; the log has the details). */
function jobErrorMessage(kind, e) {
  const code = e?.code
  switch (code) {
    case STORE_ERROR.CANCELLED:
      return kind === 'download' ? '已取消下載。已下載的部分會保留，下次可以接著下載。' : '已取消。'
    case STORE_ERROR.INSUFFICIENT_SPACE:
      return `磁碟空間不足：需要約 ${fmtGB(e.details?.required ?? 0)} 可用空間，目前只有 ${fmtGB(e.details?.free ?? 0)}。請清出空間後再試。`
    case STORE_ERROR.NETWORK_ERROR:
      return '網路中斷或無法連到模型下載網站。已下載的部分會保留，可以按「重試」接著下載；若網路封鎖了下載網站，請改用「匯入模型」。'
    case STORE_ERROR.HTTP_ERROR:
      return `模型下載網站回應錯誤${e.details?.status ? `（HTTP ${e.details.status}）` : ''}。請稍後重試，或改用「匯入模型」。`
    case STORE_ERROR.NAME_MISMATCH:
      return `檔名不符，請選擇 ${CLASSIFY_MODEL.filename}。`
    case STORE_ERROR.NOT_A_FILE:
      return '無法讀取選擇的檔案。'
    case STORE_ERROR.SIZE_MISMATCH:
      return kind === 'download'
        ? '下載到的檔案大小不符，請重試。'
        : '檔案大小不符，不是這個版本的模型檔。'
    case STORE_ERROR.HASH_MISMATCH:
      return kind === 'download'
        ? '檔案校驗失敗（SHA-256 不符），已刪除這次下載的檔案，請重新下載。'
        : '檔案校驗失敗（SHA-256 不符），不是正確或完整的模型檔。'
    case STORE_ERROR.REPLACE_FAILED:
      return '模型已通過校驗，但無法放進模型資料夾（檔案可能正在使用中）。請重新啟動程式後再試一次。'
    default:
      return '讀寫檔案時發生錯誤，請確認磁碟空間與權限後重試。'
  }
}

function createSupport() {
  const modelDir = getManagedModelDir({
    env: process.env,
    homedir: app.getPath('home'),
    appName: app.getName()
  })
  const managedPath = nodePath.join(modelDir, CLASSIFY_MODEL.filename)

  /** Passed to resolveModelPath(): verified managed file first, then a bundled copy. */
  const managedLocation = {
    dir: modelDir,
    isReady: (p) => getModelFileState(p, CLASSIFY_MODEL) === 'ready',
    exists: (p) => existsSync(p)
  }

  function locate() {
    return resolveModelPath({
      filename: CLASSIFY_MODEL.filename,
      env: process.env,
      isDev: !app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      managed: managedLocation
    })
  }

  /** @returns {'ready' | 'missing' | 'invalid' | 'unverified' | 'env-missing'} */
  function modelState(loc = locate()) {
    if (loc.source === 'env') return existsSync(loc.path) ? 'ready' : 'env-missing'
    if (loc.source === 'bundled') return 'ready'
    return getModelFileState(loc.path, CLASSIFY_MODEL)
  }

  // ── Download / import / verify jobs (one at a time) ──────────────────────
  /** @type {null | { kind: 'download' | 'import' | 'verify', step: string, received: number, total: number, controller: AbortController }} */
  let job = null
  const BUSY = Object.freeze({
    ok: false,
    code: 'BUSY',
    message: '已有模型下載、匯入或校驗正在進行。'
  })

  async function runJob(kind, work) {
    if (job) return BUSY
    const controller = new AbortController()
    job = { kind, step: 'prepare', received: 0, total: CLASSIFY_MODEL.size, controller }
    emit({ phase: 'model-job', kind, state: 'start' })
    let lastEmit = 0
    const onProgress = ({ step, received, total }) => {
      job.step = step
      job.received = received
      job.total = total
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        emit({ phase: 'model-job', kind, state: 'progress', step, received, total })
      }
    }
    logger.info(`[ModelManager] ${kind} started → ${managedPath}`)
    try {
      await work({ signal: controller.signal, onProgress })
      logger.info(`[ModelManager] ${kind} finished; verified model at ${managedPath}`)
      emit({ phase: 'model-job', kind, state: 'done' })
      return { ok: true }
    } catch (e) {
      const cancelled = e?.code === STORE_ERROR.CANCELLED
      const message = jobErrorMessage(kind, e)
      if (cancelled) logger.info(`[ModelManager] ${kind} cancelled`)
      else logger.error(`[ModelManager] ${kind} failed (${e?.code ?? 'ERROR'}): ${e?.message}`)
      const code = e?.code ?? STORE_ERROR.IO_ERROR
      emit({ phase: 'model-job', kind, state: cancelled ? 'cancelled' : 'failed', code, message })
      return { ok: false, code, message }
    } finally {
      job = null
    }
  }

  // ── Load / inference cancellation ─────────────────────────────────────────
  // generate() records runEpoch when a request is queued. cancelRuns() aborts
  // the running load / inference and bumps the epoch, so requests queued
  // before the cancel fail fast instead of each starting a new load.
  let runEpoch = 0
  let runAbortCode = MODEL_ERROR.CANCELLED
  /** @type {Set<AbortController>} */
  const activeRuns = new Set()

  return {
    modelDir,
    managedPath,
    managedLocation,
    generateTimeoutMs: WINDOWS_GENERATE_TIMEOUT_MS,
    loadTimeoutMs: WINDOWS_LOAD_TIMEOUT_MS,

    /** Snapshot for the setup UI (no file paths). */
    async status() {
      const loc = locate()
      const state = modelState(loc)
      const partialBytes = await sizeOrZero(partPathFor(managedPath))
      let freeBytes = null
      try {
        freeBytes = await getFreeBytes(await nearestExistingDir(modelDir))
      } catch (e) {
        logger.warn(`[ModelManager] free-space probe failed: ${e.message}`)
      }
      return {
        managed: true,
        state,
        source: state === 'ready' ? loc.source : null,
        model: { name: CLASSIFY_MODEL.name, size: CLASSIFY_MODEL.size },
        partialBytes,
        disk: {
          freeBytes,
          requiredBytes: Math.max(0, CLASSIFY_MODEL.size - partialBytes) + DISK_MARGIN_BYTES
        },
        memory: { totalBytes: totalmem(), recommendedBytes: RECOMMENDED_RAM_BYTES },
        job: job && { kind: job.kind, step: job.step, received: job.received, total: job.total }
      }
    },

    /** null when a model can be loaded, else the reason (fix plan §4.4.1). */
    checkModelReady() {
      const loc = locate()
      const state = modelState(loc)
      if (state === 'ready') return null
      if (state === 'env-missing') {
        return new ClassifierModelError(
          MODEL_ERROR.ENV_PATH_INVALID,
          `LLAMA_MODEL_PATH points to a file that does not exist: "${loc.path}"`
        )
      }
      if (job) {
        return new ClassifierModelError(MODEL_ERROR.BUSY, `Model ${job.kind} still in progress`)
      }
      if (state === 'missing') {
        return new ClassifierModelError(
          MODEL_ERROR.NOT_INSTALLED,
          `Model not installed: "${loc.path}"`
        )
      }
      return new ClassifierModelError(MODEL_ERROR.INVALID, `Model file is ${state}: "${loc.path}"`)
    },

    /** Which source the next load will use ('env' | 'managed' | 'bundled'). */
    modelSource() {
      return locate().source
    },

    startDownload() {
      return runJob('download', ({ signal, onProgress }) =>
        downloadModel({
          url: CLASSIFY_MODEL.url,
          finalPath: managedPath,
          expected: CLASSIFY_MODEL,
          // Electron's network stack: honours the Windows proxy settings. The
          // pinned SHA-256 protects integrity regardless of TLS.
          fetchImpl: (url, init) => net.fetch(url, { ...init, cache: 'no-store' }),
          signal,
          onProgress
        })
      )
    },

    async startImport() {
      if (job) return BUSY
      const parent = BrowserWindow.getAllWindows()[0]
      const opts = {
        title: `選擇模型檔（${CLASSIFY_MODEL.filename}）`,
        properties: ['openFile'],
        filters: [{ name: 'GGUF 模型檔', extensions: ['gguf'] }]
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, code: 'PICK_CANCELLED', message: '' }
      }
      const sourcePath = picked.filePaths[0]
      logger.info(`[ModelManager] import from "${sourcePath}"`)
      return runJob('import', ({ signal, onProgress }) =>
        importModel({
          sourcePath,
          finalPath: managedPath,
          expected: CLASSIFY_MODEL,
          signal,
          onProgress
        })
      )
    },

    verifyExisting() {
      return runJob('verify', ({ signal, onProgress }) =>
        verifyInPlace({ finalPath: managedPath, expected: CLASSIFY_MODEL, signal, onProgress })
      )
    },

    cancelJob() {
      job?.controller.abort()
      return { ok: true }
    },

    runEpoch() {
      return runEpoch
    },

    /** Requests queued before the last cancelRuns() stop here. */
    throwIfCancelledSince(epoch) {
      if (typeof epoch === 'number' && epoch < runEpoch) {
        throw new ClassifierModelError(
          runAbortCode,
          'Smart-classify request dropped by an earlier cancel / load timeout'
        )
      }
    },

    /** @param {AbortController} controller @returns {() => void} release */
    trackRun(controller) {
      activeRuns.add(controller)
      return () => activeRuns.delete(controller)
    },

    /** Stop the running load / inference and everything queued before now. */
    cancelRuns(code = MODEL_ERROR.CANCELLED, message = 'Smart classify cancelled by the user') {
      runEpoch += 1
      runAbortCode = code
      for (const c of activeRuns) {
        c.abort(new ClassifierModelError(code, message))
      }
      logger.info(`[ModelManager] runs cancelled (${code}); epoch=${runEpoch}`)
      return { ok: true }
    },

    emit
  }
}
