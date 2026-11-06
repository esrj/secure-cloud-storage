import { createHash } from 'node:crypto'
import { logger } from '../Logger.js'
import { classifyDocuments } from './ClassifyService.js'
import { getClassifierSettings } from './classifierSettings.js'
import { getWindowsClassifierSupport } from './windowsClassifierModel.js'
import { withUserHint } from './classifierModelErrors.js'

/** @typedef {{ state: 'running'|'done', result?: object, error?: string, ts?: number }} ClassifyEntry */

// ── Bounded cache (V7) ──────────────────────────────────────────────────────
// Previously this Map grew forever: clearPreUploadClassifyEntry existed but was
// never called, and every upload batch left a full LLM result behind. Over a
// long session that is an unbounded memory leak. We now cap the number of
// entries (LRU-ish: Map preserves insertion order, so we evict the oldest) and
// expire stale entries by age. The renderer also explicitly clears an entry
// when the PostUploadDialog closes (see preupload-classify-clear IPC).

/** Maximum number of cached batch results kept in memory at once. */
const MAX_CACHE_ENTRIES = 50

/** Entries older than this are considered stale and may be dropped. */
const CACHE_TTL_MS = 30 * 60 * 1000

/** @type {Map<string, ClassifyEntry>} */
const cache = new Map()

/** Drop expired entries and enforce the max-entry cap (oldest-first). */
function evictIfNeeded() {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry?.ts && now - entry.ts > CACHE_TTL_MS) cache.delete(key)
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * Stable id for this picker session (same paths set → same key for upload batch + LM cache).
 * @param {string[]} paths
 */
export function makeUploadBatchClassifyKey(paths) {
  const sorted = [...paths].filter((p) => typeof p === 'string' && p.trim()).sort()
  return createHash('sha256').update(sorted.join('\0'), 'utf8').digest('hex').slice(0, 32)
}

/**
 * @param {string} batchKey
 * @returns {ClassifyEntry | undefined}
 */
export function getPreUploadClassifyEntry(batchKey) {
  return cache.get(batchKey)
}

/**
 * @param {string} batchKey
 */
export function clearPreUploadClassifyEntry(batchKey) {
  cache.delete(batchKey)
}

/**
 * @param {(payload: object) => void} notify
 * @param {string} batchKey
 * @param {string[]} paths
 * @param {'off'|'fast'} [mode] mode snapshotted at file-pick time (V11)
 */
export async function runPreUploadClassification(notify, batchKey, paths, mode) {
  cache.set(batchKey, { state: 'running', ts: Date.now() })
  evictIfNeeded()
  notify({ batchKey, phase: 'running' })
  try {
    const { classifierThreshold } = getClassifierSettings()
    const result = await classifyDocuments({
      enable: true,
      paths,
      mode,
      threshold: classifierThreshold,
      onProgress: (p) => notify({ batchKey, phase: 'running', progress: p })
    })
    cache.set(batchKey, { state: 'done', result, ts: Date.now() })
    evictIfNeeded()
    notify({ batchKey, phase: 'finished', result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error(`[SmartClassify] Classification failed for batch ${batchKey}: ${msg}`, {
      stack: e instanceof Error ? e.stack : undefined
    })
    // Windows installer: adds a user-facing hint; returned as-is on macOS.
    const errResult = withUserHint(
      {
        supported: false,
        reason: 'CLASSIFY_EXCEPTION',
        llmError: msg,
        labels: [],
        final_labels: []
      },
      e,
      getWindowsClassifierSupport()
    )
    cache.set(batchKey, { state: 'done', result: errResult, ts: Date.now() })
    evictIfNeeded()
    notify({ batchKey, phase: 'finished', result: errResult })
  }
}

/**
 * Build payload for upload-batch-done (renderer / PostUploadDialog).
 * @param {boolean} classifierWanted
 * @param {boolean} classifierEnabled
 * @param {string | null} batchKey
 */
export function snapshotForPostUploadDialog(classifierWanted, classifierEnabled, batchKey) {
  if (!classifierWanted) {
    return { classificationPreview: null, classifyBatchKey: null }
  }
  if (!classifierEnabled) {
    return {
      classificationPreview: {
        supported: false,
        reason: 'CLASSIFIER_DISABLED',
        labels: [],
        final_labels: []
      },
      classifyBatchKey: null
    }
  }
  if (!batchKey) {
    return {
      classificationPreview: { supported: false, reason: 'NO_CLASSIFY_KEY', labels: [], final_labels: [] },
      classifyBatchKey: null
    }
  }
  const entry = cache.get(batchKey)
  if (!entry || entry.state === 'running') {
    return {
      classificationPreview: { pending: true, batchKey },
      classifyBatchKey: batchKey
    }
  }
  return {
    classificationPreview: entry.result ?? { supported: false, reason: 'NO_RESULT', labels: [], final_labels: [] },
    classifyBatchKey: batchKey
  }
}
