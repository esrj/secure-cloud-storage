/**
 * Client-side flows for fingerprint / security-key account recovery (指紋復原計劃，階段 3).
 *
 *   bindSecurityKey          logged in: key -> device secret -> extra key -> shares -> server
 *   recoverWithSecurityKey   after the email OTP: key -> same secret -> extra key -> decrypt shares -> login
 *
 * Server events are documented in the server's RecoveryService.js. The device secret and the
 * extra key only exist in this process's memory; the server receives the credential's public
 * data, the assertion, and the encrypted shares.
 *
 * Every dependency is injected, so this module imports nothing from Electron and can be
 * tested with plain Node. ipc/recoveryIpc.js wires the real socket, key and login manager.
 */
import { FidoError, deriveExtraKeyFromFidoSecret } from './FidoProvider.js'

const SHARE_THRESHOLD = 2
const RP_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const fromB64u = (value) => Buffer.from(value, 'base64url')

export class RecoveryFlowError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RecoveryFlowError'
    this.code = code
  }
}

function checkRpId(rpId) {
  if (typeof rpId !== 'string' || rpId.length > 253 || !RP_ID_PATTERN.test(rpId)) {
    throw new RecoveryFlowError('BAD_SERVER_RESPONSE', 'Server sent an invalid rpId')
  }
}

/** Derive the extra key and wipe the device secret, whatever happens. */
function toExtraKey(secret) {
  try {
    return deriveExtraKeyFromFidoSecret(secret)
  } finally {
    secret.fill(0)
  }
}

export default class RecoveryManager {
  /**
   * @param {object} deps
   * @param {(event: string, payload?: object) => Promise<object>} deps.emit
   *   Socket emit with ack. Must reject when the server answers with errorMsg.
   * @param {import('./FidoProvider.js').default} deps.fido
   * @param {() => { walletKey: string, preKeys: object }} deps.getSecretKeys
   *   Secrets of the logged-in user, the same object the password backup encrypts.
   * @param {(extraKey: string, dataStr: string) => Promise<Buffer[]>} deps.encryptShares
   *   SecretSharing.encryptDataShareKey
   * @param {(extraKey: string, shares: Buffer[]) => Promise<void>} deps.restoreFromShares
   *   LoginManager.restoreFromShares: decrypt, restore keys, log in
   */
  constructor({ emit, fido, getSecretKeys, encryptShares, restoreFromShares }) {
    this.emit = emit
    this.fido = fido
    this.getSecretKeys = getSecretKeys
    this.encryptShares = encryptShares
    this.restoreFromShares = restoreFromShares
  }

  /** Recovery methods of the logged-in user: [{ id, type, label, createdAt, lastUsedAt, sharesAvailable }]. */
  async listMethods() {
    const { methods } = await this.emit('recovery-methods', {})
    return Array.isArray(methods) ? methods : []
  }

  /**
   * Bind the connected security key as a recovery method.
   * @param {{ label?: string }} params
   * @param {import('./FidoProvider.js').FidoHandlers} [handlers] progress events and PIN requests
   * @returns {Promise<{ id: string, type: string, label: string, sharesStored: number }>}
   */
  async bindSecurityKey({ label } = {}, handlers) {
    const labelPayload = label ? { label } : {}
    const begin = await this.emit('fido-bind-begin', labelPayload)
    checkRpId(begin.rpId)
    const { credential, secret } = await this.fido.register(
      {
        rpId: begin.rpId,
        challenge: fromB64u(begin.challenge),
        userId: fromB64u(begin.userId),
        userName: begin.userName,
        salt: fromB64u(begin.salt)
      },
      handlers
    )
    const extraKey = toExtraKey(secret)
    const shares = await this.encryptShares(extraKey, JSON.stringify(this.getSecretKeys()))
    const { method } = await this.emit('fido-bind-finish', {
      credential,
      shares: shares.map((share) => Buffer.from(share).toString('base64')),
      ...labelPayload
    })
    return method
  }

  /** Remove a bound security key and its shares. */
  async deleteMethod({ methodId }) {
    await this.emit('recovery-method-delete', { methodId })
  }

  /**
   * Recover the account with a bound security key. Call after the email OTP of
   * secret-recover succeeded on this connection.
   * @param {{ methodId: string }} params one of the fido methods returned with the OTP result
   * @param {import('./FidoProvider.js').FidoHandlers} [handlers]
   */
  async recoverWithSecurityKey({ methodId }, handlers) {
    const begin = await this.emit('fido-recover-begin', { methodId })
    checkRpId(begin.rpId)
    const { assertion, secret } = await this.fido.authenticate(
      {
        rpId: begin.rpId,
        challenge: fromB64u(begin.challenge),
        credentialIds: begin.credentialIds,
        salt: fromB64u(begin.salt)
      },
      handlers
    )
    const extraKey = toExtraKey(secret)
    const { shares } = await this.emit('fido-recover-finish', { assertion })
    if (!Array.isArray(shares) || shares.length < SHARE_THRESHOLD) {
      throw new RecoveryFlowError(
        'NOT_ENOUGH_SHARES',
        'Not enough secret shares are available. Please contact the server manager.'
      )
    }
    try {
      await this.restoreFromShares(
        extraKey,
        shares.map((share) => Buffer.from(share, 'base64'))
      )
    } catch (error) {
      // The server has already used up this email verification; the user must start over.
      // LOGIN_FAILED: the keys are restored and saved, only the login was refused.
      const code = error?.code === 'LOGIN_FAILED' ? 'LOGIN_FAILED' : 'RESTORE_FAILED'
      throw new RecoveryFlowError(code, error?.message || 'Could not restore the keys.')
    }
  }

  // Key management used by the setup UI (stage 4).
  getKeyInfo() {
    return this.fido.getInfo()
  }

  setPin({ pin }) {
    return this.fido.setPin(pin)
  }

  enrollFingerprint({ name } = {}, handlers) {
    return this.fido.enrollFingerprint({ name }, handlers)
  }

  cancel() {
    this.fido.cancel()
  }
}

export { FidoError }
