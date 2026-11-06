/**
 * This component is a menu for selecting different request options (delete, detail)
 */
import { Menu, MenuHandler, Button, MenuList, MenuItem, Typography } from '@material-tailwind/react'
import { InformationCircleIcon, TrashIcon, EllipsisVerticalIcon } from '@heroicons/react/24/outline'
import { useContext, useState } from 'react'
import PropTypes from 'prop-types'
import RequestDeleteDialog from './RequestDeleteDialog'
import RequestDetailDialog from './RequestDetailDialog'
import { PageType, ResponseType } from './Types'
import { PageContext } from './Contexts'

function RequestOptionMenu({ requestData }) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [pageType] = useContext(PageContext)
  const isReply = pageType == PageType.reply

  return (
    <Menu placement="left">
      <MenuHandler>
        <Button variant="text">
          <EllipsisVerticalIcon className="size-5" />
        </Button>
      </MenuHandler>
      <MenuList className="min-w-0">
        {isReply && (
          <MenuItem
            disabled={requestData.status !== ResponseType.N}
            onClick={() => setDeleteOpen(true)}
            className="flex flex-row items-center"
          >
            <TrashIcon className="size-5" />
            <Typography className="ml-2 font-bold">刪除</Typography>
          </MenuItem>
        )}
        <MenuItem onClick={() => setDetailOpen(true)} className="flex flex-row items-center">
          <InformationCircleIcon className="size-5" />
          <Typography className="ml-2 font-bold">詳細</Typography>
        </MenuItem>
      </MenuList>

      <RequestDetailDialog open={detailOpen} setOpen={setDetailOpen} requestData={requestData} />

      {isReply && (
        <RequestDeleteDialog
          open={deleteOpen}
          setOpen={setDeleteOpen}
          requestId={requestData.requestId}
          fileId={requestData.fileId}
        />
      )}
    </Menu>
  )
}

RequestOptionMenu.propTypes = {
  requestData: PropTypes.object.isRequired
}

export default RequestOptionMenu
