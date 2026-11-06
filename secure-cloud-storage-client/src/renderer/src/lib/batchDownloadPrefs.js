/**
 * Persistent (localStorage) preferences for batch download.
 * Currently only stores the last destination directory the user picked,
 * so the BatchDownloadDialog can default to it next time.
 */
const KEY_DEST_DIR = 'scs.batchDownload.destDir'

export function readLastBatchDestDir() {
  try {
    return localStorage.getItem(KEY_DEST_DIR) || ''
  } catch {
    return ''
  }
}

export function writeLastBatchDestDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return
  try {
    localStorage.setItem(KEY_DEST_DIR, dir)
  } catch {
    // ignore quota / private-mode failures
  }
}
