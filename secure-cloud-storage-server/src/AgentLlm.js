/**
 * Smart-search LLM relay: the logic, kept free of sockets, database and config so it can be
 * tested on its own. AgentLlmManager.js wires it to the real ones.
 *
 * Clients do not talk to Ollama. They send `agent-llm` with a task name and the conversation;
 * the server picks the system prompt, the model and the sampling settings. A modified client
 * can therefore neither replace the prompt nor choose another model.
 *
 *   agent-llm  { task: 'parse' | 'summary', messages: [{ role, content }] } → { text } | { errorMsg }
 *
 * errorMsg is one of AgentLlmErrorCode, or one of the generic messages every event uses.
 */

export const AgentLlmErrorCode = {
  busy: 'LLM_BUSY', // this user already has a call running
  rateLimited: 'LLM_RATE_LIMITED', // this user used up the per-minute allowance
  timeout: 'LLM_TIMEOUT', // Ollama did not answer in time (usually: model still loading)
  unavailable: 'LLM_UNAVAILABLE' // Ollama unreachable, or it answered with an error
}

export class AgentLlmError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentLlmError'
    this.code = code
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const PARSE_SYSTEM = `你是一個檔案搜尋助手。將使用者的自然語言查詢轉換成結構化 JSON 過濾條件。

【可用欄位】
- name        (string): 檔案名稱（含副檔名），用 name.contains 做部分比對
- file_type   (string[]): 副檔名，例如 ["pdf","docx","txt","xlsx"]
- tags        (string[]): 分類標籤。重要：「海軍」「陸軍」「空軍」「聯合作戰」「演訓戰備」「其他」等軍事分類一律放在 tags，不要放在 name
  - tags.any    : 只要有其中一個標籤就符合（OR）
  - tags.all    : 必須同時有所有標籤（AND）
  - tags.none   : 不能有這些標籤（排除）
- is_public   (true/false): 是否為公開文件
- date.after / date.before (YYYY-MM-DD): 上傳日期範圍
- size.min / size.max (bytes): 檔案大小
- desc.contains (string): 說明欄位關鍵字
- uploader_name.contains (string): 上傳者名稱
- is_own      (true/false): true = 使用者自己的檔案；false = 別人分享的公開檔案
- folder_path.contains (string): 自己檔案所在的資料夾路徑（別人的檔案沒有路徑）
- any_text    (string): 跨欄位模糊搜尋（同時比對 name、desc、tags、folder_path）

【重要規則】
1. 分類標籤（海軍/陸軍/空軍等）一定要放在 tags.any，不要放在 name.contains
2. 若使用者說「只找公開」→ is_public: true；說「私人/機密」→ is_public: false
   說「我的/自己的檔案」→ is_own: true；說「別人的/其他人分享的」→ is_own: false
3. 若使用者要求「不要某類型」，用 tags.none 排除
4. 排序預設按相關度（不需指定），只有使用者明確說「按日期/大小」才用 sort

【回傳格式】只輸出 JSON，不要 markdown 或任何額外文字：
{
  "intent": "一句話描述使用者意圖",
  "filters": {
    "name":          { "contains": "..." },
    "file_type":     ["pdf", "docx"],
    "tags":          { "any": ["海軍"], "all": [], "none": [] },
    "is_public":     true,
    "date":          { "after": "2024-01-01", "before": "2025-12-31" },
    "size":          { "min": 0, "max": 10485760 },
    "desc":          { "contains": "..." },
    "uploader_name": { "contains": "..." },
    "is_own":        true,
    "folder_path":   { "contains": "..." },
    "any_text":      "..."
  },
  "sort": { "field": "date", "order": "desc" }
}
只填有意義的欄位，其餘省略。無法判斷條件時回傳 { "intent": "...", "filters": {}, "sort": null }。`

const SUMMARY_SYSTEM = `你是一個友善的檔案搜尋助手，只能分析 metadata（檔名、標籤、日期、大小、公開狀態、說明、上傳者、位置：自己的資料夾或別人的公開檔案），不能讀取文件內容。
用繁體中文、對話語氣（3-5句）總結搜尋結果：說明找到幾份檔案、最相關的是哪些、符合的原因是什麼（依相關度評分排序）。
若無結果，說明可能原因並給出修改建議。簡潔回答，不要用 markdown 清單格式。`

/** What each task runs with. Phase 1 of a search is `parse`, phase 4 is `summary`. */
export const AGENT_TASKS = {
  parse: { system: PARSE_SYSTEM, temperature: 0 },
  summary: { system: SUMMARY_SYSTEM, temperature: 0.3 }
}

// ─── Usage limits ────────────────────────────────────────────────────────────

/**
 * Per-user limits for the single GPU: one call at a time, and at most `maxPerMinute` calls in
 * any 60 seconds. One search makes two calls (parse, then summary).
 * @param {{ maxPerMinute: number, now?: () => number }} opts
 */
export function createUsageLimiter({ maxPerMinute, now = Date.now }) {
  const inFlight = new Set()
  /** @type {Map<string, number[]>} start times of each user's calls in the last minute */
  const recent = new Map()

  return {
    /**
     * Reserve a slot for one call. Every successful acquire must be followed by release.
     * @returns {string | null} null when the call may run, otherwise the AgentLlmErrorCode
     */
    acquire(userId) {
      if (inFlight.has(userId)) return AgentLlmErrorCode.busy
      const oneMinuteAgo = now() - 60_000
      const times = (recent.get(userId) ?? []).filter((t) => t > oneMinuteAgo)
      recent.set(userId, times)
      if (times.length >= maxPerMinute) return AgentLlmErrorCode.rateLimited
      times.push(now())
      inFlight.add(userId)
      return null
    },
    release(userId) {
      inFlight.delete(userId)
    }
  }
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} OllamaSettings
 * @property {string} url                     e.g. http://ollama:11434
 * @property {string} model
 * @property {number} numCtx                  context window; must be the same on every call
 * @property {number|string} [keepAlive]      Ollama keep_alive (-1 = never unload); unset = Ollama's own default
 * @property {number} timeoutMs
 */

async function postChat({ url, timeoutMs }, body, fetchImpl) {
  try {
    const res = await fetchImpl(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new AgentLlmError(
        AgentLlmErrorCode.unavailable,
        `Ollama answered ${res.status}: ${detail}`
      )
    }
    return await res.json()
  } catch (e) {
    if (e instanceof AgentLlmError) throw e
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new AgentLlmError(
        AgentLlmErrorCode.timeout,
        `Ollama did not answer within ${Math.round(timeoutMs / 1000)} s`
      )
    }
    throw new AgentLlmError(
      AgentLlmErrorCode.unavailable,
      `cannot reach Ollama at ${url}: ${e.cause?.code ?? e.cause?.message ?? e.message}`
    )
  }
}

function baseBody({ model, numCtx, keepAlive }) {
  const body = { model, stream: false, options: { num_ctx: numCtx } }
  if (keepAlive !== undefined && keepAlive !== null && keepAlive !== '') body.keep_alive = keepAlive
  return body
}

/**
 * Run one chat completion.
 * @param {OllamaSettings} settings
 * @param {{ system: string, temperature: number, messages: { role: string, content: string }[] }} call
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>} the model's text
 * @throws {AgentLlmError}
 */
export async function ollamaChat(settings, { system, temperature, messages }, fetchImpl = fetch) {
  const body = baseBody(settings)
  // Reasoning models must not interleave thinking with the JSON/text output.
  body.think = false
  body.messages = [{ role: 'system', content: system }, ...messages]
  body.options.temperature = temperature

  const data = await postChat(settings, body, fetchImpl)
  // Strip <think> blocks in case the model emits them anyway.
  return (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

// Loading the 31B model takes about 80 s on the GPU host; allow for a slow disk.
const LOAD_TIMEOUT_MS = 240_000

/**
 * Load the model into memory without generating anything (a chat call with no messages).
 * It sends the same num_ctx as real calls: with a different one Ollama would load it again.
 * @param {OllamaSettings} settings
 * @param {typeof fetch} [fetchImpl]
 * @throws {AgentLlmError}
 */
export async function loadModel(settings, fetchImpl = fetch) {
  const body = baseBody(settings)
  body.messages = []
  await postChat({ url: settings.url, timeoutMs: LOAD_TIMEOUT_MS }, body, fetchImpl)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Load the model at server start so the first user does not wait for it. After a host reboot
 * Ollama can come up later than the server, so failures are retried.
 * @param {OllamaSettings} settings
 * @param {{ log?: (level: 'info'|'warn', message: string) => void, fetchImpl?: typeof fetch,
 *           retryMs?: number, maxAttempts?: number }} [opts]
 * @returns {Promise<boolean>} whether the model got loaded
 */
export async function warmUp(
  settings,
  { log = () => {}, fetchImpl = fetch, retryMs = 30_000, maxAttempts = 20 } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    try {
      await loadModel(settings, fetchImpl)
      const seconds = Math.round((Date.now() - started) / 1000)
      log('info', `Smart-search model ${settings.model} is loaded (${seconds} s).`)
      return true
    } catch (e) {
      log('warn', `Smart-search model warm-up ${attempt}/${maxAttempts} failed: ${e.message}`)
    }
    if (attempt < maxAttempts) await sleep(retryMs)
  }
  return false
}

// ─── Socket handler ──────────────────────────────────────────────────────────

/**
 * Build the `agent-llm` handler.
 * @param {object} deps
 * @param {{ safeParse: (request: unknown) => { success: boolean, data?: any, error?: any } }} deps.schema
 * @param {(socket: object) => boolean} deps.isLoggedIn
 * @param {ReturnType<typeof createUsageLimiter>} deps.limiter
 * @param {(call: { system: string, temperature: number, messages: object[] }) => Promise<string>} deps.chat
 * @param {{ info: Function, warn: Function, error: Function }} deps.log  the logSocket* functions
 * @param {{ invalid: string, notLoggedIn: string, internal: string }} deps.errorMsgs
 * @returns {(socket: object, request: unknown, cb?: Function) => Promise<void>}
 */
export function createAgentLlmHandler({ schema, isLoggedIn, limiter, chat, log, errorMsgs }) {
  const actionStr = 'Client asks the smart-search model'

  return async function handleAgentLlm(socket, request, cb) {
    const reply = typeof cb === 'function' ? cb : () => {}
    let meta = {}
    try {
      const result = schema.safeParse(request)
      if (!result.success) {
        // Only the issue list is logged: the request itself is user text and file metadata.
        log.warn(socket, actionStr + ' with invalid arguments.', { issues: result.error.issues })
        reply({ errorMsg: errorMsgs.invalid })
        return
      }
      if (!isLoggedIn(socket)) {
        log.warn(socket, actionStr + ' but is not logged in.')
        reply({ errorMsg: errorMsgs.notLoggedIn })
        return
      }
      const { task, messages } = result.data
      meta = { task, messages: messages.length }

      const denied = limiter.acquire(socket.userId)
      if (denied) {
        log.warn(socket, `${actionStr} but is over the limit (${denied}).`, meta)
        reply({ errorMsg: denied })
        return
      }
      const started = Date.now()
      try {
        const text = await chat({ ...AGENT_TASKS[task], messages })
        log.info(socket, actionStr + '.', { ...meta, ms: Date.now() - started })
        reply({ text })
      } finally {
        limiter.release(socket.userId)
      }
    } catch (error) {
      if (error instanceof AgentLlmError) {
        log.warn(socket, `${actionStr} but the model failed: ${error.message}`, meta)
        reply({ errorMsg: error.code })
        return
      }
      log.error(socket, error, meta)
      reply({ errorMsg: errorMsgs.internal })
    }
  }
}
