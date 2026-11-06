/**
 * This component is a dialog for showing and modifying file details
 */
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Button,
  Typography,
  Textarea,
  Select,
  Option,
  Input
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useContext, useState, useEffect } from 'react'
import { PageContext, ProfileContext } from './Contexts'
import { PageType, PermissionType, bytesToSize } from './Types'
import ComboBox from './ComboBox'
import { Validators } from './Validator'
import toast from 'react-hot-toast'

function FileDetailDialog({ open, setOpen, fileData }) {
  const [desc, setDesc] = useState(fileData.desc)
  const [pageType] = useContext(PageContext)
  const [permission, setPermission] = useState(fileData.perm)
  const [selectedAttrs, setSelectedAttrs] = useState(fileData.attrs || [])
  const [tags, setTags] = useState(fileData.tags ? fileData.tags.join(' ') : '')

  // Sync state from fileData every time the dialog opens,
  // so changes made after initial mount (e.g. post-upload batch update) are reflected.
  useEffect(() => {
    if (open) {
      setDesc(fileData.desc ?? '')
      setPermission(fileData.perm)
      setSelectedAttrs(fileData.attrs || [])
      setTags(fileData.tags ? fileData.tags.join(' ') : '')
    }
  }, [open])
  const {
    userIdC: [userId, setUserId]
  } = useContext(ProfileContext)

  function dialogHandler(update = false) {
    if (update) {
      const tagsResult = Validators.tags(tags)
      if (!tagsResult.valid) {
        toast.error(tagsResult.message)
        return
      }
      const descResult = Validators.fileDescription(desc)
      if (!descResult.valid) {
        toast.error(descResult.message)
        return
      }
      window.electronAPI.updateFileDescPerm({
        fileId: fileData.fileId,
        desc,
        perm: Number.parseInt(permission),
        selectedAttrs,
        tags: tags.split(' ').slice(0, 5)
      })
    } else {
      setDesc(fileData.desc)
      setPermission(fileData.perm)
      setSelectedAttrs(fileData.attrs || [])
      setTags(fileData.tags ? fileData.tags.join(' ') : '')
    }
    setOpen(!open)
  }

  function parseOriginalOwner(originOwner) {
    if (!originOwner) return '用戶不存在'
    if (userId === originOwner) return '您'
    return originOwner
  }

  return (
    <Dialog
      open={open}
      handler={() => dialogHandler(false)}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>檔案詳情</DialogHeader>
      <DialogBody>
        <Typography variant="h5">名稱</Typography>
        <Typography variant="small">{fileData.name}</Typography>

        <Typography variant="h5" className="pt-4">
          檔案Id
        </Typography>
        <Typography variant="small">{fileData.fileId}</Typography>

        <Typography variant="h5" className="pt-4">
          擁有者
        </Typography>
        <Typography variant="small">{userId === fileData.owner ? '您' : fileData.owner}</Typography>

        <Typography variant="h5" className="pt-4">
          大小
        </Typography>
        <Typography variant="small">{bytesToSize(fileData.size)}</Typography>

        <Typography variant="h5" className="pt-4">
          上傳日期
        </Typography>
        <Typography variant="small">{fileData.date}</Typography>

        <Typography variant="h5" className="pt-4">
          原始擁有者
        </Typography>
        <Typography variant="small">{parseOriginalOwner(fileData.originOwner)}</Typography>

        <Typography variant="h5" className="pt-4">
          權限
        </Typography>
        {pageType === PageType.file && fileData.originOwner === fileData.owner ? (
          <Select
            value={String(fileData.perm)}
            onChange={(value) => {
              console.log(value)
              setPermission(value)
            }}
            labelProps={{ className: 'peer-focus:hidden' }}
            className="focus:!border-t-gray-900"
          >
            {Object.keys(PermissionType).map((key) => (
              <Option key={key} value={String(key)}>
                {PermissionType[key]}
              </Option>
            ))}
          </Select>
        ) : (
          <Typography variant="small">{PermissionType[fileData.perm]}</Typography>
        )}

        {pageType == PageType.file && (
          <div>
            <Typography variant="h5" className="pt-4">
              屬性
            </Typography>
            <ComboBox selectedAttrs={selectedAttrs} setSelectedAttrs={setSelectedAttrs}></ComboBox>
          </div>
        )}

        {pageType == PageType.file && (
          <div>
            <Typography variant="h5" className="pt-4">
              標籤
            </Typography>
            <Input
              label="最多五個，以空格隔開"
              labelProps={{ className: 'font-sans peer-focus:hidden' }}
              value={tags}
              onChange={(e) => {
                if ((e.target.value.match(/ /g) || []).length < 5)
                  setTags(e.target.value.replaceAll(/\s+/g, ' '))
              }}
              error={!Validators.tags(tags).valid}
              size="lg"
              className="grow rounded-none focus:!border-t-gray-900"
            ></Input>
          </div>
        )}

        <Typography variant="h5" className="pt-4">
          檔案說明
        </Typography>
        {pageType === PageType.file ? (
          <Textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            labelProps={{ className: 'peer-focus:hidden' }}
            error={!Validators.fileDescription(desc).valid}
            className="focus:!border-t-gray-900"
          ></Textarea>
        ) : (
          <Typography variant="paragraph" className="text-wrap break-all">
            {fileData.desc || '無'}
          </Typography>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={() => dialogHandler(false)}>
          取消
        </Button>
        <Button
          variant="gradient"
          color="black"
          onClick={() => dialogHandler(pageType === PageType.file)}
        >
          {pageType === PageType.file ? '更新' : '確定'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

FileDetailDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired,
  fileData: PropTypes.shape({
    fileId: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    owner: PropTypes.string.isRequired,
    size: PropTypes.number.isRequired,
    date: PropTypes.string.isRequired,
    originOwner: PropTypes.string.isRequired,
    perm: PropTypes.number.isRequired,
    desc: PropTypes.string.isRequired,
    attrs: PropTypes.array,
    tags: PropTypes.array
  })
}

export default FileDetailDialog
