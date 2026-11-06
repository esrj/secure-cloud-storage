/**
 * FidoProvider: bridge between the Electron main process and the FIDO2 security key
 * (YubiKey Bio / Idem Key) for fingerprint-based account recovery.
 *
 * It spawns resources/fido/fido_helper.py (python-fido2) once per operation and talks
 * newline-delimited JSON over stdin/stdout. See the helper's docstring for the protocol.
 *
 * The two core actions from the recovery plan:
 *   register()     – bind: create a credential and derive the device secret for `salt`
 *   authenticate() – recover: fingerprint again and re-derive the same secret
 *
 * The device secret is returned as a Buffer and must never be sent to the server.
 * Turn it into an extra key with deriveExtraKeyFromFidoSecret(), then zero it with
 * secret.fill(0).
 *
 * This module only depends on Node built-ins so it can be unit tested without Electron.
 */
import { spawn } from 'node:child_process'
import { hkdfSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_RP_ID = 'secure-cloud-storage.local'
const DEFAULT_TIMEOUT_MS = 120_000
const EXTRA_KEY_INFO = 'secure-cloud-storage/recovery/fido-v1'

export class FidoError extends Error {
  /**
   * @param {string} code e.g. NO_DEVICE, PIN_INVALID, UV_FAILED, WRONG_KEY, CANCELLED, TIMEOUT
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'FidoError'
    this.code = code
  }
}

/**
 * Locate fido_helper.py for dev and packaged builds.
 * electron-builder.yml copies resources/fido/*.py via extraResources, so in production
 * the script lives under process.resourcesPath/fido. (Older builds unpacked resources/**
 * out of the asar; that location is still probed first for compatibility.)
 * @param {{ appPath: string, resourcesPath?: string }} paths
 */
export function resolveHelperPath({ appPath, resourcesPath }) {
  const candidates = [
    join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'fido', 'fido_helper.py'),
    join(appPath, 'resources', 'fido', 'fido_helper.py')
  ]
  if (resourcesPath) candidates.push(join(resourcesPath, 'fido', 'fido_helper.py'))
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/**
 * Pick a python3 that is likely to have the fido2 package. A packaged macOS app gets a
 * minimal PATH, so plain `python3` would hit Apple's /usr/bin stub.
 */
export function resolvePythonPath(env = process.env) {
  if (env.SCS_FIDO_PYTHON) return env.SCS_FIDO_PYTHON
  const candidates = [
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3'
  ]
  return candidates.find((p) => existsSync(p)) ?? 'python3'
}

/**
 * Turn the 32-byte device secret into the extra-key string that
 * encryptDataShareKey / recoverDataShareKey already accept.
 * HKDF with a fixed info label keeps this key separate from any other use of the secret.
 * @param {Buffer} secret
 * @returns {string} 64 hex chars
 */
export function deriveExtraKeyFromFidoSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new FidoError('BAD_SECRET', 'FIDO secret must be a Buffer of at least 32 bytes')
  }
  const okm = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), EXTRA_KEY_INFO, 32))
  const hex = okm.toString('hex')
  okm.fill(0)
  return hex
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/**
 * @typedef {Object} FidoHandlers
 * @property {(evt: { event: string, [k: string]: any }) => void} [onEvent]
 *   Progress for the UI:
 *   - uv: a fingerprint check is starting; tell the user to wait for the green LED
 *   - touch: the key is waiting now; place the finger flat and touch the silver bezel
 *   - uv-failed {retriesLeft}: no match; retriesLeft 0 means the fingerprint is locked
 *   - lift-finger: lift the finger completely, the key re-arms in about 1.5 s
 *   - uv-blocked: fingerprint locked, the PIN is requested next (entering it unlocks)
 *   - pin-fallback, need-second-touch, multiple-devices
 *   - enroll-start, enroll-sample {remaining}, enroll-retry {feedback}
 * @property {(req: { retries: number|null }) => Promise<string|null>} [requestPin]
 *   Called when the key needs the PIN (fingerprint blocked, or enrollment). Return null to cancel.
 */

export default class FidoProvider {
  /**
   * @param {{ helperPath: string, pythonPath?: string, rpId?: string, timeoutMs?: number,
   *           logger?: { info: Function, warn: Function, error: Function } }} opts
   */
  constructor({
    helperPath,
    pythonPath,
    rpId = DEFAULT_RP_ID,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger
  } = {}) {
    if (!helperPath) throw new Error('FidoProvider requires helperPath')
    this.helperPath = helperPath
    this.pythonPath = pythonPath ?? resolvePythonPath()
    this.rpId = rpId
    this.timeoutMs = timeoutMs
    this.logger = logger ?? console
    this._current = null
  }

  /** Key capabilities and PIN / fingerprint state. No touch needed. */
  async getInfo() {
    return this._run({ cmd: 'info' })
  }

  /**
   * Binding: create a credential on the key and derive the device secret.
   * @param {{ challenge: Buffer, userId: Buffer, userName: string, salt: Buffer, rpId?: string }} params
   *   rpId defaults to the one given to the constructor; the server's value should be passed.
   * @param {FidoHandlers} [handlers]
   * @returns {Promise<{ credential: { id: string, clientDataJSON: string, attestationObject: string }, secret: Buffer }>}
   *   `credential` goes to the server; `secret` stays in memory on the client.
   */
  async register({ challenge, userId, userName, salt, rpId = this.rpId }, handlers) {
    const res = await this._run(
      {
        cmd: 'register',
        rpId,
        challenge: b64u(challenge),
        userId: b64u(userId),
        userName,
        salt: b64u(salt)
      },
      handlers
    )
    return { credential: res.credential, secret: Buffer.from(res.secret, 'base64url') }
  }

  /**
   * Recovery: fingerprint on the key and re-derive the same device secret.
   * @param {{ challenge: Buffer, credentialIds: string[], salt: Buffer, rpId?: string }} params credentialIds are base64url
   * @param {FidoHandlers} [handlers]
   * @returns {Promise<{ assertion: { id: string, clientDataJSON: string, authenticatorData: string, signature: string, userHandle: string|null }, secret: Buffer }>}
   */
  async authenticate({ challenge, credentialIds, salt, rpId = this.rpId }, handlers) {
    const res = await this._run(
      {
        cmd: 'authenticate',
        rpId,
        challenge: b64u(challenge),
        credentialIds,
        salt: b64u(salt)
      },
      handlers
    )
    return { assertion: res.assertion, secret: Buffer.from(res.secret, 'base64url') }
  }

  /** Set the PIN on a key that has none. */
  async setPin(pin) {
    return this._run({ cmd: 'set-pin', pin })
  }

  /**
   * Enroll one fingerprint. The helper asks for the PIN through handlers.requestPin.
   * @param {{ name?: string }} params
   * @param {FidoHandlers} handlers
   */
  async enrollFingerprint({ name } = {}, handlers) {
    return this._run({ cmd: 'enroll', name }, handlers)
  }

  /** Abort the running operation, e.g. when the user closes the dialog. */
  cancel() {
    if (this._current) this._current.kill('CANCELLED', 'Operation cancelled')
  }

  _run(request, handlers = {}) {
    if (this._current) {
      return Promise.reject(new FidoError('BUSY', 'Another security key operation is running'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let stdoutBuf = ''
      let stderrBuf = ''
      const child = spawn(this.pythonPath, [this.helperPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
      })

      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._current = null
        if (child.exitCode === null) child.kill()
        err ? reject(err) : resolve(value)
      }
      const timer = setTimeout(
        () => finish(new FidoError('TIMEOUT', 'Security key operation timed out')),
        this.timeoutMs
      )
      this._current = { kill: (code, msg) => finish(new FidoError(code, msg)) }

      const write = (obj) => {
        if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + '\n')
      }

      const onMessage = async (msg) => {
        switch (msg.type) {
          case 'event':
            try {
              handlers.onEvent?.(msg)
            } catch (e) {
              this.logger.warn?.(`FidoProvider onEvent handler threw: ${e}`)
            }
            break
          case 'pin-request': {
            let pin = null
            try {
              pin = handlers.requestPin ? await handlers.requestPin({ retries: msg.retries }) : null
            } catch {
              pin = null
            }
            write({ pin: pin || null })
            break
          }
          case 'result': {
            const { type, ...rest } = msg
            finish(null, rest)
            break
          }
          case 'error':
            finish(new FidoError(msg.code || 'HELPER_ERROR', msg.message || 'FIDO helper error'))
            break
          default:
            this.logger.warn?.(`FidoProvider: unknown helper message type ${msg.type}`)
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk
        let idx
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim()
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            this.logger.warn?.('FidoProvider: non-JSON line from helper ignored')
            continue
          }
          onMessage(msg)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-4000)
      })
      child.on('error', (err) => {
        finish(
          new FidoError(
            'HELPER_START_FAILED',
            `Could not start FIDO helper with ${this.pythonPath}: ${err.message}`
          )
        )
      })
      child.on('close', (code) => {
        if (!settled) {
          if (stderrBuf) this.logger.error?.(`FIDO helper stderr: ${stderrBuf}`)
          finish(
            new FidoError('HELPER_CRASHED', `FIDO helper exited with code ${code} without a result`)
          )
        }
      })
      child.stdin.on('error', () => {})

      write(request)
    })
  }
}
