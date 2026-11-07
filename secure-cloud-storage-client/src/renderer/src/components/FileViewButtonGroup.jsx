/**
 * Action bar for the file-list page: folder creation, file upload,
 * and the smart-classify on/off switch (all visible before selecting files).
 *
 * 2026-10: the former fast / thinking (4B / 9B) dropdown is gone. The switch
 * maps to mode 'fast' (on) or 'off'; main keeps the same IPC contract.
 *
 * Windows only (window.electronAPI.classifierModel; absent on macOS): turning
 * the switch on without an installed model opens the model setup dialog and
 * leaves the switch off; model download / load progress is shown next to it.
 */
import { ButtonGroup, Button, Typography, Switch } from '@material-tailwind/react'
import AddFolderDialog from './AddFolderDialog'
import { ArrowUpTrayIcon, FolderPlusIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import AnalysisSpinner from './AnalysisSpinner'
import { readSmartClassifyMode, writeSmartClassifyMode } from '../lib/smartClassifyPrefs'
import { OPEN_MODEL_SETUP_EVENT } from './ModelSetupDialog'

const openModelSetup = () => window.dispatchEvent(new CustomEvent(OPEN_MODEL_SETUP_EVENT))

function FileViewButtonGroup({ curPath }) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [mode, setMode] = useState(() => readSmartClassifyMode())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  // Windows only: model download/import job and model load in progress.
  const [modelJob, setModelJob] = useState(null)
  const [modelLoadPercent, setModelLoadPercent] = useState(null)
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

  useEffect(() => {
    const api = window.electronAPI?.classifierModel
    if (!api) return undefined // macOS: nothing to track
    void api
      .status()
      .then((s) => setModelJob(s?.job ?? null))
      .catch(() => {})
    const unsub = window.electronAPI?.subscribeClassifierLlmProgress?.((p) => {
      if (p?.phase === 'model-job') {
        if (p.state === 'start') setModelJob({ kind: p.kind, received: 0, total: 0 })
        else if (p.state === 'progress')
          setModelJob({ kind: p.kind, received: p.received, total: p.total })
        else setModelJob(null)
      } else if (p?.phase === 'model-load') {
        if (p.state === 'start') setModelLoadPercent(0)
        else if (p.state === 'progress') setModelLoadPercent(p.percent)
        else setModelLoadPercent(null)
      }
    })
    return () => unsub?.()
  }, [])

  async function handleToggle(e) {
    const next = e.target.checked ? 'fast' : 'off'
    const modelApi = window.electronAPI?.classifierModel
    if (next !== 'off' && modelApi) {
      // Windows: smart classify needs a downloaded / imported model first.
      const status = await modelApi.status().catch(() => null)
      if (status?.managed && status.state !== 'ready') {
        openModelSetup()
        return // the switch stays off until the model is ready
      }
    }
    setMode(next)
    writeSmartClassifyMode(next)
    void window.electronAPI?.setUploadBatchSmartClassify?.(next)
  }

  const modelJobPercent =
    modelJob && modelJob.total > 0 ? Math.floor((modelJob.received / modelJob.total) * 100) : 0

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
            {modelLoadPercent != null
              ? `載入模型 ${modelLoadPercent}%`
              : progress
                ? `${progress.done}/${progress.total} 段`
                : '分析中…'}
          </Typography>
        </div>
      )}
      {modelJob && (
        <button
          type="button"
          onClick={openModelSetup}
          className="flex flex-row items-center gap-1.5 h-full px-1 text-xs text-blue-600 hover:underline"
          title="查看模型下載進度"
        >
          <AnalysisSpinner className="h-3 w-3" />
          {modelJob.kind === 'download' ? '模型下載中' : '模型處理中'} {modelJobPercent}%
        </button>
      )}

      <AddFolderDialog open={folderOpen} setOpen={setFolderOpen} />
    </div>
  )
}

FileViewButtonGroup.propTypes = {
  curPath: PropTypes.array.isRequired
}

export default FileViewButtonGroup
