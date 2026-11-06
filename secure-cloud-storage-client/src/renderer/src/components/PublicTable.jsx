/**
 * This component is a table for showing public searched files
 */
import { Typography } from '@material-tailwind/react'
import { useEffect, useState } from 'react'
import FileOptionMenu from './FileOptionMenu'
import TableView from './TableView'
import { bytesToSize } from './Types'
import PropTypes from 'prop-types'
const TABLE_HEAD = ['name', 'size', 'date', 'owner', 'end']

function PublicTable({ publicFileList }) {
  const [tableContent, setTableContent] = useState([])

  useEffect(() => {
    setTableContent(publicFileList)
  }, [publicFileList])

  return (
    <TableView tableHead={TABLE_HEAD}>
      {tableContent.map((row) => (
        <tr key={row.fileId} className="border-t">
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
            <Typography className="truncate">{row.owner}</Typography>
          </td>
          <td>
            <FileOptionMenu fileData={row} haveRequest haveDetail />
          </td>
        </tr>
      ))}
    </TableView>
  )
}

PublicTable.propTypes = {
  publicFileList: PropTypes.array.isRequired
}

export default PublicTable
