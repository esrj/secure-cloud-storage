/**
 * Extract plain text from local files (main process). No LLM.
 *
 * Supported: .txt / .text / .md, .pdf, .docx
 *
 * PDF uses createRequire to load pdf-parse as a CJS module, bypassing
 * Rollup ESM→CJS interop issues with dynamic import().
 * pdfjs-dist is used as a fallback with its bundled worker.
 *
 * @typedef {{ path: string, text: string }} ExtractedTextEntry
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { createRequire } from 'node:module'
import mammoth from 'mammoth'
import { logger } from '../Logger.js'

const REASON_UNSUPPORTED = 'FORMAT_NOT_SUPPORTED_OR_EMPTY'

// ── Resource guards (V9) ──────────────────────────────────────────────────
// Extraction runs on the MAIN process. A huge file or a malformed PDF could
// otherwise read 100MB+ into memory, run multi-MB regex passes, or hang
// pdf-parse/pdfjs/mammoth indefinitely — freezing the UI and the IPC bridge.
// These bounds keep extraction cheap and non-blocking; classification only
// needs a head+tail snippet anyway, so we never need the whole file.

/** Skip files larger than this (classification doesn't need giant files). */
const MAX_EXTRACT_BYTES = 30 * 1024 * 1024

/** Per-file extraction wall-clock timeout. On timeout we fall back to filename-only. */
const EXTRACT_TIMEOUT_MS = 20_000

/**
 * Cap the raw extracted text BEFORE cleaning, taking head + tail. Downstream
 * classification only condenses to ~1.8k chars head+tail, so 200k is plenty
 * and keeps cleanExtractedText's regex/​split passes bounded regardless of the
 * source file size.
 */
const MAX_RAW_TEXT_CHARS = 200_000

/**
 * Race a promise against a timeout. On timeout the underlying work is left to
 * settle on its own (we can't cancel pdf-parse mid-flight), but we stop waiting.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Head+tail clamp of raw text so cleaning stays cheap on very large inputs.
 * @param {string} raw
 * @returns {string}
 */
function clampRawHeadTail(raw) {
  if (typeof raw !== 'string' || raw.length <= MAX_RAW_TEXT_CHARS) return raw
  const half = Math.floor(MAX_RAW_TEXT_CHARS / 2)
  return raw.slice(0, half) + '\n…\n' + raw.slice(-half)
}

// ── CJS require helper ────────────────────────────────────────────────────────
// electron-vite compiles main process code to CJS, so __filename is available.
// createRequire(__filename) lets us load CJS modules without ESM interop issues.
let _cjsRequire = null
try {
  // __filename is injected by electron-vite's CJS build
  // eslint-disable-next-line no-undef
  const base = typeof __filename !== 'undefined' ? __filename : import.meta.url
  _cjsRequire = createRequire(base)
} catch (e) {
  logger.warn(`[TextExtract] createRequire setup failed: ${e.message}`)
}

// ── pdf-parse singleton ───────────────────────────────────────────────────────
let _pdfParse = null
async function getPdfParse() {
  if (_pdfParse) return _pdfParse

  // Method 1: createRequire — most reliable for CJS modules in electron-vite
  if (_cjsRequire) {
    try {
      const mod = _cjsRequire('pdf-parse')
      const fn = typeof mod === 'function' ? mod : mod?.default
      if (typeof fn === 'function') {
        _pdfParse = fn
        logger.debug('[TextExtract] pdf-parse loaded via createRequire')
        return _pdfParse
      }
      logger.warn(`[TextExtract] pdf-parse via createRequire: unexpected type=${typeof mod}`)
    } catch (e) {
      logger.warn(`[TextExtract] pdf-parse createRequire failed: ${e.message}`)
    }
  }

  // Method 2: dynamic import fallback — try all possible module shapes
  try {
    const mod = await import('pdf-parse')
    const fn = typeof mod?.default?.default === 'function' ? mod.default.default
             : typeof mod?.default === 'function'          ? mod.default
             : typeof mod === 'function'                   ? mod
             : null
    if (typeof fn === 'function') {
      _pdfParse = fn
      logger.debug('[TextExtract] pdf-parse loaded via dynamic import')
      return _pdfParse
    }
    logger.warn(`[TextExtract] pdf-parse dynamic import: all shapes failed. Keys: ${JSON.stringify(Object.keys(mod ?? {}))}`)
  } catch (e) {
    logger.warn(`[TextExtract] pdf-parse dynamic import threw: ${e.message}`)
  }

  return null
}

// ── pdfjs-dist singleton ──────────────────────────────────────────────────────
let _pdfjsLib = null
async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib

  if (!_cjsRequire) return null

  // Resolve paths to both the library and its worker bundle
  let lib = null
  let workerPath = null

  // Try to load the library
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/build/pdf.js',
    'pdfjs-dist'
  ]
  for (const c of candidates) {
    try {
      const mod = _cjsRequire(c)
      lib = mod?.default ?? mod
      if (lib?.getDocument) {
        logger.debug(`[TextExtract] pdfjs-dist loaded from: ${c}`)
        break
      }
      lib = null
    } catch {
      // try next
    }
  }

  if (!lib) {
    logger.warn('[TextExtract] pdfjs-dist: could not load library')
    return null
  }

  // Find the worker bundle so pdfjs can spawn it
  const workerCandidates = [
    'pdfjs-dist/legacy/build/pdf.worker.js',
    'pdfjs-dist/build/pdf.worker.js',
    'pdfjs-dist/build/pdf.worker.mjs'
  ]
  for (const w of workerCandidates) {
    try {
      workerPath = _cjsRequire.resolve(w)
      break
    } catch {
      // try next
    }
  }

  if (workerPath && lib?.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = workerPath
    logger.debug(`[TextExtract] pdfjs-dist worker set to: ${workerPath}`)
  } else if (lib?.GlobalWorkerOptions) {
    // Last resort: use the module name and hope pdfjs resolves it
    lib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/build/pdf.worker.js'
    logger.warn('[TextExtract] pdfjs-dist: worker path not resolved, using module name')
  }

  _pdfjsLib = lib
  return _pdfjsLib
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function readFileBounded(filePath) {
  const st = await stat(filePath)
  if (!st.isFile()) throw new Error('NOT_A_REGULAR_FILE')
  if (st.size > MAX_EXTRACT_BYTES) throw new Error('FILE_TOO_LARGE')
  return readFile(filePath)
}

export function cleanExtractedText(raw) {
  if (!raw || typeof raw !== 'string') return ''
  let s = raw.replace(/\r\n/g, '\n')
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function isEffectivelyEmpty(text) {
  return !text || !/\S/.test(text)
}

function decodeTextBuffer(buf) {
  if (buf.length === 0) return ''
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.slice(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return buf.slice(2).toString('utf16be')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.slice(2).toString('utf16le')
  let s = buf.toString('utf8')
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s
}

// ── Extractors ────────────────────────────────────────────────────────────────

async function extractTxt(filePath) {
  const buf = await readFileBounded(filePath)
  return decodeTextBuffer(buf)
}

async function extractDocx(filePath) {
  const buf = await readFileBounded(filePath)
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return value || ''
}

async function extractPdf(filePath) {
  const buf = await readFileBounded(filePath)
  logger.debug(`[TextExtract] Extracting PDF: "${filePath}" (${buf.length} bytes)`)

  // ── Pass 1: pdf-parse ──────────────────────────────────────────────────────
  const pdfParse = await getPdfParse()
  if (pdfParse) {
    try {
      const data = await pdfParse(buf)
      const text = typeof data?.text === 'string' ? data.text : ''
      logger.debug(`[TextExtract] pdf-parse result: text.length=${text.length}`)
      if (!isEffectivelyEmpty(text)) return text
      logger.debug('[TextExtract] pdf-parse returned empty text, trying pdfjs-dist...')
    } catch (e) {
      logger.warn(`[TextExtract] pdf-parse threw for "${filePath}": ${e.message}`)
    }
  }

  // ── Pass 2: pdfjs-dist ────────────────────────────────────────────────────
  const pdfjsLib = await getPdfjsLib()
  if (!pdfjsLib) {
    logger.warn('[TextExtract] pdfjs-dist unavailable; PDF extraction failed')
    return ''
  }

  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      verbosity: 0
    })
    const pdf = await loadingTask.promise
    logger.debug(`[TextExtract] pdfjs-dist: ${pdf.numPages} pages`)

    const pageTexts = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .filter((item) => 'str' in item && item.str)
        .map((item) => item.str)
        .join(' ')
      pageTexts.push(pageText)
    }
    await pdf.destroy()

    const text = pageTexts.join('\n')
    logger.debug(`[TextExtract] pdfjs-dist result: text.length=${text.length}`)
    return text
  } catch (e) {
    logger.warn(`[TextExtract] pdfjs-dist threw for "${filePath}": ${e.message}`)
    return ''
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function extractOne(filePath, ext) {
  switch (ext) {
    case '.txt':
    case '.text':
    case '.md':
    case '.markdown':
      return extractTxt(filePath)
    case '.pdf':
      return extractPdf(filePath)
    case '.docx':
      return extractDocx(filePath)
    default:
      return null
  }
}

/**
 * @param {string[]} paths
 * @returns {Promise<{ supported: boolean, reason?: string, texts: ExtractedTextEntry[] }>}
 */
export async function extractTextFromFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { supported: false, reason: REASON_UNSUPPORTED, texts: [] }
  }

  const texts = []

  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue
    const ext = extname(filePath).toLowerCase()

    let raw = null
    try {
      raw = await withTimeout(extractOne(filePath, ext), EXTRACT_TIMEOUT_MS, 'EXTRACT')
    } catch (e) {
      logger.warn(`[TextExtract] Failed to extract "${filePath}": ${e.message}`)
      raw = null
    }

    if (raw === null) continue

    const text = cleanExtractedText(clampRawHeadTail(raw))
    if (isEffectivelyEmpty(text)) {
      logger.warn(
        `[TextExtract] "${filePath}" extracted but text is empty` +
        ` (ext=${ext}; possibly a scanned/image-only PDF with no text layer)`
      )
      continue
    }

    texts.push({ path: filePath, text })
  }

  if (texts.length === 0) {
    return { supported: false, reason: REASON_UNSUPPORTED, texts: [] }
  }

  return { supported: true, texts }
}
