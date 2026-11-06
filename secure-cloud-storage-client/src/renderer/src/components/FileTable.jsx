/**
 * This compoment is a table for showing user's files
 */
import { Typography } from '@material-tailwind/react'
import { FolderIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import FileOptionMenu from './FileOptionMenu'
import TableView from './TableView'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { PermissionType, bytesToSize, searchFilter } from './Types'
import { CurPathContext, SearchContext } from './Contexts'
import { SelectionContext } from './SelectionContext'

// 'select' column hosts the per-row checkbox. Folder rows render the column
// but disable the checkbox (folder batch-download is out of scope for v1).
const TABLE_HEAD = ['select', 'icon', 'name', 'size', 'date', 'perm', 'end']

function FileTable({ fileList, folderList }) {
  const { curPath, setCurPath } = useContext(CurPathContext)
  const [tableContent, setTableContent] = useState([])
  const [folderContent, setFolderContent] = useState([])
  const {
    searchTypeC: [searchType],
    searchTermC: [searchTerm]
  } = useContext(SearchContext)

  const {
    isSelected,
    toggle,
    selectAllVisible,
    selectedIds,
    registerItems
  } = useContext(SelectionContext)

  useEffect(() => {
    setTableContent(searchFilter(fileList, searchType, searchTerm))
    setFolderContent(searchFilter(folderList, searchType, searchTerm))
  }, [searchTerm, searchType, fileList, folderList])

  // Hand the currently visible file rows to SelectionContext so the action bar
  // and "select all visible" can find them. Folders are intentionally excluded.
  useEffect(() => {
    registerItems(tableContent)
  }, [tableContent, registerItems])

  // Header checkbox tri-state: off / indeterminate / on (relative to *visible* files only).
  const headerCheckRef = useRef(null)
  const { checked: headerChecked, indeterminate } = useMemo(() => {
    if (tableContent.length === 0) return { checked: false, indeterminate: false }
    const total = tableContent.length
    const sel = tableContent.reduce((acc, it) => acc + (selectedIds.has(it.fileId) ? 1 : 0), 0)
    if (sel === 0) return { checked: false, indeterminate: false }
    if (sel === total) return { checked: true, indeterminate: false }
    return { checked: false, indeterminate: true }
  }, [tableContent, selectedIds])

  useEffect(() => {
    if (headerCheckRef.current) {
      headerCheckRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  function renderHeadCell(head) {
    if (head !== 'select') return undefined
    return (
      <input
        ref={headerCheckRef}
        type="checkbox"
        aria-label="全選此頁可下載檔案"
        checked={headerChecked}
        onChange={selectAllVisible}
        disabled={tableContent.length === 0}
        className="cursor-pointer accent-blue-gray-900"
      />
    )
  }

  return (
    <TableView tableHead={TABLE_HEAD} headCell={renderHeadCell}>
      {folderContent.map((row) => (
        <tr
          key={row.folderId}
          onDoubleClick={() => setCurPath([...curPath, { name: row.name, folderId: row.folderId }])}
          className="border-t"
        >
          <td>
            {/* Folders aren't supported by batch download in v1. */}
            <input
              type="checkbox"
              disabled
              title="批次下載暫不支援資料夾"
              className="opacity-30 cursor-not-allowed"
            />
          </td>
          <td>
            <FolderIcon className="size-5" />
          </td>
          <td>
            <Typography className="truncate pr-4">{row.name}</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <FileOptionMenu fileData={row} haveDelete isFolder />
          </td>
        </tr>
      ))}
      {tableContent.map((row) => (
        <tr key={row.fileId} className="border-t">
          <td>
            <input
              type="checkbox"
              aria-label={`選取 ${row.name}`}
              checked={isSelected(row.fileId)}
              onChange={() => toggle(row.fileId)}
              onClick={(e) => e.stopPropagation()}
              className="cursor-pointer accent-blue-gray-900"
            />
          </td>
          <td>
            <DocumentTextIcon className="size-5" />
          </td>
          <td>
            <Typography className="truncate pr-4">{row.name}</Typography>
          </td>
          <td>
            <Typography>{bytesToSize(row.size)}</Typography>
          </td>
          <td>
            <Typography>{row.date}</Typography>
          </td>
          <td>
            <Typography>{PermissionType[row.perm]}</Typography>
          </td>
          <td>
            <FileOptionMenu fileData={row} haveDetail haveDelete haveDownload haveMove />
          </td>
        </tr>
      ))}
    </TableView>
  )
}

FileTable.propTypes = {
  fileList: PropTypes.array.isRequired,
  folderList: PropTypes.array.isRequired
}

export default FileTable
