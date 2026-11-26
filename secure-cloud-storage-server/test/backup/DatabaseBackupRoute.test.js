// Run: node --test test/backup/*.test.js
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NoDatabaseBackupMsg,
  createDownloadDbHandler,
  createUploadDbHandler
} from '../../src/DatabaseBackupRoute.js'

const uploadDir = await mkdtemp(join(tmpdir(), 'scs-backup-'))
const app = express()
// Stand-in for the auth middleware, which sets req.userId from the logged-in socket.
const fakeAuth = (req, res, next) => {
  req.userId = req.headers.userid
  next()
}
app.get('/downloadDb', fakeAuth, createDownloadDbHandler({ uploadDir }))
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

after(async () => {
  server.close()
  await rm(uploadDir, { recursive: true, force: true })
})

test('a user without a backup gets 404 and a clear message, not 500', async () => {
  const res = await fetch(`${base}/downloadDb`, { headers: { userid: 'new-user' } })
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { errorMsg: NoDatabaseBackupMsg })
})

test('a user with a backup gets its exact bytes', async () => {
  const bytes = Buffer.from('0123456789abcdef')
  await mkdir(join(uploadDir, 'user-with-backup'), { recursive: true })
  await writeFile(join(uploadDir, 'user-with-backup', 'database.db'), bytes)
  const res = await fetch(`${base}/downloadDb`, { headers: { userid: 'user-with-backup' } })
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes))
})

// POST /uploadDb: the handler called the way Express calls it, after multer has stored the
// backup as database.db in the user's folder.
const uploadBackup = async (userId, bytes) => {
  const seen = { status: 200, info: [], warnings: [] }
  if (bytes !== undefined) {
    await mkdir(join(uploadDir, userId), { recursive: true })
    await writeFile(join(uploadDir, userId, 'database.db'), bytes)
  }
  const res = {
    status(code) {
      seen.status = code
      return res
    },
    send(body) {
      seen.sent = body
      return res
    }
  }
  const handler = createUploadDbHandler({
    uploadDir,
    riskyMimeTypes: ['application/pdf'],
    logInfo: (req, ...rest) => seen.info.push(rest),
    logWarning: (...args) => seen.warnings.push(args)
  })
  const req = { userId, file: bytes === undefined ? undefined : { originalname: 'database.db' } }
  await handler(req, res, (error) => {
    seen.next = error ?? null
  })
  seen.kept = existsSync(join(uploadDir, userId, 'database.db'))
  return seen
}

test('an uploaded backup is kept and acknowledged', async () => {
  const seen = await uploadBackup('uploader', Buffer.from('not a known file type at all'))
  assert.deepEqual(
    { status: seen.status, sent: seen.sent, kept: seen.kept, next: seen.next },
    { status: 200, sent: 'File uploaded successfully.', kept: true, next: undefined }
  )
  assert.deepEqual(seen.info, [
    ['Client uploaded encrypted database.', { filename: 'database.db' }]
  ])
  assert.deepEqual(seen.warnings, [])
})

test('a backup whose content is of a refused type is removed and answered with 415', async () => {
  const pdf = Buffer.from(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n'
  )
  const seen = await uploadBackup('pdf-uploader', pdf)
  assert.deepEqual(
    { status: seen.status, sent: seen.sent, kept: seen.kept, next: seen.next },
    { status: 415, sent: 'Risky mime type', kept: false, next: undefined }
  )
  assert.deepEqual(seen.warnings, [
    [
      'Client upload a file with risky mime type for encrypted database',
      { ext: 'pdf', mime: 'application/pdf' }
    ]
  ])
  assert.deepEqual(seen.info, [])
})

test('an upload request without a file is answered with 400', async () => {
  const seen = await uploadBackup('nobody')
  assert.deepEqual(
    { status: seen.status, sent: seen.sent, next: seen.next },
    { status: 400, sent: 'No file uploaded.', next: undefined }
  )
})

test('a user id that is not a single file name is refused before the disk is touched', async () => {
  await mkdir(join(uploadDir, 'victim'), { recursive: true })
  await writeFile(join(uploadDir, 'victim', 'database.db'), '%PDF-1.7\n%%EOF\n')
  for (const userId of ['uploader/../victim', '../victim', '..', '']) {
    const res = { status: () => res, send: () => res }
    const handler = createUploadDbHandler({ uploadDir, riskyMimeTypes: ['application/pdf'] })
    let passedOn
    await handler({ userId, file: { originalname: 'database.db' } }, res, (error) => {
      passedOn = error
    })
    assert.match(passedOn.message, /Not a plain file name/)
  }
  assert.ok(existsSync(join(uploadDir, 'victim', 'database.db')), 'the other backup is untouched')
})
