/**
 * Output path for one file of a batch download.
 *
 * The file name comes from the server (`meta.name`), i.e. from whoever
 * uploaded or shared the file, so it is untrusted: a name such as
 * `../../evil.txt` must never leave the folder the user picked. The single
 * download flow is not affected because the OS save dialog shows the user the
 * final path.
 *
 * No Electron imports here so the module can be unit-tested with `node --test`
 * (see test/download/batchOutputPath.test.mjs).
 */
import { basename, extname, join, resolve, sep, win32 } from 'node:path'
import { existsSync } from 'node:fs'

export const FALLBACK_FILE_NAME = 'download'

/**
 * Keep only the last path segment of an untrusted file name.
 *
 * `path.win32.basename` treats both `/` and `\` as separators and drops a
 * drive prefix (`C:`), which is what we want on every platform: a Windows
 * client must not accept `..\..\x` either, and a Mac client must not write
 * `C:\x` literally when the file is later copied to Windows.
 *
 * @param {unknown} name
 * @param {string} [fallback]  used when nothing usable is left ('', '.', '..')
 * @returns {string}
 */
export function safeFileName(name, fallback = FALLBACK_FILE_NAME) {
  const safe = win32.basename(String(name ?? ''))
  if (safe === '' || safe === '.' || safe === '..') return fallback
  return safe
}

/**
 * Walk `destDir/name`, `destDir/name (2)`, `destDir/name (3)`, … until we find
 * a non-existent path. `exists` is injectable for tests; existsSync is
 * best-effort against parallel batches, which is fine for the single-window
 * assumption of v1.
 *
 * @param {string} destDir   folder the user picked (absolute)
 * @param {string} name      server-supplied file name (untrusted)
 * @param {{ exists?: (p: string) => boolean }} [deps]
 * @returns {string} absolute path strictly inside `destDir`
 */
export function resolveUniquePath(destDir, name, { exists = existsSync } = {}) {
  const safe = safeFileName(name)
  const root = resolve(destDir)
  const prefix = root.endsWith(sep) ? root : root + sep

  const candidate = join(root, safe)
  // Belt and braces: safeFileName() already removed every separator, so this
  // can only fail if that function regresses.
  if (!resolve(candidate).startsWith(prefix)) {
    throw new Error(`Refusing to write outside the destination folder: ${String(name)}`)
  }
  if (!exists(candidate)) return candidate

  const ext = extname(safe)
  const stem = basename(safe, ext)
  for (let n = 2; n < 10_000; n++) {
    const p = join(root, `${stem} (${n})${ext}`)
    if (!exists(p)) return p
  }
  // Astronomically unlikely fallback — append timestamp
  return join(root, `${stem}-${Date.now()}${ext}`)
}
