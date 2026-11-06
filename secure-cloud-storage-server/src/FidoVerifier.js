/**
 * FIDO2 / WebAuthn verification for security-key account recovery.
 *
 * The client talks to the key through python-fido2 (see the client's fido_helper.py),
 * which produces standard WebAuthn clientDataJSON with origin https://<rpId>.
 * Verification is delegated to @simplewebauthn/server; this module only adapts the
 * shapes and adds the checks the library leaves to the caller.
 */
import { randomBytes } from 'node:crypto'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

const SUPPORTED_ALGS = [-7, -8] // ES256, EdDSA

export class FidoVerificationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FidoVerificationError'
    this.code = code
  }
}

/** 32 random bytes, base64url. Used for challenges and hmac-secret salts. */
export const randomB64u = () => randomBytes(32).toString('base64url')

export const originForRpId = (rpId) => `https://${rpId}`

/**
 * Verify a new credential from the binding flow.
 * @param {{ credential: { id: string, clientDataJSON: string, attestationObject: string },
 *           expectedChallenge: string, rpId: string }} params
 * @returns {Promise<{ credentialId: string, publicKey: string, counter: number, aaguid: string }>}
 *   publicKey is the COSE key, base64url
 */
export async function verifyFidoRegistration({ credential, expectedChallenge, rpId }) {
  let result
  try {
    result = await verifyRegistrationResponse({
      response: {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: credential.clientDataJSON,
          attestationObject: credential.attestationObject
        }
      },
      expectedChallenge,
      expectedOrigin: originForRpId(rpId),
      expectedRPID: rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGS
    })
  } catch (error) {
    throw new FidoVerificationError('REGISTRATION_INVALID', error.message)
  }
  if (!result.verified) {
    throw new FidoVerificationError('REGISTRATION_INVALID', 'Attestation could not be verified')
  }
  const info = result.registrationInfo
  if (info.credential.id !== credential.id) {
    throw new FidoVerificationError(
      'REGISTRATION_INVALID',
      'Credential id does not match authenticator data'
    )
  }
  // Without hmac-secret the key cannot re-derive the secret, so the shares would be lost.
  const extensions = info.authenticatorExtensionResults ?? {}
  if (extensions['hmac-secret'] !== true) {
    throw new FidoVerificationError('NO_HMAC_SECRET', 'Credential was created without hmac-secret')
  }
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    aaguid: info.aaguid
  }
}

/**
 * Verify an assertion from the recovery flow against the stored credential.
 * @param {{ assertion: { id: string, clientDataJSON: string, authenticatorData: string,
 *                        signature: string, userHandle?: string|null },
 *           expectedChallenge: string, rpId: string,
 *           credential: { id: string, publicKey: string, counter: number } }} params
 * @returns {Promise<{ newCounter: number }>}
 */
export async function verifyFidoAssertion({ assertion, expectedChallenge, rpId, credential }) {
  if (assertion.id !== credential.id) {
    throw new FidoVerificationError('WRONG_CREDENTIAL', 'Assertion is from a different credential')
  }
  let result
  try {
    result = await verifyAuthenticationResponse({
      response: {
        id: assertion.id,
        rawId: assertion.id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: assertion.clientDataJSON,
          authenticatorData: assertion.authenticatorData,
          signature: assertion.signature,
          ...(assertion.userHandle ? { userHandle: assertion.userHandle } : {})
        }
      },
      expectedChallenge,
      expectedOrigin: originForRpId(rpId),
      expectedRPID: rpId,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter
      },
      requireUserVerification: true
    })
  } catch (error) {
    const code = /counter/i.test(error.message) ? 'COUNTER_REPLAY' : 'ASSERTION_INVALID'
    throw new FidoVerificationError(code, error.message)
  }
  if (!result.verified) {
    throw new FidoVerificationError('ASSERTION_INVALID', 'Signature could not be verified')
  }
  return { newCounter: result.authenticationInfo.newCounter }
}
