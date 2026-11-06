/**
 * Smart-search (LLM agent) conversation logging.
 *
 * The client sends one `agent-log` per completed turn (user message +
 * assistant reply). Conversations are owned by the logged-in user; a
 * conversation id that already belongs to someone else is rejected.
 *
 *   agent-log         { conversationId, provider?, userMessage, assistantMessage, matchedFileIds? } → {}
 *   agent-my-history  { limit? } → { conversations: [{ id, provider, startedAt, lastAt, messages }] }
 */
import { logInvalidSchemaWarning, logSocketError, logSocketInfo, logSocketWarning } from './Logger.js'
import { checkLoggedIn, InternalServerErrorMsg, InvalidArgumentErrorMsg, NotLoggedInErrorMsg } from './Utils.js'
import { addAgentMessage, getAgentHistoryByUserId, upsertAgentConversation } from './StorageDatabase.js'
import { AgentHistoryRequestSchema, AgentLogRequestSchema } from './Validation.js'
import ConfigManager from './ConfigManager.js'

const truncate = (text) => {
  const max = ConfigManager.settings.agentLogMaxChars || 8000
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

export const agentLogBinder = (socket) => {
  socket.on('agent-log', async (request, cb = () => {}) => {
    try {
      const actionStr = 'Client logs an agent turn'
      logSocketInfo(socket, actionStr + '.', { conversationId: request?.conversationId })

      const result = AgentLogRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, {
          conversationId: request?.conversationId
        })
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }
      const { conversationId, provider, userMessage, assistantMessage, matchedFileIds = [] } =
        result.data

      const conv = await upsertAgentConversation(conversationId, socket.userId, provider ?? null)
      if (conv.rowCount === 0) {
        logSocketWarning(socket, actionStr + ' for a conversation owned by another user.', {
          conversationId
        })
        cb({ errorMsg: 'Conversation belongs to another user.' })
        return
      }
      await addAgentMessage(conversationId, 'user', truncate(userMessage), [])
      await addAgentMessage(conversationId, 'assistant', truncate(assistantMessage), matchedFileIds)
      cb({})
    } catch (error) {
      logSocketError(socket, error, { conversationId: request?.conversationId })
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  socket.on('agent-my-history', async (request, cb) => {
    try {
      const actionStr = 'Client asks for own agent history'
      logSocketInfo(socket, actionStr + '.', request)

      const result = AgentHistoryRequestSchema.safeParse(request ?? {})
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.')
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }
      const conversations = await getAgentHistoryByUserId(socket.userId, result.data.limit ?? 20)
      cb({ conversations })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

console.debug('AgentLogManager.js loaded.')
