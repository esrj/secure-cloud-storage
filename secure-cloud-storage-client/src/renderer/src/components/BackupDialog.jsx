/**
 * This component is a dialog for backup.
 * Two methods: an extra password, or a security key with fingerprint (指紋復原計劃，階段 4).
 */
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Input,
  Button,
  Typography,
  Chip,
  Spinner
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Validators } from './Validator'
import { SecurityKeyPanel, describeFidoError, useSecurityKeyOperation } from './SecurityKey'

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('zh-TW') : '')

function BackupDialog({ open, setOpen }) {
  const [mode, setMode] = useState('password') // 'password' | 'key'
  const [extraKey, setExtraKey] = useState('')
  const [methods, setMethods] = useState(null)
  const [keyInfo, setKeyInfo] = useState(null)
  const [label, setLabel] = useState('YubiKey Bio')
  const [newPin, setNewPin] = useState('')
  const [newPin2, setNewPin2] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const op = useSecurityKeyOperation()

  const refreshMethods = useCallback(async () => {
    const result = await window.electronAPI.recoveryListMethods()
    if (result.ok) setMethods(result.methods)
    else toast.error(describeFidoError(result))
  }, [])

  const refreshKeyInfo = useCallback(async () => {
    setKeyInfo(null)
    setKeyInfo(await window.electronAPI.recoveryKeyInfo())
  }, [])

  useEffect(() => {
    if (open && mode === 'key') {
      refreshMethods()
      refreshKeyInfo()
    }
  }, [open, mode, refreshMethods, refreshKeyInfo])

  function dialogHandler() {
    if (op.busy) op.cancel()
    setOpen(!open)
    setExtraKey('')
    setMode('password')
    setMethods(null)
    setKeyInfo(null)
    setNewPin('')
    setNewPin2('')
    setPendingDelete(null)
  }

  function passwordBackupHandler() {
    const result = Validators.password(extraKey)
    if (!result.valid) {
      toast.error(result.message)
      return
    }
    // Send extrakey to main process
    window.electronAPI
      .askShareSecret({ extraKey })
      .then(() => {
        toast.success('Backup succeed.')
      })
      .catch((error) => {
        toast.error('Backup failed.')
      })
    dialogHandler()
  }

  async function bindHandler() {
    const result = await op.run(() =>
      window.electronAPI.recoveryBindKey({ label: label.trim() || undefined })
    )
    if (result.ok) {
      toast.success('安全金鑰綁定成功，之後可以用這支金鑰按指紋復原帳號。')
      refreshMethods()
    } else if (result.code !== 'CANCELLED') {
      toast.error(describeFidoError(result))
    }
    refreshKeyInfo()
  }

  async function setPinHandler() {
    const minLength = keyInfo?.info?.minPinLength ?? 4
    if (newPin.length < minLength) {
      toast.error(`PIN 至少需要 ${minLength} 個字元。`)
      return
    }
    if (newPin !== newPin2) {
      toast.error('兩次輸入的 PIN 不一致。')
      return
    }
    const result = await op.run(() => window.electronAPI.recoverySetPin({ pin: newPin }))
    if (result.ok) {
      toast.success('PIN 設定完成，請牢記這組 PIN。')
      setNewPin('')
      setNewPin2('')
    } else {
      toast.error(describeFidoError(result))
    }
    refreshKeyInfo()
  }

  async function enrollHandler() {
    const result = await op.run(() => window.electronAPI.recoveryEnrollFingerprint({}))
    if (result.ok) {
      toast.success(`指紋登錄完成，金鑰上共有 ${result.enrolledCount} 枚指紋。`)
    } else if (result.code !== 'CANCELLED') {
      toast.error(describeFidoError(result))
    }
    refreshKeyInfo()
  }

  async function deleteHandler(method) {
    setPendingDelete(null)
    const result = await window.electronAPI.recoveryDeleteMethod({ methodId: method.id })
    if (result.ok) toast.success('已移除這支安全金鑰。')
    else toast.error(describeFidoError(result))
    refreshMethods()
  }

  const info = keyInfo?.ok ? keyInfo.info : null
  const keyMethods = (methods ?? []).filter((m) => m.type === 'fido')
  const hasPassword = (methods ?? []).some((m) => m.type === 'password')
  const needsSecondMethod = methods !== null && !hasPassword && keyMethods.length < 2
  const canBind = Boolean(info?.hmacSecret && info?.pinSet) && !op.busy

  function renderKeyStatus() {
    if (keyInfo === null) {
      return (
        <div className="flex items-center gap-2">
          <Spinner className="size-4" />
          <Typography variant="small">偵測安全金鑰中…</Typography>
        </div>
      )
    }
    if (!keyInfo.ok) {
      return (
        <div className="flex items-center gap-3">
          <Typography variant="small" color="red">
            {describeFidoError(keyInfo)}
          </Typography>
          <Button size="sm" variant="outlined" onClick={refreshKeyInfo} disabled={op.busy}>
            重新偵測
          </Button>
        </div>
      )
    }
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Typography variant="small" className="font-medium">
            {info.product}
          </Typography>
          <Chip
            size="sm"
            variant="ghost"
            color={info.pinSet ? 'green' : 'red'}
            value={info.pinSet ? '已設定 PIN' : '尚未設定 PIN'}
          />
          {info.bioSupported && (
            <Chip
              size="sm"
              variant="ghost"
              color={info.fingerprintEnrolled ? 'green' : 'amber'}
              value={info.fingerprintEnrolled ? '已登錄指紋' : '尚未登錄指紋'}
            />
          )}
          {!info.hmacSecret && (
            <Chip size="sm" variant="ghost" color="red" value="不支援 hmac-secret" />
          )}
        </div>

        {!info.pinSet && (
          <div className="space-y-2">
            <Typography variant="small">
              先為金鑰設定 PIN。指紋連續失敗三次時要用 PIN 解鎖，PIN 累計錯八次金鑰會鎖死。
            </Typography>
            <Input
              label="新的 PIN"
              type="password"
              size="lg"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
            />
            <Input
              label="再輸入一次 PIN"
              type="password"
              size="lg"
              value={newPin2}
              onChange={(e) => setNewPin2(e.target.value)}
            />
            <Button size="sm" color="black" onClick={setPinHandler} disabled={op.busy}>
              設定 PIN
            </Button>
          </div>
        )}

        {info.pinSet && info.bioSupported && (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outlined" onClick={enrollHandler} disabled={op.busy}>
              {info.fingerprintEnrolled ? '再登錄一枚指紋' : '登錄指紋'}
            </Button>
            <Typography variant="small" color="gray">
              {info.fingerprintEnrolled
                ? '同一根手指多登錄一兩次可以提高辨識率，金鑰最多存五枚。'
                : '登錄時每次都要等綠燈閃、碰到銀色金屬環，並換一個角度。'}
            </Typography>
          </div>
        )}
      </div>
    )
  }

  function renderMethods() {
    if (methods === null) {
      return (
        <div className="flex items-center gap-2">
          <Spinner className="size-4" />
          <Typography variant="small">讀取復原方式中…</Typography>
        </div>
      )
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Typography variant="small" className="font-medium">
            密碼備份
          </Typography>
          <Chip
            size="sm"
            variant="ghost"
            color={hasPassword ? 'green' : 'blue-gray'}
            value={hasPassword ? '已設定' : '未設定'}
          />
        </div>
        {keyMethods.length === 0 && (
          <Typography variant="small" color="gray">
            還沒有綁定任何安全金鑰。
          </Typography>
        )}
        {keyMethods.map((m) => (
          <div
            key={m.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-gray-100 px-3 py-2"
          >
            <div>
              <Typography variant="small" className="font-medium">
                {m.label || '安全金鑰'}
              </Typography>
              <Typography variant="small" color="gray">
                綁定於 {formatDate(m.createdAt)}
                {m.lastUsedAt ? `，上次用於復原 ${formatDate(m.lastUsedAt)}` : ''}
                {m.sharesAvailable ? '' : '，碎片目前無法取得'}
              </Typography>
            </div>
            {pendingDelete === m.id ? (
              <div className="flex gap-1">
                <Button size="sm" color="red" onClick={() => deleteHandler(m)}>
                  確定移除
                </Button>
                <Button size="sm" variant="text" onClick={() => setPendingDelete(null)}>
                  取消
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="text"
                color="red"
                onClick={() => setPendingDelete(m.id)}
                disabled={op.busy}
              >
                移除
              </Button>
            )}
          </div>
        ))}
        {needsSecondMethod && (
          <Typography variant="small" color="red">
            提醒：安全金鑰遺失或 PIN
            鎖死時，就無法再用指紋復原。請同時設定密碼備份，或再綁定第二支金鑰。
          </Typography>
        )}
      </div>
    )
  }

  return (
    <Dialog open={open} handler={dialogHandler}>
      <DialogHeader>帳號備份</DialogHeader>
      <DialogBody className="max-h-[70vh] space-y-3 overflow-y-auto">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === 'password' ? 'filled' : 'outlined'}
            color="black"
            onClick={() => setMode('password')}
            disabled={op.busy}
          >
            密碼
          </Button>
          <Button
            size="sm"
            variant={mode === 'key' ? 'filled' : 'outlined'}
            color="black"
            onClick={() => setMode('key')}
            disabled={op.busy}
          >
            安全金鑰（指紋）
          </Button>
        </div>

        {mode === 'password' && (
          <>
            <Typography variant="lead">使用額外的密碼讓帳號可被安全的復原。</Typography>
            <Typography variant="lead" color="red">
              注意！若是此密碼遺失，則帳號再也無法被復原。
            </Typography>
            <Typography variant="lead">
              若是已經執行過備份，可以輸入新的密碼來覆蓋舊的密碼。
            </Typography>

            <Input
              label="密碼"
              size="lg"
              type="password"
              error={!Validators.password(extraKey).valid}
              value={extraKey}
              onChange={(e) => setExtraKey(e.target.value)}
            />
          </>
        )}

        {mode === 'key' && (
          <>
            <Typography variant="small">
              綁定後，忘記備份密碼時，只要收 Email
              驗證碼、插上金鑰並按指紋，就能在任何電腦上復原帳號。指紋只存在金鑰裡，不會上傳。
            </Typography>
            <div className="space-y-2">
              <Typography variant="h6">已設定的復原方式</Typography>
              {renderMethods()}
            </div>
            <div className="space-y-2">
              <Typography variant="h6">目前插著的安全金鑰</Typography>
              {renderKeyStatus()}
            </div>
            <div className="space-y-2">
              <Typography variant="h6">綁定這支金鑰</Typography>
              <Input
                label="名稱"
                size="lg"
                value={label}
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
                disabled={op.busy}
              />
              <Button color="black" onClick={bindHandler} disabled={!canBind}>
                綁定並按指紋
              </Button>
            </div>
            <SecurityKeyPanel op={op} />
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {mode === 'password' ? (
          <>
            <Button variant="text" color="red" onClick={dialogHandler}>
              取消
            </Button>
            <Button variant="gradient" color="black" onClick={passwordBackupHandler}>
              確定
            </Button>
          </>
        ) : (
          <Button variant="text" onClick={dialogHandler}>
            關閉
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}

BackupDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}

export default BackupDialog
