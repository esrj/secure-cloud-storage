/**
 * Windows only: get the smart-classify model onto this PC (download from the
 * pinned Hugging Face revision, import an offline copy, or verify a file
 * already in the model folder). Used by ModelSetupDialog (switching smart
 * classify on) and inside PostUploadDialog (after a "model not installed"
 * failure). Renders only where window.electronAPI.classifierModel exists.
 *
 * The job itself runs in the main process (windowsClassifierModel.js), so it
 * keeps going if this panel is closed; progress arrives on the
 * classifier-llm-progress channel as { phase: 'model-job', ... }.
 */
import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { Button, Progress, Typography } from '@material-tailwind/react'
import AnalysisSpinner from './AnalysisSpinner'

const GB = 1024 ** 3
const fmtGB = (n) => `${(Math.max(0, n || 0) / GB).toFixed(1)} GB`

function jobLabel(job) {
  if (!job) return ''
  const pct = job.total > 0 ? Math.floor((job.received / job.total) * 100) : 0
  switch (job.step) {
    case 'resume-check':
      return `正在檢查先前下載的部分… ${pct}%`
    case 'download':
      return `下載中 ${fmtGB(job.received)} / ${fmtGB(job.total)}（${pct}%）`
    case 'copy':
      return `複製並校驗中 ${fmtGB(job.received)} / ${fmtGB(job.total)}（${pct}%）`
    case 'verify':
      return `校驗中 ${pct}%`
    default:
      return job.kind === 'download' ? '準備下載…' : '準備中…'
  }
}

function ModelSetupPanel({ onReady, onLater, onHide, laterLabel = '稍後設定' }) {
  // Read once: a new object identity on every render would re-run the effect below.
  const [api] = useState(() => window.electronAPI?.classifierModel)
  const [status, setStatus] = useState(null)
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const s = await api.status()
      setStatus(s)
      setJob(s?.job ?? null)
    } catch (e) {
      setError(`無法取得模型狀態：${e.message}`)
    }
  }, [api])

  const ready = Boolean(status?.managed && status.state === 'ready' && !job)
  useEffect(() => {
    if (ready) onReady?.()
  }, [ready, onReady])

  useEffect(() => {
    if (!api) return undefined
    void refresh()
    const unsub = window.electronAPI?.subscribeClassifierLlmProgress?.((p) => {
      if (p?.phase !== 'model-job') return
      if (p.state === 'start') {
        setError('')
        setJob({ kind: p.kind, step: 'prepare', received: 0, total: 0 })
      } else if (p.state === 'progress') {
        setJob({ kind: p.kind, step: p.step, received: p.received, total: p.total })
      } else {
        setJob(null)
        if (p.state === 'failed' || p.state === 'cancelled') setError(p.message || '')
        void refresh()
      }
    })
    return () => unsub?.()
  }, [api, refresh])

  async function run(action) {
    setError('')
    const r = await action().catch((e) => ({ ok: false, message: e.message }))
    // Job results also arrive as events; only results without events are shown here.
    if (r && !r.ok && (r.code === 'BUSY' || r.code === 'NOT_MANAGED')) setError(r.message)
  }

  if (!api) return null

  if (!status) {
    return (
      <div className="flex flex-row items-center gap-2">
        <AnalysisSpinner />
        <Typography variant="small">正在檢查模型狀態…</Typography>
      </div>
    )
  }

  if (!status.managed) {
    return (
      <Typography variant="small" className="text-blue-gray-700">
        這個版本不需要另外下載模型。
      </Typography>
    )
  }

  if (status.state === 'ready' && !job) {
    return (
      <Typography variant="small" className="font-semibold text-green-800">
        模型已就緒，可以使用智慧分類。
      </Typography>
    )
  }

  if (status.state === 'env-missing') {
    return (
      <div className="flex flex-col gap-3">
        <Typography variant="small" className="text-red-800">
          系統環境設定指定了模型檔的位置，但找不到該檔案。請修正或移除該設定後重新啟動程式；在這之前下載或匯入的模型不會被使用。
        </Typography>
        {onLater && (
          <div>
            <Button size="sm" variant="text" onClick={onLater}>
              {laterLabel}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const free = status.disk?.freeBytes
  const required = status.disk?.requiredBytes ?? status.model.size
  const lowDisk = typeof free === 'number' && free < required
  const lowMemory = status.memory && status.memory.totalBytes < status.memory.recommendedBytes
  const resumable = status.partialBytes > 0
  const pct = job && job.total > 0 ? Math.floor((job.received / job.total) * 100) : 0

  return (
    <div className="flex flex-col gap-3 text-blue-gray-800">
      <Typography variant="small">
        智慧分類在這台電腦上執行，需要先取得約 {fmtGB(status.model.size)} 的模型檔（
        {status.model.name}，Apache 2.0 授權）。文件內容不會送到外部；下載只會向 Hugging Face
        取得模型檔本身，完成後會核對 SHA-256。
      </Typography>

      {status.state === 'invalid' && (
        <Typography variant="small" className="text-amber-900">
          模型資料夾裡的模型檔不完整或已損毀，需要重新下載或匯入。
        </Typography>
      )}
      {status.state === 'unverified' && (
        <Typography variant="small" className="text-amber-900">
          模型資料夾裡已有模型檔，但還沒通過校驗。可以先校驗這個檔案（約需一分鐘）。
        </Typography>
      )}

      <div className="rounded-lg border border-blue-gray-100 bg-blue-gray-50/60 px-3 py-2 text-xs">
        <div>
          需要可用空間：約 {fmtGB(required)}
          {typeof free === 'number' ? `；目前可用 ${fmtGB(free)}` : ''}
        </div>
        {resumable && !job && <div>先前已下載 {fmtGB(status.partialBytes)}，可以接著下載。</div>}
      </div>

      {lowDisk && (
        <Typography variant="small" className="text-red-800">
          磁碟空間不足，請先清出空間再下載或匯入。
        </Typography>
      )}
      {lowMemory && (
        <Typography variant="small" className="text-amber-900">
          這台電腦的記憶體為 {fmtGB(status.memory.totalBytes)}，低於建議的{' '}
          {fmtGB(status.memory.recommendedBytes)}；模型可能無法載入，或分析會很慢。
        </Typography>
      )}

      {job ? (
        <div className="flex flex-col gap-2">
          <Typography variant="small" className="font-medium text-blue-gray-900">
            {jobLabel(job)}
          </Typography>
          <Progress value={pct} size="sm" color="blue" />
          <div className="flex flex-row gap-2">
            <Button size="sm" variant="outlined" color="red" onClick={() => void api.cancelJob()}>
              {job.kind === 'download' ? '取消下載' : '取消'}
            </Button>
            {onHide && (
              <Button size="sm" variant="text" onClick={onHide}>
                在背景繼續
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          {error && (
            <Typography variant="small" className="text-red-800">
              {error}
            </Typography>
          )}
          <div className="flex flex-row flex-wrap gap-2">
            {status.state === 'unverified' && (
              <Button size="sm" color="blue" onClick={() => void run(api.verifyExisting)}>
                校驗現有檔案
              </Button>
            )}
            <Button
              size="sm"
              color="blue"
              variant={status.state === 'unverified' ? 'outlined' : 'filled'}
              disabled={lowDisk}
              onClick={() => void run(api.download)}
            >
              {resumable ? '繼續下載' : '下載模型'}
            </Button>
            <Button size="sm" variant="outlined" onClick={() => void run(api.importFile)}>
              匯入模型
            </Button>
            {onLater && (
              <Button size="sm" variant="text" onClick={onLater}>
                {laterLabel}
              </Button>
            )}
          </div>
          <Typography variant="small" className="text-xs text-blue-gray-600">
            無法連到 Hugging Face（例如公司或學校網路）時，可以在其他電腦下載{' '}
            <span className="font-mono">gemma-4-E4B-it-Q4_K_M.gguf</span>
            ，再用「匯入模型」選擇該檔案。
          </Typography>
        </>
      )}
    </div>
  )
}

ModelSetupPanel.propTypes = {
  onReady: PropTypes.func,
  onLater: PropTypes.func,
  onHide: PropTypes.func,
  laterLabel: PropTypes.string
}

export default ModelSetupPanel
