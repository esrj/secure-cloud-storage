/** Local (renderer) preferences — master syncs via classifierSetEnabled IPC; upload-before syncs via classifier:set-upload-batch-smart-classify. */

const LS_MASTER = 'scs.smartClassify.featureEnabled'
/** 檔案列表「上傳時執行智慧分類」模式（與 main 同步） */
const LS_UPLOAD_MODE = 'scs.uploadBatchSmartClassifyMode'

/**
 * 2026-10：只剩「開 / 關」。'fast' 即開啟（固定使用本機 Gemma 4 E4B-it）；
 * 舊版留在 localStorage 的 'medium' / 'high' 一律視為開啟。
 * @type {readonly ['off','fast']}
 */
export const SMART_CLASSIFY_MODES = /** @type {const} */ (['off', 'fast'])
const LEGACY_ON_MODES = ['medium', 'high']

export function readSmartClassifyMasterEnabled() {
  try {
    return localStorage.getItem(LS_MASTER) === '1'
  } catch {
    return false
  }
}

/**
 * @param {boolean} v
 */
export function writeSmartClassifyMasterEnabled(v) {
  try {
    if (v) localStorage.setItem(LS_MASTER, '1')
    else localStorage.removeItem(LS_MASTER)
    window.dispatchEvent(new CustomEvent('scs-smart-classify-prefs-changed'))
  } catch {
    /* ignore */
  }
}

/** @returns {'off'|'fast'} */
export function readSmartClassifyMode() {
  try {
    const v = localStorage.getItem(LS_UPLOAD_MODE)
    if (v && SMART_CLASSIFY_MODES.includes(v)) return v
    if (v && LEGACY_ON_MODES.includes(v)) return 'fast'
  } catch { /* ignore */ }
  return 'off'
}

/** @param {'off'|'fast'} mode anything other than 'off' is stored as 'fast'. */
export function writeSmartClassifyMode(mode) {
  const normalized = mode === 'off' ? 'off' : 'fast'
  try {
    localStorage.setItem(LS_UPLOAD_MODE, normalized)
    window.dispatchEvent(new CustomEvent('scs-smart-classify-prefs-changed'))
  } catch { /* ignore */ }
}

/** @returns {boolean} true when smart classify is switched on. */
export function readSmartClassifyEnabled() {
  return readSmartClassifyMode() !== 'off'
}

/** @param {boolean} v */
export function writeSmartClassifyEnabled(v) {
  writeSmartClassifyMode(v ? 'fast' : 'off')
}

/** Backwards-compatible aliases (pre-2026-10 names). */
export const readUploadSmartClassifyBeforeUpload = readSmartClassifyEnabled
export const writeUploadSmartClassifyBeforeUpload = writeSmartClassifyEnabled
