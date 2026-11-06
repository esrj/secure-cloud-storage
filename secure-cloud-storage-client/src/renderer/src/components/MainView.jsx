/**
 * This component is a wrapper to render the main view
 */
import { useContext, useState, useEffect, useMemo } from 'react'
import PropTypes from 'prop-types'
import { PageType, parseFileList, parseRequestList } from './Types'
import PublicTable from './PublicTable'
import FileTable from './FileTable'
import ReplyTable from './ReplyTable'
import WatermarkDetectPage from './WatermarkDetectPage'
import AgentPage from './AgentPage'
import AdminUsersPage from './AdminUsersPage'
import { Card } from '@material-tailwind/react'
import SearchBar from './SearchBar'
import FileViewButtonGroup from './FileViewButtonGroup'
import RequestViewButtonGroup from './RequestViewButtonGroup'
import CurPathBreadcrumbs from './CurPathBreadcrumbs'
import RequestTable from './RequestTable'
import {
  CurPathContext,
  RequestContext,
  UserListContext,
  PageContext,
  SearchContext
} from './Contexts'
import { SelectionContext, SelectionProvider } from './SelectionContext'
import BatchActionBar from './BatchActionBar'
import BatchDownloadProgress from './BatchDownloadProgress'
import toast from 'react-hot-toast'
import { Validators } from './Validator'
import PostUploadDialog from './PostUploadDialog'

function MainView() {
  const [curPath, setCurPath] = useState([{ name: '', folderId: null }])
  const [fileList, setFileList] = useState([])
  const [folderList, setFolderList] = useState([])
  const [whiteList, setWhiteList] = useState([])
  const [blackList, setBlackList] = useState([])
  const [publicFileList, setPublicFileList] = useState([])
  const [uploadBatch, setUploadBatch] = useState(null)
  const {
    publicSearchTermC: [publicSearchTerm, setPublicSearchTerm],
    searchTimesC: [searchTimes]
  } = useContext(SearchContext)

  const {
    requestListC: [requestList, setRequestList],
    requestedListC: [requestedList, setRequestedList]
  } = useContext(RequestContext)
  const [pageType] = useContext(PageContext)

  const userListContextValue = useMemo(
    () => ({
      whiteListC: [whiteList, setWhiteListHandler],
      blackListC: [blackList, setBlackListHandler]
    }),
    [whiteList, blackList]
  )
  const curPathContextValue = useMemo(() => ({ curPath, setCurPath: setPathHandler }), [curPath])

  useEffect(() => {
    window.electronAPI.onFileListRes((result) => {
      const { files, folders } = result
      const fileList = parseFileList(files, false)
      const folderList = JSON.parse(folders)
      folderList.forEach((element) => {
        element.folderId = element.id
        delete element.id
      })
      setFileList(fileList)
      setFolderList(folderList)
    })
    window.electronAPI.onRequestListRes((result) => {
      const requestList = parseRequestList(result)
      setRequestList(requestList)
    })
    window.electronAPI.onRequestedListRes((result) => {
      const requestedList = parseFileList(parseRequestList(result), false)
      setRequestedList(requestedList)
    })
    window.electronAPI.onUserList(({ whiteList, blackList }) => {
      setWhiteList(whiteList)
      setBlackList(blackList)
    })
    window.electronAPI.onSearchFiles((result) => {
      const searchedFileList = parseFileList(result, false)
      setPublicFileList((prevList) => [...prevList, ...searchedFileList])
    })
    window.electronAPI.onUploadBatchDone((result) => {
      // result now includes: fileIds, sourcePaths, classificationPreview, classifyBatchKey
      setUploadBatch(result)
    })
  }, [])

  useEffect(() => {
    if (pageType === PageType.file) {
      window.electronAPI.changeCurFolder(curPath.at(-1).folderId)
    }
  }, [pageType])

  useEffect(() => {
    async function searchFiles() {
      const result = Validators.tags(publicSearchTerm)
      if (!result.valid) {
        toast.error(result.message)
        return
      }
      setPublicFileList([])
      const searchTerm = publicSearchTerm.replaceAll(/\s+/g, ' ')
      setPublicSearchTerm(searchTerm)
      const searchedFilesPromise = window.electronAPI.askSearchFiles({
        tags: searchTerm.split(' ').slice(0, 5)
      })
      toast.promise(searchedFilesPromise, {
        loading: '搜尋中',
        success: '搜尋成功',
        error: '搜尋失敗'
      })
      try {
        await searchedFilesPromise
      } catch (error) {}
    }
    if (pageType === PageType.public && publicSearchTerm !== '') {
      searchFiles()
    }
  }, [searchTimes])

  function setPathHandler(curPath) {
    setCurPath(curPath)
    window.electronAPI.changeCurFolder(curPath.at(-1).folderId)
  }
  function setWhiteListHandler(whiteList) {
    setWhiteList(whiteList)
    window.electronAPI.updateUserList({ whiteList, blackList })
  }
  function setBlackListHandler(blackList) {
    setBlackList(blackList)
    window.electronAPI.updateUserList({ whiteList, blackList })
  }

  function renderTableView(pageType) {
    switch (pageType) {
      case PageType.public:
        return <PublicTable publicFileList={publicFileList} setPublicFileList={setPublicFileList} />
      case PageType.file:
        return <FileTable fileList={fileList} folderList={folderList} />
      case PageType.reply:
        return <ReplyTable replyList={requestList} />
      case PageType.request:
        return <RequestTable requestedList={requestedList} />
      case PageType.watermarkDetect:
        return <WatermarkDetectPage />
      case PageType.agentSearch:
        return <AgentPage />
      case PageType.adminUsers:
        return <AdminUsersPage />
      default:
        return null
    }
  }

  return (
    <CurPathContext.Provider value={curPathContextValue}>
      <UserListContext.Provider value={userListContextValue}>
        <SelectionProvider>
          <Card className="flex grow gap-2 pt-2 items-start overflow-auto">
            {pageType !== PageType.watermarkDetect &&
              pageType !== PageType.agentSearch &&
              pageType !== PageType.adminUsers && (
              <div className="flex flex-row w-full gap-4 px-2 items-center">
                <SearchBar />
                {pageType === PageType.file && <FileViewButtonGroup curPath={curPath} />}
                {pageType === PageType.request && <RequestViewButtonGroup />}
              </div>
            )}

            {pageType === PageType.file && (
              <div className="px-2">
                <CurPathBreadcrumbs />
              </div>
            )}

            {/* Batch action bar — only meaningful on the user's own files page,
                where individual rows have a checkbox bound to SelectionContext. */}
            {pageType === PageType.file && (
              <div className="w-full px-2">
                <BatchActionBar />
              </div>
            )}

            <SelectionResetOnPageOrPathChange pageType={pageType} curPath={curPath} />

            {renderTableView(pageType)}
          </Card>
        </SelectionProvider>
      </UserListContext.Provider>
      {/* Floating batch-download progress (lives outside the card so it can
          overlay the entire window). Mounting at the top-level means progress
          stays visible even if the user navigates between pages. */}
      <BatchDownloadProgress />
      {uploadBatch && uploadBatch.fileIds && uploadBatch.fileIds.length > 0 && (
        <PostUploadDialog
          key={uploadBatch.fileIds.join('\0')}
          fileIds={uploadBatch.fileIds}
          sourcePaths={uploadBatch.sourcePaths ?? []}
          classificationPreview={uploadBatch.classificationPreview ?? null}
          classifyBatchKey={uploadBatch.classifyBatchKey ?? null}
          onClose={() => setUploadBatch(null)}
        />
      )}
    </CurPathContext.Provider>
  )
}

/**
 * Sibling helper that subscribes to SelectionContext and clears the selection
 * whenever the user changes page or navigates into a different folder.
 * Kept separate so MainView itself doesn't need to consume SelectionContext.
 */
function SelectionResetOnPageOrPathChange({ pageType, curPath }) {
  const { clear } = useContext(SelectionContext)
  const folderId = curPath?.at(-1)?.folderId ?? null
  useEffect(() => {
    clear()
  }, [pageType, folderId, clear])
  return null
}

SelectionResetOnPageOrPathChange.propTypes = {
  pageType: PropTypes.string,
  curPath: PropTypes.array
}

export default MainView
