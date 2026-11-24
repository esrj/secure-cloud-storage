/**
 * Two-phase metadata search agent with relevance scoring.
 *
 * Phase 1 — NL → JSON filter  (LLM task 'parse')
 * Phase 2 — Hard filter execution (pure JS)
 * Phase 3 — Relevance scoring + sort
 * Phase 4 — LLM summary  (LLM task 'summary')
 *
 * The two LLM tasks run on the Cloud Server, which also holds their system prompts
 * (AgentLlm.js there). Filtering and scoring stay on this machine.
 */
import { logger } from '../Logger.js'

// ─── Hard filter ─────────────────────────────────────────────────────────────

function applyFilters(files, filters) {
  if (!filters || Object.keys(filters).length === 0) return files

  return files.filter((f) => {
    // name
    if (filters.name?.contains) {
      if (!f.name.toLowerCase().includes(filters.name.contains.toLowerCase())) return false
    }

    // file_type / ext
    if (Array.isArray(filters.file_type) && filters.file_type.length > 0) {
      if (!filters.file_type.map((e) => e.toLowerCase()).includes(f.ext)) return false
    }

    // tags.any — at least one must match (OR)
    if (Array.isArray(filters.tags?.any) && filters.tags.any.length > 0) {
      const lower = filters.tags.any.map((t) => t.toLowerCase())
      if (!f.tags.some((t) => lower.includes(t.toLowerCase()))) return false
    }

    // tags.all — every tag must be present (AND)
    if (Array.isArray(filters.tags?.all) && filters.tags.all.length > 0) {
      const lower = filters.tags.all.map((t) => t.toLowerCase())
      if (!lower.every((qt) => f.tags.some((ft) => ft.toLowerCase() === qt))) return false
    }

    // tags.none — none of these tags allowed
    if (Array.isArray(filters.tags?.none) && filters.tags.none.length > 0) {
      const lower = filters.tags.none.map((t) => t.toLowerCase())
      if (f.tags.some((t) => lower.includes(t.toLowerCase()))) return false
    }

    // is_public
    if (typeof filters.is_public === 'boolean') {
      if (f.is_public !== filters.is_public) return false
    }

    // date range
    if (filters.date?.after && f.date < filters.date.after) return false
    if (filters.date?.before && f.date > filters.date.before) return false

    // size
    if (typeof filters.size?.min === 'number' && f.size < filters.size.min) return false
    if (typeof filters.size?.max === 'number' && f.size > filters.size.max) return false

    // desc
    if (filters.desc?.contains) {
      if (!(f.desc ?? '').toLowerCase().includes(filters.desc.contains.toLowerCase())) return false
    }

    // is_own / folder_path
    if (typeof filters.is_own === 'boolean') {
      if (f.is_own !== filters.is_own) return false
    }
    if (filters.folder_path?.contains) {
      if (!(f.folder_path ?? '').toLowerCase().includes(filters.folder_path.contains.toLowerCase()))
        return false
    }

    // uploader_name
    if (filters.uploader_name?.contains) {
      if (!f.uploader_name.toLowerCase().includes(filters.uploader_name.contains.toLowerCase()))
        return false
    }

    // any_text — single keyword cross-field match
    if (filters.any_text) {
      const q = filters.any_text.toLowerCase()
      const inName = f.name.toLowerCase().includes(q)
      const inDesc = (f.desc ?? '').toLowerCase().includes(q)
      const inTags = f.tags.some((t) => t.toLowerCase().includes(q))
      const inFolder = (f.folder_path ?? '').toLowerCase().includes(q)
      const inOwner = (f.uploader_name ?? '').toLowerCase().includes(q)
      if (!inName && !inDesc && !inTags && !inFolder && !inOwner) return false
    }

    // keywords — array of terms, ANY match passes (used by LLM-fallback path)
    if (Array.isArray(filters.keywords) && filters.keywords.length > 0) {
      const matchesAny = filters.keywords.some((kw) => {
        const q = kw.toLowerCase()
        return (
          f.name.toLowerCase().includes(q) ||
          (f.desc ?? '').toLowerCase().includes(q) ||
          f.tags.some((t) => t.toLowerCase().includes(q))
        )
      })
      if (!matchesAny) return false
    }

    return true
  })
}

// ─── Relevance scoring ────────────────────────────────────────────────────────

/**
 * Score a file against the parsed query.
 * Higher = more relevant.
 */
function scoreFile(file, parsedQuery) {
  let score = 0
  const { filters } = parsedQuery

  if (!filters) return 0

  // Tag exact matches (strongest signal)
  const anyTags = filters.tags?.any ?? []
  const allTags = filters.tags?.all ?? []
  const queryTags = [...new Set([...anyTags, ...allTags])].map((t) => t.toLowerCase())
  if (queryTags.length > 0) {
    const matchCount = file.tags.filter((t) => queryTags.includes(t.toLowerCase())).length
    score += matchCount * 12
    // Full match bonus
    if (matchCount === queryTags.length) score += 8
  }

  // File name keyword
  if (filters.name?.contains) {
    const q = filters.name.contains.toLowerCase()
    if (file.name.toLowerCase().includes(q)) score += 7
  }

  // any_text cross-field
  if (filters.any_text) {
    const q = filters.any_text.toLowerCase()
    if (file.name.toLowerCase().includes(q)) score += 6
    if ((file.desc ?? '').toLowerCase().includes(q)) score += 4
    if (file.tags.some((t) => t.toLowerCase().includes(q))) score += 10
  }

  // Description keyword
  if (filters.desc?.contains) {
    if ((file.desc ?? '').toLowerCase().includes(filters.desc.contains.toLowerCase())) score += 4
  }

  // Recency bonus (files uploaded within 90 days get a small boost)
  const daysSince = (Date.now() - new Date(file.date).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince < 7) score += 5
  else if (daysSince < 30) score += 3
  else if (daysSince < 90) score += 1

  return score
}

/**
 * Sort files: first by relevance score (desc), then by user-requested sort,
 * then by date (desc) as final tiebreaker.
 */
function sortFiles(files, parsedQuery) {
  const scored = files.map((f) => ({ ...f, _score: scoreFile(f, parsedQuery) }))

  return scored.sort((a, b) => {
    // 1. Relevance score (always primary)
    if (b._score !== a._score) return b._score - a._score

    // 2. User-requested secondary sort
    const { sort } = parsedQuery
    if (sort?.field && sort.field !== 'relevance') {
      const av = a[sort.field] ?? ''
      const bv = b[sort.field] ?? ''
      if (av < bv) return sort.order === 'asc' ? -1 : 1
      if (av > bv) return sort.order === 'asc' ? 1 : -1
    }

    // 3. Date tiebreaker (newest first)
    if (b.date !== a.date) return b.date > a.date ? 1 : -1

    return 0
  })
}

/**
 * Extract meaningful search keywords from a natural-language Chinese message.
 * Strips common filler words so only content terms remain.
 */
function extractKeywords(message) {
  const STOP = [
    '幫我', '幫', '請', '請幫', '可以', '能不能', '有沒有', '我要', '我想', '我想要',
    '尋找', '搜尋', '查詢', '查找', '找', '找到', '找一下', '找找',
    '相關', '有關', '關於', '屬於', '關聯',
    '的文章', '的文件', '的資料', '的檔案', '的內容', '的報告',
    '文章', '文件', '資料', '檔案', '內容', '報告', '所有', '全部', '一些',
    '的', '了', '嗎', '吧', '呢', '啊', '哦', '喔', '嗯', '好', '謝謝',
    '最近', '最新', '最', '我'
  ]

  let text = message
  // Sort stop phrases by length desc so longer ones match first
  for (const s of STOP.sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(s, ' ')
  }

  // Extract tokens with 2+ characters
  const tokens = text.split(/[\s，。！？,. !?]+/).filter((t) => t.length >= 2)
  return [...new Set(tokens)]
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) + '…' : text)

function parseJsonFromText(text) {
  const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  return JSON.parse(cleaned)
}

/**
 * Models (especially smaller local ones) sometimes emit dotted flat keys like
 * "tags.none" or "date.after" at the top level of filters instead of nesting.
 * Fold them back into the nested shape applyFilters expects.
 */
function normalizeFilters(filters) {
  if (!filters || typeof filters !== 'object') return filters
  for (const key of Object.keys(filters)) {
    const dot = key.indexOf('.')
    if (dot <= 0) continue
    const parent = key.slice(0, dot)
    const child = key.slice(dot + 1)
    if (typeof filters[parent] !== 'object' || filters[parent] === null) {
      filters[parent] = {}
    }
    if (filters[parent][child] === undefined) {
      filters[parent][child] = filters[key]
    }
    delete filters[key]
  }
  return filters
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a single agent turn.
 *
 * @param {object} opts
 * @param {string} opts.userMessage
 * @param {{ role: 'user'|'assistant', content: string }[]} opts.history
 * @param {import('./MetadataCollector.js').SearchableFile[]} opts.files
 * @param {(call: { task: 'parse'|'summary', messages: object[] }) => Promise<string>} opts.generate
 *        Runs one LLM task (LlmClient.llmGenerateContent). When it fails, its error message
 *        is a reason that can be shown to the user.
 * @returns {Promise<AgentTurnResult>}
 */
export async function runAgentTurn({ userMessage, history, files, generate }) {
  // ── Phase 1: NL → filter ──
  const parseMessages = [
    ...history
      .filter((m) => typeof m?.content === 'string' && m.content.trim())
      .slice(-6)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: clip(m.content, 2000)
      })),
    { role: 'user', content: userMessage }
  ]

  let parsedQuery = { intent: userMessage, filters: {}, sort: null }
  // Why the LLM could not be used for this turn; stays '' when it worked.
  let llmError = ''
  try {
    const parseRaw = await generate({ task: 'parse', messages: parseMessages })
    try {
      parsedQuery = parseJsonFromText(parseRaw)
      parsedQuery.filters = normalizeFilters(parsedQuery.filters)
    } catch (e) {
      logger.warn(`[AgentService] parse phase answer is not the expected JSON: ${e.message}`)
      throw new Error('語言模型的回答無法解讀')
    }
    logger.debug(`[AgentService] parsed query: ${JSON.stringify(parsedQuery)}`)
  } catch (e) {
    llmError = e.message
    logger.warn(`[AgentService] parse phase failed, falling back to keyword search: ${e.message}`)
    // Fallback: extract meaningful keywords from the message so irrelevant files are excluded
    const keywords = extractKeywords(userMessage)
    logger.debug(`[AgentService] fallback keywords: ${JSON.stringify(keywords)}`)
    parsedQuery = {
      intent: userMessage,
      filters: keywords.length > 0 ? { keywords } : {},
      sort: null
    }
  }

  // ── Phase 2: Hard filter ──
  const filtered = applyFilters(files, parsedQuery.filters)

  // ── Phase 3: Relevance score + sort ──
  const sorted = sortFiles(filtered, parsedQuery)
  const topResults = sorted.slice(0, 20)

  logger.debug(
    `[AgentService] filter: ${files.length} → ${filtered.length}, top scores: ${topResults.slice(0, 3).map((f) => f._score).join(', ')}`
  )

  // ── Phase 4: LLM summary ──
  const resultSummaryForLlm =
    topResults.length === 0
      ? '查無符合條件的檔案。'
      : topResults
          .map((f, i) =>
            // One line per file, clipped so 20 of them always fit in one request.
            clip(
              `${i + 1}. [相關分:${f._score}] ${f.name}` +
                ` | 類型:${f.file_type.toUpperCase() || '未知'}` +
                ` | 大小:${f.sizeLabel}` +
                ` | 上傳:${f.upload_time}` +
                ` | 公開:${f.is_public ? '是' : '否'}` +
                ` | 上傳者:${f.uploader_name}` +
                ` | 位置:${f.location ?? ''}` +
                (f.tags.length ? ` | 標籤:${f.tags.join(',')}` : '') +
                (f.desc ? ` | 說明:${f.desc.slice(0, 80)}` : ''),
              600
            )
          )
          .join('\n')

  const summaryUserMsg =
    `使用者查詢：「${clip(userMessage, 500)}」\n` +
    `解析意圖：${clip(String(parsedQuery.intent ?? ''), 300)}\n` +
    `符合條件 ${topResults.length} / 總共 ${files.length} 份，已按相關度排序：\n\n${resultSummaryForLlm}`

  let summary = `找到 ${topResults.length} 份符合條件的檔案。`
  if (llmError) {
    // The results below come from keyword matching. Say so, and say why, in both cases:
    // "no match" from a keyword search means much less than "no match" from the LLM.
    const notice = `（AI 無法使用：${llmError}。已改用關鍵字搜尋）`
    if (topResults.length === 0) {
      summary = `${notice}查無符合「${userMessage}」的檔案。請確認關鍵字或標籤是否正確。`
    } else {
      const names = topResults
        .slice(0, 3)
        .map((f) => f.name)
        .join('、')
      summary = `${notice}找到 ${topResults.length} 份相關檔案：${names}${topResults.length > 3 ? ' 等' : ''}。`
    }
  } else {
    try {
      const text = await generate({
        task: 'summary',
        messages: [{ role: 'user', content: summaryUserMsg }]
      })
      if (text.trim()) summary = text
    } catch (e) {
      llmError = e.message
      logger.warn(`[AgentService] summary phase failed: ${e.message}`)
      summary += `（AI 摘要無法產生：${e.message}）`
    }
  }

  // Strip internal _score before returning to renderer
  const resultFiles = topResults.map(({ _score, ...rest }) => rest)

  return {
    summary,
    matchCount: topResults.length,
    totalCount: files.length,
    files: resultFiles,
    parsedQuery,
    llmError
  }
}

/**
 * @typedef {object} AgentTurnResult
 * @property {string}   summary
 * @property {number}   matchCount
 * @property {number}   totalCount
 * @property {import('./MetadataCollector.js').SearchableFile[]} files
 * @property {object}   parsedQuery
 * @property {string}   llmError  why the LLM could not be used ('' when it worked); the summary already says it
 */
