/**
 * Shared pieces for security-key (fingerprint) operations in the backup and recovery dialogs.
 *
 * useSecurityKeyOperation() subscribes to the key's progress events and PIN requests only while
 * an operation it started is running, so the dialog that started it is the only one answering.
 * The PIN is entered inline (no stacked dialog) and sent straight to the main process.
 */
import { Button, Input, Spinner, Typography } from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useCallback, useEffect, useRef, useState } from 'react'

/** Progress event from the key -> message for the user. */
export function describeFidoEvent(evt) {
  switch (evt?.event) {
    case 'uv':
      return '請等安全金鑰的綠燈開始閃爍。'
    case 'touch':
      return '現在按指紋：手指平放在感測器上，同時碰到周圍的銀色金屬環。'
    case 'uv-failed':
      return evt.retriesLeft > 0
        ? `指紋比對失敗，還可以再試 ${evt.retriesLeft} 次。`
        : '指紋比對失敗，指紋已鎖定，接下來請輸入 PIN。'
    case 'lift-finger':
      return '請把手指完全移開，稍後再按一次。'
    case 'uv-blocked':
      return '指紋已鎖定，請輸入 PIN。輸入正確的 PIN 會解除鎖定。'
    case 'pin-fallback':
      return '請輸入安全金鑰的 PIN。'
    case 'need-second-touch':
      return '需要再按一次指紋。'
    case 'multiple-devices':
      return '偵測到多支安全金鑰，請只插上一支。'
    case 'enroll-start':
      return '開始登錄指紋。每次等綠燈閃再按，並換一個角度。'
    case 'enroll-sample':
      return evt.remaining > 0
        ? `取樣成功，還需要約 ${evt.remaining} 次。換個角度再按。`
        : '取樣完成。'
    case 'enroll-retry':
      return '這次取樣不清楚，請再按一次。'
    default:
      return ''
  }
}

/** { ok: false, code, error } from the recovery IPC -> message for the user. */
export function describeFidoError(result) {
  switch (result?.code) {
    case 'NO_DEVICE':
      return '找不到安全金鑰，請確認已經插上。'
    case 'PIN_NOT_SET':
      return '安全金鑰還沒有設定 PIN，請先設定 PIN。'
    case 'UNSUPPORTED':
      return '這支安全金鑰不支援指紋復原。'
    case 'PIN_INVALID':
      return 'PIN 錯誤。'
    case 'PIN_AUTH_BLOCKED':
      return 'PIN 連續錯誤三次，請拔下金鑰重新插上再試。'
    case 'PIN_BLOCKED':
      return 'PIN 錯誤次數過多，金鑰已鎖定，必須重設金鑰。'
    case 'PIN_TOO_SHORT':
    case 'PIN_POLICY_VIOLATION':
      return 'PIN 太短或不符合金鑰的規則。'
    case 'PIN_ALREADY_SET':
      return '這支金鑰已經設定過 PIN。'
    case 'UV_FAILED':
    case 'UV_BLOCKED':
      return '指紋驗證失敗。'
    case 'WRONG_KEY':
      return '這支安全金鑰沒有綁定在這個帳號上。'
    case 'CANCELLED':
      return '已取消。'
    case 'TIMEOUT':
      return '等待逾時，請再試一次。'
    case 'HELPER_START_FAILED':
    case 'HELPER_CRASHED':
    case 'FIDO2_NOT_INSTALLED':
      return '無法啟動安全金鑰元件，請確認已安裝 Python 3 與 fido2 套件。'
    case 'NOT_ENOUGH_SHARES':
      return '可用的碎片不足，請聯絡伺服器管理員。'
    case 'RESTORE_FAILED':
      return '無法用這支金鑰的碎片還原帳號金鑰。'
    case 'LOGIN_FAILED':
      return /already logged in/i.test(result.error ?? '')
        ? '私鑰已經還原，但這個帳號正在另一個 Client 登入中。請先完全結束另一台的 Client，再重新開啟這個 Client，就會自動登入。'
        : `私鑰已經還原，但登入失敗：${result.error}。重新開啟 Client 會再試一次。`
    case 'BAD_SERVER_RESPONSE':
      return '伺服器回應的資料不正確。'
    case 'SERVER':
      return `伺服器拒絕：${result.error}`
    default:
      return result?.error || '發生未預期的錯誤。'
  }
}

export function useSecurityKeyOperation() {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [pinRequest, setPinRequest] = useState(null)
  const cleanupRef = useRef(null)

  // Unsubscribe if the dialog unmounts mid-operation.
  useEffect(() => () => cleanupRef.current?.(), [])

  /** Run one key operation; resolves to the IPC result ({ ok, ... }). */
  const run = useCallback(async (operation) => {
    setBusy(true)
    setStatus('連線安全金鑰中…')
    const offEvent = window.electronAPI.onRecoveryFidoEvent((evt) => {
      const message = describeFidoEvent(evt)
      if (message) setStatus(message)
    })
    const offPin = window.electronAPI.onRecoveryPinRequest((request) => setPinRequest(request))
    cleanupRef.current = () => {
      offEvent()
      offPin()
    }
    try {
      return await operation()
    } catch (error) {
      return { ok: false, error: error?.message }
    } finally {
      cleanupRef.current?.()
      cleanupRef.current = null
      setBusy(false)
      setPinRequest(null)
      setStatus('')
    }
  }, [])

  const submitPin = useCallback(
    (pin) => {
      if (!pinRequest) return
      window.electronAPI.recoverySendPin(pinRequest.requestId, pin || null)
      setPinRequest(null)
      setStatus('驗證 PIN 中…')
    },
    [pinRequest]
  )

  const cancel = useCallback(() => {
    window.electronAPI.recoveryCancel()
    setPinRequest(null)
  }, [])

  return { busy, status, pinRequest, run, submitPin, cancel }
}

/** Progress line, inline PIN entry, and a cancel button while an operation runs. */
export function SecurityKeyPanel({ op }) {
  const [pin, setPin] = useState('')
  if (!op.busy) return null

  const send = () => {
    op.submitPin(pin)
    setPin('')
  }

  return (
    <div className="space-y-3 rounded-lg border border-blue-gray-100 bg-blue-gray-50/50 p-4">
      <div className="flex items-center gap-2">
        <Spinner className="size-4" />
        <Typography variant="small" color="blue-gray">
          {op.status}
        </Typography>
      </div>
      {op.pinRequest && (
        <div className="space-y-2">
          <Input
            label={
              op.pinRequest.retries != null
                ? `安全金鑰 PIN（還可以錯 ${op.pinRequest.retries} 次）`
                : '安全金鑰 PIN'
            }
            type="password"
            size="lg"
            value={pin}
            autoFocus
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pin && send()}
          />
          <Button size="sm" color="black" disabled={!pin} onClick={send}>
            送出 PIN
          </Button>
        </div>
      )}
      <Button size="sm" variant="text" color="red" onClick={op.cancel}>
        取消金鑰操作
      </Button>
    </div>
  )
}

SecurityKeyPanel.propTypes = {
  op: PropTypes.shape({
    busy: PropTypes.bool.isRequired,
    status: PropTypes.string.isRequired,
    pinRequest: PropTypes.shape({ requestId: PropTypes.string, retries: PropTypes.number }),
    submitPin: PropTypes.func.isRequired,
    cancel: PropTypes.func.isRequired
  }).isRequired
}
