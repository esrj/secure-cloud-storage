/**
 * This component is a dialog for adding request black list
 */
import { MinusIcon, NoSymbolIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Button,
  Input,
  List,
  ListItem,
  Typography,
  ListItemSuffix
} from '@material-tailwind/react'

import PropTypes from 'prop-types'
import { useState, useContext } from 'react'
import toast from 'react-hot-toast'
import { UserListContext } from './Contexts'
import { Validators } from './Validator'

function BlackListDialog({ open, setOpen }) {
  const [text, setText] = useState('')
  const {
    blackListC: [blackList, setBlackList]
  } = useContext(UserListContext)

  function dialogHandler() {
    setText('')
    setOpen(!open)
  }
  function addBlackListHandler() {
    const result = Validators.uuidv4(text)
    if (!result.valid) {
      toast.error(result.message)
      return
    }

    if (blackList.includes(text)) {
      toast.error('該使用者已存在')
    } else {
      setBlackList([...blackList, text])
      toast.success('成功新增黑名單')
    }
    setText('')
  }
  function removeBlackListHandler(index) {
    setBlackList(blackList.slice(0, index).concat(blackList.slice(index + 1)))
    toast.success('成功移除黑名單')
  }

  return (
    <Dialog
      open={open}
      handler={dialogHandler}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>
        <NoSymbolIcon className="size-6" />
        黑名單
      </DialogHeader>
      <DialogBody className="flex flex-col w-full gap-2 grow overflow-auto">
        <div className="flex flex-row w-full h-fit px-4 justify-center items-center">
          <Input
            label="使用者ID"
            labelProps={{ className: 'peer-focus:hidden' }}
            size="lg"
            value={text}
            error={!Validators.uuidv4(text).valid}
            onChange={(e) => {
              setText(e.target.value)
            }}
            className="rounded-r-none focus:!border-t-gray-900"
          />
          <Button
            onClick={() => addBlackListHandler()}
            className="min-w-12 rounded-l-none justify-center"
            size="md"
            variant="gradient"
          >
            <PlusIcon className="size-5" />
          </Button>
        </div>
        <List className="flex flex-col grow overflow-auto">
          {blackList.map((item, index) => (
            <ListItem key={item} ripple={false}>
              <Typography>{item}</Typography>
              <ListItemSuffix>
                <Button
                  onClick={() => removeBlackListHandler(index)}
                  className="justify-center"
                  size="sm"
                  variant="gradient"
                >
                  <MinusIcon className="size-5" />
                </Button>
              </ListItemSuffix>
            </ListItem>
          ))}
        </List>
      </DialogBody>
      <DialogFooter>
        <Button variant="gradient" color="black" onClick={() => dialogHandler()}>
          確定
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
BlackListDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}

export default BlackListDialog
