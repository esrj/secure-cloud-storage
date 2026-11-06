/**
 * This component is a menu for file options
 */
import { Menu, MenuHandler, MenuList, MenuItem, Button, Typography } from '@material-tailwind/react'
import {
  EllipsisVerticalIcon,
  PaperAirplaneIcon,
  InformationCircleIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline'
import PropTypes from 'prop-types'
import { useState } from 'react'
import RequestDialog from './RequestDialog'
import FileDetailDialog from './FileDetailDialog'
import DeleteDialog from './DeleteDialog'
import MoveDialog from './MoveDialog'
import DownloadOptionsDialog from './DownloadOptionsDialog'

function FileOptionMenu({
  fileData,
  haveRequest = false,
  haveDetail = false,
  haveDownload = false,
  haveDelete = false,
  haveMove = false,
  isFolder = false
}) {
  const [requestOpen, setRequestOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [downloadOpen, setDownloadOpen] = useState(false)

  return (
    <Menu placement="left">
      <MenuHandler>
        <Button variant="text">
          <EllipsisVerticalIcon className="size-5" />
        </Button>
      </MenuHandler>
      <MenuList className="min-w-0">
        {haveRequest && (
          <MenuItem onClick={() => setRequestOpen(true)} className="flex flex-row items-center">
            <PaperAirplaneIcon className="size-5" />
            <Typography className="ml-2 font-bold">請求</Typography>
          </MenuItem>
        )}
        {haveDownload && (
          <MenuItem onClick={() => setDownloadOpen(true)} className="flex flex-row items-center">
            <ArrowDownTrayIcon className="size-5" />
            <Typography className="ml-2 font-bold">下載</Typography>
          </MenuItem>
        )}
        {haveDelete && (
          <MenuItem onClick={() => setDeleteOpen(true)} className="flex flex-row items-center">
            <TrashIcon className="size-5" />
            <Typography className="ml-2 font-bold">刪除</Typography>
          </MenuItem>
        )}
        {haveMove && (
          <MenuItem onClick={() => setMoveOpen(true)} className="flex flex-row items-center">
            <ArrowRightIcon className="size-5" />
            <Typography className="ml-2 font-bold">移動</Typography>
          </MenuItem>
        )}
        {haveDetail && (
          <MenuItem onClick={() => setDetailOpen(true)} className="flex flex-row items-center">
            <InformationCircleIcon className="size-5" />
            <Typography className="ml-2 font-bold">詳細</Typography>
          </MenuItem>
        )}
      </MenuList>

      {haveRequest && (
        <RequestDialog open={requestOpen} setOpen={setRequestOpen} defaultId={fileData.fileId} />
      )}
      {haveDetail && (
        <FileDetailDialog open={detailOpen} setOpen={setDetailOpen} fileData={fileData} />
      )}
      {haveDelete && (
        <DeleteDialog
          open={deleteOpen}
          setOpen={setDeleteOpen}
          fileData={fileData}
          isFolder={isFolder}
        />
      )}
      {haveMove && <MoveDialog open={moveOpen} setOpen={setMoveOpen} fileData={fileData} />}
      {haveDownload && (
        <DownloadOptionsDialog
          open={downloadOpen}
          onClose={() => setDownloadOpen(false)}
          fileData={fileData}
        />
      )}
    </Menu>
  )
}

FileOptionMenu.propTypes = {
  fileData: PropTypes.object,
  haveRequest: PropTypes.bool,
  haveDetail: PropTypes.bool,
  haveDownload: PropTypes.bool,
  haveDelete: PropTypes.bool,
  haveMove: PropTypes.bool,
  isFolder: PropTypes.bool
}

export default FileOptionMenu
