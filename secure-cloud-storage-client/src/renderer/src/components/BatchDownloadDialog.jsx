/**
 * Batch download options dialog.
 *
 * Visually mirrors DownloadOptionsDialog but applies a single set of options
 * to a list of files. Files whose format does not support watermarking are
 * shown in a banner and (when 'watermark' mode is selected) will fall back to
 * 'original' download on the main side.
 *
 * Destination directory is picked once via the OS folder picker (handled in
 * main process), and remembered in localStorage so subsequent batches default
 * to the previously used directory.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Button,
  Input,
  Select,
  Option,
  Typography
} from '@material-tailwind/react'
import { FolderIcon } from '@heroicons/react/24/outline'
import PropTypes from 'prop-types'
import toast from 'react-hot-toast'
import { bytesToSize } from './Types'
import { readLastBatchDestDir, writeLastBatchDestDir } from '../lib/batchDownloadPrefs'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC_MIME = 'application/msword'
const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg', DOCX_MIME, 'text/plain']

function getMimeFromFilename(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return (
    {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      docx: DOCX_MIME,
      doc: DOC_MIME,
      txt: 'text/plain'
    }[ext] || null
  )
}

function shortMimeLabel(mime) {
  return (
    {
      'application/pdf': 'PDF',
      'image/png': 'PNG',
      'image/jpeg': 'JPEG',
      [DOCX_MIME]: 'DOCX',
      [DOC_MIME]: 'DOC',
      'text/plain': 'TXT'
    }[mime] || (mime || '其他')
  )
}

const POSITION_LABELS = {
  bottomRight: '右下角',
  bottomLeft: '左下角',
  diagonal: '斜線滿版'
}

function BatchDownloadDialog({ open, onClose, items }) {
  const [mode, setMode] = useState('original')
  const [customNote, setCustomNote] = useState('')
  const [position, setPosition] = useState('bottomRight')
  const [opacity, setOpacity] = useState(30)
  const [fontSize, setFontSize] = useState(14)
  const [destDir, setDestDir] = useState('')
  const [busy, setBusy] = useState(false)

  // Default destDir from localStorage (if present); main will pick a sensible
  // OS default (e.g. ~/Downloads) when we hand it the empty string.
  useEffect(() => {
    if (open) setDestDir(readLastBatchDestDir())
  }, [open])

  const annotated = useMemo(
    () =>
      items.map((it) => {
        const mime = getMimeFromFilename(it.name)
        return {
          ...it,
          mime,
          watermarkSupported: mime && SUPPORTED_MIMES.includes(mime)
        }
      }),
    [items]
  )

  const wmSupportedCount = annotated.filter((x) => x.watermarkSupported).length
  const wmUnsupportedCount = annotated.length - wmSupportedCount
  const totalSize = annotated.reduce((acc, it) => acc + (parseInt(it.size, 10) || 0), 0)

  // Group by short mime label for a compact summary line.
  const formatSummary = useMemo(() => {
    const counts = new Map()
    annotated.forEach((it) => {
      const k = shortMimeLabel(it.mime)
      counts.set(k, (counts.get(k) || 0) + 1)
    })
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`)
      .join(' ｜ ')
  }, [annotated])

  // Detect formats that exist in the batch and require special handling
  // when in watermark mode (mirrors DownloadOptionsDialog's per-format notes).
  const hasDocx = annotated.some((it) => it.mime === DOCX_MIME && it.watermarkSupported)
  const hasTxt = annotated.some((it) => it.mime === 'text/plain' && it.watermarkSupported)
  const hasPdfOrImage = annotated.some(
    (it) =>
      it.watermarkSupported &&
      (it.mime === 'application/pdf' || it.mime === 'image/png' || it.mime === 'image/jpeg')
  )

  async function pickFolder() {
    try {
      const picked = await window.electronAPI.askPickDownloadFolder(destDir || undefined)
      if (picked) {
        setDestDir(picked)
        writeLastBatchDestDir(picked)
      }
    } catch (e) {
      toast.error(`選擇資料夾失敗：${e?.message || e}`)
    }
  }

  async function handleDownload() {
    if (annotated.length === 0) return
    setBusy(true)
    try {
      // Watermark visibility is now derived in the main process from `mode`:
      //   mode='watermark' → visible + (silent) invisible
      //   mode='original'  → (silent) invisible only
      // The renderer never exposes invisible watermark to the user.
      const result = await window.electronAPI.askDownloadBatchWithOptions({
        files: annotated.map((it) => ({
          fileId: it.fileId,
          name: it.name,
          mime: it.mime,
          watermarkSupported: !!it.watermarkSupported
        })),
        destDir: destDir || null,
        mode,
        watermarkOptions:
          mode === 'watermark'
            ? {
                customNote: customNote.trim(),
                position,
                opacity: opacity / 100,
                fontSize
              }
            : null
      })
      if (result?.canceled) {
        // User cancelled the folder picker — stay on dialog so they can retry.
        setBusy(false)
        return
      }
      if (result?.destDir) writeLastBatchDestDir(result.destDir)
      onClose()
    } catch (e) {
      toast.error(`啟動批次下載失敗：${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      handler={onClose}
      size="md"
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>批次下載</DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {/* ── Summary header ── */}
        <div className="flex flex-col gap-1">
          <Typography variant="h6">
            將下載 {annotated.length} 個檔案 ・ 合計 {bytesToSize(totalSize)}
          </Typography>
          <Typography variant="small" color="gray">
            {formatSummary}
          </Typography>
        </div>

        {/* ── File list (max-height, scroll) ── */}
        <div className="border border-blue-gray-100 rounded-lg max-h-44 overflow-auto p-2">
          {annotated.map((it) => (
            <div
              key={it.fileId}
              className="flex flex-row items-center gap-2 py-0.5 text-sm"
            >
              <Typography variant="small" className="truncate grow">
                {it.name}
              </Typography>
              <Typography variant="small" color="gray" className="shrink-0">
                {bytesToSize(it.size)}
              </Typography>
              <Typography
                variant="small"
                color={it.watermarkSupported ? 'gray' : 'amber'}
                className="shrink-0 w-32 text-right"
              >
                {it.watermarkSupported ? shortMimeLabel(it.mime) : '不支援浮水印'}
              </Typography>
            </div>
          ))}
        </div>

        {/* ── Mode selection ── */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="dlBatchMode"
              checked={mode === 'original'}
              onChange={() => setMode('original')}
            />
            <Typography>原檔下載</Typography>
          </label>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="dlBatchMode"
              checked={mode === 'watermark'}
              onChange={() => setMode('watermark')}
            />
            <Typography>浮水印下載</Typography>
          </label>

          {mode === 'watermark' && wmUnsupportedCount > 0 && (
            <Typography variant="small" color="amber" className="ml-6">
              ⚠ 有 {wmUnsupportedCount} 個檔案不支援浮水印，將以原檔下載。
            </Typography>
          )}
          {mode === 'watermark' && wmSupportedCount === 0 && (
            <Typography variant="small" color="red" className="ml-6">
              所選檔案皆不支援浮水印；請改選原檔下載。
            </Typography>
          )}
        </div>

        {/* ── Watermark options ── */}
        {mode === 'watermark' && wmSupportedCount > 0 && (
          <div className="flex flex-col gap-3 border-t border-gray-200 pt-3 border border-blue-gray-100 rounded-lg p-3">
            <Typography variant="small" className="font-bold text-blue-gray-700">
              浮水印設定
            </Typography>

            {/* Position only matters for PDF / Image. */}
            {hasPdfOrImage && (
              <div>
                <Typography variant="h6" className="mb-1">位置（套用於 PDF / 圖片）</Typography>
                <Select
                  value={position}
                  onChange={(v) => setPosition(v)}
                  labelProps={{ className: 'peer-focus:hidden' }}
                  className="focus:!border-t-gray-900"
                >
                  {Object.entries(POSITION_LABELS).map(([val, label]) => (
                    <Option key={val} value={val}>{label}</Option>
                  ))}
                </Select>
              </div>
            )}
            {hasDocx && (
              <Typography variant="small" color="gray">
                DOCX 的浮水印將附加於文件末尾段落，位置設定不適用。
              </Typography>
            )}
            {hasTxt && (
              <Typography variant="small" color="gray">
                TXT 的浮水印將以標記行附加於檔尾，位置／透明度／字體大小不適用。
              </Typography>
            )}

            {hasPdfOrImage && (
              <>
                <div>
                  <Typography variant="h6">透明度：{opacity}%</Typography>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                    className="w-full accent-blue-gray-900"
                  />
                </div>
                <div>
                  <Typography variant="h6">字體大小：{fontSize}px</Typography>
                  <input
                    type="range"
                    min={8}
                    max={48}
                    step={2}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-blue-gray-900"
                  />
                </div>
              </>
            )}

            <Input
              label="自訂浮水印（選填）"
              labelProps={{ className: 'font-sans peer-focus:hidden' }}
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
              size="md"
              className="focus:!border-t-gray-900"
            />
            {/*
              Batch downloads typically span mixed formats; we don't know
              up-front which files will end up with ASCII-only visible
              watermarks. Show the warning whenever the note itself contains
              non-ASCII — it applies to any PDF/PNG/JPEG/TXT in the batch.
            */}
            {customNote && /[^\x20-\x7E]/.test(customNote) && (
              <Typography variant="small" color="amber" className="-mt-1">
                ⚠ PDF、PNG/JPEG、TXT 的可視浮水印僅支援 ASCII 字元，非英文字將以 "?" 顯示（DOCX 不受影響）
              </Typography>
            )}
          </div>
        )}

        {/* ── Destination directory ── */}
        <div className="flex flex-col gap-1 border-t border-gray-100 pt-3">
          <Typography variant="h6">儲存到資料夾</Typography>
          <div className="flex flex-row items-center gap-2">
            <Typography
              variant="small"
              color="gray"
              className="grow truncate font-mono bg-blue-gray-50 rounded px-2 py-1"
            >
              {destDir || '（尚未選擇 — 將使用系統預設下載資料夾）'}
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              color="blue-gray"
              className="flex flex-row items-center gap-1"
              onClick={pickFolder}
            >
              <FolderIcon className="size-4" />
              選擇…
            </Button>
          </div>
          <Typography variant="small" color="gray">
            撞名檔案會自動編號，例如 <span className="font-mono">report (2).pdf</span>。
          </Typography>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="text" color="red" onClick={onClose} className="mr-2" disabled={busy}>
          取消
        </Button>
        <Button
          variant="gradient"
          color="black"
          onClick={handleDownload}
          disabled={busy || annotated.length === 0}
        >
          {busy ? '啟動中…' : `下載 ${annotated.length} 個`}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

BatchDownloadDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  items: PropTypes.array.isRequired
}

export default BatchDownloadDialog
