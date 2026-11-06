/**
 * This component is a dialog for recover user account.
 * After the email code, the user recovers with the backup password or with a bound
 * security key and fingerprint (指紋復原計劃，階段 4).
 */
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Input,
  Button,
  Typography
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { Validators } from './Validator'
import { SecurityKeyPanel, describeFidoError, useSecurityKeyOperation } from './SecurityKey'

// Server messages meaning this email verification can no longer be used (RecoveryService.js).
const RESTART_REQUIRED = [
  'Verify the email code before recovering.',
  'Email verification expired. Please start recovery again.'
]

// step: 'email' -> 'code' -> 'choose' -> 'password' | 'key'
function RecoverDialog({ open, setOpen }) {
  const [email, setEmail] = useState('')
  const [emailAuth, setEmailAuth] = useState('')
  const [extraKey, setExtraKey] = useState('')
  const [step, setStep] = useState('email')
  const [hasPassword, setHasPassword] = useState(true)
  const [keyMethods, setKeyMethods] = useState([])
  const [selectedKey, setSelectedKey] = useState(null)
  const op = useSecurityKeyOperation()

  function dialogHandler() {
    if (op.busy) op.cancel()
    setOpen(!open)
    setEmail('')
    setEmailAuth('')
    setExtraKey('')
    setStep('email')
    setHasPassword(true)
    setKeyMethods([])
    setSelectedKey(null)
  }

  function cancelHandler() {
    dialogHandler()
    toast.error('Recover canceled.')
  }

  /** After the email code: decide which recovery options to offer. */
  function onEmailVerified(result) {
    // Older servers send no method list; the password method is then the only option.
    const methods = Array.isArray(result?.methods)
      ? result.methods
      : [{ id: 'password', type: 'password' }]
    const keys = methods.filter((m) => m.type === 'fido')
    const password = methods.some((m) => m.type === 'password')
    if (!password && keys.length === 0) {
      dialogHandler()
      toast.error('這個帳號沒有設定任何備份，無法復原。')
      return
    }
    setHasPassword(password)
    setKeyMethods(keys)
    setStep(keys.length > 0 ? 'choose' : 'password')
  }

  async function recoverWithKey(method) {
    setSelectedKey(method)
    setStep('key')
    const result = await op.run(() =>
      window.electronAPI.recoveryRecoverWithKey({ methodId: method.id })
    )
    if (result.ok) {
      dialogHandler()
      toast.success('Secret recover succeeded')
      return
    }
    if (result.code !== 'CANCELLED') toast.error(describeFidoError(result))
    // The email verification is used up after a restore attempt or when the server says so.
    if (
      result.code === 'RESTORE_FAILED' ||
      result.code === 'LOGIN_FAILED' ||
      RESTART_REQUIRED.includes(result.error)
    ) {
      dialogHandler()
      return
    }
    setStep('choose') // key problems can be retried with the same email verification
  }

  function updateHandler() {
    switch (step) {
      case 'email': {
        const result = Validators.email(email)
        if (!result.valid) {
          toast.error(result.message)
          return
        }
        const askRecoverSecretPromise = window.electronAPI.askRecoverSecret({ email })
        toast.promise(askRecoverSecretPromise, {
          loading: '確認中',
          success: '確認成功',
          error: '確認失敗'
        })
        askRecoverSecretPromise
          .then(() => {
            setStep('code')
          })
          .catch((error) => {
            dialogHandler()
            toast.error('Failed to recover secrets.')
          })
        break
      }
      case 'code': {
        const result = Validators.verificationCode(emailAuth)
        if (!result.valid) {
          toast.error(result.message)
          return
        }
        const sendEmailAuthPromise = window.electronAPI.sendEmailAuth({
          emailAuth
        })
        toast.promise(sendEmailAuthPromise, {
          loading: '驗證中',
          success: '驗證成功',
          error: '驗證失敗'
        })
        sendEmailAuthPromise.then(onEmailVerified).catch((error) => {
          dialogHandler()
          toast.error('Failed to recover secrets.')
        })
        break
      }
      case 'password': {
        const result = Validators.password(extraKey)
        if (!result.valid) {
          toast.error(result.message)
          return
        }
        const sendRecoverExtraKeyPromise = window.electronAPI.sendRecoverExtraKey({ extraKey })
        toast.promise(sendRecoverExtraKeyPromise, {
          loading: '解密中',
          success: '解密成功',
          error: '解密失敗'
        })
        sendRecoverExtraKeyPromise
          .then(() => {
            dialogHandler()
            toast.success('Secret recover succeeded')
          })
          .catch((error) => {
            dialogHandler()
            toast.error('Failed to recover secrets.')
          })
        break
      }
      default:
        break
    }
  }

  function renderText() {
    switch (step) {
      case 'email':
        return '輸入電子信箱以復原帳號。'
      case 'code':
        return '輸入驗證碼。'
      case 'choose':
        return '選擇復原方式。'
      case 'password':
        return '輸入備份使用的密碼。'
      case 'key':
        return `插上安全金鑰「${selectedKey?.label || '安全金鑰'}」，依照提示按指紋。`
      default:
        return ''
    }
  }

  const showConfirm = step === 'email' || step === 'code' || step === 'password'

  return (
    <Dialog open={open} handler={cancelHandler}>
      <DialogHeader>帳號復原</DialogHeader>
      <DialogBody className="space-y-2">
        <Typography variant="lead">{renderText()}</Typography>

        <Input
          label="電子信箱"
          size="lg"
          value={email}
          error={!Validators.email(email).valid}
          readOnly={step !== 'email'}
          onChange={(e) => setEmail(e.target.value)}
        />
        {step !== 'email' && (
          <Input
            label="驗證碼"
            size="lg"
            value={emailAuth}
            error={!Validators.verificationCode(emailAuth).valid}
            readOnly={step !== 'code'}
            onChange={(e) => setEmailAuth(e.target.value.trim())}
          />
        )}

        {step === 'choose' && (
          <div className="flex flex-col gap-2 pt-2">
            {keyMethods.map((m) => (
              <Button key={m.id} color="black" onClick={() => recoverWithKey(m)}>
                使用安全金鑰與指紋：{m.label || '安全金鑰'}
              </Button>
            ))}
            {hasPassword && (
              <Button variant="outlined" color="black" onClick={() => setStep('password')}>
                使用備份密碼
              </Button>
            )}
          </div>
        )}

        {step === 'password' && (
          <>
            <Input
              label="密碼"
              size="lg"
              type="password"
              error={!Validators.password(extraKey).valid}
              value={extraKey}
              onChange={(e) => setExtraKey(e.target.value)}
            />
            {keyMethods.length > 0 && (
              <Button size="sm" variant="text" onClick={() => setStep('choose')}>
                改用安全金鑰
              </Button>
            )}
          </>
        )}

        {step === 'key' && <SecurityKeyPanel op={op} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={cancelHandler}>
          取消
        </Button>
        {showConfirm && (
          <Button variant="gradient" color="black" onClick={updateHandler}>
            確定
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}

RecoverDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}
export default RecoverDialog
