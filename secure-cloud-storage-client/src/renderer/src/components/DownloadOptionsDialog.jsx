/**
 * Dialog for choosing download options (original / watermark).
 * Shown when the user clicks "Download" on any file.
 */
import { useState, useEffect } from 'react'
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
import PropTypes from 'prop-types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC_MIME = 'application/msword'

/** Supported MIME types for watermark — mirrors WatermarkProcessor.js */
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

const POSITION_LABELS = {
  bottomRight: '右下角',
  bottomLeft: '左下角',
  diagonal: '斜線滿版'
}

function DownloadOptionsDialog({ open, onClose, fileData }) {
  const mime = getMimeFromFilename(fileData?.name)
  const watermarkSupported = SUPPORTED_MIMES.includes(mime)

  const [mode, setMode] = useState('original')
  const [customNote, setCustomNote] = useState('')
  const [position, setPosition] = useState('bottomRight')
  const [opacity, setOpacity] = useState(30) // 0–100, sent as /100
  const [fontSize, setFontSize] = useState(14)

  // Reset to original mode if format doesn't support watermark
  useEffect(() => {
    if (open && !watermarkSupported) setMode('original')
  }, [open, watermarkSupported])

  function handleDownload() {
    const effectiveMode = !watermarkSupported ? 'original' : mode
    onClose()
    // The watermark *visibility* is now derived from `mode` on the main side:
    //   mode='watermark' → visible + (silent) invisible
    //   mode='original'  → (silent) invisible only
    // We still send the visible-watermark style options so they can be applied
    // when mode='watermark'. The renderer never asks the user about invisible.
    window.electronAPI.askDownloadFileWithOptions({
      fileId: fileData.fileId,
      mode: effectiveMode,
      watermarkOptions:
        effectiveMode === 'watermark'
          ? {
              customNote: customNote.trim(),
              position,
              opacity: opacity / 100,
              fontSize,
              mimeType: mime
            }
          : null
    })
  }

  return (
    <Dialog
      open={open}
      handler={onClose}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>下載選項</DialogHeader>
      <DialogBody className="flex flex-col gap-4">

        {/* ── Mode selection ── */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="dlMode"
              checked={mode === 'original'}
              onChange={() => setMode('original')}
            />
            <Typography>原檔下載</Typography>
          </label>

          <label
            className={`flex items-center gap-2 select-none ${
              !watermarkSupported ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <input
              type="radio"
              name="dlMode"
              disabled={!watermarkSupported}
              checked={mode === 'watermark'}
              onChange={() => watermarkSupported && setMode('watermark')}
            />
            <Typography>浮水印下載</Typography>
          </label>

          {!watermarkSupported && mime === DOC_MIME && (
            <Typography variant="small" color="amber" className="ml-6">
              ⚠ 舊版 DOC 格式不支援浮水印，請先將檔案另存為 DOCX 後再試。
            </Typography>
          )}
          {!watermarkSupported && mime && mime !== DOC_MIME && (
            <Typography variant="small" color="red" className="ml-6">
              此檔案格式（{mime}）不支援浮水印
            </Typography>
          )}
          {!watermarkSupported && !mime && (
            <Typography variant="small" color="red" className="ml-6">
              此檔案格式不支援浮水印
            </Typography>
          )}
        </div>

        {/* ── Watermark options (only when mode=watermark and supported) ── */}
        {mode === 'watermark' && watermarkSupported && (
          <div className="flex flex-col gap-3 border-t border-gray-200 pt-3 border border-blue-gray-100 rounded-lg p-3">
            <Typography variant="small" className="font-bold text-blue-gray-700">
              浮水印設定
            </Typography>

            {/* Position
                DOCX：渲染引擎不支援滿版斜線、左下、右下，最終都會落在文末段落，
                      所以位置選單直接隱藏，僅顯示說明文字。
                TXT ：純文字無位置概念，同樣隱藏。 */}
            {mime !== 'text/plain' && mime !== DOCX_MIME && (
              <div>
                <Typography variant="h6" className="mb-1">位置</Typography>
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
            {mime === DOCX_MIME && (
              <Typography variant="small" color="gray">
                DOCX 格式的浮水印將附加於文件末尾段落，位置設定不適用（不支援滿版斜線與左下／右下）。
              </Typography>
            )}
            {mime === 'text/plain' && (
              <Typography variant="small" color="gray">
                TXT 為純文字格式，浮水印將以標記行形式附加於文件末尾。位置、透明度與字體大小設定不適用。
              </Typography>
            )}

            {/* Opacity & Font size sliders
                TXT：純文字格式無樣式概念，固定值由後端決定，所以兩個 slider 直接隱藏。 */}
            {mime !== 'text/plain' && (
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

            {/* Custom note */}
            <Input
              label="自訂浮水印（選填）"
              labelProps={{ className: 'font-sans peer-focus:hidden' }}
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
              size="md"
              className="focus:!border-t-gray-900"
            />
            {/*
              Heads-up for users who type CJK/emoji into the visible note:
              PDF (Helvetica) and image (Jimp bitmap fonts) only render
              printable ASCII. _toAsciiSafe replaces any non-ASCII glyph
              with '?'. DOCX renders fine because Word's font fallback
              handles CJK. We only show the warning on formats that will
              actually mangle the note.
            */}
            {customNote && /[^\x20-\x7E]/.test(customNote) &&
              (mime === 'application/pdf' ||
                mime === 'image/png' ||
                mime === 'image/jpeg' ||
                mime === 'text/plain') && (
                <Typography variant="small" color="amber" className="-mt-1">
                  ⚠ 此格式的可視浮水印只支援 ASCII 字元，非英文字將以 "?" 顯示
                </Typography>
              )}
          </div>
        )}

        {/* ── File info footer ── */}
        <div className="border-t border-gray-100 pt-2 flex flex-col gap-1">
          <Typography variant="small" color="gray">
            檔案：{fileData?.name || '—'} ｜ 格式：{mime || '未知'} ｜{' '}
            浮水印：{watermarkSupported ? '✓ 支援' : mime === DOC_MIME ? '⚠ 需轉為 DOCX' : '✗ 不支援'}
          </Typography>
          {watermarkSupported && mime === DOCX_MIME && (
            <Typography variant="small" color="gray">
              DOCX 浮水印將附加於文件末尾段落。
            </Typography>
          )}
          {watermarkSupported && mime === 'text/plain' && (
            <Typography variant="small" color="gray">
              TXT 浮水印將以末尾標記行附加。
            </Typography>
          )}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="text" color="red" onClick={onClose} className="mr-2">
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={handleDownload}>
          下載
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

DownloadOptionsDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  fileData: PropTypes.object.isRequired
}

export default DownloadOptionsDialog
