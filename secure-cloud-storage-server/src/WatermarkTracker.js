/**
 * Server-side keyed encoding for watermark user IDs.
 *
 * Threat model
 * ────────────
 * An attacker who manages to overwrite (or fabricate) the invisible watermark
 * inside a leaked document could otherwise embed any uid string they want and
 * frame an arbitrary user. By encoding uid with a server-only secret BEFORE
 * embedding, that attack stops working: without the key, computing the correct
 * tracked uid for someone else is computationally infeasible.
 *
 * The honest server keeps the key, so it can deterministically encode users
 * (for embedding at download time) and decode any embedded value back to the
 * plain uid (for forensic tracing).
 *
 * Construction
 * ────────────
 *   IV  = HMAC-SHA256(key, plain).slice(0, 16)
 *   CT  = AES-256-CBC(key, IV, plain)
 *   tracked = 'v1' + hex(IV) + hex(CT)
 *
 * - Same plain uid always yields the same tracked uid (stable mapping; allows
 *   prefix-based DB lookup from the visible watermark, which only carries 8
 *   hex chars of the IV).
 * - IV is included so decryption needs only the key (no separate state).
 * - Without the key, the IV alone reveals nothing about the plain uid (it's
 *   pseudo-random output of HMAC).
 *
 * Key management
 * ──────────────
 * - Auto-generated as 32 random bytes on first run, persisted to
 *   `<certs>/watermark.key` with mode 600.
 * - Operator should back this file up; losing it means historical watermarks
 *   become un-decodable. Replacing it would invalidate all previously embedded
 *   watermarks.
 */
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from './Logger.js'
import ConfigManager from './ConfigManager.js'

const VERSION_PREFIX = 'v1'
const IV_BYTES = 16
const KEY_BYTES = 32

let cachedKey = null

function getKeyPath() {
  // Reuse the certs directory; this is operator-managed secret material.
  const dir = ConfigManager.directoryConfig?.certs || 'certs'
  return join(dir, 'watermark.key')
}

function loadOrCreateKey() {
  if (cachedKey) return cachedKey
  const p = getKeyPath()
  if (existsSync(p)) {
    const buf = readFileSync(p)
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `[WatermarkTracker] watermark.key has invalid length: ${buf.length} (expected ${KEY_BYTES})`
      )
    }
    cachedKey = buf
    logger.info('[WatermarkTracker] Loaded existing watermark tracking key.')
    return cachedKey
  }
  cachedKey = crypto.randomBytes(KEY_BYTES)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, cachedKey, { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch (_) {
    // chmod can fail on Windows; not fatal.
  }
  logger.warn(
    `[WatermarkTracker] Generated NEW watermark tracking key at ${p} — back this file up.`
  )
  return cachedKey
}

/**
 * Deterministically encode a plain uid into a tracked uid that can be embedded
 * in watermarks. Same input always yields the same output.
 *
 * @param {string} plainUid
 * @returns {string} tracked uid, hex-encoded with the version prefix
 */
export function encodeTrackedUid(plainUid) {
  if (typeof plainUid !== 'string' || plainUid.length === 0) {
    throw new Error('encodeTrackedUid requires a non-empty string')
  }
  const key = loadOrCreateKey()
  const iv = crypto.createHmac('sha256', key).update(plainUid).digest().slice(0, IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(plainUid, 'utf8'), cipher.final()])
  return VERSION_PREFIX + iv.toString('hex') + ct.toString('hex')
}

/**
 * Reverse `encodeTrackedUid`, verifying authenticity. Throws on malformed
 * input, wrong key, OR a failed integrity check (i.e. the value was tampered
 * with or forged).
 *
 * Integrity model: by construction (see `encodeTrackedUid`) the IV IS
 * `HMAC-SHA256(key, plain)[:16]` — a keyed tag bound to the plaintext. After
 * decrypting we recompute that HMAC from the recovered plaintext and require an
 * exact match with the embedded IV. An attacker without the key cannot produce
 * a (IV, ciphertext) pair that satisfies this, so any edited/forged tracked uid
 * — even one that happens to AES-decrypt with valid PKCS#7 padding — is
 * rejected as tampered.
 *
 * @param {string} tracked
 * @returns {string} plain uid
 */
export function decodeTrackedUid(tracked) {
  if (typeof tracked !== 'string' || !tracked.startsWith(VERSION_PREFIX)) {
    throw new Error('Unsupported tracked-uid version')
  }
  const key = loadOrCreateKey()
  const body = tracked.slice(VERSION_PREFIX.length)
  const ivHex = body.slice(0, IV_BYTES * 2)
  const ctHex = body.slice(IV_BYTES * 2)
  if (ivHex.length !== IV_BYTES * 2 || ctHex.length === 0) {
    throw new Error('Malformed tracked uid')
  }
  const iv = Buffer.from(ivHex, 'hex')
  const ct = Buffer.from(ctHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')

  // Authenticity / integrity check: the IV must equal HMAC-SHA256(key, plain).
  const expectedIv = crypto.createHmac('sha256', key).update(plain).digest().slice(0, IV_BYTES)
  if (iv.length !== expectedIv.length || !crypto.timingSafeEqual(iv, expectedIv)) {
    throw new Error('Watermark integrity check failed — tracked uid is tampered or forged')
  }
  return plain
}

/**
 * Visible watermarks only embed a short hex prefix (8 hex chars) of the
 * tracked uid (after stripping the version prefix). Given that prefix and the
 * full set of users, find the candidate plain uids whose tracked encoding
 * starts with the same prefix.
 *
 * Returns ALL matches because, for very short prefixes, collisions are
 * theoretically possible (probability ≈ users / 16^prefix.length). With 8 hex
 * chars (32 bits) collisions need ≳ 65k users to hit chance > 50%, so in
 * practice this returns 0 or 1 elements.
 *
 * @param {Array<{id:string}>} users
 * @param {string} prefix       lowercase hex prefix as embedded in visible watermark
 * @returns {string[]} matching plain uids
 */
export function findUserIdsByShortPrefix(users, prefix) {
  if (!Array.isArray(users) || typeof prefix !== 'string' || prefix.length === 0) return []
  const lcPrefix = prefix.toLowerCase()
  const matches = []
  for (const u of users) {
    if (!u?.id) continue
    let tracked
    try {
      tracked = encodeTrackedUid(u.id)
    } catch {
      continue
    }
    const shortTracked = tracked.replace(/^v\d+/, '').slice(0, lcPrefix.length).toLowerCase()
    if (shortTracked === lcPrefix) matches.push(u.id)
  }
  return matches
}

/**
 * Heuristic: looks like a full tracked uid (version prefix + IV + ciphertext).
 * Used by the decode endpoint to pick between direct decryption and prefix lookup.
 */
export function isFullTrackedUid(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(VERSION_PREFIX) &&
    value.length >= VERSION_PREFIX.length + IV_BYTES * 2 + 2
  )
}

console.debug('WatermarkTracker.js loaded.')
