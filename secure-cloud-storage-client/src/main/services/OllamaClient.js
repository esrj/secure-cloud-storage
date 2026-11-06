/**
 * Thin wrapper around a local Ollama server's /api/chat endpoint.
 * Settings come from config `agent.ollama.*`, overridable with
 * OLLAMA_URL / OLLAMA_MODEL env vars. When no model is configured,
 * the first installed model is used (models named *gemma* preferred).
 */
import { logger } from '../Logger'

const DEFAULTS = {
  url: 'http://localhost:11434',
  model: '',
  numCtx: 8192
}

function loadSettings() {
  const settings = { ...DEFAULTS }
  try {
    // Lazy require: NODE_CONFIG_DIR is set by GlobalValueManager during app startup.
    const config = require('config')
    if (config.has('agent.ollama.url')) settings.url = config.get('agent.ollama.url')
    if (config.has('agent.ollama.model')) settings.model = config.get('agent.ollama.model')
    if (config.has('agent.ollama.numCtx')) settings.numCtx = config.get('agent.ollama.numCtx')
  } catch (e) {
    logger.warn(`[OllamaClient] config unavailable, using defaults: ${e.message}`)
  }
  if (process.env.OLLAMA_URL) settings.url = process.env.OLLAMA_URL
  if (process.env.OLLAMA_MODEL) settings.model = process.env.OLLAMA_MODEL
  return settings
}

let _autoModel = null

async function resolveModel(url, configuredModel) {
  if (configuredModel) return configuredModel
  if (_autoModel) return _autoModel

  const res = await fetch(`${url}/api/tags`)
  if (!res.ok) {
    throw new Error(`Ollama /api/tags error ${res.status}`)
  }
  const data = await res.json()
  const names = (data.models ?? []).map((m) => m.name)
  if (names.length === 0) {
    throw new Error('Ollama 已啟動但沒有安裝任何模型（ollama pull <model>）')
  }
  _autoModel = names.find((n) => n.toLowerCase().includes('gemma')) ?? names[0]
  logger.info(`[OllamaClient] auto-selected model: ${_autoModel} (installed: ${names.join(', ')})`)
  return _autoModel
}

/**
 * Call Ollama /api/chat. Same signature as geminiGenerateContent so the
 * two providers are interchangeable.
 *
 * @param {object} opts
 * @param {{ role: 'user'|'assistant', content: string }[]} opts.messages - Conversation history.
 * @param {string} opts.systemInstruction - System prompt.
 * @param {number} [opts.temperature=0] - Sampling temperature.
 * @returns {Promise<string>} The model's text response.
 */
export async function ollamaGenerateContent({ messages, systemInstruction, temperature = 0 }) {
  const { url, model: configuredModel, numCtx } = loadSettings()

  let model
  try {
    model = await resolveModel(url, configuredModel)
  } catch (e) {
    throw new Error(`無法使用本地 Ollama（${url}）：${e.message}`)
  }

  const body = {
    model,
    stream: false,
    // Reasoning models must not interleave thinking with the JSON/text output.
    think: false,
    messages: [{ role: 'system', content: systemInstruction }, ...messages],
    options: { temperature, num_ctx: numCtx }
  }

  logger.debug(`[OllamaClient] POST ${url}/api/chat model=${model} — ${messages.length} message(s)`)

  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Ollama API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  // Belt-and-braces: strip <think> blocks in case the model emits them anyway.
  const text = (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  logger.debug(`[OllamaClient] response length=${text.length}`)
  return text
}
