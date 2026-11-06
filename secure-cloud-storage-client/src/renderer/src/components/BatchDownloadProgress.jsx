/**
 * Floating bottom-right card that follows main-process batch-download events.
 *
 * - Picks up `batch-started` to spawn a tracker, `item-started` / `item-done`
 *   to update per-file rows, and `batch-done` to switch to the summary view.
 * - Multiple batches can run in parallel; each gets its own card stacked
 *   vertically (newest at top).
 * - "取消剩餘" sets the cancel flag in main; current item still completes.
 * - "在 Finder 顯示" calls `shell.showItemInFolder` on the destination dir.
 */
import { useEffect, useState } from 'react'
import { Card, IconButton, Typography, Button } from '@material-tailwind/react'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  XMarkIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  FolderOpenIcon
} from '@heroicons/react/24/outline'

const STATUS_META = {
  pending: { color: 'text-blue-gray-400', icon: ClockIcon, label: '等待中' },
  running: { color: 'text-blue-600', icon: ArrowPathIcon, label: '下載中' },
  watermarking: { color: 'text-purple-600', icon: ArrowPathIcon, label: '套浮水印…' },
  success: { color: 'text-green-600', icon: CheckCircleIcon, label: '完成' },
  error: { color: 'text-red-600', icon: XCircleIcon, label: '失敗' },
  skipped: { color: 'text-blue-gray-400', icon: XMarkIcon, label: '已取消' }
}

function BatchDownloadProgress() {
  // batchId -> tracker state
  const [batches, setBatches] = useState(() => new Map())

  useEffect(() => {
    const unsub = window.electronAPI.onBatchDownloadProgress((evt) => {
      setBatches((prev) => {
        const next = new Map(prev)
        const cur = next.get(evt.batchId) || {
          batchId: evt.batchId,
          total: evt.total ?? 0,
          destDir: evt.destDir,
          startedAt: Date.now(),
          finishedAt: null,
          collapsed: false,
          cancelled: false,
          items: [] // [{ index, fileId, name, status, outPath?, error? }]
        }
        switch (evt.type) {
          case 'batch-started': {
            cur.total = evt.total
            cur.destDir = evt.destDir
            cur.items = evt.files.map((f, i) => ({
              index: i,
              fileId: f.fileId,
              name: f.name,
              status: 'pending'
            }))
            break
          }
          case 'item-started': {
            const it = cur.items[evt.index]
            if (it) it.status = evt.phase || 'running'
            break
          }
          case 'item-progress': {
            // reserved for future per-byte progress; v1 leaves it as 'running'
            const it = cur.items[evt.index]
            if (it && evt.phase) it.status = evt.phase
            break
          }
          case 'item-done': {
            const it = cur.items[evt.index]
            if (it) {
              it.status = evt.status
              it.outPath = evt.outPath
              it.error = evt.error
            }
            break
          }
          case 'batch-cancelled':
            cur.cancelled = true
            break
          case 'batch-done':
            cur.finishedAt = Date.now()
            cur.summary = evt.summary
            break
          default:
            break
        }
        next.set(evt.batchId, { ...cur })
        return next
      })
    })
    return () => {
      try { unsub?.() } catch (_) { /* noop */ }
    }
  }, [])

  function dismiss(batchId) {
    setBatches((prev) => {
      const next = new Map(prev)
      next.delete(batchId)
      return next
    })
  }

  function toggle(batchId) {
    setBatches((prev) => {
      const next = new Map(prev)
      const cur = next.get(batchId)
      if (cur) next.set(batchId, { ...cur, collapsed: !cur.collapsed })
      return next
    })
  }

  function cancel(batchId) {
    window.electronAPI.cancelDownloadBatch?.(batchId)
  }

  function showInFolder(destDir) {
    if (!destDir) return
    window.electronAPI.showItemInFolder?.(destDir)
  }

  if (batches.size === 0) return null

  // Newest first.
  const list = Array.from(batches.values()).reverse()

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
      {list.map((b) => (
        <BatchCard
          key={b.batchId}
          batch={b}
          onCancel={() => cancel(b.batchId)}
          onDismiss={() => dismiss(b.batchId)}
          onToggle={() => toggle(b.batchId)}
          onShowInFolder={() => showInFolder(b.destDir)}
        />
      ))}
    </div>
  )
}

function BatchCard({ batch, onCancel, onDismiss, onToggle, onShowInFolder }) {
  const done = batch.items.filter((i) => i.status === 'success' || i.status === 'error' || i.status === 'skipped').length
  const ok = batch.items.filter((i) => i.status === 'success').length
  const fail = batch.items.filter((i) => i.status === 'error').length
  const total = batch.total || batch.items.length || 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const finished = !!batch.finishedAt

  return (
    <Card className="p-3 shadow-lg pointer-events-auto border border-blue-gray-100">
      <div className="flex flex-row items-center gap-2">
        <Typography variant="small" className="font-bold grow">
          {finished
            ? `批次下載完成 (${ok} ✔ / ${fail} ✘)`
            : `批次下載中 (${done} / ${total})`}
        </Typography>
        <IconButton variant="text" size="sm" onClick={onToggle} title={batch.collapsed ? '展開' : '收起'}>
          {batch.collapsed ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
        </IconButton>
        {finished && (
          <IconButton variant="text" size="sm" onClick={onDismiss} title="關閉">
            <XMarkIcon className="size-4" />
          </IconButton>
        )}
      </div>

      {!batch.collapsed && (
        <>
          <div className="mt-2 h-2 rounded bg-blue-gray-100 overflow-hidden">
            <div
              className={`h-full ${finished ? (fail > 0 ? 'bg-amber-500' : 'bg-green-500') : 'bg-blue-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-2 max-h-48 overflow-auto">
            {batch.items.map((it) => {
              const meta = STATUS_META[it.status] || STATUS_META.pending
              const Icon = meta.icon
              return (
                <div key={it.index} className="flex flex-row items-center gap-2 py-0.5 text-xs">
                  <Icon className={`size-3.5 shrink-0 ${meta.color} ${it.status === 'running' || it.status === 'watermarking' ? 'animate-spin' : ''}`} />
                  <span className="truncate grow" title={it.error || it.outPath || it.name}>
                    {it.name}
                  </span>
                  <span className={`shrink-0 ${meta.color}`}>{meta.label}</span>
                </div>
              )
            })}
          </div>

          {/* Show first error message inline so the user knows what happened
              without clicking around. */}
          {fail > 0 && (
            <div className="mt-2 max-h-20 overflow-auto bg-red-50 rounded px-2 py-1">
              {batch.items
                .filter((it) => it.status === 'error')
                .slice(0, 3)
                .map((it) => (
                  <Typography key={it.index} variant="small" color="red" className="text-xs">
                    {it.name}: {it.error || '未知錯誤'}
                  </Typography>
                ))}
            </div>
          )}

          <div className="mt-2 flex flex-row items-center gap-2">
            {!finished && (
              <Button
                size="sm"
                variant="text"
                color="red"
                onClick={onCancel}
                disabled={batch.cancelled}
              >
                {batch.cancelled ? '取消中…' : '取消剩餘'}
              </Button>
            )}
            {finished && batch.destDir && (
              <Button
                size="sm"
                variant="outlined"
                color="blue-gray"
                onClick={onShowInFolder}
                className="flex flex-row items-center gap-1"
              >
                <FolderOpenIcon className="size-4" />
                在資料夾顯示
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

export default BatchDownloadProgress
