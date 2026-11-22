/**
 * Which files the client refuses to upload.
 *
 * A file is encrypted on this machine before it is sent, so the server only ever receives
 * ciphertext and cannot tell what kind of file it is. The type check therefore runs here, on the
 * original file, before encryption.
 *
 * Two rules, because each catches what the other misses:
 *   - by extension: scripts are plain text and carry no signature that could be detected;
 *   - by content:   an executable or archive renamed to something harmless still starts with
 *                   its own signature.
 *
 * The refused categories follow the server's `riskyMimeTypes` list: executables and install
 * packages, scripts, macro-capable Office documents (including the old .doc/.xls/.ppt formats),
 * archives, disk images, Flash and browser extensions, SVG. PDF is on that list too but is NOT
 * refused here, because watermarking and text extraction work on PDF files.
 *
 * No Electron imports here so the module can be unit-tested with `node --test`
 * (see test/upload/uploadTypeGuard.test.mjs).
 */
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const CATEGORY_LABEL = {
  executable: 'an executable or install package',
  script: 'a script',
  office: 'a macro-capable Office document',
  archive: 'an archive',
  diskImage: 'a disk image',
  activeContent: 'a file type that can carry active content'
}

const EXTENSIONS_BY_CATEGORY = {
  executable: [
    'exe', 'dll', 'msi', 'msp', 'com', 'scr', 'cpl', 'sys', 'jar', 'deb', 'rpm', 'apk', 'pkg',
    'appimage'
  ],
  script: [
    'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'hta',
    'sh', 'bash', 'zsh', 'csh', 'ksh', 'tcl', 'pl'
  ],
  office: [
    'doc', 'dot', 'docm', 'dotm', 'xls', 'xlt', 'xla', 'xlsm', 'xltm', 'xlam', 'xlsb', 'ppt',
    'pps', 'pot', 'ppa', 'pptm', 'ppsm', 'potm', 'ppam'
  ],
  archive: [
    'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'tar', 'xz', 'txz', 'zst', 'lz',
    'lz4', 'cab', 'arj', 'lzh', 'ace', 'cpio'
  ],
  diskImage: ['iso', 'dmg'],
  activeContent: ['swf', 'xpi', 'svg', 'svgz']
}

// MIME types as reported by the `file-type` package (see its supported.js).
const MIMES_BY_CATEGORY = {
  executable: [
    'application/x-msdownload', // .exe, .dll
    'application/x-elf',
    'application/x-mach-binary',
    'application/java-archive',
    'application/x-deb',
    'application/x-rpm',
    'application/vnd.android.package-archive'
  ],
  office: [
    'application/x-cfb', // the container of .doc / .xls / .ppt (and .msi)
    'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.ms-word.template.macroenabled.12',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.ms-excel.template.macroenabled.12',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    'application/vnd.ms-powerpoint.template.macroenabled.12'
  ],
  archive: [
    'application/zip', // a plain zip; .docx / .xlsx / .pptx are reported under their own types
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/gzip',
    'application/x-bzip2',
    'application/x-tar',
    'application/x-xz',
    'application/zstd',
    'application/x-lzip',
    'application/x-lz4',
    'application/x-compress',
    'application/vnd.ms-cab-compressed',
    'application/x-arj',
    'application/x-lzh-compressed',
    'application/x-ace-compressed',
    'application/x-cpio'
  ],
  diskImage: ['application/x-apple-diskimage'],
  activeContent: ['application/x-shockwave-flash', 'application/x-xpinstall']
}

const toLookup = (byCategory) =>
  new Map(
    Object.entries(byCategory).flatMap(([category, values]) => values.map((v) => [v, category]))
  )

const CATEGORY_OF_EXTENSION = toLookup(EXTENSIONS_BY_CATEGORY)
const CATEGORY_OF_MIME = toLookup(MIMES_BY_CATEGORY)

/** Every refused extension, without the dot. Exported for tests and documentation. */
export const BLOCKED_EXTENSIONS = [...CATEGORY_OF_EXTENSION.keys()]
/** Every refused content type. Exported for tests and documentation. */
export const BLOCKED_MIME_TYPES = [...CATEGORY_OF_MIME.keys()]

/**
 * Extension of a file name in lower case and without the dot.
 * Windows ignores trailing dots and spaces ("a.exe." opens as "a.exe"), so they are dropped first.
 * @param {string} filePath
 * @returns {string} '' when the name has no extension
 */
export function extensionOf(filePath) {
  const name = basename(String(filePath)).replace(/[. ]+$/, '')
  return extname(name).slice(1).toLowerCase()
}

/**
 * Content type of a file according to its first bytes, or undefined when it has no known
 * signature (plain text, for instance). A file that cannot be read or parsed counts as unknown,
 * so the upload goes on and reports the problem the way it always did.
 * @param {string} filePath
 * @returns {Promise<string | undefined>}
 */
async function detectMime(filePath) {
  try {
    // file-type is an ES module; the main process is built as CommonJS, hence the dynamic import.
    const { fileTypeFromFile } = await import('file-type')
    return (await fileTypeFromFile(filePath))?.mime
  } catch {
    return undefined
  }
}

/**
 * True when the file starts with "#!/" (or "#! /"), the first line of a Unix script.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function startsWithShebang(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0)
    const head = buffer.subarray(0, bytesRead).toString('latin1')
    return head.startsWith('#!/') || head.startsWith('#! /')
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

const refusal = (filePath, category, detail) => ({
  allowed: false,
  category,
  reason: `${basename(String(filePath))} is ${CATEGORY_LABEL[category]} (${detail}). This type of file cannot be uploaded.`
})

/**
 * Decide whether one file may be uploaded.
 *
 * @param {string} filePath
 * @param {{ detect?: (filePath: string) => Promise<string | undefined> }} [options]
 *        `detect` replaces the content detection (tests only).
 * @returns {Promise<{ allowed: true } | { allowed: false, category: string, reason: string }>}
 */
export async function checkUploadAllowed(filePath, { detect = detectMime } = {}) {
  const extension = extensionOf(filePath)
  const byExtension = CATEGORY_OF_EXTENSION.get(extension)
  if (byExtension) return refusal(filePath, byExtension, `.${extension}`)

  const mime = await detect(filePath)
  const byContent = mime && CATEGORY_OF_MIME.get(mime)
  if (byContent) return refusal(filePath, byContent, `content type ${mime}`)

  if (await startsWithShebang(filePath)) return refusal(filePath, 'script', 'starts with #!')

  return { allowed: true }
}

/**
 * Split the files a user picked into those that may be uploaded and those that are refused.
 * The order of the allowed files is kept.
 *
 * @param {string[]} filePaths
 * @param {{ detect?: (filePath: string) => Promise<string | undefined> }} [options]
 * @returns {Promise<{ allowed: string[], refused: Array<{ filePath: string, category: string, reason: string }> }>}
 */
export async function partitionUploads(filePaths, options) {
  const allowed = []
  const refused = []
  for (const filePath of filePaths) {
    const result = await checkUploadAllowed(filePath, options)
    if (result.allowed) allowed.push(filePath)
    else refused.push({ filePath, category: result.category, reason: result.reason })
  }
  return { allowed, refused }
}
