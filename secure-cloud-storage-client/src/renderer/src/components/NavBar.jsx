/**
 * This component is the navigation bar to navigate to different pages (public, file, reply, request)
 */
import {
  Card,
  Typography,
  List,
  ListItem,
  ListItemPrefix,
  ListItemSuffix,
  Chip
} from '@material-tailwind/react'
import {
  UserCircleIcon,
  RectangleStackIcon,
  DocumentTextIcon,
  ClipboardDocumentCheckIcon,
  ClipboardDocumentListIcon,
  PaperAirplaneIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  UsersIcon
} from '@heroicons/react/24/outline'
import PropTypes from 'prop-types'
import { useState, useContext } from 'react'
import RequestDialog from './RequestDialog'
import ProfileDialog from './ProfileDialog'
import { PageType, ResponseType } from './Types'
import { ProfileContext, RequestContext } from './Contexts'
import { checkIsLoggedIn } from './Utils'
import BackupDialog from './BackupDialog'
import RecoverDialog from './RecoverDialog'
import RegisterDialog from './RegisterDialog'

function NavBar({ pageType, setPageType, seenRequest, seenReply }) {
  const [profileOpen, setProfileOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [recoverOpen, setRecoverOpen] = useState(false)
  const [registerOpen, setRegisterOpen] = useState(false)
  const {
    requestListC: [requestList],
    requestedListC: [requestedList]
  } = useContext(RequestContext)
  const {
    userIdC: [userId],
    roleC: [role]
  } = useContext(ProfileContext)
  const isAdmin = role === 'admin'

  return (
    <>
      <Card className="h-full w-80 shrink-0 p-4 shadow-xl shadow-blue-gray-900/5">
        <div className="mb-2 p-4">
          <Typography variant="h5" color="blue-gray">
            機敏雲端
          </Typography>
        </div>
        <List>
          <ListItem
            selected={pageType === PageType.agentSearch}
            onClick={() => setPageType(PageType.agentSearch)}
            ripple={false}
            className="focus:bg-none"
          >
            <ListItemPrefix>
              <SparklesIcon className="h-5 w-5" />
            </ListItemPrefix>
            智慧搜尋
          </ListItem>
          <ListItem
            selected={pageType === PageType.public}
            onClick={() => setPageType(PageType.public)}
            ripple={false}
            className="focus:bg-none"
          >
            <ListItemPrefix>
              <RectangleStackIcon className="h-5 w-5" />
            </ListItemPrefix>
            公開列表
          </ListItem>
          <ListItem
            selected={pageType === PageType.file}
            onClick={() => setPageType(PageType.file)}
            ripple={false}
            className="focus:bg-none"
          >
            <ListItemPrefix>
              <DocumentTextIcon className="h-5 w-5" />
            </ListItemPrefix>
            檔案列表
          </ListItem>
          <ListItem
            selected={pageType === PageType.reply}
            onClick={() => setPageType(PageType.reply)}
            ripple={false}
            className="focus:bg-none"
          >
            <ListItemPrefix>
              <ClipboardDocumentCheckIcon className="h-5 w-5" />
            </ListItemPrefix>
            回覆列表
            <ListItemSuffix>
              <Chip
                value={Math.max(
                  requestList.filter((file) => file.status !== ResponseType.N).length - seenReply,
                  0
                )}
                size="sm"
                variant="ghost"
                color="blue-gray"
                className="rounded-full"
              />
            </ListItemSuffix>
          </ListItem>
          <ListItem
            selected={pageType === PageType.request}
            onClick={() => setPageType(PageType.request)}
            ripple={false}
            className="focus:bg-none"
          >
            <ListItemPrefix>
              <ClipboardDocumentListIcon className="h-5 w-5" />
            </ListItemPrefix>
            請求列表
            <ListItemSuffix>
              <Chip
                value={Math.max(requestedList.length - seenRequest, 0)}
                size="sm"
                variant="ghost"
                color="blue-gray"
                className="rounded-full"
              />
            </ListItemSuffix>
          </ListItem>
          <ListItem
            onClick={() => setRequestOpen(!requestOpen)}
            ripple={false}
            className="focus:bg-white"
          >
            <ListItemPrefix>
              <PaperAirplaneIcon className="h-5 w-5" />
            </ListItemPrefix>
            請求檔案
          </ListItem>
          {/* Admin-only pages. Hidden here for UX; the server enforces the role. */}
          {isAdmin && (
            <ListItem
              selected={pageType === PageType.watermarkDetect}
              onClick={() => setPageType(PageType.watermarkDetect)}
              ripple={false}
              className="focus:bg-none"
            >
              <ListItemPrefix>
                <MagnifyingGlassIcon className="h-5 w-5" />
              </ListItemPrefix>
              浮水印追蹤
            </ListItem>
          )}
          {isAdmin && (
            <ListItem
              selected={pageType === PageType.adminUsers}
              onClick={() => setPageType(PageType.adminUsers)}
              ripple={false}
              className="focus:bg-none"
            >
              <ListItemPrefix>
                <UsersIcon className="h-5 w-5" />
              </ListItemPrefix>
              使用者管理
            </ListItem>
          )}
          <ListItem
            onClick={() =>
              checkIsLoggedIn(userId)
                ? setProfileOpen(!profileOpen)
                : setRegisterOpen(!registerOpen)
            }
            ripple={false}
            className={checkIsLoggedIn(userId) ? 'focus:bg-white' : 'bg-red-100 focus:bg-red-100'}
          >
            <ListItemPrefix>
              <UserCircleIcon className="h-5 w-5" />
            </ListItemPrefix>
            {checkIsLoggedIn(userId) ? '使用者資料' : '註冊帳號'}
          </ListItem>
          <ListItem
            onClick={() => {
              checkIsLoggedIn(userId) ? setBackupOpen(!backupOpen) : setRecoverOpen(!recoverOpen)
            }}
            ripple={false}
            className={checkIsLoggedIn(userId) ? 'focus:bg-white' : 'bg-red-100 focus:bg-red-100'}
          >
            <ListItemPrefix>
              <DocumentDuplicateIcon className="h-5 w-5" />
            </ListItemPrefix>
            {checkIsLoggedIn(userId) ? '帳號備份' : '帳號復原'}
          </ListItem>
        </List>
      </Card>
      <RequestDialog open={requestOpen} setOpen={setRequestOpen} />
      <ProfileDialog open={profileOpen} setOpen={setProfileOpen} />
      <BackupDialog open={backupOpen} setOpen={setBackupOpen} />
      <RecoverDialog open={recoverOpen} setOpen={setRecoverOpen} />
      <RegisterDialog open={registerOpen} setOpen={setRegisterOpen} />
    </>
  )
}

NavBar.propTypes = {
  pageType: PropTypes.oneOf(Object.values(PageType)).isRequired,
  setPageType: PropTypes.func.isRequired,
  seenRequest: PropTypes.number.isRequired,
  seenReply: PropTypes.number.isRequired
}

export default NavBar
export { PageType }
