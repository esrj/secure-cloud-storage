/**
 * LLM access for the metadata search agent.
 *
 * The client has no model of its own. Every call goes to the Cloud Server over the existing
 * Socket.IO connection (`agent-llm`) and the server runs it on its GPU, so smart search works
 * on any computer that can log in: no local Ollama, no SSH tunnel. The server also owns the
 * system prompts and the model choice; the client only names the task.
 */
import { socket } from '../MessageManager.js'
import { emitWithAck } from '../ipc/adminIpc.js'
import { logger } from '../Logger.js'
import { describeLlmError } from './llmErrors.js'

/** Recorded with each logged conversation turn. */
export const LLM_PROVIDER = 'server'

// The server gives Ollama 150 s (a cold model takes about 80 s to load). Waiting longer than
// that here means the server always answers first, with the real reason for a failure.
const LLM_ACK_TIMEOUT_MS = 180000

/**
 * Run one LLM task on the server.
 * @param {object} opts
 * @param {'parse'|'summary'} opts.task
 * @param {{ role: 'user'|'assistant', content: string }[]} opts.messages
 * @returns {Promise<string>} the model's text
 * @throws {Error} with a message that can be shown to the user
 */
export async function llmGenerateContent({ task, messages }) {
  try {
    // Without this check the request would sit in the socket's send buffer until the timeout.
    if (!socket.connected) throw new Error('NOT_CONNECTED')
    const { text } = await emitWithAck('agent-llm', { task, messages }, LLM_ACK_TIMEOUT_MS)
    if (typeof text !== 'string') throw new Error('LLM_UNAVAILABLE')
    return text
  } catch (e) {
    logger.warn(`[LlmClient] ${task} failed: ${e.message}`)
    throw new Error(describeLlmError(e.message))
  }
}
