/**
 * Main-process runtime state for the smart-classify feature.
 *
 * appClassifierEnabled defaults to true — the per-upload on/off switch
 * (uploadBatchSmartClassifyMode) is the only user-facing gate.
 * Set to false via IPC if you add a global master switch.
 *
 * 2026-10: only one model tier remains ('fast' = Gemma 4 E4B-it). The former
 * 'medium' (9B) and 'high' (27B) tiers were removed; those legacy values are
 * still accepted from old renderer state / IPC callers and map to 'fast'.
 */

/** @type {readonly ['off', 'fast']} */
const VALID_MODES = ['off', 'fast']
/** Legacy tiers that no longer exist; treated as "on". */
const LEGACY_ON_MODES = ['medium', 'high']

let appClassifierEnabled = true

/** @type {'off'|'fast'} */
let uploadBatchSmartClassifyMode = 'off'

export function setAppClassifierEnabled(v) {
  appClassifierEnabled = Boolean(v)
}

export function getAppClassifierEnabled() {
  return appClassifierEnabled
}

/** @param {'off'|'fast'|'medium'|'high'|boolean} v */
export function setUploadBatchSmartClassifyWanted(v) {
  if (typeof v === 'boolean') {
    uploadBatchSmartClassifyMode = v ? 'fast' : 'off'
  } else if (LEGACY_ON_MODES.includes(v)) {
    uploadBatchSmartClassifyMode = 'fast'
  } else if (VALID_MODES.includes(v)) {
    uploadBatchSmartClassifyMode = v
  } else {
    uploadBatchSmartClassifyMode = 'off'
  }
}

export function getUploadBatchSmartClassifyWanted() {
  return uploadBatchSmartClassifyMode !== 'off'
}

/** @returns {'off'|'fast'} */
export function getSmartClassifyMode() {
  return uploadBatchSmartClassifyMode
}
