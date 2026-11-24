/**
 * Turns a failed `agent-llm` call into a reason the user can read.
 * The codes come from the server (AgentLlm.js) or from this client's own socket layer.
 */
const REASONS = {
  LLM_BUSY: '你的上一個查詢還在處理中',
  LLM_RATE_LIMITED: '查詢太頻繁，請一分鐘後再試',
  LLM_TIMEOUT: '語言模型回應逾時，可能正在載入，請稍後再試',
  LLM_UNAVAILABLE: '伺服器上的語言模型目前無法使用，請洽系統管理者',
  NOT_CONNECTED: '與伺服器的連線中斷',
  'Server did not respond.': '伺服器沒有回應',
  'Not logged in.': '尚未登入',
  'Invalid arguments.': '查詢內容過長',
  'Internal server error.': '伺服器發生錯誤'
}

/**
 * @param {string} code  the error message of the failed call
 * @returns {string} a short reason in Traditional Chinese, without trailing punctuation
 */
export function describeLlmError(code) {
  return REASONS[code] ?? `伺服器回報錯誤（${code}）`
}
