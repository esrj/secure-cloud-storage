/**
 * Thin wrapper around the Gemini REST API.
 * API key is loaded from src/main/config/agentApiKeys.json (dev)
 * or process.resourcesPath/agentApiKeys.json (production).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { logger } from '../Logger'

const MODEL = 'gemini-3-flash-preview'
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

function resolveConfigPath() {
  if (is.dev) {
    return join(app.getAppPath(), 'src/main/config/agentApiKeys.json')
  }
  return join(process.resourcesPath, 'agentApiKeys.json')
}

function loadApiKey() {
  const configPath = resolveConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(
      `agentApiKeys.json not found at ${configPath}. ` +
        'Copy agentApiKeys.example.json → agentApiKeys.json and fill in your Gemini key.'
    )
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!cfg.gemini) {
    throw new Error('Gemini API key is empty. Fill in the "gemini" field in agentApiKeys.json.')
  }
  return cfg.gemini
}

/**
 * Call the Gemini generateContent endpoint.
 *
 * @param {object} opts
 * @param {{ role: 'user'|'assistant', content: string }[]} opts.messages - Conversation history.
 * @param {string} opts.systemInstruction - System prompt.
 * @param {number} [opts.temperature=0] - Sampling temperature.
 * @returns {Promise<string>} The model's text response.
 */
export async function geminiGenerateContent({ messages, systemInstruction, temperature = 0 }) {
  const apiKey = loadApiKey()

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }))

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature, maxOutputTokens: 2048 }
  }

  logger.debug(`[GeminiClient] POST ${BASE_URL} — ${messages.length} message(s)`)

  const res = await fetch(`${BASE_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  logger.debug(`[GeminiClient] response length=${text.length}`)
  return text
}
