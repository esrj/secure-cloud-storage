/**
 * Classifier configuration (main process).
 *
 * Model path resolution lives in LlamaCppClient.getModelPath() →
 * classifierModelLocator.js (in order):
 *   1. LLAMA_MODEL_PATH environment variable
 *   2. dev: <appPath>/resources/models/gemma-4-E4B-it-Q4_K_M.gguf
 *      installed: <resourcesPath>/models/gemma-4-E4B-it-Q4_K_M.gguf
 *   Windows installer: the model downloaded / imported by the Windows model
 *   manager (%LOCALAPPDATA%\<app>\models) comes before <resourcesPath>/models.
 *
 * Threshold:
 *   - CLASSIFIER_THRESHOLD env var (0–1, default 0.55)
 *   - or GlobalValueManager.classifier.threshold
 */

const DEFAULT_CLASSIFIER_THRESHOLD = 0.55

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function parseThreshold(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

import GlobalValueManager from '../GlobalValueManager.js'

/**
 * @returns {{ classifierThreshold: number }}
 */
export function getClassifierSettings() {
  let classifierThreshold = parseThreshold(
    process.env.CLASSIFIER_THRESHOLD,
    DEFAULT_CLASSIFIER_THRESHOLD
  )

  try {
    const g = GlobalValueManager
    const ct = g?.classifier?.threshold ?? g?.['classifier.threshold']
    if (ct != null && ct !== '') classifierThreshold = parseThreshold(ct, classifierThreshold)
  } catch {
    // ignore
  }

  return { classifierThreshold }
}
