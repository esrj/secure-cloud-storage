// Run: node --test test/backup/*.test.js
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoDatabaseBackupMsg, createDownloadDbHandler } from '../../src/DatabaseBackupRoute.js'

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
