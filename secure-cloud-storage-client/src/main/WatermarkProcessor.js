/**
 * Applies visible AND invisible watermarks to PDF, image, DOCX, and TXT files.
 * Due to E2E encryption, watermarking happens client-side.
 * Server provides authenticated metadata (userId, fileId, timestamp) for the watermark text.
 *
 * Invisible watermark techniques by format:
 *  - PDF   : PDF text rendering mode 3 (Invisible) via content-stream operators.
 *  - PNG   : True LSB (Least-Significant-Bit) steganography on the R channel.
 *  - JPEG  : LSB encoding + high-quality (95%) re-save.
 *            ⚠ JPEG is lossy — watermark MAY degrade after re-compression.
 *  - DOCX  : Custom document property (docProps/custom.xml, "WatermarkPayload").
 *            Very stable — preserved across Word open/save cycles.
 *  - TXT   : Zero-width character (ZWC) sequence prepended to file.
 *            ⚠ Some text editors strip ZWC on re-save; stability is limited.
 *
 * Visible watermark techniques by format:
 *  - PDF   : pdf-lib drawText with opacity.
 *  - PNG/JPEG : Jimp transparent text overlay.
 *  - DOCX  : Gray-colored paragraph appended before final section properties.
 *            Position setting is ignored (always at document end); opacity → gray level.
 *  - TXT   : Marker line appended at end: "# Watermark: <text>".
 *            Position, opacity, and fontSize settings are not applicable to plain text.
 */
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib'
import {
  Jimp,
  JimpMime,
  BlendMode,
  loadFont,
  measureText,
  measureTextHeight
} from 'jimp'
import { SANS_8_WHITE, SANS_16_WHITE, SANS_32_WHITE } from 'jimp/fonts'
import JSZip from 'jszip'
import { logger } from './Logger'

// ── MIME constants ─────────────────────────────────────────────────────────────

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const TXT_MIME = 'text/plain'

/** Supported MIME types for VISIBLE watermark */
export const WATERMARK_SUPPORTED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  DOCX_MIME,
  TXT_MIME
]

/** Supported MIME types for INVISIBLE watermark */
export const INVISIBLE_WATERMARK_SUPPORTED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  DOCX_MIME,
  TXT_MIME
]

/** Derive MIME type from file extension */
export function getMimeFromFilename(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    docx: DOCX_MIME,
    doc: 'application/msword', // not in supported list — binary OLE format
    txt: TXT_MIME
  }
  return map[ext] || null
}

/** Whether visible watermark is supported for this filename */
export function isWatermarkSupported(filename) {
  return WATERMARK_SUPPORTED_MIMES.includes(getMimeFromFilename(filename))
}

/**
 * Detect the actual content type from the file's leading "magic bytes".
 * Used to override a misleading filename extension (e.g. a PDF stored with a
 * `.png` name) so we watermark with the correct engine instead of feeding a
 * PDF buffer to the image decoder (Jimp), which throws
 * "Mime type application/pdf does not support decoding".
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {string|null} a sniffed mime ('application/pdf' | 'image/png' |
 *   'image/jpeg'), or null when the bytes aren't one of those (caller then
 *   falls back to the filename-based type, which is correct for DOCX/TXT).
 */
export function getMimeFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf' // %PDF
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png' // \x89PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg' // JPEG SOI
  return null
}

// ══════════════════════════════════════════════════════════════
// VISIBLE WATERMARK
// ══════════════════════════════════════════════════════════════

/**
 * Apply visible watermark to a buffer and return the watermarked buffer.
 * @param {Buffer} inputBuffer Decrypted file content
 * @param {string} mimeType MIME type of the file
 * @param {{ text: string, position: string, opacity: number, fontSize: number }} opts
 * @returns {Promise<Buffer>}
 */
export async function applyVisibleWatermark(inputBuffer, mimeType, opts) {
  logger.info(`[WatermarkProcessor] Applying visible watermark: mime=${mimeType}, position=${opts.position}, opacity=${opts.opacity}`)
  if (mimeType === 'application/pdf') return _watermarkPDF(inputBuffer, opts)
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') return _watermarkImage(inputBuffer, mimeType, opts)
  if (mimeType === DOCX_MIME) return _visibleDocx(inputBuffer, opts)
  if (mimeType === TXT_MIME) return _visibleTxt(inputBuffer, opts)
  throw new Error('WATERMARK_UNSUPPORTED_FORMAT')
}

// ──────────────────────────────────────────────────────────────
// PDF visible
// ──────────────────────────────────────────────────────────────
async function _watermarkPDF(inputBuffer, { text, position = 'bottomRight', opacity = 0.3, fontSize = 14 }) {
  // Helvetica covers printable ASCII only. Non-ASCII characters (CJK custom
  // notes etc.) are replaced with '?' by _toAsciiSafe so the user can see
  // *something* changed. The base uid/fid/ts payload is always ASCII.
  const safeText = _toAsciiSafe(text)
  // ignoreEncryption: some real-world PDFs carry an encryption dictionary
  // (e.g. owner-password permission flags) even with no open password. Without
  // this flag pdf-lib throws on load, which would abort the whole watermarked
  // download and leave NO file at the destination. The bytes are already E2E
  // -decrypted on the client, so reading them here is safe.
  const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true })
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const color = rgb(0.4, 0.4, 0.4)

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize()
    const textWidth = font.widthOfTextAtSize(safeText, fontSize)

    if (position === 'diagonal') {
      const step = Math.max(120, height / 3)
      for (let y = step * 0.5; y < height; y += step) {
        page.drawText(safeText, {
          x: Math.max(10, (width - textWidth) / 2),
          y,
          size: fontSize,
          font,
          color,
          opacity,
          rotate: degrees(45)
        })
      }
    } else {
      const x = position === 'bottomRight' ? Math.max(10, width - textWidth - 20) : 20
      page.drawText(safeText, { x, y: 20, size: fontSize, font, color, opacity })
    }
  }

  return Buffer.from(await pdfDoc.save())
}

// ──────────────────────────────────────────────────────────────
// Images (PNG / JPEG) visible
// ──────────────────────────────────────────────────────────────
async function _watermarkImage(inputBuffer, mimeType, { text, position = 'bottomRight', opacity = 0.5, fontSize = 32 }) {
  // Jimp bitmap fonts cover printable ASCII only. Non-ASCII characters are
  // replaced with '?' by _toAsciiSafe so the user can see *something* changed
  // instead of a silently truncated note. The base uid/fid/ts payload is
  // always ASCII.
  const safeText = _toAsciiSafe(text)

  const image = await Jimp.read(inputBuffer)
  const w = image.bitmap.width
  const h = image.bitmap.height

  let fontDef
  if (fontSize >= 32) fontDef = SANS_32_WHITE
  else if (fontSize >= 16) fontDef = SANS_16_WHITE
  else fontDef = SANS_8_WHITE

  const font = await loadFont(fontDef)
  const textW = measureText(font, safeText)
  const textH = measureTextHeight(font, safeText, w + 1)

  const overlay = new Jimp({ width: w, height: h, color: 0x00000000 })

  let x = 20
  let y = Math.max(0, h - textH - 20)
  if (position === 'bottomRight') {
    x = Math.max(10, w - textW - 20)
  } else if (position === 'diagonal') {
    x = Math.max(0, (w - textW) / 2)
    y = Math.max(0, (h - textH) / 2)
  }

  overlay.print({ font, x, y, text: safeText })

  const clampedOpacity = Math.min(1, Math.max(0, opacity))
  overlay.scan(0, 0, w, h, function (px, py, idx) {
    const origAlpha = this.bitmap.data[idx + 3]
    if (origAlpha > 0) {
      this.bitmap.data[idx + 3] = Math.round(origAlpha * clampedOpacity)
    }
  })

  image.composite(overlay, 0, 0, {
    mode: BlendMode.SRC_OVER,
    opacitySource: 1,
    opacityDest: 1
  })

  // Pixels only here. The machine-readable VISIBLE metadata marker is written
  // centrally by applyImageWatermarkMarkers, so that markers reflect EXACTLY
  // what this download applied (and never leak a stale marker from the source).
  if (mimeType === 'image/png') {
    return image.getBuffer(JimpMime.png)
  }
  return image.getBuffer(JimpMime.jpeg, { quality: 95 })
}

// ──────────────────────────────────────────────────────────────
// DOCX visible: append gray watermark paragraph before sectPr
// Position setting is ignored — DOCX paragraph flow doesn't map to x/y coordinates.
// opacity → gray level; fontSize → OOXML half-points (szHp = fontSize * 2).
// ──────────────────────────────────────────────────────────────
async function _visibleDocx(inputBuffer, { text, opacity = 0.3, fontSize = 14 }) {
  const zip = await JSZip.loadAsync(inputBuffer)

  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('WATERMARK_UNSUPPORTED_FORMAT')

  const docXml = await docFile.async('string')

  // Map opacity (0→1) to gray: low opacity = light gray, high = darker
  const grayVal = Math.round(64 + (1 - Math.min(1, Math.max(0, opacity))) * 128)
  const hex = grayVal.toString(16).padStart(2, '0').toUpperCase()
  const colorHex = `${hex}${hex}${hex}`

  // OOXML font size is in half-points
  const szHp = Math.round(fontSize * 2)

  const wmPara = [
    '<w:p>',
    '<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="0"/>',
    '<w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="CCCCCC"/></w:pBdr>',
    '</w:pPr>',
    '<w:r>',
    `<w:rPr><w:color w:val="${colorHex}"/><w:sz w:val="${szHp}"/><w:szCs w:val="${szHp}"/></w:rPr>`,
    `<w:t xml:space="preserve">${_escapeXml(text)}</w:t>`,
    '</w:r>',
    '</w:p>'
  ].join('')

  // sectPr must be the last element in w:body; insert our paragraph right before it
  const sectPrIdx = docXml.lastIndexOf('<w:sectPr')
  let modified
  if (sectPrIdx !== -1) {
    modified = docXml.slice(0, sectPrIdx) + wmPara + docXml.slice(sectPrIdx)
  } else {
    modified = docXml.replace('</w:body>', wmPara + '</w:body>')
  }

  zip.file('word/document.xml', modified)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ──────────────────────────────────────────────────────────────
// TXT visible: append marker line at end of file.
// IMPORTANT: do NOT convert the original buffer to a string.
// TXT files may use non-UTF-8 encodings (Big5, GBK, etc.).
// Converting to string corrupts non-UTF-8 bytes. Instead, append
// the ASCII/UTF-8 marker bytes directly after the original buffer.
// ──────────────────────────────────────────────────────────────
function _visibleTxt(inputBuffer, { text }) {
  const suffix = Buffer.from(`\n\n# Watermark: ${text}\n`, 'utf8')
  return Buffer.concat([inputBuffer, suffix])
}

// ══════════════════════════════════════════════════════════════
// INVISIBLE WATERMARK
// ══════════════════════════════════════════════════════════════

/**
 * Apply invisible watermark to a buffer.
 * @param {Buffer} inputBuffer Decrypted file content
 * @param {string} mimeType
 * @param {{ text: string }} opts
 * @returns {Promise<Buffer>}
 */
export async function applyInvisibleWatermark(inputBuffer, mimeType, opts) {
  logger.info(`[WatermarkProcessor] Applying invisible watermark: mime=${mimeType}`)
  if (mimeType === 'application/pdf') return _invisiblePDF(inputBuffer, opts)
  if (mimeType === 'image/png') return _lsbPNG(inputBuffer, opts)
  if (mimeType === 'image/jpeg') return _lsbJPEG(inputBuffer, opts)
  if (mimeType === DOCX_MIME) return _invisibleDocx(inputBuffer, opts)
  if (mimeType === TXT_MIME) return _invisibleTxt(inputBuffer, opts)
  throw new Error('WATERMARK_UNSUPPORTED_FORMAT')
}

// ──────────────────────────────────────────────────────────────
// PDF invisible: document Keywords metadata + fully-transparent (opacity 0)
// normal-mode text. (The older mode-3 "invisible" text rendering is NOT
// extracted by browser pdfjs, so it was undetectable — see _invisiblePDF body.)
//
// Defence-in-depth: caller (`_buildInvisibleWmText`) already produces an
// ASCII-only string, but we sanitize here too — the bundled Helvetica
// (StandardFonts) can only encode WinAnsi, and one non-ASCII char anywhere
// in `text` makes drawText throw. Replacing rather than stripping preserves
// text length so the detector heuristics still work.
// ──────────────────────────────────────────────────────────────
async function _invisiblePDF(inputBuffer, { text }) {
  const safeText = _winAnsiSafe(text)
  // ignoreEncryption: some real-world PDFs carry an encryption dictionary
  // (e.g. owner-password permission flags) even with no open password. Without
  // this flag pdf-lib throws on load, which would abort the whole watermarked
  // download and leave NO file at the destination. The bytes are already E2E
  // -decrypted on the client, so reading them here is safe.
  const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true })
  // Reliable carrier #1: document metadata (Keywords), read via pdfjs getMetadata().
  try {
    pdfDoc.setKeywords([text])
  } catch (e) {
    logger.warn(`[WatermarkProcessor] PDF setKeywords failed: ${e?.message || e}`)
  }

  // Reliable carrier #2: fully-transparent (opacity 0) NORMAL-mode text.
  //
  // The previous approach used PDF text-rendering-mode 3 ("invisible"), but
  // browser pdfjs getTextContent() does NOT return mode-3 text, so the embedded
  // watermark was undetectable in the app. opacity-0 text IS extracted by pdfjs
  // (the very same path that already finds the visible watermark) yet is
  // imperceptible to the eye. Drawn small (size 8) so the detector's height
  // heuristic (<10 ⇒ invisible) classifies it correctly.
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontSize = 8
  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize()
    for (let y = 30; y < height; y += 120) {
      for (let x = 10; x < width - 10; x += 180) {
        page.drawText(safeText, { x, y, size: fontSize, font, opacity: 0 })
      }
    }
  }
  // useObjectStreams:false keeps the Info dictionary (and thus /Keywords) as a
  // plaintext object rather than packing it into a compressed object stream, so
  // the detector can read the watermark straight from the PDF bytes WITHOUT
  // relying on pdfjs (whose browser build surfaces neither getMetadata keywords
  // nor opacity-0 text reliably).
  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }))
}

/**
 * Replace any non-WinAnsi codepoint with '?' so pdf-lib's StandardFonts.Helvetica
 * never throws on encodeText. Keeps the string length stable.
 */
function _winAnsiSafe(text) {
  return String(text ?? '').replace(/[^\x20-\x7E]/g, '?')
}

// ──────────────────────────────────────────────────────────────
// Reliable invisible carrier: lossless metadata embedded in the file bytes.
//
// Pixel-stego (LSB) and PDF invisible-text are unreliable for DETECTION —
// JPEG re-compression destroys LSB, a browser <canvas> premultiplies alpha and
// corrupts the R-channel LSB, and pdfjs extraction of render-mode-3 text is
// inconsistent. So the invisible payload is ALSO stored in a metadata carrier
// that survives encoding and is read straight from the file bytes:
//   • PNG  → tEXt chunk (keyword WM_KEY_INVISIBLE / WM_KEY_VISIBLE)
//   • JPEG → COM (comment) marker, prefixed with the kind key
//   • PDF  → Keywords entry + opacity-0 text (see _invisiblePDF)
// Visible and invisible carry SEPARATE markers so the detector can report each
// independently — including the visible watermark on images, which is only a
// pixel overlay and otherwise has no machine-readable signal.
// ──────────────────────────────────────────────────────────────
export const WM_KEY_INVISIBLE = 'scs-wm-inv'
export const WM_KEY_VISIBLE = 'scs-wm-vis'

const _CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function _crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Insert a PNG tEXt chunk (keyword\0text) immediately before the IEND chunk. */
function _pngWithText(pngBuf, keyword, text) {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(_crc32(Buffer.concat([type, data])), 0)
  const chunk = Buffer.concat([len, type, data, crc])
  const iendIdx = pngBuf.length - 12 // IEND is the final 12-byte chunk
  return Buffer.concat([pngBuf.subarray(0, iendIdx), chunk, pngBuf.subarray(iendIdx)])
}

/** Insert a JPEG COM (comment) segment after SOI and any leading APPn markers. */
function _jpegWithComment(jpgBuf, text) {
  const payload = Buffer.from(text, 'utf8')
  const segLen = payload.length + 2 // COM length field includes the 2 length bytes
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe, (segLen >> 8) & 0xff, segLen & 0xff]),
    payload
  ])
  let off = 2
  while (
    off + 4 < jpgBuf.length &&
    jpgBuf[off] === 0xff &&
    jpgBuf[off + 1] >= 0xe0 &&
    jpgBuf[off + 1] <= 0xef
  ) {
    off += 2 + jpgBuf.readUInt16BE(off + 2)
  }
  return Buffer.concat([jpgBuf.subarray(0, off), com, jpgBuf.subarray(off)])
}

/** Remove all of our watermark tEXt chunks (invisible/visible) from a PNG. */
function _pngStripWmText(pngBuf) {
  const parts = [pngBuf.subarray(0, 8)] // PNG signature
  let off = 8
  while (off + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(off)
    const type = pngBuf.toString('latin1', off + 4, off + 8)
    const end = off + 12 + len
    let drop = false
    if (type === 'tEXt') {
      const seg = pngBuf.subarray(off + 8, off + 8 + len)
      const z = seg.indexOf(0)
      const kw = z >= 0 ? seg.toString('latin1', 0, z) : ''
      drop = kw === WM_KEY_INVISIBLE || kw === WM_KEY_VISIBLE
    }
    if (!drop) parts.push(pngBuf.subarray(off, end))
    off = end
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

/** Remove all of our watermark COM markers (invisible/visible) from a JPEG. */
function _jpegStripWmComments(jpgBuf) {
  const parts = [jpgBuf.subarray(0, 2)] // SOI
  let off = 2
  while (off + 4 <= jpgBuf.length) {
    if (jpgBuf[off] !== 0xff) break
    const marker = jpgBuf[off + 1]
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(jpgBuf.subarray(off, off + 2)) // standalone marker, no length
      off += 2
      continue
    }
    if (marker === 0xda) {
      parts.push(jpgBuf.subarray(off)) // SOS → entropy data + EOI: copy the rest
      return Buffer.concat(parts)
    }
    const segLen = jpgBuf.readUInt16BE(off + 2)
    const end = off + 2 + segLen
    let drop = false
    if (marker === 0xfe) {
      const content = jpgBuf.toString('utf8', off + 4, end)
      drop = content.startsWith(`${WM_KEY_INVISIBLE}:`) || content.startsWith(`${WM_KEY_VISIBLE}:`)
    }
    if (!drop) parts.push(jpgBuf.subarray(off, end))
    off = end
  }
  if (off < jpgBuf.length) parts.push(jpgBuf.subarray(off))
  return Buffer.concat(parts)
}

/**
 * (Re)write the image watermark METADATA markers so they reflect EXACTLY this
 * download's choices: any pre-existing scs-wm-* markers are stripped first, then
 * a marker is written only for each kind of watermark actually applied. This is
 * what keeps the visible marker out of an "original"-mode (invisible-only)
 * download even when the SOURCE file already carried one.
 *
 * @param {Buffer} buffer image bytes after the pixel watermark passes
 * @param {string} mimeType 'image/png' | 'image/jpeg'
 * @param {{ invisibleText: string|null, visibleText: string|null }} marks
 * @returns {Buffer}
 */
export function applyImageWatermarkMarkers(buffer, mimeType, { invisibleText, visibleText }) {
  let buf = Buffer.from(buffer)
  if (mimeType === 'image/png') {
    buf = _pngStripWmText(buf)
    if (invisibleText) buf = _pngWithText(buf, WM_KEY_INVISIBLE, invisibleText)
    if (visibleText) buf = _pngWithText(buf, WM_KEY_VISIBLE, visibleText)
  } else if (mimeType === 'image/jpeg') {
    buf = _jpegStripWmComments(buf)
    if (invisibleText) buf = _jpegWithComment(buf, `${WM_KEY_INVISIBLE}:${invisibleText}`)
    if (visibleText) buf = _jpegWithComment(buf, `${WM_KEY_VISIBLE}:${visibleText}`)
  }
  return buf
}

// ──────────────────────────────────────────────────────────────
// LSB helpers shared by PNG and JPEG
// Format: [4-byte big-endian payload length][UTF-8 bytes]
// ──────────────────────────────────────────────────────────────
function _encodeLSB(bitmapData, width, height, text) {
  const textBytes = Buffer.from(text, 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(textBytes.length, 0)
  const payload = Buffer.concat([header, textBytes])

  const capacity = width * height
  if (payload.length * 8 > capacity) {
    throw new Error(
      `Invisible watermark text too long for this image (need ${payload.length * 8} bits, have ${capacity}).`
    )
  }

  let bitPos = 0
  for (let byteIdx = 0; byteIdx < payload.length; byteIdx++) {
    for (let bit = 7; bit >= 0; bit--) {
      const rOffset = bitPos * 4
      const bitValue = (payload[byteIdx] >> bit) & 1
      bitmapData[rOffset] = (bitmapData[rOffset] & 0xfe) | bitValue
      bitPos++
    }
  }
}

async function _lsbPNG(inputBuffer, { text }) {
  // Pixel-LSB pass only. The reliable tEXt metadata marker is written centrally
  // by applyImageWatermarkMarkers (Jimp re-encode here drops any source tEXt).
  const image = await Jimp.read(inputBuffer)
  try {
    _encodeLSB(image.bitmap.data, image.bitmap.width, image.bitmap.height, text)
  } catch (e) {
    // Image too small to hold the full payload in pixel-LSB. The tEXt metadata
    // marker still gives reliable detection, so don't abort the download.
    logger.warn(`[WatermarkProcessor] PNG LSB skipped (${e?.message || e}); using metadata marker only.`)
  }
  return image.getBuffer(JimpMime.png)
}

// JPEG is lossy, so pixel-LSB cannot survive re-compression (the bits are
// destroyed by the DCT quantizer). The JPEG invisible payload lives entirely in
// the COM metadata marker, written centrally by applyImageWatermarkMarkers — so
// there is no pixel pass to do here.
async function _lsbJPEG(inputBuffer) {
  return Buffer.from(inputBuffer)
}

// ──────────────────────────────────────────────────────────────
// DOCX invisible: custom document property (docProps/custom.xml)
// Stored as "WatermarkPayload" — invisible to readers, preserved across
// open/save cycles in Microsoft Word and LibreOffice.
// ──────────────────────────────────────────────────────────────
async function _invisibleDocx(inputBuffer, { text }) {
  const zip = await JSZip.loadAsync(inputBuffer)

  const customXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"',
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="WatermarkPayload">',
    `<vt:lpwstr>${_escapeXml(text)}</vt:lpwstr>`,
    '</property>',
    '</Properties>'
  ].join('\n')

  zip.file('docProps/custom.xml', customXml)

  // Register in [Content_Types].xml if not already present
  const ctFile = zip.file('[Content_Types].xml')
  if (ctFile) {
    const ctXml = await ctFile.async('string')
    if (!ctXml.includes('custom-properties')) {
      zip.file(
        '[Content_Types].xml',
        ctXml.replace(
          '</Types>',
          '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'
        )
      )
    }
  }

  // Add relationship in _rels/.rels if not already present
  const relsFile = zip.file('_rels/.rels')
  if (relsFile) {
    const relsXml = await relsFile.async('string')
    if (!relsXml.includes('custom-properties')) {
      zip.file(
        '_rels/.rels',
        relsXml.replace(
          '</Relationships>',
          '<Relationship Id="rId_WmCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'
        )
      )
    }
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ──────────────────────────────────────────────────────────────
// TXT invisible: zero-width character (ZWC) steganography
// ZWSP (U+200B) = bit 0, ZWJ (U+200D) = bit 1.
// Format: [32 ZWC bits = payload byte length, big-endian][N*8 ZWC bits = UTF-8 payload]
// Sequence is APPENDED at the END of the file.
//
// ENCODING SAFETY: ZWC characters are 3-byte UTF-8 sequences (e.g. U+200B = 0xE2 0x80 0x8B).
// Appending them to a non-UTF-8 file (e.g. Big5, GBK) creates a mixed-encoding file
// that text editors cannot open. To preserve file integrity, we SKIP invisible watermark
// for files that are not valid UTF-8 and return the original buffer unchanged.
// Visible watermark (pure ASCII) is unaffected and still works for all encodings.
// ──────────────────────────────────────────────────────────────
function _invisibleTxt(inputBuffer, { text }) {
  // Guard: ZWC bytes are UTF-8 — only append them to UTF-8 source files.
  // For non-UTF-8 files (Big5, GBK …), fall back to the visible ASCII marker
  // so the watermark is still detectable without corrupting the file.
  if (!_isValidUtf8(inputBuffer)) {
    logger.warn('[WatermarkProcessor] TXT invisible watermark: non-UTF-8 file detected. Falling back to visible ASCII marker to preserve detectability.')
    const suffix = Buffer.from(`\n\n# Watermark: ${text}\n`, 'utf8')
    return Buffer.concat([inputBuffer, suffix])
  }

  const textBytes = Buffer.from(text, 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(textBytes.length, 0)
  const payload = Buffer.concat([header, textBytes])

  let zwcStr = ''
  for (let i = 0; i < payload.length; i++) {
    for (let bit = 7; bit >= 0; bit--) {
      zwcStr += ((payload[i] >> bit) & 1) ? '\u200D' : '\u200B'
    }
  }

  const zwcBytes = Buffer.from(zwcStr, 'utf8')
  return Buffer.concat([inputBuffer, zwcBytes])
}

// ──────────────────────────────────────────────────────────────
// UTF-8 validator — checks raw buffer byte-by-byte.
// Returns false for Big5, GBK, Latin-1, or any non-UTF-8 encoding.
// ──────────────────────────────────────────────────────────────
function _isValidUtf8(buf) {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    let extra
    if (b < 0x80) {
      extra = 0                          // ASCII
    } else if ((b & 0xE0) === 0xC0) {
      extra = 1                          // 2-byte sequence
    } else if ((b & 0xF0) === 0xE0) {
      extra = 2                          // 3-byte sequence
    } else if ((b & 0xF8) === 0xF0) {
      extra = 3                          // 4-byte sequence
    } else {
      return false                       // invalid leading byte
    }
    for (let j = 1; j <= extra; j++) {
      if (i + j >= buf.length || (buf[i + j] & 0xC0) !== 0x80) return false
    }
    i += extra + 1
  }
  return true
}

// ──────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────

/**
 * Sanitize text for fonts that only support printable ASCII (Helvetica, Jimp bitmap).
 * Non-ASCII characters (e.g. CJK) are replaced with '?' rather than removed.
 *
 * Why replace, not strip:
 *   Previously this function stripped non-ASCII silently. Combined with the
 *   `|| text.replace(...)` fallback in the call sites it meant CJK custom
 *   notes vanished entirely from the rendered watermark — the user saw a
 *   clean watermark with no clue their note had been dropped. Replacement
 *   surfaces the issue: the user sees "??????" where their note should be,
 *   and the UI warns them up front (see DownloadOptionsDialog / BatchDownloadDialog).
 *
 * The core watermark payload (uid:/fid:/ts:) is pure ASCII and is always
 * preserved verbatim. Invisible watermark payloads (where present) store the
 * raw UTF-8 bytes and don't go through this function.
 */
function _toAsciiSafe(text) {
  return String(text ?? '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function _escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
