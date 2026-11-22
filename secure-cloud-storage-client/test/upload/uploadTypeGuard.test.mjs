// Run: npm run test:upload
// Risky file types must be refused before a file is encrypted and uploaded, and the file types
// the rest of the app works with (PDF, DOCX, images, text) must keep going through.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  BLOCKED_EXTENSIONS,
  BLOCKED_MIME_TYPES,
  checkUploadAllowed,
  extensionOf,
  partitionUploads
} from '../../src/main/uploadTypeGuard.js'

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upload-guard-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write a fixture and return its path. */
async function file(name, content = '') {
  const filePath = join(dir, name)
  await writeFile(filePath, content)
  return filePath
}

const zipOf = (entries) => {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const contentTypes = (mainType) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  `<Override PartName="/part.xml" ContentType="${mainType}"/></Types>`

const ooxml = (folder, mainType) =>
  zipOf({ '[Content_Types].xml': contentTypes(mainType), [`${folder}/part.xml`]: '<x/>' })

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
const DOCM = 'application/vnd.ms-word.document.macroEnabled.main+xml'
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
const pad = (bytes, length = 4096) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(length)])

async function refusedAs(filePath, category) {
  const result = await checkUploadAllowed(filePath)
  assert.equal(result.allowed, false, `${filePath} should be refused`)
  assert.equal(result.category, category, filePath)
  return result
}

async function allowed(filePath) {
  assert.deepEqual(await checkUploadAllowed(filePath), { allowed: true }, filePath)
}

test('extensionOf is case-insensitive and ignores trailing dots and spaces', () => {
  assert.equal(extensionOf('/tmp/SETUP.EXE'), 'exe')
  assert.equal(extensionOf('/tmp/report.pdf.exe'), 'exe')
  assert.equal(extensionOf('/tmp/a.exe.'), 'exe')
  assert.equal(extensionOf('/tmp/a.exe . '), 'exe')
  assert.equal(extensionOf('/tmp/archive.tar.gz'), 'gz')
  assert.equal(extensionOf('/tmp/no-extension'), '')
  assert.equal(extensionOf('/tmp/.bashrc'), '')
})

test('files are refused by extension, whatever they contain', async () => {
  const cases = {
    executable: ['setup.exe', 'SETUP.EXE', 'report.pdf.exe', 'trailing.exe.', 'lib.dll', 'a.msi', 'tool.jar', 'a.deb', 'a.rpm', 'a.apk'],
    script: ['run.bat', 'run.cmd', 'run.ps1', 'run.vbs', 'app.js', 'deploy.sh', 'a.csh', 'a.tcl', 'a.pl'],
    office: ['old.doc', 'old.xls', 'old.ppt', 'macro.docm', 'macro.xlsm', 'macro.pptm', 'addin.xlam', 'addin.ppam'],
    archive: ['data.zip', 'data.7z', 'data.rar', 'data.tar', 'data.tar.gz', 'data.tgz', 'data.bz2'],
    diskImage: ['disk.iso', 'app.dmg'],
    activeContent: ['movie.swf', 'ext.xpi', 'picture.svg']
  }
  for (const [category, names] of Object.entries(cases)) {
    for (const name of names) {
      const result = await refusedAs(await file(name, 'plain text content'), category)
      assert.match(result.reason, /cannot be uploaded/)
    }
  }
})

test('an empty file named .exe is refused', async () => {
  await refusedAs(await file('empty.exe', ''), 'executable')
})

test('executables are refused by content even under a harmless name', async () => {
  await refusedAs(await file('windows-program.txt', pad([0x4d, 0x5a, 0x90, 0x00])), 'executable')
  await refusedAs(await file('linux-program.pdf', pad([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01])), 'executable')
  await refusedAs(await file('mac-program.png', pad([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01])), 'executable')
})

test('archives are refused by content even under a harmless name', async () => {
  await refusedAs(await file('plain-zip.docx', await zipOf({ 'a.txt': 'hello' })), 'archive')
  await refusedAs(await file('gzip.txt', pad([0x1f, 0x8b, 0x08, 0x00])), 'archive')
  await refusedAs(await file('sevenzip.txt', pad([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), 'archive')
  await refusedAs(await file('rar.txt', pad([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])), 'archive')
})

test('macro-capable Office documents are refused by content even when renamed', async () => {
  await refusedAs(await file('macro-renamed.docx', await ooxml('word', DOCM)), 'office')
  await refusedAs(await file('macro-renamed.xlsx', await ooxml('xl', XLSM)), 'office')
  // .doc / .xls / .ppt share the OLE compound-file container
  await refusedAs(await file('old-word.txt', pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'office')
})

test('a Unix script is refused even without a script extension', async () => {
  await refusedAs(await file('run-me.txt', '#!/bin/sh\nrm -rf "$HOME"\n'), 'script')
  await refusedAs(await file('run-me-2', '#! /usr/bin/env python3\nprint(1)\n'), 'script')
})

test('the file types the app works with are still accepted', async () => {
  await allowed(await file('report.pdf', PDF))
  await allowed(await file('報告 第2版.docx', await ooxml('word', DOCX)))
  await allowed(await file('table.xlsx', await ooxml('xl', XLSX)))
  await allowed(await file('slides.pptx', await ooxml('ppt', PPTX)))
  await allowed(await file('photo.png', PNG))
  await allowed(await file('photo.jpg', JPEG))
  await allowed(await file('notes.txt', '一般的文字內容\nsecond line\n'))
  await allowed(await file('readme.md', '# Title\n\nSee `#!/bin/sh` for the script header.\n'))
  await allowed(await file('data.csv', 'a,b\n1,2\n'))
  await allowed(await file('data.json', '{"a":1}'))
  await allowed(await file('empty.txt', ''))
  await allowed(await file('no-extension', 'text'))
})

test('PDF, DOCX, images and text are not on the refusal lists', () => {
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'txt', 'text', 'md', 'markdown']) {
    assert.equal(BLOCKED_EXTENSIONS.includes(ext), false, ext)
  }
  for (const mime of [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]) {
    assert.equal(BLOCKED_MIME_TYPES.includes(mime), false, mime)
  }
})

test('a file that cannot be read is left to the upload itself to report', async () => {
  await allowed(join(dir, 'does-not-exist.txt'))
})

test('content detection can be replaced, and its result decides', async () => {
  const filePath = await file('anything.bin', 'data')
  const asZip = await checkUploadAllowed(filePath, { detect: async () => 'application/zip' })
  assert.equal(asZip.allowed, false)
  assert.equal(asZip.category, 'archive')
  assert.deepEqual(await checkUploadAllowed(filePath, { detect: async () => 'application/pdf' }), {
    allowed: true
  })
  assert.deepEqual(await checkUploadAllowed(filePath, { detect: async () => undefined }), {
    allowed: true
  })
})

test('partitionUploads keeps the order of accepted files and explains each refusal', async () => {
  const a = await file('1-first.pdf', PDF)
  const b = await file('2-installer.exe', pad([0x4d, 0x5a]))
  const c = await file('3-notes.txt', 'hello')
  const d = await file('4-bundle.zip', await zipOf({ 'x.txt': 'x' }))
  const e = await file('5-photo.png', PNG)

  const { allowed: accepted, refused } = await partitionUploads([a, b, c, d, e])
  assert.deepEqual(accepted, [a, c, e])
  assert.deepEqual(
    refused.map((r) => [r.filePath, r.category]),
    [
      [b, 'executable'],
      [d, 'archive']
    ]
  )
  assert.match(refused[0].reason, /^2-installer\.exe is an executable or install package \(\.exe\)\./)
  assert.match(refused[1].reason, /^4-bundle\.zip is an archive \(\.zip\)\./)
})

test('partitionUploads of nothing is nothing', async () => {
  assert.deepEqual(await partitionUploads([]), { allowed: [], refused: [] })
})
