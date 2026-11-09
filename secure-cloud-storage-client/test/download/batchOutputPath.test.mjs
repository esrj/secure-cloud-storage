// Run: npm run test:download
// Batch download must write every file inside the folder the user picked,
// whatever name the server (i.e. the uploader) supplied.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import {
  FALLBACK_FILE_NAME,
  resolveUniquePath,
  safeFileName
} from '../../src/main/batchOutputPath.js'

const DEST = process.platform === 'win32' ? 'C:\\Users\\sam\\Downloads\\batch' : '/Users/sam/Downloads/batch'
const never = () => false
const existsIn = (...paths) => {
  const set = new Set(paths.map((p) => join(DEST, p)))
  return (p) => set.has(p)
}

test('safeFileName keeps ordinary names unchanged', () => {
  for (const name of ['report.pdf', '報告 第2版.docx', 'my file (1).txt', '.bashrc', 'no-extension', 'a..b.txt']) {
    assert.equal(safeFileName(name), name)
  }
})

test('safeFileName keeps only the last segment of a path', () => {
  assert.equal(safeFileName('../../evil.txt'), 'evil.txt')
  assert.equal(safeFileName('..\\..\\evil.txt'), 'evil.txt')
  assert.equal(safeFileName('/etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\Windows\\System32\\x.txt'), 'x.txt')
  assert.equal(safeFileName('\\\\server\\share\\x.txt'), 'x.txt')
  assert.equal(safeFileName('dir/sub\\file.pdf'), 'file.pdf')
  assert.equal(safeFileName('trailing/'), 'trailing')
})

test('safeFileName falls back when nothing usable is left', () => {
  for (const name of ['', '.', '..', '/', '\\', '../..', 'C:', null, undefined]) {
    assert.equal(safeFileName(name), FALLBACK_FILE_NAME, `name=${JSON.stringify(name)}`)
  }
  assert.equal(safeFileName('..', 'x'), 'x')
})

test('resolveUniquePath: ordinary names map to destDir/name', () => {
  assert.equal(resolveUniquePath(DEST, 'report.pdf', { exists: never }), join(DEST, 'report.pdf'))
  assert.equal(resolveUniquePath(DEST, '報告.docx', { exists: never }), join(DEST, '報告.docx'))
  // A trailing separator on destDir makes no difference.
  assert.equal(resolveUniquePath(DEST + sep, 'report.pdf', { exists: never }), join(DEST, 'report.pdf'))
})

test('resolveUniquePath: collisions get (2), (3), … before the extension', () => {
  assert.equal(
    resolveUniquePath(DEST, 'report.pdf', { exists: existsIn('report.pdf') }),
    join(DEST, 'report (2).pdf')
  )
  assert.equal(
    resolveUniquePath(DEST, 'report.pdf', { exists: existsIn('report.pdf', 'report (2).pdf') }),
    join(DEST, 'report (3).pdf')
  )
  assert.equal(
    resolveUniquePath(DEST, 'README', { exists: existsIn('README') }),
    join(DEST, 'README (2)')
  )
  assert.equal(
    resolveUniquePath(DEST, 'archive.tar.gz', { exists: existsIn('archive.tar.gz') }),
    join(DEST, 'archive.tar (2).gz')
  )
})

test('resolveUniquePath: traversal names stay inside destDir', () => {
  const cases = {
    '../../evil.txt': 'evil.txt',
    '..\\..\\evil.txt': 'evil.txt',
    '../../../Library/LaunchAgents/com.evil.plist': 'com.evil.plist',
    '/etc/passwd': 'passwd',
    'C:\\Windows\\x.txt': 'x.txt',
    '..': FALLBACK_FILE_NAME,
    '': FALLBACK_FILE_NAME
  }
  for (const [name, expected] of Object.entries(cases)) {
    const out = resolveUniquePath(DEST, name, { exists: never })
    assert.equal(out, join(DEST, expected), `name=${JSON.stringify(name)}`)
    assert.ok(out.startsWith(DEST + sep), `${out} must be inside ${DEST}`)
  }
})

test('resolveUniquePath: a traversal name that collides is still renamed inside destDir', () => {
  assert.equal(
    resolveUniquePath(DEST, '../evil.txt', { exists: existsIn('evil.txt') }),
    join(DEST, 'evil (2).txt')
  )
})
