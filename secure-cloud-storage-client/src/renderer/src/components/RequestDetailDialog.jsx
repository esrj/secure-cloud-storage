/**
 * This component is a dialog for showing request details
 */
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Button,
  Typography,
  Textarea
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useContext, useState } from 'react'
import { PageContext, UserListContext } from './Contexts'
import { PageType, ResponseType } from './Types'
import toast from 'react-hot-toast'
import {
  BookmarkSquareIcon,
  InformationCircleIcon,
  NoSymbolIcon
} from '@heroicons/react/24/outline'
import FileDetailDialog from './FileDetailDialog'

function RequestDetailDialog({ open, setOpen, requestData }) {
  const [desc, setDesc] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)

  const [pageType] = useContext(PageContext)
  const {
    blackListC: [blackList, setBlackList],
    whiteListC: [whiteList, setWhiteList]
  } = useContext(UserListContext)
  const isRequest = pageType === PageType.request
  const canRespond = isRequest && requestData.status === ResponseType.N

  function responseHandler(agreed) {
    window.electronAPI.askRespondRequest({
      requestId: requestData.requestId,
      agreed,
      description: desc,
      pk: requestData.pk,
      spk: requestData.spk
    })
    setOpen(!open)
  }
  function whiteListHandler(userId) {
    if (whiteList.includes(userId)) {
      toast('該使用者已存在')
      return
    }
    setWhiteList([...whiteList, userId])
    toast.success('成功新增白名單')
  }
  function blackListHandler(userId) {
    if (blackList.includes(userId)) {
      toast('該使用者已存在')
      return
    }
    setBlackList([...blackList, userId])
    toast.success('成功新增黑名單')
  }
  function fileDialogHandler() {
    setDetailOpen(!detailOpen)
  }

  function renderData(header, data, dataColor = 'blue-gray') {
    return (
      <>
        <Typography variant="h5" className="pt-4">
          {header}
        </Typography>
        <Typography variant="small" color={dataColor}>
          {data || '無'}
        </Typography>
      </>
    )
  }

  return (
    <Dialog open={open} handler={() => setOpen(!open)}>
      <DialogHeader>請求詳情</DialogHeader>
      <DialogBody className="flex flex-row">
        <div className="flex flex-col w-1/2 pl-4">
          {isRequest ? (
            <>
              <div className="flex flex-row gap-2 items-end">
                <Typography variant="h5" className="pt-4">
                  使用者ID
                </Typography>
                <BookmarkSquareIcon
                  className="size-6 mb-0.5 rounded-md hover:bg-gray-300"
                  onClick={() => whiteListHandler(requestData.userId)}
                />
                <NoSymbolIcon
                  className="size-6 mb-0.5 rounded-md hover:bg-gray-300"
                  onClick={() => blackListHandler(requestData.userId)}
                />
              </div>
              <Typography variant="small">{requestData.userId || '無'}</Typography>
            </>
          ) : (
            renderData('使用者ID', requestData.userId)
          )}
          {renderData('名字', requestData.userName)}
          {renderData('電子信箱', requestData.userEmail)}
          {renderData('請求日期', requestData.reqDate)}
          <Typography variant="h5" className="pt-4">
            備註
          </Typography>
          <Typography variant="paragraph" className="text-wrap break-all">
            {requestData.reqDesc || '無'}
          </Typography>
        </div>
        <div className="flex flex-col w-1/2">
          {isRequest ? (
            <>
              <div className="flex flex-row gap-2 items-end">
                <Typography variant="h5" className="pt-4">
                  檔案ID
                </Typography>
                <InformationCircleIcon
                  className="size-6 mb-0.5 rounded-md hover:bg-gray-300"
                  onClick={() => fileDialogHandler()}
                />
              </div>
              <Typography variant="small">{requestData.fileId || '無'}</Typography>
            </>
          ) : (
            renderData('檔案ID', requestData.fileId)
          )}
          {renderData('請求ID', requestData.requestId)}
          {renderData('狀態', requestData.status)}
          {renderData('回覆日期', requestData.resDate)}
          <Typography variant="h5" className="pt-4">
            回覆留言
          </Typography>
          {canRespond ? (
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              labelProps={{ className: 'peer-focus:hidden' }}
              className="focus:!border-t-gray-900"
            ></Textarea>
          ) : (
            <Typography variant="paragraph" className="text-wrap break-all">
              {requestData.resDesc || '無'}
            </Typography>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        {canRespond ? (
          <>
            <Button variant="text" color="red" onClick={() => setOpen(!open)}>
              取消
            </Button>
            <Button variant="gradient" color="red" onClick={() => responseHandler(false)}>
              拒絕
            </Button>
            <Button variant="gradient" color="green" onClick={() => responseHandler(true)}>
              同意
            </Button>
          </>
        ) : (
          <Button variant="gradient" color="black" onClick={() => setOpen(!open)}>
            確定
          </Button>
        )}
      </DialogFooter>
      <FileDetailDialog open={detailOpen} setOpen={setDetailOpen} fileData={requestData} />
    </Dialog>
  )
}

RequestDetailDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired,
  requestData: PropTypes.object.isRequired
}

export default RequestDetailDialog
