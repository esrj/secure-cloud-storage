/**
 * This component is a dialog for deleteing requests
 */
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Button,
  Typography
} from '@material-tailwind/react'
import PropTypes from 'prop-types'

function RequestDeleteDialog({ open, setOpen, requestId, fileId }) {
  function deleteHandler() {
    window.electronAPI.askDeleteRequest(requestId)
    setOpen(!open)
  }

  return (
    <Dialog open={open} handler={() => setOpen(!open)}>
      <DialogHeader>
        <Typography variant="h4" color="red">
          刪除請求
        </Typography>
      </DialogHeader>
      <DialogBody>
        <Typography className="font-bold overflow-wrap">{`是否確認要刪除對檔案「${fileId}」的請求?`}</Typography>
        <Typography className="font-bold">此行動無法被還原！</Typography>
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="black" onClick={() => setOpen(!open)}>
          取消
        </Button>
        <Button variant="gradient" color="red" onClick={() => deleteHandler()}>
          確定
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

RequestDeleteDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired,
  requestId: PropTypes.string.isRequired,
  fileId: PropTypes.string.isRequired
}

export default RequestDeleteDialog
