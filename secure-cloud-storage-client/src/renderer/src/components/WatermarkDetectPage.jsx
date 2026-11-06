/**
 * Watermark detection page.
 * All processing is local — no file is uploaded to the server.
 * Supports: PDF (invisible text), PNG/JPEG (LSB LSB), DOCX (custom property + body text), TXT (visible marker + ZWC).
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Card,
  Typography,
  Button,
  Spinner,
  Chip
} from '@material-tailwind/react'
import {
  ArrowUpTrayIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ClipboardDocumentIcon,
  CheckCircleIcon,
  XCircleIcon,
  UserIcon,
  ShieldExclamationIcon
} from '@heroicons/react/24/outline'
import { detectWatermark, extractTrackedUidFromPayload } from '../watermarkDetector'
import { bytesToSize } from './Types'
import toast from 'react-hot-toast'

const SUPPORTED_EXTS = ['PDF', 'PNG', 'JPG', 'JPEG', 'DOCX', 'TXT']
const SUPPORTED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]

function _mimeFromExt(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword', txt: 'text/plain'
  }[ext] || ''
}

function _friendlyMime(mime = '') {
  const map = {
    'application/pdf': 'PDF',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/msword': 'DOC',
    'text/plain': 'TXT'
  }
  return map[mime] || mime
}

function WatermarkDetectPage() {
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('idle') // idle | detecting | done | error
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  // ── File handling ──────────────────────────────────────────

  function handleFileSelect(selectedFile) {
    if (!selectedFile) return
    const mime = selectedFile.type || _mimeFromExt(selectedFile.name)
    if (mime === 'application/msword') {
      toast.error('舊版 DOC 不支援偵測，請先另存為 DOCX 格式後再試')
      return
    }
    if (!SUPPORTED_MIMES.includes(mime)) {
      toast.error(`不支援的格式：${mime || selectedFile.name.split('.').pop().toUpperCase()}`)
      return
    }
    setFile(selectedFile)
    setStatus('idle')
    setResult(null)
  }

  function handleInputChange(e) {
    handleFileSelect(e.target.files?.[0] || null)
    e.target.value = ''
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    handleFileSelect(e.dataTransfer.files?.[0] || null)
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  function clearFile() {
    setFile(null)
    setStatus('idle')
    setResult(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // ── Detection ──────────────────────────────────────────────

  async function runDetection() {
    if (!file) return
    setStatus('detecting')
    setResult(null)
    try {
      const res = await detectWatermark(file)
      setResult(res)
      setStatus('done')
    } catch (err) {
      setResult({
        fileName: file.name,
        mimeType: file.type,
        detected: false,
        method: 'error',
        reason: err.message
      })
      setStatus('error')
    }
  }

  // ── Copy payload ───────────────────────────────────────────

  function copyPayload(payload) {
    const value = payload ?? result?.payload
    if (!value) return
    navigator.clipboard.writeText(value).then(() => {
      toast.success('已複製到剪貼板')
    })
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-2xl mx-auto">
      <Typography variant="h4" className="flex items-center gap-2">
        <MagnifyingGlassIcon className="size-6" />
        浮水印偵測
      </Typography>
      <Typography variant="small" color="gray">
        本機偵測，檔案不會上傳至伺服器。支援格式：{SUPPORTED_EXTS.join('、')}
      </Typography>

      {/* ── Drop zone ── */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !file && inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3
          py-10 transition-colors cursor-pointer select-none
          ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-blue-gray-200 hover:border-blue-400 hover:bg-blue-gray-50'}
          ${file ? 'cursor-default' : ''}
        `}
      >
        {!file ? (
          <>
            <ArrowUpTrayIcon className="size-10 text-blue-gray-400" />
            <Typography color="blue-gray">拖曳或點擊選擇檔案</Typography>
            <Typography variant="small" color="gray">
              支援：{SUPPORTED_EXTS.join(' / ')}
            </Typography>
          </>
        ) : (
          <FileInfoCard file={file} onClear={clearFile} />
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.docx,.txt"
          className="hidden"
          onChange={handleInputChange}
        />
      </div>

      {/* ── Action buttons ── */}
      {file && (
        <div className="flex gap-3">
          <Button
            variant="gradient"
            color="black"
            className="flex items-center gap-2"
            onClick={runDetection}
            disabled={status === 'detecting'}
          >
            {status === 'detecting' ? (
              <>
                <Spinner className="size-4" />
                偵測中...
              </>
            ) : (
              <>
                <MagnifyingGlassIcon className="size-4" />
                開始偵測
              </>
            )}
          </Button>
          <Button variant="outlined" color="red" onClick={clearFile}>
            <XMarkIcon className="size-4 mr-1 inline" />
            重新選擇
          </Button>
        </div>
      )}

      {/* ── Result card ── */}
      {result && <ResultCard result={result} onCopy={copyPayload} />}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function FileInfoCard({ file, onClear }) {
  return (
    <div className="flex flex-col items-center gap-1 w-full px-6">
      <Typography variant="h6" className="truncate max-w-xs">
        {file.name}
      </Typography>
      <div className="flex gap-3">
        <Chip value={_friendlyMime(file.type) || '未知格式'} size="sm" variant="ghost" color="blue" />
        <Chip value={bytesToSize(file.size)} size="sm" variant="ghost" color="gray" />
      </div>
      <Button
        variant="text"
        size="sm"
        color="red"
        className="mt-1 flex items-center gap-1"
        onClick={(e) => {
          e.stopPropagation()
          onClear()
        }}
      >
        <XMarkIcon className="size-4" />
        清除
      </Button>
    </div>
  )
}

/**
 * Build the headline label for a result, listing every kind of watermark found.
 * One finding  → "偵測到可視浮水印" / "偵測到不可視浮水印"
 * Two findings → "同時偵測到可視與不可視浮水印"
 */
function _buildHeadline(findings) {
  const kinds = new Set(findings.map((f) => f.kind))
  const hasVisible = kinds.has('visible')
  const hasInvisible = kinds.has('invisible')
  if (hasVisible && hasInvisible) return '同時偵測到可視與不可視浮水印'
  if (hasInvisible) return '偵測到不可視浮水印'
  if (hasVisible) return '偵測到可視浮水印'
  return '偵測到浮水印'
}

function ResultCard({ result, onCopy }) {
  const isUnsupported = result.method === 'unsupported'
  const isError = result.method === 'error'
  const findings = Array.isArray(result.findings) ? result.findings : []

  // Reset tampered state whenever the file under inspection changes.
  // The set holds indices of findings that auto-validation flagged as tampered.
  const [tamperedIndices, setTamperedIndices] = useState(() => new Set())
  useEffect(() => {
    setTamperedIndices(new Set())
  }, [result.fileName, result.mimeType])

  const reportTampered = useCallback((idx, isTampered) => {
    setTamperedIndices((prev) => {
      const has = prev.has(idx)
      if (isTampered === has) return prev
      const next = new Set(prev)
      if (isTampered) next.add(idx)
      else next.delete(idx)
      return next
    })
  }, [])

  const anyTampered = tamperedIndices.size > 0

  return (
    <Card className="p-5 flex flex-col gap-4 border border-blue-gray-100">
      <Typography variant="h5">偵測結果</Typography>

      {/* File summary */}
      <div className="flex flex-wrap gap-2">
        <Chip value={result.fileName} size="sm" variant="ghost" color="gray" />
        <Chip value={result.mimeType || '未知'} size="sm" variant="ghost" color="blue" />
      </div>

      {/* Detected / Not detected */}
      {!isUnsupported && !isError && (
        <div className="flex items-center gap-3">
          {result.detected ? (
            <>
              <CheckCircleIcon className="size-7 text-green-600 shrink-0" />
              <Typography color="green" className="font-bold">
                ✅ {_buildHeadline(findings)}
              </Typography>
            </>
          ) : (
            <>
              <XCircleIcon className="size-7 text-red-400 shrink-0" />
              <Typography color="red" className="font-bold">
                ❌ 未偵測到浮水印
              </Typography>
            </>
          )}
        </div>
      )}

      {/* Top-level tampering banner — shown once, even if multiple findings flagged. */}
      {anyTampered && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 flex flex-row items-start gap-2">
          <ShieldExclamationIcon className="size-6 text-red-700 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <Typography className="font-bold text-red-800">
              ⚠ 不可視浮水印內容遭到竄改
            </Typography>
            <Typography variant="small" className="text-red-700">
              其中 {tamperedIndices.size} 個不可視浮水印未通過伺服器密鑰驗證 — 表示該浮水印已遭竄改、或並非由本系統嵌入；嵌入的 uid 不可信任，請勿據此判定來源使用者。
            </Typography>
          </div>
        </div>
      )}

      {/* Per-finding details (one section per visible / invisible) */}
      {result.detected && findings.length > 0 && (
        <div className="flex flex-col gap-3">
          {findings.map((f, i) => (
            <FindingBlock
              key={`${f.method}-${i}`}
              finding={f}
              index={i}
              onCopy={onCopy}
              onTamperedChange={reportTampered}
            />
          ))}
        </div>
      )}

      {/* Fallback: method badge for not-detected / unsupported / error */}
      {(!result.detected || findings.length === 0) && (
        <div className="flex items-center gap-2">
          <Typography variant="small" color="gray">偵測方法：</Typography>
          <MethodBadge method={result.method} />
        </div>
      )}

      {/* Stability warning for TXT ZWC if any finding uses it */}
      {findings.some((f) => f.method === 'txt-zwc-steganography') && (
        <div className="flex items-start gap-2 bg-amber-50 rounded-lg p-3">
          <Typography variant="small" color="amber">
            ⚠ TXT 零寬字元浮水印穩定性有限，部分文字編輯器在重新儲存後可能移除，建議以 DOCX 或 PDF 格式保存機敏文件。
          </Typography>
        </div>
      )}

      {/* Reason / explanation — shown for not-detected/unsupported/error only,
          since per-finding reasons already render inside FindingBlock. */}
      {result.reason && !result.detected && (
        <div className="border-t border-blue-gray-50 pt-3">
          <Typography variant="small" color="gray">
            {isError ? '⚠ ' : ''}{result.reason}
          </Typography>
        </div>
      )}

      {/* Unsupported (only if there's no reason message already) */}
      {isUnsupported && !result.reason && (
        <Typography color="red">此檔案格式不支援浮水印偵測</Typography>
      )}
    </Card>
  )
}

function FindingBlock({ finding, index, onCopy, onTamperedChange }) {
  const isVisible = finding.kind === 'visible'
  const trackedUid = finding.payload ? extractTrackedUidFromPayload(finding.payload) : null
  // Heuristic for the trace button label: full v1... values can be decrypted
  // directly; short hex prefixes require server-side prefix lookup.
  const isFullTracked = !!trackedUid && /^v\d+/.test(trackedUid)

  // Trace state. status: idle | loading | done | error
  const [traceState, setTraceState] = useState({ status: 'idle' })

  async function runTrace() {
    if (!trackedUid) return
    setTraceState({ status: 'loading' })
    try {
      const resp = await window.electronAPI.askDecodeWatermarkUid?.(trackedUid)
      if (resp?.errorMsg) {
        setTraceState({ status: 'error', error: resp.errorMsg })
        return
      }
      setTraceState({
        status: 'done',
        matches: Array.isArray(resp?.matches) ? resp.matches : [],
        reason: resp?.reason
      })
    } catch (e) {
      setTraceState({ status: 'error', error: e?.message || String(e) })
    }
  }

  // Tampering verdict for invisible watermarks
  // ──────────────────────────────────────────
  // There are two ways an invisible watermark fails authentication:
  //
  //   1) LOCAL — payload doesn't even carry a keyed-encrypted uid (no `v1...`
  //      ciphertext). Either someone tampered with the content, or the file
  //      predates the keyed-encoding scheme. We can decide this offline, so
  //      no server round-trip is needed.
  //
  //   2) SERVER — payload looks like a `v1...` ciphertext, but the server's
  //      AES decrypt fails (`decode_failed`). The keyed-encryption integrity
  //      check rejects fabricated/edited values, so this is a high-confidence
  //      tampering signal.
  //
  // Visible watermarks only carry an 8-char short prefix and can legitimately
  // miss for non-tampering reasons (e.g. user deleted), so they never flip
  // the tampering flag here.
  const isLocallyTampered = finding.kind === 'invisible' && !isFullTracked
  const isServerTampered =
    finding.kind === 'invisible' &&
    isFullTracked &&
    traceState.status === 'done' &&
    traceState.matches?.length === 0 &&
    traceState.reason === 'decode_failed'
  const isTampered = isLocallyTampered || isServerTampered

  // Auto-verify on mount when, and ONLY when, we have a `v1` ciphertext to
  // verify. Local tampering needs no server call; visible watermarks stay
  // manual to avoid false alarms.
  useEffect(() => {
    if (finding.kind === 'invisible' && isFullTracked && traceState.status === 'idle') {
      void runTrace()
    }
    // We deliberately fire this only once per mount; deps reflect that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bubble tampering state up so the page header can show one consolidated
  // warning even when multiple findings are flagged. `onTamperedChange` is
  // memoized in the parent (useCallback), so this effect only fires when the
  // tampering verdict actually flips.
  useEffect(() => {
    if (typeof onTamperedChange === 'function') {
      onTamperedChange(index, isTampered)
    }
  }, [isTampered, index, onTamperedChange])

  // Card framing: tampering takes precedence over the kind colouring so users
  // notice immediately.
  let containerClass
  if (isTampered) {
    containerClass = 'border-red-300 bg-red-50/60'
  } else if (isVisible) {
    containerClass = 'border-emerald-200 bg-emerald-50/40'
  } else {
    containerClass = 'border-purple-200 bg-purple-50/40'
  }

  return (
    <div className={`rounded-lg p-3 border ${containerClass}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Chip
          value={isVisible ? '可視' : '不可視'}
          size="sm"
          color={isVisible ? 'green' : 'purple'}
        />
        <MethodBadge method={finding.method} />
        {isTampered && (
          <Chip
            value="已被竄改"
            size="sm"
            color="red"
            icon={<ShieldExclamationIcon className="size-3.5" />}
          />
        )}
      </div>

      {finding.reason && (
        <Typography variant="small" color="gray" className="mt-2">
          {finding.reason}
        </Typography>
      )}

      {isTampered && (
        <div className="mt-2 rounded-md border border-red-300 bg-red-100/70 p-2 flex flex-row items-start gap-2">
          <ShieldExclamationIcon className="size-5 text-red-700 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <Typography variant="small" className="font-bold text-red-800">
              浮水印內容遭到竄改
            </Typography>
            <Typography variant="small" className="text-red-700">
              {isLocallyTampered
                ? '此不可視浮水印未帶有伺服器加密的 uid（缺少 v1 密文格式），代表內容已被改寫，或並非本系統嵌入的版本。'
                : '嵌入的 v1 密文無法以伺服器密鑰解密 — 表示浮水印已遭竄改、或並非本系統嵌入的版本。'}
              <span className="font-bold"> 不可據此判定來源使用者。</span>
            </Typography>
          </div>
        </div>
      )}

      {finding.payload && (
        <div className="mt-2 flex flex-col gap-1">
          <Typography variant="small" color="gray">浮水印內容（Payload）：</Typography>
          <div className="relative bg-blue-gray-50 rounded-lg p-3 pr-12 break-all">
            <Typography variant="small" className="font-mono text-blue-gray-800">
              {finding.payload}
            </Typography>
            <button
              onClick={() => onCopy(finding.payload)}
              className="absolute top-2 right-2 p-1.5 rounded hover:bg-blue-gray-200 transition-colors"
              title="複製"
            >
              <ClipboardDocumentIcon className="size-4 text-blue-gray-600" />
            </button>
          </div>
        </div>
      )}

      {/* Trace UI — hidden for locally-tampered invisible findings, because
          looking up a non-encrypted "uid" prefix would only be misleading. */}
      {trackedUid && !isLocallyTampered && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-row items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outlined"
              color="blue-gray"
              className="flex flex-row items-center gap-1"
              onClick={runTrace}
              disabled={traceState.status === 'loading'}
            >
              {traceState.status === 'loading' ? (
                <>
                  <Spinner className="size-3.5" />
                  查詢中…
                </>
              ) : (
                <>
                  <UserIcon className="size-3.5" />
                  {traceState.status === 'done' ? '重新查詢' : '查詢來源使用者'}
                </>
              )}
            </Button>
            <Typography variant="small" color="gray">
              {isFullTracked
                ? '（完整不可視 ID — 載入時自動以伺服器密鑰驗證並解密）'
                : '（短前綴 — 伺服器將比對所有使用者）'}
            </Typography>
          </div>

          {traceState.status === 'error' && (
            <Typography variant="small" color="red">
              查詢失敗：{traceState.error}
            </Typography>
          )}

          {/* "no match" messaging: distinguish sub-cases. Server-tampered is
              handled by the dedicated red banner above, so we skip it here. */}
          {traceState.status === 'done' && traceState.matches?.length === 0 && !isTampered && (
            <Typography variant="small" color="amber">
              ⚠ 無對應使用者
              {!traceState.reason && isFullTracked && '（解密成功但對應使用者已不在系統中）'}
              {!traceState.reason && !isFullTracked && '（前綴未對應到任何使用者，可視浮水印可能被改寫，或該使用者已刪除）'}
              。
            </Typography>
          )}

          {traceState.status === 'done' && traceState.matches?.length > 0 && (
            <div className="bg-white rounded-md border border-blue-gray-200 p-2">
              <Typography variant="small" className="font-bold text-blue-gray-800 mb-1">
                {traceState.matches.length === 1
                  ? '解密後的來源使用者：'
                  : `解密後比對到 ${traceState.matches.length} 位可能的使用者：`}
              </Typography>
              {traceState.matches.map((u) => (
                <div key={u.id} className="text-xs flex flex-col py-0.5 border-t border-blue-gray-50 first:border-t-0">
                  <span className="font-mono text-blue-gray-800">{u.name || '(未知)'} &lt;{u.email || '—'}&gt;</span>
                  <span className="font-mono text-blue-gray-400 text-[10px]">id: {u.id}</span>
                  <DownloadLogList userId={u.id} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Download audit trail of a traced user (admin only; the server enforces it).
 * Turns "who" into "who downloaded what, and when" for the forensic chain.
 */
function DownloadLogList({ userId }) {
  const [state, setState] = useState({ status: 'loading', logs: [] })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.electronAPI.adminUserDownloadLogs?.({ userId })
        if (cancelled) return
        if (!res?.ok) {
          setState({ status: 'error', error: res?.error || '未知錯誤', logs: [] })
          return
        }
        setState({ status: 'done', logs: res.logs })
      } catch (e) {
        if (!cancelled) setState({ status: 'error', error: e?.message || String(e), logs: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  if (state.status === 'loading') {
    return (
      <span className="mt-1 flex items-center gap-1 text-blue-gray-400">
        <Spinner className="size-3" /> 載入下載紀錄…
      </span>
    )
  }
  if (state.status === 'error') {
    return <span className="mt-1 text-red-600">下載紀錄查詢失敗：{state.error}</span>
  }
  if (state.logs.length === 0) {
    return <span className="mt-1 text-blue-gray-400">此使用者沒有下載紀錄</span>
  }
  return (
    <div className="mt-1 rounded border border-blue-gray-100 bg-blue-gray-50/60 p-2">
      <span className="font-bold text-blue-gray-700">下載紀錄（最近 {state.logs.length} 筆）：</span>
      <table className="mt-1 w-full text-left text-[11px]">
        <thead>
          <tr className="text-blue-gray-500">
            <th className="pr-2 font-medium">時間</th>
            <th className="pr-2 font-medium">檔案</th>
            <th className="pr-2 font-medium">模式</th>
            <th className="font-medium">浮水印</th>
          </tr>
        </thead>
        <tbody>
          {state.logs.map((l) => (
            <tr key={l.id} className="border-t border-blue-gray-100">
              <td className="pr-2 py-0.5 whitespace-nowrap">{formatLogTime(l.timestamp)}</td>
              <td className="pr-2 py-0.5 break-all">{l.fileName || `(已刪除) ${l.fileId}`}</td>
              <td className="pr-2 py-0.5">{l.mode}</td>
              <td className="py-0.5">
                {[l.watermarkVisible && '可視', l.watermarkInvisible && '不可視']
                  .filter(Boolean)
                  .join('＋') || '無'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatLogTime(value) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-TW', { hour12: false })
}

function MethodBadge({ method }) {
  const config = {
    'pdf-invisible-text': { label: 'PDF 不可視文字', color: 'purple' },
    'pdf-visible-text': { label: 'PDF 可視文字', color: 'green' },
    'pdf-metadata': { label: 'PDF 中繼資料', color: 'purple' },
    'image-metadata': { label: '圖片中繼資料', color: 'purple' },
    'lsb-r-channel': { label: 'LSB R 通道隱寫', color: 'teal' },
    'docx-custom-property': { label: 'DOCX 自訂屬性', color: 'indigo' },
    'docx-body-text': { label: 'DOCX 文件文字', color: 'blue-gray' },
    'txt-visible-marker': { label: 'TXT 可視標記', color: 'green' },
    'txt-zwc-steganography': { label: 'TXT 零寬字元', color: 'cyan' },
    unsupported: { label: '不支援', color: 'red' },
    error: { label: '錯誤', color: 'red' }
  }
  const { label, color } = config[method] || { label: method, color: 'gray' }
  return <Chip value={label} size="sm" color={color} />
}

export default WatermarkDetectPage
