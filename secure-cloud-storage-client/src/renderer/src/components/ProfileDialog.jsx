/**
 * This component is for showing user profile
 */
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Input,
  Button
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useState, useContext, useEffect } from 'react'
import { ProfileContext } from './Contexts'
import { checkIsLoggedIn } from './Utils'
import toast from 'react-hot-toast'
import { Validators } from './Validator'

function ProfileDialog({ open, setOpen }) {
  const {
    storedNameC: [storedName, setStoredName],
    storedEmailC: [storedEmail, setStoredEmail],
    userIdC: [userId, setUserId]
  } = useContext(ProfileContext)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => {
    setName(storedName)
    setEmail(storedEmail)
  }, [storedName, storedEmail])

  function dialogHandler() {
    setOpen(!open)
  }

  function updateHandler() {
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

    setStoredName(name)
    setStoredEmail(email)
    if (!checkIsLoggedIn(userId)) {
      window.electronAPI.askRegister({ name, email })
    }
    setOpen(!open)
  }
  return (
    <Dialog open={open} handler={dialogHandler}>
      <DialogHeader>使用者資料</DialogHeader>
      <DialogBody className="space-y-2">
        {checkIsLoggedIn(userId) && (
          <Input label="使用者ID" size="lg" readOnly value={userId} tabIndex={-1} />
        )}
        <Input
          label="名字"
          size="lg"
          value={name}
          error={!Validators.name(name).valid}
          readOnly={checkIsLoggedIn(userId)}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="電子信箱"
          size="lg"
          value={email}
          error={!Validators.email(email).valid}
          readOnly={checkIsLoggedIn(userId)}
          onChange={(e) => setEmail(e.target.value)}
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={dialogHandler}>
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={updateHandler}>
          {checkIsLoggedIn(userId) ? '確定' : '註冊'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

ProfileDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}

export default ProfileDialog
