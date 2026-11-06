/**
 * This component is a wrapper to render different table views (public, file, reply, request)
 */
import { Card } from '@material-tailwind/react'
// import { TableHeadContent } from "./Settings";
import PropTypes from 'prop-types'

export const TableHeadContent = Object.freeze({
  name: { text: '名稱', className: '' },
  size: { text: '大小', className: 'w-20' },
  date: { text: '上傳日期', className: 'w-24' },
  owner: { text: '擁有者', className: 'w-24' },
  perm: { text: '權限', className: 'w-20' },
  end: { text: '', className: 'w-12' },
  icon: { text: '', className: 'w-10' },
  // 'select' is a custom column; the column header content is rendered by the
  // table's `headCell` slot so it can host a controlled checkbox bound to the
  // SelectionContext. Width is fixed and intentionally narrow.
  select: { text: '', className: 'w-10' },
  fileId: { text: '檔案ID', className: '' },
  reqDate: { text: '請求日期', className: 'w-24' },
  resDate: { text: '回覆日期', className: 'w-24' },
  status: { text: '狀態', className: 'w-24' },
  userName: { text: '姓名', className: 'w-24' }
})

function TableView({ tableHead, children, headCell }) {
  return (
    <Card className="flex w-full grow px-8 py-4 overflow-auto border-2 rounded-t-none">
      <table className="w-full text-left table-fixed overflow-auto">
        <thead>
          <tr>
            {tableHead.map((head) => {
              const custom = headCell ? headCell(head) : undefined
              return (
                <th
                  key={head}
                  className={TableHeadContent[head]['className'] + ' font-sans font-bold'}
                >
                  {custom !== undefined ? custom : TableHeadContent[head].text}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="overflow-auto">{children}</tbody>
      </table>
    </Card>
  )
}

TableView.propTypes = {
  tableHead: PropTypes.array.isRequired,
  children: PropTypes.array.isRequired,
  headCell: PropTypes.func
}

export default TableView
