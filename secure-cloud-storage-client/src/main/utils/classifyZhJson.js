/** @typedef {{ name: string, score: number, evidence: string[] }} ZhLabelEntry */

export const ZH_LABEL_ORDER = ['海軍', '陸軍', '空軍', '聯合作戰', '演訓戰備', '其他']

const ZH_SET = new Set(ZH_LABEL_ORDER)

/**
 * @param {number} n
 */
function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * @param {number} n
 */
export function roundScore2(n) {
  return Math.round(clamp01(n) * 100) / 100
}

/**
 * @param {unknown} t
 */
export function clampThreshold(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0.55
  return Math.min(1, Math.max(0, t))
}

/**
 * @param {string} s
 */
export function stripMarkdownFence(s) {
  let t = String(s).trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim()
  }
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) t = t.slice(i, j + 1)
  return t.trim()
}

/**
 * Parse model JSON → six fixed labels (no final_labels enforcement).
 * @param {string} rawText
 * @returns {{ ok: true, labels: ZhLabelEntry[] } | { ok: false, reason: string }}
 */
export function parseZhClassificationResponse(rawText) {
  let parsed
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText))
  } catch {
    return { ok: false, reason: 'JSON_PARSE_FAILED' }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.labels)) {
    return { ok: false, reason: 'JSON_PARSE_FAILED' }
  }

  /** @type {Map<string, { score?: unknown, evidence?: unknown }>} */
  const byName = new Map()
  for (const entry of parsed.labels) {
    if (entry && typeof entry.name === 'string' && ZH_SET.has(entry.name)) {
      byName.set(entry.name, entry)
    }
  }

  /** @type {ZhLabelEntry[]} */
  const labels = ZH_LABEL_ORDER.map((name) => {
    const e = byName.get(name)
    const score = roundScore2(typeof e?.score === 'number' ? e.score : 0)
    const evidence = Array.isArray(e?.evidence)
      ? e.evidence
          .filter((x) => typeof x === 'string')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
    return { name, score, evidence }
  })

  return { ok: true, labels }
}

/**
 * 多段／多檔 LM 結果：各標籤分數取平均；evidence 優先採用該標籤分數最高那一段的 evidence，否則合併去重取前三。
 * @param {Array<{ labels: ZhLabelEntry[] }>} okRuns
 * @returns {ZhLabelEntry[]}
 */
export function balanceZhLabelsFromRuns(okRuns) {
  const runs = okRuns.filter((r) => r && Array.isArray(r.labels) && r.labels.length > 0)
  if (runs.length === 0) {
    return ZH_LABEL_ORDER.map((name) => ({ name, score: 0, evidence: [] }))
  }

  return ZH_LABEL_ORDER.map((name) => {
    let sum = 0
    let n = 0
    let bestScore = -1
    /** @type {string[]} */
    let bestEv = []
    /** @type {string[]} */
    const pool = []

    for (const run of runs) {
      const L = run.labels.find((l) => l.name === name)
      if (!L) continue
      sum += L.score
      n += 1
      const ev = Array.isArray(L.evidence) ? L.evidence : []
      for (const x of ev) {
        if (typeof x === 'string' && x.trim() && !pool.includes(x.trim())) pool.push(x.trim())
      }
      if (L.score > bestScore && ev.length > 0) {
        bestScore = L.score
        bestEv = ev.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)
      }
    }

    const score = roundScore2(n > 0 ? sum / n : 0)
    const evidence = (bestEv.length > 0 ? bestEv : pool).slice(0, 3)
    return { name, score, evidence }
  })
}

/**
 * 多檔分組合併：跨組「取各標籤的最大分數」（而非平均）。
 *
 * 與 balanceZhLabelsFromRuns 的差異與時機：
 *   - balanceZhLabelsFromRuns 取「平均」，適用於「同一份文件被切成多段」的情境
 *     （每段都在描述同一份文件，平均才能反映整份文件的傾向）。
 *   - mergeZhLabelRunsByMax 取「最大」，適用於「一個批次拆成多組檔案、各組各跑一次
 *     推論」的情境。產品規則是「只要批次中有任一檔明顯屬於某類，整批該類分數就要高」，
 *     若用平均，第 1 組全是海軍(0.9)、第 2 組全是空軍(0.0) 會把海軍稀釋成 0.45 而漏標。
 *     取最大可保留「批次中最強證據」。
 *
 * evidence 採用「貢獻最大分數那一組」的 evidence；若該組無 evidence，則退而合併各組去重取前三。
 *
 * @param {Array<{ labels: ZhLabelEntry[] }>} okRuns
 * @returns {ZhLabelEntry[]}
 */
export function mergeZhLabelRunsByMax(okRuns) {
  const runs = okRuns.filter((r) => r && Array.isArray(r.labels) && r.labels.length > 0)
  if (runs.length === 0) {
    return ZH_LABEL_ORDER.map((name) => ({ name, score: 0, evidence: [] }))
  }

  return ZH_LABEL_ORDER.map((name) => {
    let best = -1
    /** @type {string[]} */
    let bestEv = []
    /** @type {string[]} */
    const pool = []

    for (const run of runs) {
      const L = run.labels.find((l) => l.name === name)
      if (!L) continue
      const ev = Array.isArray(L.evidence) ? L.evidence : []
      for (const x of ev) {
        const s = typeof x === 'string' ? x.trim() : ''
        if (s && !pool.includes(s)) pool.push(s)
      }
      if (L.score > best) {
        best = L.score
        bestEv = ev.length > 0 ? ev.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : []
      }
    }

    const score = roundScore2(best < 0 ? 0 : best)
    const evidence = (bestEv.length > 0 ? bestEv : pool).slice(0, 3)
    return { name, score, evidence }
  })
}

/**
 * @param {ZhLabelEntry[]} labels
 * @param {number} threshold
 * @returns {string[]}
 */
export function computeFinalLabelsFromBalanced(labels, threshold) {
  const th = clampThreshold(threshold)

  // Primary: labels that clear the threshold AND have supporting evidence.
  // Evidence is required here to filter out hallucinated labels in the normal
  // case.
  const withEvidence = labels.filter((l) => l.score >= th && l.evidence.length > 0).map((l) => l.name)
  if (withEvidence.length > 0) return withEvidence

  // V12 fallback: a label cleared the threshold but the model returned no
  // evidence for it. Previously these were dropped and the whole batch fell
  // back to ['其他'] — which, for a tagging-drives-access system, wrongly
  // RELAXES the scope of a confidently-classified (possibly sensitive)
  // document. A high score is the real signal, so keep those labels rather
  // than silently downgrading to 其他.
  const scoreOnly = labels.filter((l) => l.score >= th).map((l) => l.name)
  if (scoreOnly.length > 0) return scoreOnly

  return ['其他']
}

/**
 * Single-shot parse + threshold (e.g. retry dialog).
 * @param {string} rawText
 * @param {number} threshold
 */
export function parseZhClassificationJson(rawText, threshold) {
  const parsed = parseZhClassificationResponse(rawText)
  if (!parsed.ok) return parsed
  const final_labels = computeFinalLabelsFromBalanced(parsed.labels, threshold)
  return { ok: true, labels: parsed.labels, final_labels }
}
