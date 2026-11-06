/**
 * Windows only: the "get the model" dialog shown when smart classify is
 * switched on but no usable model is installed (fix plan §4.2.1).
 *
 * Open it with: window.dispatchEvent(new CustomEvent(OPEN_MODEL_SETUP_EVENT))
 *
 * Mounted once in MainView. On macOS (no window.electronAPI.classifierModel)
 * the host renders nothing and registers no listeners.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogHeader, DialogBody } from '@material-tailwind/react'
import toast from 'react-hot-toast'
import ModelSetupPanel from './ModelSetupPanel'
import { readSmartClassifyMode, writeSmartClassifyMode } from '../lib/smartClassifyPrefs'

export const OPEN_MODEL_SETUP_EVENT = 'scs-open-model-setup'

function enableSmartClassify() {
  writeSmartClassifyMode('fast')
  void window.electronAPI?.setUploadBatchSmartClassify?.('fast')
}

function ModelSetupDialog() {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  openRef.current = open

  // The model turned out to be ready while the dialog is open: finish the "turn on" flow.
  const handleReady = useCallback(() => {
    enableSmartClassify()
    setOpen(false)
    toast.success('智慧分類模型已就緒，智慧標籤已開啟。', { id: 'model-ready' })
  }, [])

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_MODEL_SETUP_EVENT, show)
    // A finished download / import is announced here even when the dialog was
    // sent to the background. Only an open dialog switches smart classify on:
    // the user is still in the "turn it on" flow then.
    const unsub = window.electronAPI?.subscribeClassifierLlmProgress?.((p) => {
      if (p?.phase !== 'model-job' || p.state !== 'done') return
      if (openRef.current) {
        enableSmartClassify()
        setOpen(false)
        toast.success('智慧分類模型已就緒，智慧標籤已開啟。', { id: 'model-ready' })
      } else if (readSmartClassifyMode() === 'off') {
        toast.success('智慧分類模型已就緒，可以在檔案列表開啟「智慧標籤」了。', {
          id: 'model-ready'
        })
      } else {
        toast.success('智慧分類模型已就緒。', { id: 'model-ready' })
      }
    })
    return () => {
      window.removeEventListener(OPEN_MODEL_SETUP_EVENT, show)
      unsub?.()
    }
  }, [])

  return (
    <Dialog open={open} handler={() => setOpen(false)} size="md">
      <DialogHeader>啟用智慧分類：取得模型</DialogHeader>
      <DialogBody className="pt-0">
        {open && (
          <ModelSetupPanel
            onReady={handleReady}
            onLater={() => setOpen(false)}
            onHide={() => {
              setOpen(false)
              toast('模型會在背景繼續下載，完成時會通知你。', { id: 'model-background' })
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  )
}

/** Renders nothing unless the Windows model manager API exists (never on macOS). */
export default function ModelSetupDialogHost() {
  if (!window.electronAPI?.classifierModel) return null
  return <ModelSetupDialog />
}
