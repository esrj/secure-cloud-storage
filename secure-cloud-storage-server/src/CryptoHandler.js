/**
 * This file handles cryptography for user, including verifying message and file reencryption
 */
import {
  pre_schema1_MessageGen,
  pre_schema1_SigningKeyGen,
  pre_schema1_Encrypt,
  pre_schema1_ReEncrypt
} from '@aldenml/ecc'
import { logger } from './Logger.js'
import { Base64Schema } from './Validation.js'

/**
 * Reencrypt a cipher with the rekey
 * @param {*} rekey 
 * @param {*} cipher 
 * @param {*} aSpk 
 * @param {*} bPk 
 * @returns The reencrypted cipher
 */
const reencrypt = async (rekey, cipher, aSpk, bPk) => {
  const parsedRekey = Base64Schema.parse(rekey)
  const parsedCipher = Base64Schema.parse(cipher)
  const parsedASpk = Base64Schema.parse(aSpk)
  const parsedBPk = Base64Schema.parse(bPk)

  logger.debug(
    `rekey: ${parsedRekey}, cipher: ${parsedCipher}, aSpk: ${parsedASpk}, bPk: ${parsedBPk}`
  )
  const signingArray = await pre_schema1_SigningKeyGen()
  const rekeyArray = new Uint8Array(Buffer.from(parsedRekey, 'base64'))
  const cipherArray = new Uint8Array(Buffer.from(parsedCipher, 'base64'))
  const aSpkArray = new Uint8Array(Buffer.from(parsedASpk, 'base64'))
  const bPkArray = new Uint8Array(Buffer.from(parsedBPk, 'base64'))
  const recipherArray = await pre_schema1_ReEncrypt(
    cipherArray,
    rekeyArray,
    aSpkArray,
    bPkArray,
    signingArray
  )
  if (recipherArray === null) {
    throw new Error('Failed to reencrypt.')
  }
  logger.debug(`spk: ${Buffer.from(signingArray.spk).toString('base64')}`)
  logger.debug(`ssk: ${Buffer.from(signingArray.ssk).toString('base64')}`)
  logger.debug(`recipher: ${Buffer.from(recipherArray).toString('base64')}`)
  return {
    recipher: Buffer.from(recipherArray).toString('base64'),
    spk: Buffer.from(signingArray.spk).toString('base64')
  }
}

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
  reencrypt,
  verifyGen
}
export default CryptoHandler
console.debug('CryptoHandler.js loaded.')