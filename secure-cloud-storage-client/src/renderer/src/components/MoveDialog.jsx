/**
 * This component is a dialog for moving file to different folders
 */
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Button,
  List,
  ListItem,
  Typography,
  ListItemPrefix
} from '@material-tailwind/react'
import { FolderIcon } from '@heroicons/react/24/outline'
import PropTypes from 'prop-types'
import { useState, useEffect } from 'react'

const homeFolder = { name: 'home', id: null }

function MoveDialog({ open, setOpen, fileData }) {
  //? It's possible to make a file view in this dialog
  const [paths, setPaths] = useState([])
  const [selectedPath, setSelectedPath] = useState([homeFolder])
  function moveHandler() {
    window.electronAPI.askMoveFile(fileData.fileId, selectedPath.id)
    setOpen(!open)
  }

  useEffect(() => {
    async function getAllFolders() {
      const allFolders = await window.electronAPI.askAllFolder()
      setPaths([homeFolder, ...JSON.parse(allFolders)])
    }
    if (open) getAllFolders()
  }, [open])

  return (
    <Dialog
      open={open}
      handler={() => setOpen(!open)}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>{`移動「${fileData.name}」至`}</DialogHeader>
      {/* <CurPathBreadcrumbs /> */}
      <DialogBody className="flex w-full grow overflow-auto">
        {/**Search box // TODO also set path in input box when selected*/}
        <List className="overflow-auto w-full">
          {paths.map((item) => {
            return (
              <ListItem
                key={item.id}
                ripple={false}
                selected={selectedPath.id === item.id}
                onClick={() => setSelectedPath(item)}
                className="flex flex-row w-full"
              >
                <ListItemPrefix>
                  <FolderIcon className="size-4" />
                </ListItemPrefix>
                {/* <div className="overflow-x-auto"> */}
                <Typography className="text-wrap break-all">{item.name}</Typography>
                {/* </div> */}
              </ListItem>
            )
          })}
        </List>
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={() => setOpen(!open)}>
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={() => moveHandler()}>
          移動
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
MoveDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired,
  fileData: PropTypes.object.isRequired
}

export default MoveDialog
