/**
 * This component is a table for showing request list
 */
import { Typography } from '@material-tailwind/react'
import TableView from './TableView'
import { searchFilter } from './Types'
import RequestOptionMenu from './RequestOptionMenu'
import { useContext, useEffect, useState } from 'react'
import { SearchContext } from './Contexts'
import propTypes from 'prop-types'
import { statusToColor } from './Utils'

const tableHead = ['fileId', 'reqDate', 'userName', 'status', 'end']

function RequestTable({ requestedList }) {
  const [tableContent, setTableContent] = useState([])
  const {
    searchTypeC: [searchType],
    searchTermC: [searchTerm]
  } = useContext(SearchContext)

  useEffect(() => {
    setTableContent(searchFilter(requestedList, searchType, searchTerm))
  }, [searchTerm, searchType, requestedList])
  return (
    <TableView tableHead={tableHead}>
      {tableContent.map((row) => (
        <tr key={row.requestId} className="border-t">
          <td>
            <Typography className="truncate pr-4">{row.fileId}</Typography>
          </td>
          <td>
            <Typography>{row.reqDate}</Typography>
          </td>
          <td>
            <Typography className="truncate">{row.userName}</Typography>
          </td>
          <td>
            <Typography color={statusToColor(row.status)} className="font-bold">
              {row.status}
            </Typography>
          </td>
          <td>
            <RequestOptionMenu requestData={row} />
          </td>
        </tr>
      ))}
    </TableView>
  )
}

RequestTable.propTypes = {
  requestedList: propTypes.array.isRequired
}

export default RequestTable
