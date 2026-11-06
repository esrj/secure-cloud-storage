/**
 * IPC handlers for the metadata search agent.
 *
 * Channels:
 *   agent:file-scope  — fetch the searchable set: own files (all folders) + others' public files
 *   agent:query       — run a single agent turn
 *                       payload: { userMessage, history, rawFiles, folders, currentUserId }
 *                       returns: AgentTurnResult & { provider }
 *   agent:log         — persist one completed turn on the server (audit + history)
 *   agent:my-history  — fetch the caller's own conversations from the server
 */
import { ipcMain } from 'electron'
import { buildSearchableMetadata } from '../services/MetadataCollector.js'
import { runAgentTurn } from '../services/AgentService.js'
import { resolveProvider } from '../services/LlmClient.js'
import { logger } from '../Logger.js'
import { emitWithAck } from './adminIpc.js'

let _databaseManager = null
let _fileManager = null
let _registered = false

/** Inject the FileManager used to fetch the search scope. Call from index.js. */
export function setFileManagerForAgentIpc(fileManager) {
  _fileManager = fileManager
}

/** Inject the DatabaseManager so we can read local tags. Call from index.js. */
export function setDatabaseManagerForAgentIpc(databaseManager) {
  _databaseManager = databaseManager
}

export function registerAgentIpcOnce() {
  if (_registered) return
  _registered = true

  // Persist one completed turn on the server (admin audit + cross-restart history).
  ipcMain.handle('agent:log', async (_event, payload) => {
    try {
      await emitWithAck('agent-log', payload)
      return { ok: true }
    } catch (e) {
      logger.warn(`[AgentIpc] agent:log failed: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('agent:my-history', async (_event, { limit } = {}) => {
    try {
      const { conversations } = await emitWithAck('agent-my-history', limit ? { limit } : {})
      return { ok: true, conversations: Array.isArray(conversations) ? conversations : [] }
    } catch (e) {
      logger.warn(`[AgentIpc] agent:my-history failed: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('agent:file-scope', async () => {
    try {
      if (!_fileManager) throw new Error('FileManager not ready')
      const { files, folders } = await _fileManager.getAgentFileScopeProcess()
      return { ok: true, files, folders }
    } catch (e) {
      logger.warn(`[AgentIpc] agent:file-scope failed: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('agent:query', async (_event, { userMessage, history = [], rawFiles = [], folders = [], uploaderName = '', currentUserId = '' }) => {
    try {
      logger.info(`[AgentIpc] agent:query — "${userMessage.slice(0, 80)}"`)

      // Local provider (ollama): metadata never leaves this machine, so the
      // user's own private files are searchable too. Cloud provider (gemini):
      // only public files (perm === 1) — private metadata is never sent out.
      const provider = resolveProvider()
      const searchable =
        provider === 'gemini'
          ? rawFiles.filter((f) => (f.perm ?? f.permissions ?? 0) === 1)
          : rawFiles
      logger.debug(
        `[AgentIpc] provider=${provider}, total=${rawFiles.length}, searchable=${searchable.length}`
      )

      const files = buildSearchableMetadata(searchable, _databaseManager, {
        uploaderName,
        folders,
        currentUserId
      })
      const result = await runAgentTurn({ userMessage, history, files })
      return { ok: true, provider, ...result }
    } catch (e) {
      logger.error(`[AgentIpc] agent:query error: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })
}
