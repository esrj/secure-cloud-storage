/**
 * This component is a dialog for register
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
import { useState, useContext } from 'react'
import { ProfileContext } from './Contexts'
import toast from 'react-hot-toast'
import { Validators } from './Validator'

function RegisterDialog({ open, setOpen }) {
  const {
    storedNameC: [storedName, setStoredName],
    storedEmailC: [storedEmail, setStoredEmail],
    userIdC: [userId, setUserId]
  } = useContext(ProfileContext)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [emailAuth, setEmailAuth] = useState('')
  const [currentState, setCurrentState] = useState(0)

  function dialogHandler() {
    setOpen(!open)
    setName('')
    setEmail('')
    setEmailAuth('')
    setCurrentState(0)
  }

  function cancelHandler() {
    dialogHandler()
    toast.error('Register canceled')
  }

  function updateHandler() {
    switch (currentState) {
      case 0:
        {
          const nameResult = Validators.name(name)
          if (!nameResult.valid) {
            toast.error(nameResult.message)
            return
          }
          const emailResult = Validators.email(email)
          if (!emailResult.valid) {
            toast.error(emailResult.message)
            return
          }

          // Ask to register
          const askRegisterPromise = window.electronAPI.askRegister({ name, email })
          toast.promise(askRegisterPromise, {
            loading: '確認中',
            success: '確認成功',
            error: '確認失敗'
          })
          askRegisterPromise
            .then(() => {
              setCurrentState((prevState) => prevState + 1)
            })
            .catch((error) => {
              dialogHandler()
              toast.error(`Failed to register: ${error.message}`)
            })
        }

        break
      case 1:
        {
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
          sendEmailAuthPromise
            .then(({ userId }) => {
              if (userId) {
                setStoredName(name)
                setStoredEmail(email)
                setUserId(userId)
                dialogHandler()
                toast.success('Register success')
              } else {
                throw new Error('UserId not returned')
              }
            })
            .catch((error) => {
              if (error.message.includes('did not match')) {
                toast.error('Authentication code did not match')
              } else {
                dialogHandler()
                toast.error(`Failed to register: ${error.message}.`)
              }
            })
        }

        break
    }
  }
  return (
    <Dialog open={open} handler={cancelHandler}>
      <DialogHeader>註冊帳號</DialogHeader>
      <DialogBody className="space-y-2">
        <Typography variant="lead">
          {currentState == 0 ? '輸入名字與電子信箱' : '輸入驗證碼'}
        </Typography>
        {currentState == 0 && (
          <Typography variant="lead" color="red">
            注意！註冊即是認知並同意您的名字與電子信箱將會被蒐集與處理，並在請求檔案與公開檔案時顯示給其他使用者。
          </Typography>
        )}
        <Input
          label="名字"
          size="lg"
          value={name}
          error={!Validators.name(name).valid}
          readOnly={currentState != 0}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="電子信箱"
          size="lg"
          value={email}
          error={!Validators.email(email).valid}
          readOnly={currentState != 0}
          onChange={(e) => setEmail(e.target.value)}
        />
        {currentState > 0 && (
          <Input
            label="驗證碼"
            size="lg"
            value={emailAuth}
            error={!Validators.verificationCode(emailAuth).valid}
            readOnly={currentState != 1}
            onChange={(e) => setEmailAuth(e.target.value.trim())}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={cancelHandler}>
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={updateHandler}>
          {currentState == 0 ? '註冊' : '確定'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

RegisterDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}

export default RegisterDialog
