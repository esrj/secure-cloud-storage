/**
 * Smart-search LLM relay, wired to the real socket, config and logger.
 * The logic and the event contract are in AgentLlm.js.
 */
import ConfigManager from './ConfigManager.js'
import { logger, logSocketError, logSocketInfo, logSocketWarning } from './Logger.js'
import {
  checkLoggedIn,
  InternalServerErrorMsg,
  InvalidArgumentErrorMsg,
  NotLoggedInErrorMsg
} from './Utils.js'
import { AgentLlmRequestSchema } from './Validation.js'
import { createAgentLlmHandler, createUsageLimiter, ollamaChat, warmUp } from './AgentLlm.js'

const handleAgentLlm = createAgentLlmHandler({
  schema: AgentLlmRequestSchema,
  isLoggedIn: checkLoggedIn,
  limiter: createUsageLimiter({ maxPerMinute: ConfigManager.agent.maxRequestsPerMinute }),
  chat: (call) => ollamaChat(ConfigManager.agent.ollama, call),
  log: { info: logSocketInfo, warn: logSocketWarning, error: logSocketError },
  errorMsgs: {
    invalid: InvalidArgumentErrorMsg,
    notLoggedIn: NotLoggedInErrorMsg,
    internal: InternalServerErrorMsg
  }
})

export const agentLlmBinder = (socket) => {
  socket.on('agent-llm', (request, cb) => handleAgentLlm(socket, request, cb))
}

/** Load the model in the background at server start (config `agent.warmUp`). Never throws. */
export const startAgentWarmUp = () => {
  if (!ConfigManager.agent.warmUp) return
  logger.info(`Warming up smart-search model at ${ConfigManager.agent.ollama.url}...`)
  warmUp(ConfigManager.agent.ollama, {
    log: (level, message) => logger[level](message)
  })
    .then((loaded) => {
      if (!loaded) logger.warn('Smart-search model warm-up gave up; the first search will load it.')
    })
    .catch((error) => logger.error(error))
}

console.debug('AgentLlmManager.js loaded.')
