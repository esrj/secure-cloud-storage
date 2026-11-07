/**
 * Error codes and user-facing hints for smart classify on Windows.
 *
 * On Windows the post-upload dialog shows `result.userHint.message` instead of
 * the raw reason code, error text, file paths or environment variable names;
 * the full error stays in the log. macOS never gets a `userHint`, so its error
 * messages and result format are unchanged (see withUserHint).
 */

export const MODEL_ERROR = Object.freeze({
  NOT_INSTALLED: 'MODEL_NOT_INSTALLED',
  BUSY: 'MODEL_BUSY',
  INVALID: 'MODEL_INVALID',
  ENV_PATH_INVALID: 'MODEL_ENV_PATH_INVALID',
  LOAD_FAILED: 'MODEL_LOAD_FAILED',
  LOAD_TIMEOUT: 'MODEL_LOAD_TIMEOUT',
  CANCELLED: 'CLASSIFY_CANCELLED',
  GENERATE_TIMEOUT: 'GENERATE_TIMEOUT'
})

const MODEL_ERROR_CODES = new Set(Object.values(MODEL_ERROR))

/** A model-level failure: the rest of the batch would fail the same way. */
export class ClassifierModelError extends Error {
  /**
   * @param {string} code one of MODEL_ERROR
   * @param {string} message full detail for the log (may contain paths)
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts)
    this.name = 'ClassifierModelError'
    this.code = code
  }
}

/** @param {unknown} e */
export function isModelLevelError(e) {
  return e instanceof ClassifierModelError || MODEL_ERROR_CODES.has(/** @type {any} */ (e)?.code)
}

/**
 * action: 'setup' → offer download / import; 'retry' → offer the retry button;
 * null → nothing the app can do (the message says what to change).
 * @type {Record<string, { message: string, action: 'setup' | 'retry' | null }>}
 */
const HINTS = {
  [MODEL_ERROR.NOT_INSTALLED]: {
    message: '尚未安裝智慧分類模型。請先下載或匯入模型；這次可以先手動輸入標籤。',
    action: 'setup'
  },
  [MODEL_ERROR.BUSY]: {
    message: '模型還在下載、匯入或校驗中，完成後再重試分類；這次可以先手動輸入標籤。',
    action: 'setup'
  },
  [MODEL_ERROR.INVALID]: {
    message: '模型檔不完整或未通過校驗，請重新下載或匯入。這次可以先手動輸入標籤。',
    action: 'setup'
  },
  [MODEL_ERROR.ENV_PATH_INVALID]: {
    message:
      '系統環境設定指定的模型檔不存在或無法載入。請修正或移除該設定後重新啟動程式；詳細原因已記錄在 log。這次可以先手動輸入標籤。',
    action: null
  },
  [MODEL_ERROR.LOAD_FAILED]: {
    message:
      '模型載入失敗，可能是記憶體不足或顯示卡驅動不相容。請關閉其他程式後重試，或手動輸入標籤。',
    action: 'retry'
  },
  [MODEL_ERROR.LOAD_TIMEOUT]: {
    message: '模型載入時間過長，已停止載入。請稍後重試，或手動輸入標籤。',
    action: 'retry'
  },
  [MODEL_ERROR.CANCELLED]: {
    message: '已取消智慧分類。可以手動輸入標籤，或稍後重試。',
    action: 'retry'
  },
  [MODEL_ERROR.GENERATE_TIMEOUT]: {
    message: '分析時間過長，已停止。請重試或手動輸入標籤。',
    action: 'retry'
  },
  GENERATE_FAILED: {
    message: '智慧分類執行失敗，請重試或手動輸入標籤。',
    action: 'retry'
  },
  JSON_PARSE_FAILED: {
    message: '模型回覆的格式無法解析，請重試或手動輸入標籤。',
    action: 'retry'
  },
  EMPTY_CONTENT: {
    message: '這批檔案沒有可供分析的內容，請手動輸入標籤。',
    action: null
  },
  CLASSIFY_EXCEPTION: {
    message: '智慧分類發生錯誤，請重試或手動輸入標籤。',
    action: 'retry'
  },
  DISABLED: {
    message: '智慧分類目前為關閉狀態。',
    action: null
  },
  NO_FILES: {
    message: '沒有可供分析的檔案。',
    action: null
  }
}

/**
 * @param {string | undefined} reason result.reason
 * @param {unknown} [error] the error behind the failure, if any
 * @returns {{ code: string, message: string, action: 'setup' | 'retry' | null }}
 */
export function buildUserHint(reason, error) {
  const errorCode = /** @type {any} */ (error)?.code
  const code = MODEL_ERROR_CODES.has(errorCode)
    ? errorCode
    : reason && HINTS[reason] && reason !== 'LLM_GENERATE_FAILED'
      ? reason
      : 'GENERATE_FAILED'
  return { code, ...HINTS[code] }
}

/**
 * Attach a user-facing hint to a failed classification result — only when the
 * Windows model manager is active (`support` non-null). Otherwise the result is
 * returned untouched, which keeps the macOS result format byte-for-byte.
 * @template {{ supported?: boolean, reason?: string }} T
 * @param {T} result
 * @param {unknown} error
 * @param {unknown} support getWindowsClassifierSupport()
 * @returns {T}
 */
export function withUserHint(result, error, support) {
  if (!support || !result || result.supported) return result
  return { ...result, userHint: buildUserHint(result.reason, error) }
}
