/**
 * This component is a dialog to delete file or folder
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

function DeleteDialog({ open, setOpen, fileData, isFolder = false }) {
  function deleteHandler(isFolder) {
    if (isFolder) {
      window.electronAPI.askDeleteFolder(fileData.folderId)
    } else {
      window.electronAPI.askDeleteFile(fileData.fileId)
    }

    setOpen(!open)
  }

  return (
    <Dialog open={open} handler={() => setOpen(!open)}>
      <DialogHeader>
        <Typography variant="h4" color="red">
          刪除{isFolder ? '資料夾' : '檔案'}
        </Typography>
      </DialogHeader>
      <DialogBody>
        <Typography className="font-bold overflow-wrap">{`是否確認要刪除「${fileData.name}」?`}</Typography>
        <Typography className="font-bold">此行動無法被還原！</Typography>
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="black" onClick={() => setOpen(!open)}>
          取消
        </Button>
        <Button variant="gradient" color="red" onClick={() => deleteHandler(isFolder)}>
          確定
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

DeleteDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired,
  fileData: PropTypes.object.isRequired,
  isFolder: PropTypes.bool
}

export default DeleteDialog
