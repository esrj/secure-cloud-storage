/**
 * This file keeps secrets out of the logs.
 *
 * Handlers log the request they received, and the authentication request carries the answer
 * to the login challenge, which must never be written down. The winston format exported here
 * masks such fields by name, at any depth, just before a line is written. It works on a copy,
 * so the objects the handlers go on to use are never changed.
 *
 * Same module as the Cloud Server's src/LogRedaction.js; keep the two in step.
 */
import { format } from 'winston'

export const REDACTED = '[REDACTED]'

// Field names to mask, compared case-insensitively.
const SENSITIVE_KEYS = new Set(
  [
    // Challenge-response login: the client's answer and the value it is checked against
    'decryptedValue',
    'randKey',
    // Email one-time code: the client's answer and the value it is checked against
    'emailAuth',
    'socketEmailAuth',
    // Account recovery: Shamir shares and security-key material
    'share',
    'shares',
    'credential',
    'assertion',
    // Proxy re-encryption key and search key
    'rekey',
    'SK',
    // Generic credentials, in case a config object or header set is ever logged
    'password',
    'pass',
    'secret',
    'token',
    'apiKey',
    'privateKey',
    'walletKey',
    'authorization',
    'cookie'
  ].map((key) => key.toLowerCase())
)

// Deeper than any real request; stops a hostile, deeply nested payload from exhausting the stack.
const MAX_DEPTH = 12
const SPLAT = Symbol.for('splat') // winston keeps the original, unmasked arguments here

const isSensitiveKey = (key) => SENSITIVE_KEYS.has(key.toLowerCase())
const isEmpty = (value) => value === undefined || value === null || value === ''
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Copy a value with every sensitive field replaced by a marker.
 * Plain objects and arrays are walked. Anything else (strings, numbers, bigints, Buffers,
 * Errors, class instances) is returned as is. Empty fields stay empty, so a line still shows
 * that a field was missing.
 * @param {*} value
 * @returns {*} the masked copy; the input is not modified
 */
export const redact = (value, depth = 0, seen = new WeakMap()) => {
  const isArray = Array.isArray(value)
  if (!isArray && !isPlainObject(value)) return value
  if (seen.has(value)) return seen.get(value)
  if (depth >= MAX_DEPTH) return '[Truncated]'
  const copy = isArray ? [] : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    const item = value[key]
    const masked = !isArray && isSensitiveKey(key) && !isEmpty(item)
    // defineProperty, so a field literally named "__proto__" stays an ordinary field
    Object.defineProperty(copy, key, {
      value: masked ? REDACTED : redact(item, depth + 1, seen),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return copy
}

/**
 * Winston format that masks sensitive fields in everything about to be logged.
 * Put it after format.errors(), which turns Error objects into plain fields first.
 * It never throws: a logging problem must not take a request handler down with it.
 */
export const redactSensitive = format((info) => {
  try {
    const masked = redact({ ...info })
    // Object spread keeps winston's symbol keys (the level); the walk above does not.
    for (const symbol of Object.getOwnPropertySymbols(info)) {
      if (symbol !== SPLAT) masked[symbol] = info[symbol]
    }
    return masked
  } catch {
    const fallback = { level: info.level, message: 'Log entry withheld: it could not be masked.' }
    for (const symbol of Object.getOwnPropertySymbols(info)) {
      if (symbol !== SPLAT) fallback[symbol] = info[symbol]
    }
    return fallback
  }
})
