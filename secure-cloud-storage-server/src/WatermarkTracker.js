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
 * The honest server keeps the key, so it can encode users (for embedding at
 * download time) and decode any embedded value back to the plain uid (for
 * forensic tracing).
 *
 * Construction (implemented in TrackedUid.js)
 * ────────────
 *   tag = HMAC-SHA256(key, plain).slice(0, 16)
 *   IV  = 16 random bytes, new for every encoding
 *   CT  = AES-256-CBC(key, IV, plain)
 *   tracked = 'v2' + hex(tag) + hex(IV) + hex(CT)
 *
 * - Every tracked uid of one user starts with the same tag (stable prefix;
 *   allows prefix-based lookup from the visible watermark, which only carries
 *   8 hex chars of the tag). The rest differs from one download to the next.
 * - IV is included so decryption needs only the key (no separate state).
 * - Without the key, the tag alone reveals nothing about the plain uid (it's
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
import { decodeWithKey, encodeWithKey, looksFull, matchesPrefixWithKey } from './TrackedUid.js'

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
 * Encode a plain uid into a tracked uid that can be embedded in watermarks.
 * Every encoding of the same uid starts with the same tag; the rest is new
 * each time (random IV).
 *
 * @param {string} plainUid
 * @returns {string} tracked uid, hex-encoded with the version prefix
 */
export function encodeTrackedUid(plainUid) {
  return encodeWithKey(loadOrCreateKey(), plainUid)
}

/**
 * Reverse `encodeTrackedUid`, verifying authenticity. Throws on malformed
 * input, wrong key, OR a failed integrity check (i.e. the value was tampered
 * with or forged).
 *
 * Integrity model: by construction (see TrackedUid.js) the tag IS
 * `HMAC-SHA256(key, plain)[:16]` — a keyed tag bound to the plaintext. After
 * decrypting we recompute that HMAC from the recovered plaintext and require an
 * exact match with the embedded tag. An attacker without the key cannot produce
 * a (tag, IV, ciphertext) triple that satisfies this, so any edited/forged
 * tracked uid — even one that happens to AES-decrypt with valid PKCS#7 padding
 * — is rejected as tampered.
 *
 * @param {string} tracked
 * @returns {string} plain uid
 */
export function decodeTrackedUid(tracked) {
  return decodeWithKey(loadOrCreateKey(), tracked)
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
    let same
    try {
      same = matchesPrefixWithKey(loadOrCreateKey(), u.id, lcPrefix)
    } catch {
      continue
    }
    if (same) matches.push(u.id)
  }
  return matches
}

/**
 * Heuristic: looks like a full tracked uid (version prefix + tag + IV + ciphertext).
 * Used by the decode endpoint to pick between direct decryption and prefix lookup.
 */
export function isFullTrackedUid(value) {
  return looksFull(value)
}

console.debug('WatermarkTracker.js loaded.')
