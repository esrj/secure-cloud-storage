/**
 * Merges agent search APIs into the electronAPI object.
 *
 * import { mergeAgentApisIntoElectronApi } from './agentPreloadMerge.js'
 * mergeAgentApisIntoElectronApi(electronAPIObj)
 */
import { ipcRenderer } from 'electron'

/**
 * @param {Record<string, unknown>} electronApi
 */
export function mergeAgentApisIntoElectronApi(electronApi) {
  /**
   * Run one agent turn.
   * @param {{ userMessage: string, history: {role:string,content:string}[], rawFiles: object[] }} payload
   * @returns {Promise<import('../main/services/AgentService.js').AgentTurnResult & { ok: boolean, error?: string }>}
   */
  electronApi.agentQuery = (payload) => ipcRenderer.invoke('agent:query', payload)

  return electronApi
}
