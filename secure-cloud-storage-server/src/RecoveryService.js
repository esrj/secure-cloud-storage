/**
 * Fingerprint / security-key account recovery (指紋復原計劃，階段 2).
 *
 * Socket events (all use an ack callback):
 *   Logged in:
 *     recovery-methods        {}                              -> { methods }
 *     fido-bind-begin         { label? }                      -> { rpId, rpName, challenge, salt, userId, userName, timeoutMs }
 *     fido-bind-finish        { credential, shares, label? }  -> { method }
 *     recovery-method-delete  { methodId }                    -> {}
 *   After the email OTP of secret-recover succeeded (see Authentication.js):
 *     fido-recover-begin      { methodId }                    -> { rpId, challenge, credentialIds, salt, timeoutMs }
 *     fido-recover-finish     { assertion }                   -> { shares }
 *   Errors are returned as { errorMsg }.
 *
 * The device secret never reaches the server. The server only stores the credential's
 * public data and salt, checks the signature and the user-verified flag, and releases the
 * shares of that method when both are valid.
 *
 * Everything external is injected so the flows can be tested without the real databases.
 */
import { randomUUID } from 'node:crypto'
import * as defaultVerifier from './FidoVerifier.js'
import { FidoVerificationError, randomB64u } from './FidoVerifier.js'
import { PASSWORD_METHOD_ID } from './RecoverySchema.js'
import {
  FidoBindBeginRequestSchema,
  FidoBindFinishRequestSchema,
  FidoRecoverBeginRequestSchema,
  FidoRecoverFinishRequestSchema,
  RecoveryMethodDeleteRequestSchema
} from './Validation.js'

export const FIDO_METHOD_TYPE = 'fido'
export const PASSWORD_METHOD_TYPE = 'password'
/** Shamir threshold used by the client (10 shares, threshold 2). */
export const SHARE_THRESHOLD = 2

export const RecoveryErrorMsg = Object.freeze({
  invalidArgument: 'Invalid arguments.',
  notLoggedIn: 'Not logged in.',
  noEmailAuth: 'Verify the email code before recovering.',
  emailAuthExpired: 'Email verification expired. Please start recovery again.',
  noBegin: 'Did not start this security key operation first.',
  challengeExpired: 'Security key operation timed out. Please try again.',
  tooManyKeys: 'Too many security keys are bound to this account.',
  methodNotFound: 'Recovery method not found.',
  keyRejected: 'Security key verification failed.',
  keyNoHmacSecret: 'This security key cannot be used for recovery.',
  sharesNotStored: 'Could not store enough secret shares. Please try again later.'
})

/** An expected, user-facing failure. `detail` is for the log only. */
export class RecoveryError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'RecoveryError'
    this.detail = detail
  }
}

function parse(schema, request) {
  const result = schema.safeParse(request ?? {})
  if (!result.success) {
    throw new RecoveryError(RecoveryErrorMsg.invalidArgument, { issues: result.error.issues })
  }
  return result.data
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./RecoveryMethodStore.js').createRecoveryMethodStore>} deps.methodStore
 * @param {ReturnType<import('./SecretShareStore.js').createSecretShareStore>} deps.shareStore
 * @param {{ rpId: string, rpName: string, challengeTimeoutSec: number, recoverWindowMin: number,
 *           maxMethodsPerUser: number, maxRecoverAttempts: number }} deps.config
 * @param {(socket: object) => boolean} deps.isLoggedIn
 * @param {typeof import('./FidoVerifier.js')} [deps.verifier]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 */
export function createRecoveryService({
  methodStore,
  shareStore,
  config,
  isLoggedIn,
  verifier = defaultVerifier,
  now = () => Date.now(),
  newId = randomUUID
}) {
  const challengeTimeoutMs = config.challengeTimeoutSec * 1000
  const recoverWindowMs = config.recoverWindowMin * 60 * 1000

  function requireLoggedIn(socket) {
    if (!isLoggedIn(socket)) throw new RecoveryError(RecoveryErrorMsg.notLoggedIn)
  }

  /** The OTP verification is bound to the user it was issued for, not to socket.userId. */
  function requireRecoverVerified(socket) {
    const verified = socket.recoverVerified
    if (!verified) throw new RecoveryError(RecoveryErrorMsg.noEmailAuth)
    if (now() - verified.at > recoverWindowMs) {
      delete socket.recoverVerified
      throw new RecoveryError(RecoveryErrorMsg.emailAuthExpired)
    }
    return verified
  }

  function takeState(socket, key, userId) {
    const state = socket[key]
    delete socket[key] // challenges are single-use, whatever the outcome
    if (!state || state.userId !== userId) throw new RecoveryError(RecoveryErrorMsg.noBegin)
    if (now() - state.createdAt > challengeTimeoutMs) {
      throw new RecoveryError(RecoveryErrorMsg.challengeExpired)
    }
    return state
  }

  function verificationFailed(error) {
    if (error instanceof FidoVerificationError) {
      const msg =
        error.code === 'NO_HMAC_SECRET'
          ? RecoveryErrorMsg.keyNoHmacSecret
          : RecoveryErrorMsg.keyRejected
      return new RecoveryError(msg, { code: error.code, reason: error.message })
    }
    return error
  }

  /**
   * Recovery methods of a user. The password method is listed when its shares exist.
   * @returns {Promise<Array<{ id: string, type: string, label?: string, createdAt?: Date,
   *                           lastUsedAt?: Date|null, sharesAvailable: boolean }>>}
   */
  async function listMethods(userId) {
    const [rows, shareMethodIds] = await Promise.all([
      methodStore.listByUser(userId),
      shareStore.listUserShareMethodIds(userId)
    ])
    const methods = []
    if (shareMethodIds.has(PASSWORD_METHOD_ID)) {
      methods.push({ id: PASSWORD_METHOD_ID, type: PASSWORD_METHOD_TYPE, sharesAvailable: true })
    }
    for (const row of rows) {
      methods.push({
        id: row.id,
        type: row.type,
        label: row.label,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        sharesAvailable: shareMethodIds.has(row.id)
      })
    }
    return methods
  }

  const handlers = {
    async 'recovery-methods'(socket) {
      requireLoggedIn(socket)
      return { methods: await listMethods(socket.userId) }
    },

    async 'fido-bind-begin'(socket, request) {
      requireLoggedIn(socket)
      const { label } = parse(FidoBindBeginRequestSchema, request)
      const count = await methodStore.countByUser(socket.userId, FIDO_METHOD_TYPE)
      if (count >= config.maxMethodsPerUser) throw new RecoveryError(RecoveryErrorMsg.tooManyKeys)
      const state = {
        userId: socket.userId,
        challenge: randomB64u(),
        salt: randomB64u(),
        label: label ?? '',
        createdAt: now()
      }
      socket.fidoBind = state
      return {
        rpId: config.rpId,
        rpName: config.rpName,
        challenge: state.challenge,
        salt: state.salt,
        userId: Buffer.from(String(socket.userId)).toString('base64url'),
        userName: socket.name || 'user',
        timeoutMs: challengeTimeoutMs
      }
    },

    async 'fido-bind-finish'(socket, request) {
      requireLoggedIn(socket)
      const state = takeState(socket, 'fidoBind', socket.userId)
      const { credential, shares, label } = parse(FidoBindFinishRequestSchema, request)

      let reg
      try {
        reg = await verifier.verifyFidoRegistration({
          credential,
          expectedChallenge: state.challenge,
          rpId: config.rpId
        })
      } catch (error) {
        throw verificationFailed(error)
      }

      const count = await methodStore.countByUser(socket.userId, FIDO_METHOD_TYPE)
      if (count >= config.maxMethodsPerUser) throw new RecoveryError(RecoveryErrorMsg.tooManyKeys)

      const methodId = newId()
      const stored = await shareStore.storeUserShares(socket.userId, shares, methodId)
      if (stored < SHARE_THRESHOLD) {
        await shareStore.deleteUserShares(socket.userId, methodId)
        throw new RecoveryError(RecoveryErrorMsg.sharesNotStored, { stored })
      }
      const finalLabel = label ?? state.label
      try {
        await methodStore.addFidoMethod({
          id: methodId,
          userId: socket.userId,
          label: finalLabel,
          credentialId: reg.credentialId,
          publicKey: reg.publicKey,
          signCount: reg.counter,
          salt: state.salt,
          aaguid: reg.aaguid
        })
      } catch (error) {
        await shareStore.deleteUserShares(socket.userId, methodId)
        throw error
      }
      return {
        method: { id: methodId, type: FIDO_METHOD_TYPE, label: finalLabel, sharesStored: stored }
      }
    },

    async 'recovery-method-delete'(socket, request) {
      requireLoggedIn(socket)
      const { methodId } = parse(RecoveryMethodDeleteRequestSchema, request)
      const deleted = await methodStore.deleteForUser(methodId, socket.userId)
      if (!deleted) throw new RecoveryError(RecoveryErrorMsg.methodNotFound)
      await shareStore.deleteUserShares(socket.userId, methodId)
      return {}
    },

    async 'fido-recover-begin'(socket, request) {
      const verified = requireRecoverVerified(socket)
      const { methodId } = parse(FidoRecoverBeginRequestSchema, request)
      const method = await methodStore.getById(methodId)
      if (!method || method.userId !== verified.userId || method.type !== FIDO_METHOD_TYPE) {
        throw new RecoveryError(RecoveryErrorMsg.methodNotFound)
      }
      const challenge = randomB64u()
      socket.fidoRecover = { userId: verified.userId, methodId, challenge, createdAt: now() }
      return {
        rpId: config.rpId,
        challenge,
        credentialIds: [method.credentialId],
        salt: method.salt,
        timeoutMs: challengeTimeoutMs
      }
    },

    async 'fido-recover-finish'(socket, request) {
      const verified = requireRecoverVerified(socket)
      const state = takeState(socket, 'fidoRecover', verified.userId)
      const { assertion } = parse(FidoRecoverFinishRequestSchema, request)
      const method = await methodStore.getById(state.methodId)
      if (!method || method.userId !== verified.userId) {
        throw new RecoveryError(RecoveryErrorMsg.methodNotFound)
      }

      let result
      try {
        result = await verifier.verifyFidoAssertion({
          assertion,
          expectedChallenge: state.challenge,
          rpId: config.rpId,
          credential: {
            id: method.credentialId,
            publicKey: method.publicKey,
            counter: method.signCount
          }
        })
      } catch (error) {
        verified.failures = (verified.failures ?? 0) + 1
        if (verified.failures >= config.maxRecoverAttempts) delete socket.recoverVerified
        throw verificationFailed(error)
      }

      await methodStore.recordUse(method.id, result.newCounter)
      const shares = await shareStore.retrieveUserShares(verified.userId, method.id)
      delete socket.recoverVerified // one successful recovery per OTP
      return { shares }
    }
  }

  return { handlers, listMethods }
}
