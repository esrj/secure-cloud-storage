// Run: node --test test/upload/*.test.js
// POST /upload and GET /download, each handler called the way Express calls it, after the
// middleware has left req.userId and req.fileId on the request.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDownloadHandler, createUploadHandler } from '../../src/FileTransferRoute.js'

const root = await mkdtemp(path.join(tmpdir(), 'scs-transfer-'))
const uploadDir = path.join(root, 'uploads')
after(() => rm(root, { recursive: true, force: true }))

const storedPath = (userId, fileId) => path.join(uploadDir, userId, fileId)
const store = async (userId, fileId, bytes = 'stored bytes') => {
  await mkdir(path.join(uploadDir, userId), { recursive: true })
  await writeFile(storedPath(userId, fileId), bytes)
}

// What a handler did with the response, and what it logged or handed to next().
const run = async (makeHandler, options, req) => {
  const seen = { status: 200, logs: [] }
  const log =
    (level) =>
    (...args) =>
      seen.logs.push([level, ...args.slice(1)])
  const res = {
    status(code) {
      seen.status = code
      return res
    },
    send(body) {
      seen.sent = body
      return res
    },
    download(...args) {
      seen.download = args
      return res
    }
  }
  const handler = makeHandler({
    uploadDir,
    logInfo: log('info'),
    logWarning: log('warn'),
    logError: log('error'),
    ...options
  })
  await handler(req, res, (error) => {
    seen.next = error ?? null
  })
  return seen
}

const uploadRequest = (userId, fileId) => ({
  userId,
  fileId,
  file: { originalname: '報告.txt', filename: fileId, size: 12 }
})

test('upload: the stored file is registered under the ids the middleware checked', async () => {
  const userId = randomUUID()
  const fileId = randomUUID()
  await store(userId, fileId)
  const registered = []
  const seen = await run(
    createUploadHandler,
    { finishUpload: async (info) => registered.push(info) },
    uploadRequest(userId, fileId)
  )
  assert.deepEqual(registered, [
    { name: '報告.txt', id: fileId, userId, originOwnerId: userId, size: 12 }
  ])
  assert.deepEqual(
    { status: seen.status, sent: seen.sent, next: seen.next },
    { status: 200, sent: 'File uploaded successfully.', next: undefined }
  )
  assert.deepEqual(seen.logs, [['info', 'Client uploaded file.', { filename: '報告.txt' }]])
  assert.ok(existsSync(storedPath(userId, fileId)))
})

test('upload: a request without a file is answered with 400 and registers nothing', async () => {
  let called = false
  const seen = await run(
    createUploadHandler,
    { finishUpload: async () => (called = true) },
    { userId: randomUUID(), fileId: randomUUID() }
  )
  assert.deepEqual(
    { status: seen.status, sent: seen.sent, next: seen.next },
    { status: 400, sent: 'No file uploaded.', next: undefined }
  )
  assert.equal(called, false)
})

test('upload: if registering fails, the stored file is removed and the error is passed on', async () => {
  const userId = randomUUID()
  const fileId = randomUUID()
  const other = randomUUID()
  await store(userId, fileId)
  await store(userId, other)
  const failure = new Error('registering failed')
  const seen = await run(
    createUploadHandler,
    {
      finishUpload: async () => {
        throw failure
      }
    },
    uploadRequest(userId, fileId)
  )
  assert.equal(seen.next, failure)
  assert.equal(seen.sent, undefined)
  assert.equal(existsSync(storedPath(userId, fileId)), false)
  assert.ok(existsSync(storedPath(userId, other)), 'only the file of this upload is removed')
  assert.deepEqual(seen.logs, [['info', 'Client uploaded file.', { filename: '報告.txt' }]])
})

test('upload: a stored file that is already gone is not reported as a second error', async () => {
  const failure = new Error('registering failed')
  const seen = await run(
    createUploadHandler,
    {
      finishUpload: async () => {
        throw failure
      }
    },
    uploadRequest(randomUUID(), randomUUID())
  )
  assert.equal(seen.next, failure)
  assert.equal(seen.logs.filter(([level]) => level === 'error').length, 0)
})

test('upload: clearing up never reaches outside the upload directory', async () => {
  const outside = path.join(root, 'outside.txt')
  await writeFile(outside, 'must stay')
  const userId = randomUUID()
  await mkdir(path.join(uploadDir, userId), { recursive: true })
  const failure = new Error('registering failed')
  for (const fileId of [
    '../../outside.txt',
    path.join('..', '..', 'outside.txt'),
    outside,
    '..',
    ''
  ]) {
    const seen = await run(
      createUploadHandler,
      {
        finishUpload: async () => {
          throw failure
        }
      },
      uploadRequest(userId, fileId)
    )
    assert.equal(seen.next, failure)
    const errors = seen.logs.filter(([level]) => level === 'error')
    assert.equal(errors.length, 1)
    assert.match(errors[0][1].message, /Not a plain file name/)
  }
  assert.ok(existsSync(outside))
})

const fileRow = (ownerId, id = randomUUID()) => ({ id, ownerId, name: '報告.txt' })

test('download: the owner gets the stored file under its original name', async () => {
  const userId = randomUUID()
  const row = fileRow(userId)
  const asked = []
  const seen = await run(
    createDownloadHandler,
    {
      getFileInfo: async (fileId) => {
        asked.push(fileId)
        return row
      }
    },
    { userId, fileId: row.id }
  )
  assert.deepEqual(asked, [row.id])
  assert.deepEqual(seen.download, [path.resolve(uploadDir, userId, row.id), '報告.txt'])
  assert.deepEqual(seen.logs, [['info', 'Client downloading file.']])
  assert.equal(seen.next, undefined)
})

test('download: an unknown file is 404, a file of someone else is 403, and neither is sent', async () => {
  const userId = randomUUID()
  const unknown = await run(
    createDownloadHandler,
    { getFileInfo: async () => undefined },
    { userId, fileId: randomUUID() }
  )
  assert.deepEqual(
    { status: unknown.status, sent: unknown.sent, download: unknown.download },
    { status: 404, sent: 'File not found', download: undefined }
  )
  assert.deepEqual(unknown.logs, [['warn', 'Client asks to download file which does not exist.']])

  const row = fileRow(randomUUID())
  const foreign = await run(
    createDownloadHandler,
    { getFileInfo: async () => row },
    { userId, fileId: row.id }
  )
  assert.deepEqual(
    { status: foreign.status, sent: foreign.sent, download: foreign.download },
    { status: 403, sent: 'File not owned.', download: undefined }
  )
  assert.deepEqual(foreign.logs, [
    ['warn', 'Client asks to download file which is not owned by the client.']
  ])
})

test('download: an id that is not a single file name is refused, whatever the database holds', async () => {
  const userId = randomUUID()
  for (const id of ['../../outside.txt', '..', '', path.join(root, 'outside.txt')]) {
    const seen = await run(
      createDownloadHandler,
      { getFileInfo: async () => fileRow(userId, id) },
      { userId, fileId: randomUUID() }
    )
    assert.equal(seen.download, undefined)
    assert.match(seen.next.message, /Not a plain file name/)
  }
})

test('download: a failing lookup is passed on to the error handler', async () => {
  const failure = new Error('database is away')
  const seen = await run(
    createDownloadHandler,
    {
      getFileInfo: async () => {
        throw failure
      }
    },
    { userId: randomUUID(), fileId: randomUUID() }
  )
  assert.equal(seen.next, failure)
  assert.equal(seen.download, undefined)
})
