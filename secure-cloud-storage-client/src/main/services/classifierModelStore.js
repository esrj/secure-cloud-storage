/**
 * Model file operations for the Windows model manager: state check, download
 * with resume, offline import and SHA-256 verification.
 *
 * Node built-ins only (no Electron), so it can be tested on its own; the HTTP
 * client and the free-space probe are injected.
 *
 * Safety rules (Windows smart-classify fix plan §4.2):
 *   - New bytes only ever go to a temporary file next to the model. The model
 *     file is replaced by a rename, and only after the SHA-256 matches the
 *     pinned value, so a cancel, a full disk, a bad hash or a broken source
 *     never overwrites or deletes a usable model.
 *   - A download keeps its `.part` file on cancel or network failure and
 *     resumes from it with an HTTP Range request. A `.part` that fails the
 *     hash check is deleted (resuming it could never succeed).
 *   - Only the model URL is requested; no document content, classification
 *     snippet or other metadata is sent.
 *   - After a successful check, `<model>.verified.json` records the hash,
 *     size and mtime. Startup trusts the file only while size and mtime still
 *     match, so the 5 GB file is not re-hashed on every launch.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { mkdir, open, realpath, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'

export const STORE_ERROR = Object.freeze({
  CANCELLED: 'CANCELLED',
  INSUFFICIENT_SPACE: 'INSUFFICIENT_SPACE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  NAME_MISMATCH: 'NAME_MISMATCH',
  NOT_A_FILE: 'NOT_A_FILE',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  HASH_MISMATCH: 'HASH_MISMATCH',
  REPLACE_FAILED: 'REPLACE_FAILED',
  IO_ERROR: 'IO_ERROR'
})

export class ModelStoreError extends Error {
  /**
   * @param {string} code one of STORE_ERROR
   * @param {string} message
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [opts]
   */
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ModelStoreError'
    this.code = code
    this.details = details ?? {}
  }
}

/** Room left on the disk after the model is in place. */
export const DISK_MARGIN_BYTES = 256 * 1024 * 1024

const READ_CHUNK_BYTES = 4 * 1024 * 1024

/** @typedef {{ filename: string, size: number, sha256: string, revision?: string }} ExpectedModel */
/** @typedef {(p: { step: 'resume-check' | 'download' | 'copy' | 'verify', received: number, total: number }) => void} OnProgress */

export const partPathFor = (finalPath) => `${finalPath}.part`
export const importPartPathFor = (finalPath) => `${finalPath}.import.part`
export const markerPathFor = (finalPath) => `${finalPath}.verified.json`

/**
 * Synchronous state of the managed model file (cheap: two stats and a small JSON read).
 * @param {string} finalPath
 * @param {ExpectedModel} expected
 * @param {{ statSync: typeof statSync, readFileSync: typeof readFileSync }} [fs]
 * @returns {'missing' | 'invalid' | 'unverified' | 'ready'}
 */
export function getModelFileState(finalPath, expected, fs = { statSync, readFileSync }) {
  let st
  try {
    st = fs.statSync(finalPath)
  } catch {
    return 'missing'
  }
  if (!st.isFile() || st.size !== expected.size) return 'invalid'
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerPathFor(finalPath), 'utf8'))
  } catch {
    return 'unverified'
  }
  const sameFile =
    marker?.sha256 === expected.sha256 &&
    marker?.size === st.size &&
    typeof marker?.mtimeMs === 'number' &&
    Math.abs(marker.mtimeMs - st.mtimeMs) < 1
  return sameFile ? 'ready' : 'unverified'
}

/** Size of a file, or 0 when it does not exist. */
export async function sizeOrZero(p) {
  try {
    const st = await stat(p)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** Free bytes on the volume holding `dir`. */
export async function getFreeBytes(dir) {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ModelStoreError(STORE_ERROR.CANCELLED, 'Operation cancelled')
}

async function ensureFreeSpace(dir, neededBytes, getFree) {
  if (neededBytes <= 0) return
  const free = await getFree(dir)
  const required = neededBytes + DISK_MARGIN_BYTES
  if (free < required) {
    throw new ModelStoreError(
      STORE_ERROR.INSUFFICIENT_SPACE,
      `Not enough disk space in ${dir}: need ${required} bytes, ${free} free`,
      { details: { required, free } }
    )
  }
}

/**
 * Stream a file through `hash` (resume prefix check / in-place verification).
 * @param {import('node:crypto').Hash} hash
 * @param {string} file
 * @param {{ signal?: AbortSignal, onChunk?: (n: number) => void }} [opts]
 */
async function feedFileIntoHash(hash, file, { signal, onChunk } = {}) {
  const stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES })
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      hash.update(chunk)
      onChunk?.(chunk.length)
    }
  } finally {
    stream.destroy()
  }
}

async function writeMarker(finalPath, expected, source) {
  const st = await stat(finalPath)
  const marker = {
    sha256: expected.sha256,
    size: st.size,
    mtimeMs: st.mtimeMs,
    revision: expected.revision ?? null,
    source,
    verifiedAt: new Date().toISOString()
  }
  await writeFile(markerPathFor(finalPath), JSON.stringify(marker, null, 2))
}

/** Move a verified temp file into place, then record it as verified. */
async function commitVerified(tmpPath, finalPath, expected, source) {
  try {
    await rename(tmpPath, finalPath)
  } catch (e) {
    // e.g. EPERM/EBUSY when the old file is open on Windows. The verified temp
    // file stays, so the next attempt only re-checks it instead of re-downloading.
    throw new ModelStoreError(
      STORE_ERROR.REPLACE_FAILED,
      `Could not move ${tmpPath} to ${finalPath}: ${e.message}`,
      { cause: e }
    )
  }
  await writeMarker(finalPath, expected, source)
}

function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) }
}

/**
 * Download the model to `finalPath`, resuming from `<finalPath>.part`.
 * @param {{
 *   url: string,
 *   finalPath: string,
 *   expected: ExpectedModel,
 *   fetchImpl: (url: string, init: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<Response>,
 *   signal?: AbortSignal,
 *   onProgress?: OnProgress,
 *   getFree?: (dir: string) => Promise<number>
 * }} opts
 */
export async function downloadModel({
  url,
  finalPath,
  expected,
  fetchImpl,
  signal,
  onProgress,
  getFree = getFreeBytes
}) {
  const dir = nodePath.dirname(finalPath)
  const part = partPathFor(finalPath)
  await mkdir(dir, { recursive: true })

  let offset = await sizeOrZero(part)
  if (offset > expected.size) {
    await unlink(part)
    offset = 0
  }
  throwIfAborted(signal)
  await ensureFreeSpace(dir, expected.size - offset, getFree)

  let hash = createHash('sha256')
  if (offset > 0) {
    // Resuming: the final hash must cover the bytes already on disk.
    let done = 0
    await feedFileIntoHash(hash, part, {
      signal,
      onChunk: (n) => {
        done += n
        onProgress?.({ step: 'resume-check', received: done, total: offset })
      }
    })
  }

  if (offset < expected.size) {
    let res
    try {
      res = await fetchImpl(url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal
      })
    } catch (e) {
      if (signal?.aborted)
        throw new ModelStoreError(STORE_ERROR.CANCELLED, 'Download cancelled', { cause: e })
      throw new ModelStoreError(STORE_ERROR.NETWORK_ERROR, `Request failed: ${e.message}`, {
        cause: e
      })
    }

    if (offset > 0 && res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'))
      if (
        !range ||
        range.start !== offset ||
        (range.total != null && range.total !== expected.size)
      ) {
        await res.body?.cancel?.()
        throw new ModelStoreError(
          STORE_ERROR.HTTP_ERROR,
          `Unexpected Content-Range "${res.headers.get('content-range')}" for offset ${offset}`
        )
      }
    } else if (res.status === 200) {
      // Fresh download, or the server ignored the Range header: start over.
      const len = Number(res.headers.get('content-length'))
      if (Number.isFinite(len) && len > 0 && len !== expected.size) {
        await res.body?.cancel?.()
        throw new ModelStoreError(
          STORE_ERROR.SIZE_MISMATCH,
          `Server reports ${len} bytes, expected ${expected.size}`
        )
      }
      if (offset > 0) hash = createHash('sha256')
      offset = 0
    } else {
      await res.body?.cancel?.()
      throw new ModelStoreError(STORE_ERROR.HTTP_ERROR, `HTTP ${res.status} from model server`, {
        details: { status: res.status }
      })
    }

    const fh = await open(part, offset > 0 ? 'a' : 'w')
    let written = offset
    const reader = res.body.getReader()
    try {
      for (;;) {
        let chunk
        try {
          chunk = await reader.read()
        } catch (e) {
          if (signal?.aborted)
            throw new ModelStoreError(STORE_ERROR.CANCELLED, 'Download cancelled', { cause: e })
          throw new ModelStoreError(
            STORE_ERROR.NETWORK_ERROR,
            `Download interrupted: ${e.message}`,
            { cause: e }
          )
        }
        if (chunk.done) break
        const buf = chunk.value
        if (written + buf.length > expected.size) {
          throw new ModelStoreError(
            STORE_ERROR.SIZE_MISMATCH,
            'Server sent more data than expected'
          )
        }
        await fh.write(buf)
        hash.update(buf)
        written += buf.length
        onProgress?.({ step: 'download', received: written, total: expected.size })
        throwIfAborted(signal)
      }
    } catch (e) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw e
    } finally {
      await fh.close()
    }
  }

  const size = await sizeOrZero(part)
  if (size < expected.size) {
    // Connection closed early; keep the part file so the next attempt resumes.
    throw new ModelStoreError(
      STORE_ERROR.NETWORK_ERROR,
      `Download ended early at ${size} of ${expected.size} bytes`
    )
  }
  if (size > expected.size) {
    await unlink(part)
    throw new ModelStoreError(
      STORE_ERROR.SIZE_MISMATCH,
      `Downloaded ${size} bytes, expected ${expected.size}`
    )
  }
  const digest = hash.digest('hex')
  if (digest !== expected.sha256) {
    await unlink(part)
    throw new ModelStoreError(
      STORE_ERROR.HASH_MISMATCH,
      `SHA-256 mismatch: got ${digest}, expected ${expected.sha256}`
    )
  }
  await commitVerified(part, finalPath, expected, 'download')
}

async function isSameFile(a, b) {
  try {
    const [ra, rb] = await Promise.all([realpath(a), realpath(b)])
    return ra.toLowerCase() === rb.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Import a model file the user picked (offline install). Checks name and size
 * first, then copies to a temp file while hashing it, and moves it into place
 * only if the SHA-256 matches. Picking the file that is already in the model
 * folder just verifies it in place.
 * @param {{
 *   sourcePath: string,
 *   finalPath: string,
 *   expected: ExpectedModel,
 *   signal?: AbortSignal,
 *   onProgress?: OnProgress,
 *   getFree?: (dir: string) => Promise<number>
 * }} opts
 */
export async function importModel({
  sourcePath,
  finalPath,
  expected,
  signal,
  onProgress,
  getFree = getFreeBytes
}) {
  if (nodePath.basename(sourcePath).toLowerCase() !== expected.filename.toLowerCase()) {
    throw new ModelStoreError(
      STORE_ERROR.NAME_MISMATCH,
      `Picked "${nodePath.basename(sourcePath)}", expected "${expected.filename}"`
    )
  }
  let st
  try {
    st = await stat(sourcePath)
  } catch (e) {
    throw new ModelStoreError(STORE_ERROR.NOT_A_FILE, `Cannot read ${sourcePath}: ${e.message}`, {
      cause: e
    })
  }
  if (!st.isFile()) throw new ModelStoreError(STORE_ERROR.NOT_A_FILE, `${sourcePath} is not a file`)
  if (st.size !== expected.size) {
    throw new ModelStoreError(
      STORE_ERROR.SIZE_MISMATCH,
      `File is ${st.size} bytes, expected ${expected.size}`,
      { details: { size: st.size } }
    )
  }

  const dir = nodePath.dirname(finalPath)
  await mkdir(dir, { recursive: true })
  if (await isSameFile(sourcePath, finalPath)) {
    await verifyInPlace({ finalPath, expected, signal, onProgress, source: 'import' })
    return
  }

  throwIfAborted(signal)
  await ensureFreeSpace(dir, expected.size, getFree)

  const tmp = importPartPathFor(finalPath)
  const hash = createHash('sha256')
  const input = createReadStream(sourcePath, { highWaterMark: READ_CHUNK_BYTES })
  let fh
  let copied = 0
  try {
    fh = await open(tmp, 'w')
    for await (const chunk of input) {
      throwIfAborted(signal)
      await fh.write(chunk)
      hash.update(chunk)
      copied += chunk.length
      onProgress?.({ step: 'copy', received: copied, total: expected.size })
    }
    await fh.close()
    fh = null
  } catch (e) {
    input.destroy()
    await fh?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    if (e instanceof ModelStoreError) throw e
    throw new ModelStoreError(STORE_ERROR.IO_ERROR, `Copy failed: ${e.message}`, { cause: e })
  }

  const digest = hash.digest('hex')
  if (copied !== expected.size || digest !== expected.sha256) {
    await unlink(tmp).catch(() => {})
    throw new ModelStoreError(
      STORE_ERROR.HASH_MISMATCH,
      `SHA-256 mismatch: got ${digest}, expected ${expected.sha256}`
    )
  }
  await commitVerified(tmp, finalPath, expected, 'import')
}

/**
 * Hash a model file that is already in place (e.g. copied there by hand) and
 * record it as verified. A file that fails is left untouched.
 * @param {{ finalPath: string, expected: ExpectedModel, signal?: AbortSignal, onProgress?: OnProgress, source?: string }} opts
 */
export async function verifyInPlace({
  finalPath,
  expected,
  signal,
  onProgress,
  source = 'verify'
}) {
  const size = await sizeOrZero(finalPath)
  if (size !== expected.size) {
    throw new ModelStoreError(
      STORE_ERROR.SIZE_MISMATCH,
      `File is ${size} bytes, expected ${expected.size}`
    )
  }
  const hash = createHash('sha256')
  let done = 0
  await feedFileIntoHash(hash, finalPath, {
    signal,
    onChunk: (n) => {
      done += n
      onProgress?.({ step: 'verify', received: done, total: size })
    }
  })
  const digest = hash.digest('hex')
  if (digest !== expected.sha256) {
    throw new ModelStoreError(
      STORE_ERROR.HASH_MISMATCH,
      `SHA-256 mismatch: got ${digest}, expected ${expected.sha256}`
    )
  }
  await writeMarker(finalPath, expected, source)
}
