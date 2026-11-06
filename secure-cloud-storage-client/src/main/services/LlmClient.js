/**
 * Provider dispatch for the metadata search agent's LLM calls.
 * `agent.provider` in config (or AGENT_PROVIDER env) selects the backend:
 *   - 'ollama' (default): local Ollama server, no data leaves the machine
 *   - 'gemini':           Google Gemini API
 */
import { geminiGenerateContent } from './GeminiClient.js'
import { ollamaGenerateContent } from './OllamaClient.js'
import { logger } from '../Logger'

export function resolveProvider() {
  if (process.env.AGENT_PROVIDER) return process.env.AGENT_PROVIDER
  try {
    const config = require('config')
    if (config.has('agent.provider')) return config.get('agent.provider')
  } catch (e) {
    logger.warn(`[LlmClient] config unavailable, defaulting to ollama: ${e.message}`)
  }
  return 'ollama'
}

export async function llmGenerateContent(opts) {
  const provider = resolveProvider()
  if (provider === 'gemini') return geminiGenerateContent(opts)
  return ollamaGenerateContent(opts)
}
