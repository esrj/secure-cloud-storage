/**
 * Merge into your main preload object before contextBridge.exposeInMainWorld('electronAPI', api).
 *
 * import { mergeClassifierApisIntoElectronApi } from './classifierPreloadMerge.js'
 * mergeClassifierApisIntoElectronApi(api)
 * contextBridge.exposeInMainWorld('electronAPI', api)
 */
import { ipcRenderer } from 'electron'

/**
 * @param {Record<string, unknown>} electronApi
 */
export function mergeClassifierApisIntoElectronApi(electronApi) {
  electronApi.classifierSetEnabled = (enabled) => ipcRenderer.invoke('classifier:set-enabled', enabled)
  electronApi.subscribeClassifierLlmProgress = (cb) => {
    if (typeof cb !== 'function') return () => {}
    const fn = (_, p) => cb(p)
    ipcRenderer.on('classifier-llm-progress', fn)
    return () => ipcRenderer.removeListener('classifier-llm-progress', fn)
  }

  electronApi.classifyDocuments = (input) => ipcRenderer.invoke('classify-documents', input)
  electronApi.preuploadClassifyGetSnapshot = (batchKey) =>
    ipcRenderer.invoke('preupload-classify-snapshot', batchKey)
  electronApi.preuploadClassifyClear = (batchKey) =>
    ipcRenderer.invoke('preupload-classify-clear', batchKey)
  electronApi.startUploadFromFileList = (folderId) =>
    ipcRenderer.invoke('file-manager:start-upload', folderId)
  electronApi.requestFileList = (folderId) =>
    ipcRenderer.invoke('file-manager:refresh-list', folderId)
  electronApi.onFileListRes = (cb) => {
    if (typeof cb !== 'function') return () => {}
    const fn = (_, p) => cb(p)
    ipcRenderer.on('file-list-res', fn)
    return () => ipcRenderer.removeListener('file-list-res', fn)
  }
  electronApi.setUploadBatchSmartClassify = (wanted) =>
    ipcRenderer.invoke('classifier:set-upload-batch-smart-classify', wanted)
  electronApi.getUploadBatchSmartClassify = () =>
    ipcRenderer.invoke('classifier:get-upload-batch-smart-classify')
  electronApi.askBatchUpdateFileDescPerm = (payload) =>
    ipcRenderer.invoke('ask-batch-update-file-desc-perm', payload)

  electronApi.onUploadBatchDone = (cb) => {
    if (typeof cb !== 'function') return () => {}
    const fn = (_, p) => cb(p)
    ipcRenderer.on('upload-batch-done', fn)
    return () => ipcRenderer.removeListener('upload-batch-done', fn)
  }

  electronApi.onPreuploadClassifyStatus = (cb) => {
    if (typeof cb !== 'function') return () => {}
    const fn = (_, p) => cb(p)
    ipcRenderer.on('preupload-classify-status', fn)
    return () => ipcRenderer.removeListener('preupload-classify-status', fn)
  }

  return electronApi
}
