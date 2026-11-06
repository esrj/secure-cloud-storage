/**
 * Minimal software FIDO2 authenticator for tests: real P-256 keys and signatures,
 * standard authenticator data, attestation format "none".
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const sha256 = (data) => createHash('sha256').update(data).digest()
const b64u = (data) => Buffer.from(data).toString('base64url')
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

const UP = 0x01
const UV = 0x04
const AT = 0x40
const ED = 0x80

export function createSoftAuthenticator({ rpId, hmacSecret = true } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(48)
  const coseKey = Buffer.from(
    isoCBOR.encode(
      new Map([
        [1, 2], // kty EC2
        [3, -7], // alg ES256
        [-1, 1], // crv P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')]
      ])
    )
  )
  let counter = 0

  return {
    id: b64u(credentialId),
    get counter() {
      return counter
    },

    makeCredential({ challenge, origin = `https://${rpId}`, hashRpId = rpId, uv = true }) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
      )
      counter += 1
      const ext = hmacSecret
        ? Buffer.from(isoCBOR.encode(new Map([['hmac-secret', true]])))
        : Buffer.alloc(0)
      const flags = UP | (uv ? UV : 0) | AT | (hmacSecret ? ED : 0)
      const authData = Buffer.concat([
        sha256(hashRpId),
        Buffer.from([flags]),
        u32(counter),
        Buffer.alloc(16), // aaguid
        u16(credentialId.length),
        credentialId,
        coseKey,
        ext
      ])
      const attestationObject = isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData]
        ])
      )
      return {
        id: b64u(credentialId),
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject)
      }
    },

    getAssertion({
      challenge,
      origin = `https://${rpId}`,
      hashRpId = rpId,
      uv = true,
      setCounter
    }) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })
      )
      counter = setCounter ?? counter + 1
      const authData = Buffer.concat([
        sha256(hashRpId),
        Buffer.from([UP | (uv ? UV : 0)]),
        u32(counter)
      ])
      const signature = sign(
        'sha256',
        Buffer.concat([authData, sha256(clientDataJSON)]),
        privateKey
      )
      return {
        id: b64u(credentialId),
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: null
      }
    }
  }
}
