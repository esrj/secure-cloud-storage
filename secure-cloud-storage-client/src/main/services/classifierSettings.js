/**
 * Classifier configuration (main process).
 *
 * Model path resolution (in order):
 *   1. LLAMA_MODEL_PATH environment variable
 *   2. <userData>/models/model.gguf  (set by LlamaCppClient.getModelPath())
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
