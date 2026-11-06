#!/usr/bin/env node
/**
 * End-to-end check of the admin / agent-log socket events against a running
 * server, logging in with THIS machine's client keys (userData/user.keys).
 *
 *   node scripts/admin_e2e.mjs
 *
 * The desktop client must NOT be logged in at the same time (the server
 * refuses a second login of the same account).
 */
import { io } from 'socket.io-client'
import { pre_schema1_DecryptLevel1 } from '@aldenml/ecc'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const SERVER = process.env.SERVER_URL || 'https://localhost:3001'
const keyFile = join(homedir(), 'Library/Application Support/client-side/user.keys')
const [pkB64, skB64] = readFileSync(keyFile, 'utf8').split('\n')
const sk = new Uint8Array(Buffer.from(skB64, 'base64'))

const socket = io(SERVER, { rejectUnauthorized: false, transports: ['websocket'] })
const emit = (event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(15000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)))
  })
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

await new Promise((resolve, reject) => {
  socket.on('connect', resolve)
  socket.on('connect_error', reject)
})

// ── Not logged in: admin event must be refused ─────────────────────
let r = await emit('admin-list-users', {})
check('admin-list-users refused when not logged in', r?.errorMsg === 'Not logged in.', r?.errorMsg)
r = await emit('get-agent-file-scope', {})
check('get-agent-file-scope refused when not logged in', r?.errorMsg === 'Not logged in.', r?.errorMsg)

// ── Login with the client's PRE keys ───────────────────────────────
r = await emit('login', { publicKey: pkB64 })
if (r?.errorMsg) throw new Error('login: ' + r.errorMsg)
const msg = await pre_schema1_DecryptLevel1(
  new Uint8Array(Buffer.from(r.cipher, 'base64')),
  sk,
  new Uint8Array(Buffer.from(r.spk, 'base64'))
)
r = await emit('auth-res', { decryptedValue: Buffer.from(msg).toString('base64') })
if (r?.errorMsg) throw new Error('auth-res: ' + r.errorMsg)
const me = r.userInfo
check('login returns role', typeof me.role === 'string', `role=${me.role}`)
const isAdmin = me.role === 'admin'

// ── Smart-search scope ─────────────────────────────────────────────
r = await emit('get-agent-file-scope', {})
const scopeFiles = r?.files ? JSON.parse(r.files) : null
const ownFiles = scopeFiles ? scopeFiles.filter((f) => f.ownerId === me.userId) : []
const foreign = scopeFiles ? scopeFiles.filter((f) => f.ownerId !== me.userId) : []
check('get-agent-file-scope returns own + public files with ownerName',
  Array.isArray(scopeFiles) && foreign.every((f) => f.permissions === 1) && scopeFiles.every((f) => typeof f.ownerName === 'string' && Array.isArray(f.tags)),
  scopeFiles ? `${scopeFiles.length} file(s): own=${ownFiles.length}, public-others=${foreign.length}, folders=${JSON.parse(r.folders).length}` : r?.errorMsg)
check('foreign files carry no cipher/spk', Array.isArray(scopeFiles) && foreign.every((f) => f.cipher === undefined && f.spk === undefined))

// ── Agent log + history ────────────────────────────────────────────
const conversationId = randomUUID()
r = await emit('agent-log', {
  conversationId,
  provider: 'ollama',
  userMessage: 'e2e 測試：找海軍相關的文章',
  assistantMessage: 'e2e 測試回覆',
  matchedFileIds: []
})
check('agent-log accepted', r && !r.errorMsg, r?.errorMsg)
r = await emit('agent-log', { conversationId, userMessage: 'bad', assistantMessage: 'x', matchedFileIds: ['not-a-uuid'] })
check('agent-log rejects invalid file id', r?.errorMsg === 'Invalid arguments.', r?.errorMsg)
r = await emit('agent-my-history', { limit: 5 })
const mine = r?.conversations?.find((c) => c.id === conversationId)
check('agent-my-history returns the new conversation', !!mine && mine.messages.length === 2,
  mine ? `${mine.messages.length} messages, roles=${mine.messages.map((m) => m.role).join(',')}` : r?.errorMsg)

// ── Admin events ───────────────────────────────────────────────────
r = await emit('admin-list-users', {})
if (isAdmin) {
  check('admin-list-users returns users with counters',
    Array.isArray(r?.users) && r.users.some((u) => u.id === me.userId && typeof u.conversationCount === 'number'),
    r?.users ? `${r.users.length} user(s)` : r?.errorMsg)
  r = await emit('admin-export-conversations', { userId: me.userId })
  const msgs = Array.isArray(r?.messages) ? r.messages : []
  const mineInExport = msgs.filter((m) => m.conversationId === conversationId)
  check('admin-export-conversations includes the logged turn',
    mineInExport.length === 2 && r.user?.id === me.userId,
    r?.errorMsg || `${msgs.length} message(s) in ${r?.sessionCount} session(s)`)
  const ids = msgs.map((m) => m.id)
  check('export holds no duplicate messages', new Set(ids).size === ids.length,
    `${ids.length - new Set(ids).size} duplicate(s)`)
  const times = msgs.map((m) => new Date(m.timestamp).getTime())
  const ordered = times.every((t, i) => i === 0 || t >= times[i - 1])
  check('export is a single list ordered oldest-first', ordered,
    ordered ? '' : 'messages out of order')
  r = await emit('admin-export-conversations', { userId: 'nope' })
  check('admin-export-conversations rejects bad userId', r?.errorMsg === 'Invalid arguments.', r?.errorMsg)
  r = await emit('admin-user-download-logs', { userId: me.userId })
  check('admin-user-download-logs returns array', Array.isArray(r?.logs), r?.logs ? `${r.logs.length} log(s)` : r?.errorMsg)
  r = await emit('decode-watermark-uid', { value: 'deadbeef' })
  check('decode-watermark-uid allowed for admin', r && !r.errorMsg, r?.errorMsg || `matches=${r?.matches?.length}`)
} else {
  check('admin-list-users refused for non-admin', r?.errorMsg === 'Admin only.', r?.errorMsg)
  r = await emit('decode-watermark-uid', { value: 'deadbeef' })
  check('decode-watermark-uid refused for non-admin', r?.errorMsg === 'Admin only.', r?.errorMsg)
}

// ── Clean up ───────────────────────────────────────────────────────
// The turns above were written to the real account's audit log. Remove them
// so exported conversation histories stay free of test data. The purge is a
// local server-side command; there is deliberately no socket event for it.
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../secure-cloud-storage-server')
try {
  execFileSync('node', ['scripts/purge-agent-log.mjs', conversationId, '--yes'], {
    cwd: serverDir,
    stdio: 'pipe'
  })
  r = await emit('agent-my-history', { limit: 50 })
  const leftBehind = r?.conversations?.some((c) => c.id === conversationId)
  check('e2e conversation purged from the audit log', !leftBehind,
    leftBehind ? 'test turns left behind in the log' : '')
} catch (e) {
  check('e2e conversation purged from the audit log', false, e.message)
}

const failed = results.filter((x) => !x.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed (role=${me.role})`)
socket.disconnect()
process.exit(failed ? 1 : 0)
