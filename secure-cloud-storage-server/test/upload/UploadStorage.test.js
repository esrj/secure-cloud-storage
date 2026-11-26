// Run: node --test test/upload/*.test.js
// The upload routes with multer in front of them, the way HttpsServer.js registers them:
// what ends up on disk, and under which name, for each way a request can be written.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUploadDbHandler } from '../../src/DatabaseBackupRoute.js'
import { createUploadHandler } from '../../src/FileTransferRoute.js'
import { createUploader } from '../../src/UploadStorage.js'

const root = await mkdtemp(join(tmpdir(), 'scs-storage-'))
const uploadDir = join(root, 'uploads')
await mkdir(uploadDir)

const finished = []
const app = express()
// Stand-ins for the auth and checkUpload middleware. The second one deliberately checks
// nothing, so the tests see what the storage does with a name that should never reach it.
const fakeAuth = (req, res, next) => {
  req.userId = req.headers.userid
  next()
}
const fakeCheckUpload = (req, res, next) => {
  req.fileId = req.headers.fileid
  next()
}
const uploadFileBody = createUploader({ uploadDir, storedName: (req) => req.fileId })
const uploadBackupBody = createUploader({ uploadDir, storedName: () => 'database.db' })
app.post(
  '/upload',
  fakeAuth,
  fakeCheckUpload,
  uploadFileBody.single('file'),
  createUploadHandler({ uploadDir, finishUpload: async (info) => void finished.push(info) })
)
app.post(
  '/uploadDb',
  fakeAuth,
  uploadBackupBody.single('file'),
  createUploadDbHandler({ uploadDir, riskyMimeTypes: ['application/x-msdownload'] })
)
// Express takes a function of four arguments as the error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.sendStatus(500)
})
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

after(async () => {
  server.close()
  await rm(root, { recursive: true, force: true })
})

const post = async (route, headers, bytes, name = 'database.db') => {
  const body = new FormData()
  body.append('file', new Blob([bytes]), name)
  const res = await fetch(base + route, { method: 'POST', headers, body })
  return { status: res.status, text: await res.text() }
}
const filesOf = async (userId) =>
  existsSync(join(uploadDir, userId)) ? (await readdir(join(uploadDir, userId))).sort() : []
const everything = async () => (await readdir(root, { recursive: true })).sort()

test('a backup is stored as database.db in the folder of the user who sent it', async () => {
  const bytes = Buffer.from('encrypted backup of user-a')
  const res = await post('/uploadDb', { userid: 'user-a' }, bytes)
  assert.deepEqual(res, { status: 200, text: 'File uploaded successfully.' })
  assert.deepEqual(await filesOf('user-a'), ['database.db'])
  assert.ok((await readFile(join(uploadDir, 'user-a', 'database.db'))).equals(bytes))
})

test('a backup request cannot choose its stored name, however the URL is written', async () => {
  await mkdir(join(uploadDir, 'user-b'), { recursive: true })
  const backupOfB = Buffer.from('backup of user-b')
  await writeFile(join(uploadDir, 'user-b', 'database.db'), backupOfB)

  const routes = ['/uploadDb', '/uploadDb/', '/UPLOADDB', '/uploadDb?x=1', '/uploadDb/?x=1']
  const names = ['../../outside.txt', '../user-b/database.db', 'second-name.bin', '/tmp/x', '..']
  let n = 0
  for (const route of routes) {
    for (const fileid of names) {
      const bytes = Buffer.from(`attempt ${++n}`)
      const res = await post(route, { userid: 'user-c', fileid }, bytes)
      assert.equal(res.status, 200, `${route} with fileid ${fileid}`)
      // The request is an ordinary backup of user-c and nothing else
      assert.deepEqual(await filesOf('user-c'), ['database.db'])
      assert.ok((await readFile(join(uploadDir, 'user-c', 'database.db'))).equals(bytes))
    }
  }
  assert.ok((await readFile(join(uploadDir, 'user-b', 'database.db'))).equals(backupOfB))
  assert.deepEqual(await everything(), [
    'uploads',
    'uploads/user-a',
    'uploads/user-a/database.db',
    'uploads/user-b',
    'uploads/user-b/database.db',
    'uploads/user-c',
    'uploads/user-c/database.db'
  ])
})

test('a file upload is stored under the checked file id and reported with its details', async () => {
  const fileid = '0b1d3c5e-7f90-4a2b-8c4d-6e8f0a1b2c3d'
  const bytes = Buffer.from('encrypted file body')
  const res = await post('/upload', { userid: 'user-d', fileid }, bytes, '報告.pdf')
  assert.deepEqual(res, { status: 200, text: 'File uploaded successfully.' })
  assert.deepEqual(await filesOf('user-d'), [fileid])
  assert.ok((await readFile(join(uploadDir, 'user-d', fileid))).equals(bytes))
  assert.deepEqual(finished, [
    { name: '報告.pdf', id: fileid, userId: 'user-d', originOwnerId: 'user-d', size: bytes.length }
  ])
})

test('the storage refuses a name that is not a plain file name and writes nothing', async () => {
  const before = await everything()
  for (const fileid of ['../../outside.txt', '../user-b/database.db', 'a/b', '..', '.']) {
    const res = await post('/upload', { userid: 'user-e', fileid }, Buffer.from('x'))
    assert.equal(res.status, 500, `fileid ${fileid}`)
  }
  // No file id at all: nothing to store the body as
  assert.equal((await post('/upload', { userid: 'user-e' }, Buffer.from('x'))).status, 500)
  // Only the (empty) folder of the user was made
  assert.deepEqual(await everything(), [...before, 'uploads/user-e'].sort())
  assert.equal(finished.length, 1)
})

test('a user id that is not a plain folder name is refused before anything is made', async () => {
  const before = await everything()
  const res = await post('/uploadDb', { userid: '../elsewhere' }, Buffer.from('x'))
  assert.equal(res.status, 500)
  assert.deepEqual(await everything(), before)
})
