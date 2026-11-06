/**
 * This file handles cryptography for user verification
 */
import {
  pre_schema1_MessageGen,
  pre_schema1_SigningKeyGen,
  pre_schema1_Encrypt,
} from '@aldenml/ecc'
import { Base64Schema } from './Validation.js'


/**
 * Generate a random message and cipher for verification
 * @param {string} publicKey
 * @returns {Promise<{message: string, cipher: string, spk: string}>}
 */
const verifyGen = async (publicKey) => {
  const parsedPublicKey = Base64Schema.parse(publicKey)
  const publicKeyArray = new Uint8Array(Buffer.from(parsedPublicKey, 'base64'))
  const messageArray = await pre_schema1_MessageGen()
  const signKeyArray = await pre_schema1_SigningKeyGen()
  const cipherArray = await pre_schema1_Encrypt(messageArray, publicKeyArray, signKeyArray)
  if (cipherArray === null) {
    throw new Error('Failed to create verify message.')
  }
  // const messageStr = Buffer.from(message).toString('base64')
  return {
    message: Buffer.from(messageArray).toString('base64'),
    cipher: Buffer.from(cipherArray).toString('base64'),
    spk: Buffer.from(signKeyArray.spk).toString('base64')
  }
}

const CryptoHandler = {
  verifyGen
}
export default CryptoHandler