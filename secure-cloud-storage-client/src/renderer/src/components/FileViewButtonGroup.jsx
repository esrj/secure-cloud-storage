/**
 * Action bar for the file-list page: folder creation, file upload,
 * and the smart-classify on/off switch (all visible before selecting files).
 *
 * 2026-10: the former fast / thinking (4B / 9B) dropdown is gone. The switch
 * maps to mode 'fast' (on) or 'off'; main keeps the same IPC contract.
 */
import { ButtonGroup, Button, Typography, Switch } from '@material-tailwind/react'
import AddFolderDialog from './AddFolderDialog'
import { ArrowUpTrayIcon, FolderPlusIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import AnalysisSpinner from './AnalysisSpinner'
import { readSmartClassifyMode, writeSmartClassifyMode } from '../lib/smartClassifyPrefs'

function FileViewButtonGroup({ curPath }) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [mode, setMode] = useState(() => readSmartClassifyMode())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const enabled = mode !== 'off'

  useEffect(() => {
    const v = readSmartClassifyMode()
    setMode(v)
    void window.electronAPI?.setUploadBatchSmartClassify?.(v)

    const sync = () => {
      const updated = readSmartClassifyMode()
      setMode(updated)
    }
    window.addEventListener('scs-smart-classify-prefs-changed', sync)
    return () => window.removeEventListener('scs-smart-classify-prefs-changed', sync)
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI?.onPreuploadClassifyStatus?.((p) => {
      if (p?.phase === 'running') {
        setBusy(true)
        if (typeof p.progress?.done === 'number' && typeof p.progress?.total === 'number') {
          setProgress(p.progress)
        }
      }
      if (p?.phase === 'finished') {
        setBusy(false)
        setProgress(null)
      }
    })
    return () => unsub?.()
  }, [])

  function handleToggle(e) {
    const next = e.target.checked ? 'fast' : 'off'
    setMode(next)
    writeSmartClassifyMode(next)
    void window.electronAPI?.setUploadBatchSmartClassify?.(next)
  }

  function uploadHandler() {
    window.electronAPI.askUploadFile(curPath.at(-1).folderId)
  }

  return (
    <div className="flex flex-row items-stretch h-11 gap-2 shrink-0">
      <ButtonGroup variant="outlined" className="h-full">
        <Button
          onClick={() => setFolderOpen(!folderOpen)}
          className="flex flex-row h-full px-3 gap-1.5 items-center justify-center"
        >
          <FolderPlusIcon className="size-4" />
          <Typography variant="small">資料夾</Typography>
        </Button>
        <Button
          onClick={() => uploadHandler()}
          className="flex flex-row h-full px-3 gap-1.5 items-center justify-center"
        >
          <ArrowUpTrayIcon className="size-4" />
          <Typography variant="small">上傳</Typography>
        </Button>
      </ButtonGroup>

      <div
        className="flex h-full items-center rounded-md border border-blue-gray-200 bg-white px-3"
        title="開啟後，上傳前會用本機模型為整批檔案建議標籤"
      >
        <Switch
          id="smart-classify-switch"
          color="blue"
          ripple={false}
          checked={enabled}
          onChange={handleToggle}
          label={
            <Typography variant="small" className="text-xs text-blue-gray-800 whitespace-nowrap">
              智慧標籤{enabled ? '：開啟' : '：關閉'}
            </Typography>
          }
          labelProps={{ className: 'ml-2' }}
        />
      </div>
      {busy && (
        <div className="flex flex-row items-center gap-1.5 h-full px-1">
          <AnalysisSpinner className="h-3 w-3" />
          <Typography variant="small" className="text-xs text-blue-600">
            {progress ? `${progress.done}/${progress.total} 段` : '分析中…'}
          </Typography>
        </div>
      )}

      <AddFolderDialog open={folderOpen} setOpen={setFolderOpen} />
    </div>
  )
}

FileViewButtonGroup.propTypes = {
  curPath: PropTypes.array.isRequired
}

export default FileViewButtonGroup
