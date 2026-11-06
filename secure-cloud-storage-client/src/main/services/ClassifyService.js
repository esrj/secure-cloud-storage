/**
 * Document classification via local LLM (node-llama-cpp, main process only).
 *
 * Multi-file batch pipeline (since 2026-04):
 *   1. Extract text from each file (txt / pdf / docx via TextExtractService).
 *      Files whose extraction fails are KEPT — they enter the prompt with
 *      filename only, since the filename itself is a strong classification
 *      signal (e.g. "海軍任務日誌.docx").
 *   2. Build ONE composite prompt containing every file's name plus a
 *      head+tail-condensed snippet of its body. Per-file character budget is
 *      computed dynamically from the model's context window so the whole
 *      batch fits in a single inference.
 *   3. Run ONE inference. The model returns a single set of labels covering
 *      the whole batch — exactly the "看整批、給同一組標籤" semantics the
 *      product asks for.
 *   4. Apply threshold to derive final_labels for the batch.
 *
 * Windows installer only (getWindowsClassifierSupport() is null elsewhere):
 * the model is checked before text extraction, a model-level failure (missing
 * model, load failure, cancel, timeout) stops the remaining groups, and failed
 * results carry a `userHint` for the UI. macOS results are unchanged.
 */
import { basename } from 'node:path'
import { extractTextFromFiles } from './TextExtractService.js'
import { getClassifierSettings } from './classifierSettings.js'
import { generate, MAX_CHUNK_CHARS } from './LlamaCppClient.js'
import { ZH_CLASSIFY_SYSTEM_PROMPT } from './classifyZhPrompt.js'
import {
  clampThreshold,
  computeFinalLabelsFromBalanced,
  mergeZhLabelRunsByMax,
  parseZhClassificationResponse
} from '../utils/classifyZhJson.js'
import { getSmartClassifyMode } from './classifierRuntime.js'
import { logger } from '../Logger.js'
import { getWindowsClassifierSupport } from './windowsClassifierModel.js'
import { isModelLevelError, withUserHint } from './classifierModelErrors.js'

/**
 * Per-file framing overhead in the composite prompt (the `# 檔案 N：xxx.pdf`
 * header, separator line, and a small slack for newlines / quote chars).
 * Roughly tracks token count on Chinese input (1 char ≈ 1 token).
 */
const PER_FILE_FRAME_OVERHEAD = 60

/**
 * Minimum characters of body text we'll dedicate to each file in the
 * composite prompt. Below this, the snippet is too short to be informative.
 */
const MIN_PER_FILE_CHARS = 120

/**
 * Hard cap on per-file body characters even when only one file is in the
 * batch. Prevents a single huge document from monopolising the context and
 * keeps inference time predictable.
 */
const MAX_PER_FILE_CHARS = 1800

/**
 * Head+tail condense `text` to fit `budget` chars.
 * Titles/abstracts live at the top and conclusions/summaries at the bottom —
 * both are the most informative regions for classification.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
function condenseToBudget(text, budget) {
  const t = typeof text === 'string' ? text : ''
  if (t.length === 0) return ''
  if (t.length <= budget) return t
  const ELLIPSIS = '\n…（中略）…\n'
  const half = Math.floor((budget - ELLIPSIS.length) / 2)
  if (half <= 0) return t.slice(0, budget)
  return t.slice(0, half) + ELLIPSIS + t.slice(-half)
}

/**
 * Compute the per-file character budget so the composite body fits the
 * largest viable context tier.
 *
 * @param {number} fileCount
 * @returns {number}
 */
function perFileBudgetForBatch(fileCount) {
  const N = Math.max(1, fileCount)
  const totalBudget = Math.max(0, MAX_CHUNK_CHARS - N * PER_FILE_FRAME_OVERHEAD)
  const raw = Math.floor(totalBudget / N)
  return Math.max(MIN_PER_FILE_CHARS, Math.min(MAX_PER_FILE_CHARS, raw))
}

/** Max characters of a filename we put into the prompt header. */
const MAX_FILENAME_CHARS = 120

/**
 * Neutralize attacker-controlled text before it goes into the prompt (V10).
 *
 * Filenames and document bodies are user-controlled. Without sanitization a
 * document could embed our own framing tokens — `# 檔案 N：…`, the `---`
 * separator, or fake JSON / "本文件屬於海軍 score 1.0" instructions — to break
 * the per-file structure or steer the classifier. The JSON grammar already
 * prevents full output hijacking, but we still defend the framing and strip
 * control characters:
 *   - drop C0/C1 control chars (except newline/tab) that could corrupt the prompt;
 *   - defang lines that begin with our header marker "# 檔案" or a "---" fence
 *     by prefixing a zero-width-safe marker so they can't masquerade as real
 *     framing;
 *   - collapse runs of dashes so "-----" can't read as a separator.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeBodyForPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    // Strip control chars except \n (0x0A) and \t (0x09).
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, ' ')
    // Defang our framing markers if they appear at the start of a line.
    .replace(/^(\s*)#\s*檔案/gm, '$1＃ 檔案')
    .replace(/^(\s*)-{3,}(\s*)$/gm, '$1—（分隔）$2')
}

/**
 * Sanitize a filename for the prompt header: single line, no framing markers,
 * length-capped.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilenameForPrompt(name) {
  const oneLine = String(name || '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[#`]/g, '＃')
    .replace(/-{3,}/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > MAX_FILENAME_CHARS
    ? oneLine.slice(0, MAX_FILENAME_CHARS) + '…'
    : oneLine
}

/**
 * Build one composite body containing every file's framing + condensed text.
 *
 * @param {Array<{ path: string, text: string, extracted: boolean }>} files
 * @param {number} perFileBudget
 * @returns {string}
 */
function buildCompositeBody(files, perFileBudget) {
  return files
    .map((f, idx) => {
      const header = `# 檔案 ${idx + 1}：${sanitizeFilenameForPrompt(basename(f.path))}`
      if (!f.extracted || !f.text) {
        return `${header}\n（無法擷取內文，請僅依檔名判斷）`
      }
      const body = sanitizeBodyForPrompt(condenseToBudget(f.text, perFileBudget))
      return `${header}\n${body}`
    })
    .join('\n\n---\n\n')
}

/**
 * Maximum files we put into a single inference run.
 *
 * Even at the per-file floor (MIN_PER_FILE_CHARS + frame), a run must still fit
 * the content budget; this bounds how many files share one composite so that a
 * large batch is split across multiple runs instead of being front-truncated
 * (which used to silently drop the trailing files — bug V4).
 */
const MAX_FILES_PER_RUN = Math.max(
  1,
  Math.floor(MAX_CHUNK_CHARS / (MIN_PER_FILE_CHARS + PER_FILE_FRAME_OVERHEAD))
)

/**
 * Split `arr` into consecutive chunks of at most `size`.
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(arr, size) {
  const out = []
  const step = Math.max(1, size)
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step))
  return out
}

/**
 * @param {{
 *   paths?: string[],
 *   enable?: boolean,
 *   debug?: boolean,
 *   temperature?: number,
 *   threshold?: number,
 *   mode?: 'off'|'fast',
 *   onProgress?: (p: { done: number, total: number }) => void
 * }} input
 */
export async function classifyDocuments(input) {
  const enable = input?.enable !== false
  // null on macOS / Linux / dev: every withUserHint() below is then a no-op.
  const win = getWindowsClassifierSupport()

  if (!enable) {
    return withUserHint(
      { supported: false, reason: 'DISABLED', labels: [], final_labels: [] },
      null,
      win
    )
  }

  // V11: prefer the mode snapshotted by the caller at file-pick time. The live
  // getSmartClassifyMode() is only a fallback (e.g. manual retry from the
  // dialog), so a mid-flight dropdown change can't silently flip this batch's
  // behavior to a different model — or to 'off'.
  // 2026-10: only 'fast' (4B) remains. Legacy 'medium'/'high' snapshots from an
  // old renderer state are treated as 'fast' rather than falling back to live state.
  const mode =
    input?.mode === 'fast' || input?.mode === 'off'
      ? input.mode
      : input?.mode === 'medium' || input?.mode === 'high'
        ? 'fast'
        : getSmartClassifyMode()
  if (mode === 'off') {
    return withUserHint(
      { supported: false, reason: 'DISABLED', labels: [], final_labels: [] },
      null,
      win
    )
  }

  const settings = getClassifierSettings()
  const threshold = clampThreshold(
    typeof input?.threshold === 'number' ? input.threshold : settings.classifierThreshold
  )

  const paths = Array.isArray(input?.paths)
    ? input.paths.filter((p) => typeof p === 'string' && p.trim())
    : []

  if (paths.length === 0) {
    return withUserHint(
      {
        supported: false,
        reason: 'NO_FILES',
        labels: [],
        final_labels: [],
        extraction: { attempted: false }
      },
      null,
      win
    )
  }

  // Windows installer: report a missing / invalid model up front instead of
  // extracting text first and then failing once per group.
  const notReady = win ? win.checkModelReady() : null
  if (notReady) {
    logger.warn(`[Classify] model not ready (${notReady.code}): ${notReady.message}`)
    return withUserHint(
      {
        supported: false,
        reason: 'LLM_GENERATE_FAILED',
        labels: [],
        final_labels: [],
        extraction: { attempted: false },
        llmError: notReady.message,
        thresholdUsed: threshold
      },
      notReady,
      win
    )
  }

  // ── 1. Text extraction ────────────────────────────────────────────────────
  // Note: We still call extractTextFromFiles, but unlike the per-file pipeline
  // we keep ALL paths in the batch — files whose extraction returned empty
  // text still contribute via filename in the composite prompt.
  const extracted = await extractTextFromFiles(paths)
  const extractedByPath = new Map()
  if (extracted.supported) {
    for (const e of extracted.texts) extractedByPath.set(e.path, e.text)
  }

  /** @type {Array<{ path: string, text: string, extracted: boolean }>} */
  const files = paths.map((p) => {
    const text = extractedByPath.get(p) ?? ''
    return { path: p, text, extracted: text.length > 0 }
  })

  const filesWithText = files.filter((f) => f.extracted).length
  const extraction = {
    attempted: true,
    ok: filesWithText > 0,
    filesCount: files.length,
    filesWithText,
    files: files.map((f) => ({
      path: f.path,
      name: basename(f.path),
      charLen: f.text.length,
      extracted: f.extracted
    }))
  }

  // ── 2. Split the batch into runs that each fit the context ───────────────
  // V4 fix: a single composite for a large batch used to overshoot
  // MAX_CHUNK_CHARS and get hard-truncated from the front, silently dropping
  // the trailing files (even their filenames) from the prompt — yet the
  // resulting label set was still applied to ALL of them. Instead we split the
  // batch into groups small enough to fit and classify each group. Every file
  // is now guaranteed to appear in some run's prompt.
  const groups = chunkArray(files, MAX_FILES_PER_RUN)

  const temperature = typeof input?.temperature === 'number' ? input.temperature : 0.1

  logger.info(
    `[Classify] Batch: files=${files.length}, withText=${filesWithText}, ` +
      `groups=${groups.length}, maxPerRun=${MAX_FILES_PER_RUN}, mode=${mode}`
  )

  const report = (done) => {
    if (typeof input?.onProgress === 'function') {
      input.onProgress({ done, total: groups.length })
    }
  }
  report(0)

  /** @type {Array<{ labels: import('../utils/classifyZhJson.js').ZhLabelEntry[] }>} */
  const okRuns = []
  let lastRaw = ''
  let generateError = null
  /** @type {unknown} the error object behind generateError (for the Windows hint) */
  let generateErrorObj = null
  let anyParseFail = false

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    const perFileBudget = perFileBudgetForBatch(group.length)
    let composite = buildCompositeBody(group, perFileBudget)

    // Defensive cap (the per-file budget + MAX_FILES_PER_RUN already keep a
    // group under the char budget; the client also does a final token-accurate
    // trim). This only fires for pathological inputs.
    if (composite.length > MAX_CHUNK_CHARS) {
      const TAIL = '\n…（內容因長度超過模型上限而省略）'
      composite = composite.slice(0, MAX_CHUNK_CHARS - TAIL.length) + TAIL
    }
    if (composite.length === 0) {
      report(gi + 1)
      continue
    }

    const userPrompt = `本輪門檻 threshold = ${threshold}
本組共 ${group.length} 個檔案（整批第 ${gi + 1}/${groups.length} 組），請綜合判斷並輸出一組嚴格 JSON（規格見 system，僅 JSON、勿 markdown、勿 <think>）。
注意：score 必須真實反映你對這些檔案的判斷，不可全部填 0、也不可照抄 system 範例的數值。

以下為每個檔案的「檔名 + 摘要內容」：

${composite}`

    let raw
    try {
      raw = await generate(userPrompt, {
        system: ZH_CLASSIFY_SYSTEM_PROMPT,
        temperature,
        mode
      })
    } catch (e) {
      generateError = e instanceof Error ? e.message : String(e)
      generateErrorObj = e
      logger.warn(`[Classify] group ${gi + 1}/${groups.length} generate failed: ${generateError}`)
      report(gi + 1)
      // Windows: a load failure, cancel or timeout would hit every remaining
      // group the same way (and reload the model each time), so stop here.
      if (win && isModelLevelError(e)) break
      continue
    }

    lastRaw = raw
    const parsed = parseZhClassificationResponse(raw)
    if (parsed.ok) {
      okRuns.push({ labels: parsed.labels })
    } else {
      anyParseFail = true
      logger.warn(`[Classify] group ${gi + 1}/${groups.length} JSON parse failed`)
    }
    report(gi + 1)
  }

  // ── 3. No usable run → surface the failure ───────────────────────────────
  if (okRuns.length === 0) {
    if (generateError) {
      return withUserHint(
        {
          supported: false,
          reason: 'LLM_GENERATE_FAILED',
          labels: [],
          final_labels: [],
          extraction,
          llmError: generateError,
          thresholdUsed: threshold
        },
        generateErrorObj,
        win
      )
    }
    return withUserHint(
      {
        supported: false,
        reason: anyParseFail ? 'JSON_PARSE_FAILED' : 'EMPTY_CONTENT',
        labels: [],
        final_labels: [],
        extraction,
        llmRawText: lastRaw || undefined,
        thresholdUsed: threshold
      },
      null,
      win
    )
  }

  // ── 4. Merge runs (max score per label) + threshold ──────────────────────
  // Max-merge (not average) so a label that is strong in ANY group survives,
  // matching the product rule "批次中只要有任一檔屬於某類，整批該類分數就要高".
  const balancedLabels = mergeZhLabelRunsByMax(okRuns)
  const final_labels = computeFinalLabelsFromBalanced(balancedLabels, threshold)

  return {
    supported: true,
    labels: balancedLabels,
    final_labels,
    classification: { labels: balancedLabels, final_labels },
    extraction: {
      ...extraction,
      groups: groups.length,
      chunksClassified: okRuns.length,
      parseSuccessRuns: okRuns.length
    },
    llmRawText: input?.debug ? lastRaw : undefined,
    thresholdUsed: threshold
  }
}

export { parseZhClassificationJson } from '../utils/classifyZhJson.js'
