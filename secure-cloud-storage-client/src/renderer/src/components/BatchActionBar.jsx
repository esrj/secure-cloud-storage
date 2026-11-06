/**
 * Sticky bar that appears above the FileTable whenever at least one row is
 * selected. Lives independently from FileViewButtonGroup (per design decision)
 * so its presence/absence doesn't shuffle the existing toolbar layout.
 */
import { useContext, useState } from 'react'
import { Button, Typography } from '@material-tailwind/react'
import {
  ArrowDownTrayIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { SelectionContext } from './SelectionContext'
import { bytesToSize } from './Types'
import BatchDownloadDialog from './BatchDownloadDialog'

function BatchActionBar() {
  const { selectedItems, selectedSize, clear } = useContext(SelectionContext)
  const [dlgOpen, setDlgOpen] = useState(false)

  if (selectedItems.length === 0) return null

  return (
    <>
      <div
        className="sticky top-0 z-20 flex flex-row items-center gap-3 w-full px-3 py-2
                   bg-blue-gray-50/95 backdrop-blur border border-blue-gray-100
                   rounded-md shadow-sm"
      >
        <Typography variant="small" className="font-bold text-blue-gray-800">
          已選 {selectedItems.length} 個檔案
        </Typography>
        <Typography variant="small" color="gray">
          合計 {bytesToSize(selectedSize)}
        </Typography>
        <div className="grow" />
        <Button
          size="sm"
          variant="gradient"
          color="black"
          className="flex flex-row items-center gap-1.5"
          onClick={() => setDlgOpen(true)}
        >
          <ArrowDownTrayIcon className="size-4" />
          批次下載
        </Button>
        <Button
          size="sm"
          variant="text"
          color="blue-gray"
          className="flex flex-row items-center gap-1"
          onClick={clear}
        >
          <XMarkIcon className="size-4" />
          取消選取
        </Button>
      </div>
      <BatchDownloadDialog
        open={dlgOpen}
        onClose={() => setDlgOpen(false)}
        items={selectedItems}
      />
    </>
  )
}

export default BatchActionBar
