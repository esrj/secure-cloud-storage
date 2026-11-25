// Run: node --test test/upload/*.test.js
// Stored files live at <uploads>/<user id>/<file id>. The paths must stay exactly what the
// server built before, and an id that is not a single file name must be refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveFilePath, resolveUserDir } from '../../src/UploadPath.js'

const sep = path.sep
const uploadDirs = [
  'uploads', // as in config/default.yaml: relative to the working directory
  `uploads${sep}`,
  path.join('data', '..', 'uploads'),
  path.join(tmpdir(), 'scs-uploads'),
  path.join(tmpdir(), 'scs-uploads') + sep
]
const BACKUP_NAME = 'database.db'

test('ids issued by the server give the same paths as path.resolve()', () => {
  for (const uploadDir of uploadDirs) {
    for (let i = 0; i < 50; i++) {
      const userId = randomUUID()
      const fileId = randomUUID()
      assert.equal(resolveUserDir(uploadDir, userId), path.resolve(uploadDir, userId))
      assert.equal(
        resolveFilePath(uploadDir, userId, fileId),
        path.resolve(uploadDir, userId, fileId)
      )
      assert.equal(
        resolveFilePath(uploadDir, userId, BACKUP_NAME),
        path.resolve(uploadDir, userId, BACKUP_NAME)
      )
    }
  }
})

test('the result is always inside the upload directory, two levels deep', () => {
  for (const uploadDir of uploadDirs) {
    const root = path.resolve(uploadDir)
    const userId = randomUUID()
    const filePath = resolveFilePath(uploadDir, userId, BACKUP_NAME)
    assert.ok(path.isAbsolute(filePath))
    assert.equal(path.dirname(filePath), path.join(root, userId))
    assert.equal(path.dirname(resolveUserDir(uploadDir, userId)), root)
  }
})

test('other plain names are accepted unchanged', () => {
  for (const name of ['a', 'a.b', '...', '.hidden', 'user-with-backup', '測試', 'with space']) {
    assert.equal(resolveFilePath('uploads', name, name), path.resolve('uploads', name, name))
  }
})

test('an id that is not a single file name is refused', () => {
  const userId = randomUUID()
  const notNames = [
    '',
    '.',
    '..',
    ['..', 'x'].join(sep),
    ['..', '..', 'outside.txt'].join(sep),
    ['a', 'b'].join(sep),
    `a${sep}`,
    `${sep}a`,
    sep,
    ['.', 'a'].join(sep),
    [userId, '..', randomUUID()].join(sep)
  ]
  for (const bad of notNames) {
    assert.throws(() => resolveFilePath('uploads', userId, bad), /Not a plain file name/)
    assert.throws(() => resolveFilePath('uploads', bad, BACKUP_NAME), /Not a plain file name/)
    assert.throws(() => resolveUserDir('uploads', bad), /Not a plain file name/)
  }
})

test('an id that is not a string fails, as it did with path.resolve()', () => {
  for (const bad of [undefined, null, 7, {}]) {
    assert.throws(() => resolveFilePath('uploads', bad, BACKUP_NAME), TypeError)
    assert.throws(() => resolveFilePath('uploads', randomUUID(), bad), TypeError)
    assert.throws(() => resolveUserDir('uploads', bad), TypeError)
    assert.throws(() => path.resolve('uploads', bad), TypeError)
  }
})
