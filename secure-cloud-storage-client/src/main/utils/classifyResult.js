/**
 * Helpers for military document classification results.
 * @typedef {'NAVY'|'ARMY'|'AIR_FORCE'|'JOINT'|'OTHER'} MilitaryLabelName
 */

const ALLOWED_SET = new Set(['NAVY', 'ARMY', 'AIR_FORCE', 'JOINT', 'OTHER'])

/**
 * @param {unknown} name
 * @returns {name is MilitaryLabelName}
 */
function isAllowedName(name) {
  return typeof name === 'string' && ALLOWED_SET.has(name)
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * @param {Partial<{
 *   supported: boolean,
 *   reason?: string,
 *   labels: Array<{name:MilitaryLabelName, score:number, evidence:string[]}>,
 *   final_labels: MilitaryLabelName[],
 *   model: string,
 *   chunks?: unknown
 * }>} result
 */
export function normalizeResult(result) {
  const supported = Boolean(result?.supported)
  const reason = typeof result?.reason === 'string' ? result.reason : undefined
  const model = typeof result?.model === 'string' ? result.model : 'gemma-4-E4B-it'
  const chunks = result?.chunks

  const rawLabels = Array.isArray(result?.labels) ? result.labels : []
  const labels = rawLabels
    .filter((l) => l && isAllowedName(l.name))
    .map((l) => {
      const evidence = Array.isArray(l.evidence)
        ? l.evidence.filter((e) => typeof e === 'string').slice(0, 3)
        : []
      return {
        name: l.name,
        score: clamp01(l.score),
        evidence
      }
    })

  const rawFinal = Array.isArray(result?.final_labels) ? result.final_labels : []
  const final_labels = rawFinal.filter(isAllowedName)

  return {
    supported,
    ...(reason !== undefined ? { reason } : {}),
    labels,
    final_labels,
    model,
    ...(chunks !== undefined ? { chunks } : {})
  }
}

/**
 * @param {Array<{name:MilitaryLabelName, score:number, evidence?: string[]}>} labels
 * @param {{ threshold?: number, maxPick?: number }} [opts]
 * @returns {MilitaryLabelName[]}
 */
export function pickFinalLabels(labels, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.55
  const maxPick = typeof opts.maxPick === 'number' ? opts.maxPick : 3

  const list = Array.isArray(labels)
    ? labels.filter((l) => l && isAllowedName(l.name)).map((l) => ({
        name: l.name,
        score: clamp01(l.score)
      }))
    : []

  if (list.length === 0) return []

  const above = list.filter((l) => l.score >= threshold).sort((a, b) => b.score - a.score)

  let picked
  if (above.length > 0) {
    picked = above
  } else {
    const best = [...list].sort((a, b) => b.score - a.score)[0]
    picked = best ? [best] : []
  }

  const seen = new Set()
  const out = []
  for (const { name } of picked) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= maxPick) break
  }
  return out
}
