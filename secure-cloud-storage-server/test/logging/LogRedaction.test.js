// Run: node --test test/logging/*.test.js
// Secrets carried by a request must not reach the log, and masking them must not change
// the request object the handler goes on to use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Transport from 'winston-transport'
import { REDACTED, redact, redactSensitive } from '../../src/LogRedaction.js'
import {
  logger,
  logInvalidSchemaWarning,
  logSocketError,
  logSocketInfo,
  logSocketWarning
} from '../../src/Logger.js'

const MESSAGE = Symbol.for('message') // the line winston actually writes

/** Collects the lines the server's own logger would have written. */
class Capture extends Transport {
  lines = []
  log(info, callback) {
    this.lines.push(info[MESSAGE])
    callback()
  }
}
const capture = new Capture()
for (const transport of logger.transports) transport.silent = true // keep test output readable
logger.add(capture)
const lastLine = () => capture.lines.at(-1)
const lastEntry = () => JSON.parse(lastLine())

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}
const socket = { ip: '::ffff:10.0.0.7', userId: 'user-1', event: 'auth-res' }

test('redact masks secret fields at any depth, whatever the letter case', () => {
  const masked = redact({
    decryptedValue: 'answer',
    RANDKEY: 'expected',
    emailAuth: 'A1B2C3',
    socketEmailAuth: 'A1B2C3',
    nested: { shares: ['s1', 's2'], deeper: [{ rekey: 'rk' }, { credential: { id: 'x' } }] },
    assertion: { signature: 'sig' },
    SK: { sk1: 'a' },
    smtp: { user: 'u', pass: 'p', apiKey: 'k' }
  })
  assert.deepEqual(masked, {
    decryptedValue: REDACTED,
    RANDKEY: REDACTED,
    emailAuth: REDACTED,
    socketEmailAuth: REDACTED,
    nested: { shares: REDACTED, deeper: [{ rekey: REDACTED }, { credential: REDACTED }] },
    assertion: REDACTED,
    SK: REDACTED,
    smtp: { user: 'u', pass: REDACTED, apiKey: REDACTED }
  })
})

test('redact leaves ordinary request fields exactly as they were', () => {
  const request = {
    // the base64 fields of an upload request, as they arrive on the wire
    ...JSON.parse('{"publicKey": "cGs=", "cipher": "Y2lwaGVy", "spk": "c3Br"}'),
    fileId: 'f3b0c1d2-0000-4000-8000-000000000000',
    parentFolderId: null,
    permission: 2,
    agreed: false,
    tags: ['a', 'b'],
    CTw: { ctStar: 'ab', ctw: ['cd'], ct: ['ef'] },
    fileHash: 123n,
    description: 'the password is in the description text, not in a field called password'
  }
  assert.deepEqual(redact(request), request)
})

test('redact never modifies its input', () => {
  const request = deepFreeze({
    decryptedValue: 'answer',
    shares: ['s1', 's2'],
    nested: { rekey: 'rk', list: [{ token: 't' }] }
  })
  const masked = redact(request) // a write to a frozen object would throw in a module
  assert.notEqual(masked, request)
  assert.notEqual(masked.nested, request.nested)
  assert.equal(request.decryptedValue, 'answer')
  assert.deepEqual(request.shares, ['s1', 's2'])
  assert.equal(request.nested.list[0].token, 't')
})

test('redact keeps empty secret fields empty and passes other value types through', () => {
  const date = new Date(0)
  const buffer = Buffer.from('abc')
  const error = new Error('boom')
  const masked = redact({
    decryptedValue: undefined,
    emailAuth: null,
    shares: '',
    date,
    buffer,
    error,
    n: 0,
    b: false
  })
  assert.equal(masked.decryptedValue, undefined)
  assert.equal(masked.emailAuth, null)
  assert.equal(masked.shares, '')
  assert.equal(masked.date, date)
  assert.equal(masked.buffer, buffer)
  assert.equal(masked.error, error)
  assert.equal(masked.n, 0)
  assert.equal(masked.b, false)
  for (const value of ['text', 7, 7n, true, null, undefined]) assert.equal(redact(value), value)
})

test('redact survives cycles, absurd nesting and a field named __proto__', () => {
  const cyclic = { name: 'loop', token: 't' }
  cyclic.self = cyclic
  const masked = redact(cyclic)
  assert.equal(masked.self, masked)
  assert.equal(masked.token, REDACTED)

  let deep = { decryptedValue: 'bottom' }
  for (let i = 0; i < 50000; i++) deep = { child: deep }
  const flat = JSON.stringify(redact(deep))
  assert.ok(flat.includes('[Truncated]'))
  assert.ok(!flat.includes('bottom'))

  const hostile = JSON.parse('{"__proto__": {"polluted": true, "password": "p"}, "a": 1}')
  const copy = redact(hostile)
  assert.equal(Object.getPrototypeOf(copy), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.equal(copy.polluted, undefined)
  assert.deepEqual(Object.keys(copy), ['__proto__', 'a'])
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(copy, '__proto__').value,
    JSON.parse(`{"polluted": true, "password": "${REDACTED}"}`)
  )
})

test("the server's logger masks a request that is logged whole", () => {
  const request = { decryptedValue: 'c2VjcmV0LWFuc3dlcg==' }
  logSocketWarning(
    socket,
    'Client responds to authentication without asking to login or register.',
    request
  )
  assert.ok(!lastLine().includes('c2VjcmV0LWFuc3dlcg=='))
  const entry = lastEntry()
  assert.equal(entry.decryptedValue, REDACTED)
  assert.equal(entry.level, 'warn')
  assert.equal(
    entry.message,
    'Client responds to authentication without asking to login or register.'
  )
  assert.equal(entry.ip, socket.ip)
  assert.equal(entry.userId, socket.userId)
  assert.equal(entry.event, socket.event)
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  // the handler still sees the real value
  assert.equal(request.decryptedValue, 'c2VjcmV0LWFuc3dlcg==')
})

test("the server's logger masks shares, email codes and re-encryption keys", () => {
  const shares = ['c2hhcmUtb25l', 'c2hhcmUtdHdv', 'c2hhcmUtdGhyZWU=']
  const shareRequest = { shares }
  logSocketInfo(socket, 'Client asks to share secret.', shareRequest)
  assert.equal(lastEntry().shares, REDACTED)
  for (const share of shares) assert.ok(!lastLine().includes(share))
  assert.deepEqual(shareRequest.shares, shares)

  logSocketInfo(socket, 'Client asks to respond to email auth.', { emailAuth: 'K7Q2ZD' })
  assert.equal(lastEntry().emailAuth, REDACTED)
  assert.ok(!lastLine().includes('K7Q2ZD'))

  const respond = { requestId: 'r-1', agreed: true, description: 'ok', rekey: 'cmVrZXktYnl0ZXM=' }
  logSocketInfo(socket, 'Client asks to respond to request.', respond)
  assert.deepEqual(
    { ...lastEntry(), timestamp: undefined },
    {
      ...socket,
      requestId: 'r-1',
      agreed: true,
      description: 'ok',
      rekey: REDACTED,
      level: 'info',
      message: 'Client asks to respond to request.',
      timestamp: undefined
    }
  )
  assert.equal(respond.rekey, 'cmVrZXktYnl0ZXM=')
})

test("the server's logger masks an invalid request and keeps the validation issues", () => {
  const issues = [
    { code: 'invalid_type', expected: 'string', path: ['decryptedValue'], message: 'Invalid input' }
  ]
  logInvalidSchemaWarning(socket, 'Client responds to authentication', issues, {
    decryptedValue: 12345,
    extra: { token: 'tok-1' }
  })
  const entry = lastEntry()
  assert.equal(entry.message, 'Client responds to authentication with invalid arguments.')
  assert.deepEqual(entry.issues, issues)
  assert.equal(entry.decryptedValue, REDACTED)
  assert.equal(entry.extra.token, REDACTED)
  assert.ok(!lastLine().includes('12345') && !lastLine().includes('tok-1'))
})

test("the server's logger still reports errors with their stack and extra fields", () => {
  // extra fields as a database driver might attach them to its error
  const error = Object.assign(
    new Error('relation "users" does not exist'),
    JSON.parse('{"code": "42P01", "password": "from-a-driver"}')
  )
  logSocketError(socket, error, { fileId: 'file-1', rekey: 'cmVrZXk=' })
  let entry = lastEntry()
  assert.equal(entry.level, 'error')
  assert.equal(entry.message, 'relation "users" does not exist')
  assert.match(entry.stack, /^Error: relation "users" does not exist\n\s+at /)
  assert.equal(entry.code, '42P01')
  assert.equal(entry.fileId, 'file-1')
  assert.equal(entry.userId, socket.userId)
  assert.equal(entry.rekey, REDACTED)
  assert.equal(entry.password, REDACTED)

  logger.error(new Error('bare error')) // the single-argument form used across the server
  entry = lastEntry()
  assert.equal(entry.message, 'bare error')
  assert.match(entry.stack, /^Error: bare error\n/)

  logger.warn('Blockchain diagnosis error: timeout')
  assert.deepEqual(
    { ...lastEntry(), timestamp: undefined },
    { level: 'warn', message: 'Blockchain diagnosis error: timeout', timestamp: undefined }
  )
})

test("the server's logger does not modify an object that is logged directly", () => {
  // CLIListener forwards CLI log entries this way: logger.log(req.body)
  const body = {
    level: 'info',
    message: 'from the CLI',
    token: 'cli-token',
    detail: { secret: 's' }
  }
  logger.log(body)
  const entry = lastEntry()
  assert.equal(entry.message, 'from the CLI')
  assert.equal(entry.token, REDACTED)
  assert.equal(entry.detail.secret, REDACTED)
  assert.equal(body.token, 'cli-token')
  assert.equal(body.detail.secret, 's')
})

test('the format withholds an entry it cannot mask instead of throwing', () => {
  const LEVEL = Symbol.for('level')
  const info = { level: 'info', message: 'm', [LEVEL]: 'info' }
  Object.defineProperty(info, 'broken', {
    enumerable: true,
    get() {
      throw new Error('getter failed')
    }
  })
  const out = redactSensitive().transform(info)
  assert.equal(out.level, 'info')
  assert.equal(out[LEVEL], 'info')
  assert.equal(out.message, 'Log entry withheld: it could not be masked.')
  assert.deepEqual(Object.keys(out), ['level', 'message'])
})
