// Run: npm run test:classifier
// Download / resume / cancel / verify / import against a local HTTP server
// (fix plan §6.1). The rule under test throughout: a failure never overwrites
// or deletes a usable model.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STORE_ERROR,
  downloadModel,
  getModelFileState,
  importModel,
  importPartPathFor,
  markerPathFor,
  partPathFor,
  verifyInPlace
} from '../../src/main/services/classifierModelStore.js'

const SIZE = 3 * 1024 * 1024 + 123
const CONTENT = randomBytes(SIZE)
const EXPECTED = {
  filename: 'test-model.gguf',
  size: SIZE,
  sha256: createHash('sha256').update(CONTENT).digest('hex'),
  revision: 'abc'
}
const plenty = async () => 100 * 1024 ** 3

/** Server behaviour for the next requests. */
const server = {
  mode: 'ok', // ok | cut | ignore-range | corrupt | 404
  cutAt: 0,
  requests: []
}
let httpServer
let url

before(async () => {
  httpServer = http.createServer((req, res) => {
    server.requests.push({
      method: req.method,
      url: req.url,
      range: req.headers.range ?? null,
      headers: req.headers
    })
    if (server.mode === '404') {
      res.writeHead(404).end('nope')
      return
    }
    const body = server.mode === 'corrupt' ? Buffer.from(CONTENT).fill(7, 1000, 2000) : CONTENT
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (m && server.mode !== 'ignore-range') {
      const start = Number(m[1])
      res.writeHead(206, {
        'Content-Length': SIZE - start,
        'Content-Range': `bytes ${start}-${SIZE - 1}/${SIZE}`
      })
      res.end(body.subarray(start))
      return
    }
    res.writeHead(200, { 'Content-Length': SIZE })
    if (server.mode === 'cut') {
      res.write(body.subarray(0, server.cutAt), () => setTimeout(() => res.socket.destroy(), 20))
      return
    }
    res.end(body)
  })
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${httpServer.address().port}/model`
})

after(() => httpServer.close())

let dir
let finalPath
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scs-model-'))
  finalPath = join(dir, 'models', EXPECTED.filename)
  server.mode = 'ok'
  server.requests = []
})

const download = (extra = {}) =>
  downloadModel({ url, finalPath, expected: EXPECTED, fetchImpl: fetch, getFree: plenty, ...extra })

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e.code === code)

/** A usable model already in place (imported + verified). */
async function installGoodModel() {
  const src = join(dir, EXPECTED.filename)
  writeFileSync(src, CONTENT)
  await importModel({ sourcePath: src, finalPath, expected: EXPECTED, getFree: plenty })
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
  return { marker: readFileSync(markerPathFor(finalPath), 'utf8') }
}

function assertGoodModelUntouched(before) {
  assert.ok(readFileSync(finalPath).equals(CONTENT), 'model bytes unchanged')
  assert.equal(readFileSync(markerPathFor(finalPath), 'utf8'), before.marker, 'marker unchanged')
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
}

test('fresh download: verified, moved into place, only the model URL requested', async () => {
  const steps = new Set()
  await download({ onProgress: (p) => steps.add(p.step) })
  assert.ok(readFileSync(finalPath).equals(CONTENT))
  assert.equal(existsSync(partPathFor(finalPath)), false)
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
  assert.deepEqual([...steps], ['download'])
  assert.equal(server.requests.length, 1)
  const req = server.requests[0]
  assert.equal(req.method, 'GET')
  assert.equal(req.url, '/model')
  assert.equal(req.headers['content-length'], undefined, 'no request body')
  rmSync(dir, { recursive: true, force: true })
})

test('interrupted download keeps the .part file and resumes with Range', async () => {
  server.mode = 'cut'
  server.cutAt = 1024 * 1024
  await rejectsWith(download(), STORE_ERROR.NETWORK_ERROR)
  const partSize = statSync(partPathFor(finalPath)).size
  assert.ok(partSize > 0 && partSize < SIZE, `partial ${partSize}`)
  assert.equal(existsSync(finalPath), false)

  server.mode = 'ok'
  const steps = new Set()
  await download({ onProgress: (p) => steps.add(p.step) })
  assert.equal(server.requests.at(-1).range, `bytes=${partSize}-`)
  assert.ok(steps.has('resume-check'))
  assert.ok(readFileSync(finalPath).equals(CONTENT))
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
  rmSync(dir, { recursive: true, force: true })
})

test('a server that ignores Range restarts the download from zero', async () => {
  server.mode = 'cut'
  server.cutAt = 512 * 1024
  await rejectsWith(download(), STORE_ERROR.NETWORK_ERROR)
  server.mode = 'ignore-range'
  await download()
  assert.ok(server.requests.at(-1).range)
  assert.ok(readFileSync(finalPath).equals(CONTENT))
  rmSync(dir, { recursive: true, force: true })
})

test('hash mismatch deletes the download and keeps the existing model', async () => {
  const before = await installGoodModel()
  server.mode = 'corrupt'
  await rejectsWith(download(), STORE_ERROR.HASH_MISMATCH)
  assert.equal(existsSync(partPathFor(finalPath)), false)
  assertGoodModelUntouched(before)
  rmSync(dir, { recursive: true, force: true })
})

test('not enough disk space: nothing is requested and the existing model stays', async () => {
  const before = await installGoodModel()
  await rejectsWith(download({ getFree: async () => SIZE }), STORE_ERROR.INSUFFICIENT_SPACE)
  assert.equal(server.requests.length, 0)
  assertGoodModelUntouched(before)
  rmSync(dir, { recursive: true, force: true })
})

test('cancel keeps the .part file and the existing model; the next attempt resumes', async () => {
  const before = await installGoodModel()
  const controller = new AbortController()
  await rejectsWith(
    download({ signal: controller.signal, onProgress: () => controller.abort() }),
    STORE_ERROR.CANCELLED
  )
  assert.ok(existsSync(partPathFor(finalPath)))
  assertGoodModelUntouched(before)
  await download()
  assert.ok(readFileSync(finalPath).equals(CONTENT))
  rmSync(dir, { recursive: true, force: true })
})

test('HTTP errors are reported', async () => {
  server.mode = '404'
  await rejectsWith(download(), STORE_ERROR.HTTP_ERROR)
  assert.equal(existsSync(finalPath), false)
  rmSync(dir, { recursive: true, force: true })
})

test('import checks name, size and SHA-256 before anything reaches the model folder', async () => {
  const before = await installGoodModel()

  const imp = (sourcePath) =>
    importModel({ sourcePath, finalPath, expected: EXPECTED, getFree: plenty })

  const wrongName = join(dir, 'other.gguf')
  writeFileSync(wrongName, CONTENT)
  await rejectsWith(imp(wrongName), STORE_ERROR.NAME_MISMATCH)

  mkdirSync(join(dir, 'x'))
  const wrongSize = join(dir, 'x', EXPECTED.filename)
  writeFileSync(wrongSize, CONTENT.subarray(0, SIZE - 1))
  await rejectsWith(imp(wrongSize), STORE_ERROR.SIZE_MISMATCH)

  // Same name in another case, right size, wrong bytes.
  mkdirSync(join(dir, 'y'))
  const wrongHash = join(dir, 'y', 'TEST-MODEL.GGUF')
  writeFileSync(wrongHash, Buffer.from(CONTENT).fill(1, 0, 10))
  await rejectsWith(imp(wrongHash), STORE_ERROR.HASH_MISMATCH)
  assert.equal(existsSync(importPartPathFor(finalPath)), false, 'temp copy removed')

  assertGoodModelUntouched(before)
  rmSync(dir, { recursive: true, force: true })
})

test('importing the file already in the model folder verifies it in place', async () => {
  mkdirSync(join(dir, 'models'))
  writeFileSync(finalPath, CONTENT)
  assert.equal(getModelFileState(finalPath, EXPECTED), 'unverified')
  await importModel({
    sourcePath: finalPath,
    finalPath,
    expected: EXPECTED,
    getFree: async () => 0
  })
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
  rmSync(dir, { recursive: true, force: true })
})

test('file state: missing / invalid / unverified / ready, and a changed file needs re-verification', async () => {
  assert.equal(getModelFileState(finalPath, EXPECTED), 'missing')
  mkdirSync(join(dir, 'models'))
  writeFileSync(finalPath, CONTENT.subarray(0, 10))
  assert.equal(getModelFileState(finalPath, EXPECTED), 'invalid')
  writeFileSync(finalPath, Buffer.from(CONTENT).fill(0, 0, 5))
  assert.equal(getModelFileState(finalPath, EXPECTED), 'unverified')
  await rejectsWith(verifyInPlace({ finalPath, expected: EXPECTED }), STORE_ERROR.HASH_MISMATCH)
  assert.equal(existsSync(finalPath), true, 'a failed verification leaves the file alone')
  assert.equal(getModelFileState(finalPath, EXPECTED), 'unverified')

  writeFileSync(finalPath, CONTENT)
  await verifyInPlace({ finalPath, expected: EXPECTED })
  assert.equal(getModelFileState(finalPath, EXPECTED), 'ready')
  const later = new Date(Date.now() + 60_000)
  utimesSync(finalPath, later, later)
  assert.equal(getModelFileState(finalPath, EXPECTED), 'unverified')
  rmSync(dir, { recursive: true, force: true })
})
