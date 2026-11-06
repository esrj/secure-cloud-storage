/**
 * 上傳後設定：以「智慧分類結果 → 套用或手動 → 標籤」為主；其餘權限／屬性／說明為次要區塊。
 */
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Button,
  Input,
  Textarea,
  Typography,
  Select,
  Option
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import ComboBox from './ComboBox'
import { Validators } from './Validator'
import { PermissionType } from './Types'
import toast from 'react-hot-toast'
import AnalysisSpinner from './AnalysisSpinner'

function PostUploadDialog({
  fileIds,
  sourcePaths = [],
  classificationPreview = null,
  classifyBatchKey = null,
  onClose
}) {
  const [permission, setPermission] = useState('0')
  const [selectedAttrs, setSelectedAttrs] = useState([])
  const [tags, setTags] = useState('')
  const [desc, setDesc] = useState('')
  const [loading, setLoading] = useState(false)
  const [previewOverride, setPreviewOverride] = useState(null)
  const [liveClassifyResult, setLiveClassifyResult] = useState(null)
  const [analyzeProgress, setAnalyzeProgress] = useState(null)
  const [classifyThreshold, setClassifyThreshold] = useState(0.55)
  /** apply = 套用 LM 建議到標籤欄；manual = 不套用，自行輸入 */
  const [lmTagApplication, setLmTagApplication] = useState('apply')

  const effectivePreview = useMemo(
    () => previewOverride ?? liveClassifyResult ?? classificationPreview,
    [previewOverride, liveClassifyResult, classificationPreview]
  )

  const pendingKey = classifyBatchKey || classificationPreview?.batchKey

  // V7: release the (potentially large) cached classification result as soon as
  // the dialog closes, instead of waiting for TTL/LRU eviction in main.
  function handleClose() {
    const key = classifyBatchKey || classificationPreview?.batchKey
    if (key) void window.electronAPI?.preuploadClassifyClear?.(key)
    onClose()
  }

  useEffect(() => {
    setPreviewOverride(null)
    setLiveClassifyResult(null)
    setAnalyzeProgress(null)
  }, [classificationPreview])

  useEffect(() => {
    const unsub = window.electronAPI?.subscribeClassifierLlmProgress?.((p) => {
      if (p?.phase === 'serve' && p?.message) {
        toast(p.message, { id: 'ollama-serve', duration: 4000 })
      }
      if (p?.phase === 'pull') {
        const pct = typeof p.percent === 'number' ? ` ${p.percent}%` : ''
        const line = p.message || p.status || ''
        if (line || pct.trim()) {
          toast(`模型：${line}${pct}`, { id: 'ollama-pull', duration: 6000 })
        }
      }
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (!classificationPreview?.pending || !pendingKey) return
    void window.electronAPI?.preuploadClassifyGetSnapshot?.(pendingKey).then((entry) => {
      if (entry?.state === 'done' && entry.result) setLiveClassifyResult(entry.result)
    })
  }, [classificationPreview, pendingKey])

  useEffect(() => {
    if (!pendingKey || !classificationPreview?.pending) return
    const unsub = window.electronAPI?.onPreuploadClassifyStatus?.((p) => {
      if (p?.batchKey !== pendingKey) return
      if (p?.phase === 'running') {
        if (p?.progress && typeof p.progress.done === 'number') {
          setAnalyzeProgress(p.progress)
        }
      }
      if (p?.phase === 'finished') {
        setAnalyzeProgress(null)
        if (p?.result) setLiveClassifyResult(p.result)
      }
    })
    return () => unsub?.()
  }, [pendingKey, classificationPreview?.pending])

  const isMultiple = fileIds.length > 1

  const hasLmBlock = effectivePreview != null && effectivePreview?.reason !== 'CLASSIFIER_DISABLED'
  const lmWaiting = Boolean(effectivePreview?.pending)
  const lmLabels = Array.isArray(effectivePreview?.labels) ? effectivePreview.labels : []
  const lmFinal = Array.isArray(effectivePreview?.final_labels) ? effectivePreview.final_labels : []
  const lmSucceeded =
    !lmWaiting &&
    Boolean(effectivePreview?.supported) &&
    lmLabels.length > 0 &&
    lmFinal.length > 0
  const lmFailed =
    hasLmBlock &&
    !lmWaiting &&
    !lmSucceeded &&
    effectivePreview?.reason !== 'CLASSIFIER_DISABLED'

  // V6: the smart-classify result is computed pre-upload over the originally
  // *selected* files, but tags are applied to the files that actually finished
  // uploading. If some selected files failed to upload, the (batch-wide) labels
  // were partly influenced by files that won't receive them — surface that so
  // the user can sanity-check before applying.
  const classifiedFiles = useMemo(
    () => (Array.isArray(effectivePreview?.extraction?.files) ? effectivePreview.extraction.files : []),
    [effectivePreview?.extraction]
  )
  const labelScopeMismatch = useMemo(() => {
    if (!lmSucceeded || classifiedFiles.length === 0) return null
    let notApplied
    if (Array.isArray(sourcePaths) && sourcePaths.length > 0) {
      const applied = new Set(sourcePaths)
      notApplied = classifiedFiles.filter((f) => f && !applied.has(f.path)).length
    } else {
      notApplied = Math.max(0, classifiedFiles.length - fileIds.length)
    }
    if (notApplied <= 0 && classifiedFiles.length === fileIds.length) return null
    return {
      classifiedCount: classifiedFiles.length,
      appliedCount: fileIds.length,
      notApplied
    }
  }, [lmSucceeded, classifiedFiles, sourcePaths, fileIds])

  const finalLabelsKey = useMemo(() => {
    if (!effectivePreview?.supported || !Array.isArray(effectivePreview?.final_labels)) return ''
    return JSON.stringify(effectivePreview.final_labels)
  }, [effectivePreview?.supported, effectivePreview?.final_labels])

  const prevFinalKeyRef = useRef('')
  useEffect(() => {
    if (lmTagApplication !== 'apply') return
    const fl = effectivePreview?.final_labels
    if (!effectivePreview?.supported || !Array.isArray(fl) || fl.length === 0) return
    if (finalLabelsKey === prevFinalKeyRef.current) return
    prevFinalKeyRef.current = finalLabelsKey
    setTags(fl.slice(0, 5).join(' '))
  }, [lmTagApplication, finalLabelsKey, effectivePreview?.supported, effectivePreview?.final_labels])

  useEffect(() => {
    const t = effectivePreview?.thresholdUsed
    if (typeof t === 'number' && Number.isFinite(t)) {
      setClassifyThreshold(t)
    }
  }, [effectivePreview?.thresholdUsed])

  function selectLmApplyMode() {
    setLmTagApplication('apply')
    const fl = effectivePreview?.final_labels
    if (effectivePreview?.supported && Array.isArray(fl) && fl.length > 0) {
      setTags(fl.slice(0, 5).join(' '))
    }
  }

  function selectLmManualMode() {
    setLmTagApplication('manual')
    setTags('')
  }

  async function handleConfirm() {
    const tagsResult = Validators.tags(tags)
    if (!tagsResult.valid) {
      toast.error(tagsResult.message)
      return
    }
    const descResult = Validators.fileDescription(desc)
    if (!descResult.valid) {
      toast.error(descResult.message)
      return
    }

    setLoading(true)
    try {
      const tagList = String(tags)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5)

      const { succeeded, failed } = await window.electronAPI.askBatchUpdateFileDescPerm({
        fileIds,
        desc: desc.trim(),
        perm: parseInt(permission, 10),
        selectedAttrs,
        tags: tagList
      })

      if (failed.length > 0) {
        toast.error(`${failed.length} 個檔案設定失敗`)
      }
      if (succeeded.length > 0) {
        toast.success(`${succeeded.length} 個檔案已寫入中繼資料（含標籤）`)
      }
    } catch (error) {
      toast.error(`設定失敗：${error.message}`)
    } finally {
      setLoading(false)
      handleClose()
    }
  }

  async function handleRetryClassify() {
    if (!sourcePaths.length) {
      toast.error('沒有可用的本機路徑，無法重試')
      return
    }
    try {
      toast('重新執行智慧分類…', { id: 'reclassify' })
      const classifyRes = await window.electronAPI.classifyDocuments({
        enable: true,
        paths: sourcePaths,
        threshold: classifyThreshold
      })
      if (classifyRes?.reason === 'DISABLED') {
        toast.error('智慧分類未啟用，請在設定中開啟')
      } else if (
        classifyRes?.supported &&
        Array.isArray(classifyRes?.labels) &&
        classifyRes.labels.length > 0 &&
        Array.isArray(classifyRes?.final_labels)
      ) {
        setPreviewOverride(classifyRes)
        if (lmTagApplication === 'apply') {
          setTags(classifyRes.final_labels.slice(0, 5).join(' '))
        }
        toast.success('已重新取得分類結果')
      } else {
        toast.error(classifyRes?.reason || classifyRes?.llmError || '分類失敗')
      }
    } catch (e) {
      toast.error(`重試失敗：${e.message}`)
    }
  }

  const showLmFlow = hasLmBlock && (lmWaiting || lmSucceeded || lmFailed)
  const showLmTagChoice = hasLmBlock && (lmWaiting || lmSucceeded)

  return (
    <Dialog
      open={true}
      handler={() => {
        if (!loading) handleClose()
      }}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>上傳後設定</DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <Typography variant="small" className="text-blue-gray-600">
          {isMultiple
            ? `本批共 ${fileIds.length} 個檔案。請確認智慧分類建議與標籤；按下「確認」後會寫入伺服器與本機索引。`
            : '請確認智慧分類建議與標籤；按下「確認」後會寫入伺服器與本機索引。'}
        </Typography>

        {!hasLmBlock && (
          <Typography variant="small" color="gray" className="rounded-lg bg-blue-gray-50 px-3 py-2 text-xs">
            本次上傳未開啟檔案列表的「智慧分類」，未執行 LM。請在檔案列表頁先開啟後再選檔上傳。
          </Typography>
        )}

        {effectivePreview?.reason === 'CLASSIFIER_DISABLED' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <Typography variant="small" className="font-semibold text-amber-900">
              未執行智慧分類
            </Typography>
            <Typography variant="small" className="text-xs text-amber-800">
              檔案列表已開啟智慧分類，但設定中的主開關為關閉。請至設定開啟後再試。
            </Typography>
          </div>
        )}

        {/* —— 智慧分類結果（此頁核心） —— */}
        {showLmFlow && (
          <section className="rounded-xl border-2 border-blue-gray-200 bg-blue-gray-50/50 p-4">
            <Typography variant="h6" className="mb-3 text-blue-gray-900">
              智慧分類推測標籤
            </Typography>

            {lmWaiting && (
              <div className="flex flex-row items-start gap-3">
                <AnalysisSpinner className="mt-0.5" />
                <div>
                  <Typography variant="small" className="font-semibold text-blue-gray-900">
                    正在分析…
                  </Typography>
                  <Typography variant="small" className="mt-1 text-xs text-blue-gray-700">
                    預測與上傳並行進行，請稍候。完成後會自動顯示推測標籤。
                  </Typography>
                  {analyzeProgress != null && analyzeProgress.total > 0 && (
                    <Typography variant="small" className="mt-2 text-xs font-medium text-blue-800">
                      進度：{analyzeProgress.done} / {analyzeProgress.total} 段推論
                    </Typography>
                  )}
                </div>
              </div>
            )}

            {lmSucceeded && (
              <div className="flex flex-col gap-3">
                <Typography variant="small" className="text-blue-gray-800">
                  以下為本批檔案共用的推測標籤（已做多段／多檔平衡）：
                </Typography>
                <div className="flex flex-wrap gap-2">
                  {lmFinal.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-blue-200 bg-white px-3 py-1.5 text-sm font-semibold text-blue-gray-900 shadow-sm"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                {typeof effectivePreview.thresholdUsed === 'number' && (
                  <Typography variant="small" className="text-xs text-blue-gray-600">
                    決策門檻 threshold = {effectivePreview.thresholdUsed}
                  </Typography>
                )}
                {isMultiple && (
                  <div className="rounded-lg border border-blue-gray-100 bg-white px-3 py-2">
                    <Typography variant="small" className="text-xs text-blue-gray-700">
                      提醒：智慧分類對「整批」產生同一組標籤，並會套用到本批所有檔案。
                      若本批檔案主題差異較大，建議改選「不套用」並逐一設定標籤，以免標籤交叉汙染。
                    </Typography>
                  </div>
                )}
                {labelScopeMismatch && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <Typography variant="small" className="font-semibold text-amber-900">
                      標籤依據與套用範圍不一致
                    </Typography>
                    <Typography variant="small" className="text-xs text-amber-800">
                      本組標籤是依「選取時的 {labelScopeMismatch.classifiedCount} 個檔案」推得，
                      但本次實際成功上傳 {labelScopeMismatch.appliedCount} 個
                      {labelScopeMismatch.notApplied > 0
                        ? `（其中 ${labelScopeMismatch.notApplied} 個分類依據的檔案未成功上傳）`
                        : ''}
                      。標籤為整批共用，套用前請再確認是否符合這些檔案。
                    </Typography>
                  </div>
                )}
                <details className="rounded-lg border border-blue-gray-200 bg-white text-xs text-blue-gray-800">
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium text-blue-gray-900">
                    查看各標籤分數與原文依據
                  </summary>
                  <div className="max-h-40 overflow-auto border-t border-blue-gray-100 px-2 py-2">
                    <table className="w-full border-collapse text-left">
                      <thead>
                        <tr className="border-b border-blue-gray-100">
                          <th className="px-2 py-1">標籤</th>
                          <th className="px-2 py-1">分數</th>
                          <th className="px-2 py-1">依據</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lmLabels.map((l) => (
                          <tr key={l.name} className="border-b border-blue-gray-50 align-top">
                            <td className="px-2 py-1">{l.name}</td>
                            <td className="px-2 py-1 tabular-nums">{l.score}</td>
                            <td className="px-2 py-1">
                              {(Array.isArray(l.evidence) ? l.evidence : []).join('；') || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}

            {lmFailed && (
              <div className="flex flex-col gap-2">
                <Typography variant="small" className="font-semibold text-red-900">
                  分析失敗：{effectivePreview?.reason || 'UNKNOWN'}
                </Typography>
                {effectivePreview?.llmError && (
                  <Typography variant="small" className="text-xs text-red-800">
                    {effectivePreview.llmError}
                  </Typography>
                )}
                {effectivePreview?.llmRawText && effectivePreview?.reason === 'JSON_PARSE_FAILED' && (
                  <Typography
                    variant="small"
                    className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-red-900/90"
                  >
                    {String(effectivePreview.llmRawText)}
                  </Typography>
                )}
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Select
                    value={String(classifyThreshold)}
                    onChange={(v) => setClassifyThreshold(parseFloat(String(v)))}
                    label="重試門檻"
                    labelProps={{ className: 'peer-focus:hidden' }}
                    className="min-w-[8rem] focus:!border-t-gray-900"
                  >
                    {['0.35', '0.45', '0.55', '0.65', '0.75'].map((v) => (
                      <Option key={v} value={v}>
                        {v}
                      </Option>
                    ))}
                  </Select>
                  <Button size="sm" variant="outlined" color="red" onClick={() => void handleRetryClassify()}>
                    重試分類
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* 套用 / 不套用 → 標籤輸入框 */}
        {showLmTagChoice && (
          <section className="flex flex-col gap-3">
            <Typography variant="small" className="font-semibold text-blue-gray-900">
              標籤要如何使用？
            </Typography>
            <div className="flex flex-col gap-3 rounded-lg border border-blue-gray-100 bg-white px-3 py-3 text-sm text-blue-gray-800">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="lm-tag-mode"
                  className="mt-1"
                  checked={lmTagApplication === 'apply'}
                  onChange={() => selectLmApplyMode()}
                />
                <span>
                  <strong>套用智慧分類</strong>：把上方推測標籤填入下方「標籤」欄（可再修改）。按確認後會寫入每個檔案的標籤中繼資料。
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="lm-tag-mode"
                  className="mt-1"
                  checked={lmTagApplication === 'manual'}
                  onChange={() => selectLmManualMode()}
                />
                <span>
                  <strong>不套用</strong>：標籤欄留空或由您自行輸入；行為與未開智慧分類時相同。
                </span>
              </label>
            </div>
            <div>
              <Typography variant="small" className="mb-1 font-semibold text-blue-gray-900">
                標籤（將寫入中繼資料）
              </Typography>
              <Input
                label="最多五個，以空格隔開"
                labelProps={{ className: 'font-sans peer-focus:hidden' }}
                value={tags}
                onChange={(e) => {
                  if ((e.target.value.match(/ /g) || []).length < 5)
                    setTags(e.target.value.replaceAll(/\s+/g, ' '))
                }}
                error={!Validators.tags(tags).valid}
                size="lg"
                className="grow rounded-none focus:!border-t-gray-900"
              />
            </div>
          </section>
        )}

        {/* 未進入「套用／手動」流程時（含未開智慧分類、主開關關閉、或 LM 失敗）仍顯示標籤欄 */}
        {!showLmTagChoice && (
          <div>
            <Typography variant="small" className="mb-1 font-semibold text-blue-gray-900">
              標籤
            </Typography>
            <Input
              label="最多五個，以空格隔開"
              labelProps={{ className: 'font-sans peer-focus:hidden' }}
              value={tags}
              onChange={(e) => {
                if ((e.target.value.match(/ /g) || []).length < 5)
                  setTags(e.target.value.replaceAll(/\s+/g, ' '))
              }}
              error={!Validators.tags(tags).valid}
              size="lg"
              className="grow rounded-none focus:!border-t-gray-900"
            />
          </div>
        )}

        <section className="border-t border-blue-gray-100 pt-4">
          <Typography variant="small" className="mb-3 font-semibold text-blue-gray-700">
            其他設定
          </Typography>
          <div className="flex flex-col gap-4">
            <div>
              <Typography variant="small" className="mb-1 text-blue-gray-800">
                權限
              </Typography>
              <Select
                value={String(permission)}
                onChange={(value) => setPermission(value)}
                labelProps={{ className: 'peer-focus:hidden' }}
                className="focus:!border-t-gray-900"
              >
                {Object.keys(PermissionType).map((key) => (
                  <Option key={key} value={String(key)}>
                    {PermissionType[key]}
                  </Option>
                ))}
              </Select>
            </div>
            <div>
              <Typography variant="small" className="mb-1 text-blue-gray-800">
                屬性
              </Typography>
              <ComboBox selectedAttrs={selectedAttrs} setSelectedAttrs={setSelectedAttrs} />
            </div>
            <div>
              <Typography variant="small" className="mb-1 text-blue-gray-800">
                檔案說明
              </Typography>
              <Textarea
                label="（選填）"
                labelProps={{ className: 'peer-focus:hidden' }}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                error={!Validators.fileDescription(desc).valid}
                className="focus:!border-t-gray-900"
              />
            </div>
          </div>
        </section>
      </DialogBody>

      <DialogFooter>
        <Button variant="text" color="red" onClick={handleClose} disabled={loading} className="mr-2">
          略過
        </Button>
        <Button variant="gradient" color="black" onClick={handleConfirm} disabled={loading}>
          {loading ? '寫入中…' : isMultiple ? '確認並套用至全部' : '確認'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

PostUploadDialog.propTypes = {
  fileIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  sourcePaths: PropTypes.arrayOf(PropTypes.string),
  classificationPreview: PropTypes.object,
  classifyBatchKey: PropTypes.string,
  onClose: PropTypes.func.isRequired
}

export default PostUploadDialog
