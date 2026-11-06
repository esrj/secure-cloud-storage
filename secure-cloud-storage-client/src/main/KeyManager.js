/**
 * This file handles user private/public key initialization, storing and encryption/decryption.
 */
import { logger } from './Logger'
import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import {
  pre_schema1_DecryptLevel1,
  pre_schema1_DecryptLevel2,
  pre_schema1_Encrypt,
  pre_schema1_KeyGen,
  pre_schema1_MessageGen,
  pre_schema1_ReKeyGen,
  pre_schema1_SigningKeyGen
} from '@aldenml/ecc'
import GlobalValueManager from './GlobalValueManager'

const keyFilePath = GlobalValueManager.keyPath

class KeyManager {
  keys
  signingKeys
  checkInit() {
    if (!this.keys || !this.signingKeys) {
      throw new Error('Keys are not initialized')
    }
  }

  /**
   * Restore the keys and store to file.
   * @param {*} param0
   */
  restoreKeys({ pk, sk, spk, ssk }) {
    const keysStr = `${pk}\n${sk}\n${spk}\n${ssk}`
    writeFileSync(keyFilePath, keysStr)
    this.keys = {
      pk: new Uint8Array(Buffer.from(pk, 'base64')),
      sk: new Uint8Array(Buffer.from(sk, 'base64'))
    }
    this.signingKeys = {
      spk: new Uint8Array(Buffer.from(spk, 'base64')),
      ssk: new Uint8Array(Buffer.from(ssk, 'base64'))
    }
    if (
      this.keys.pk.length !== 48 ||
      this.keys.sk.length !== 32 ||
      this.signingKeys.spk.length !== 32 ||
      this.signingKeys.ssk.length !== 64
    ) {
      throw new Error('Keys are not in correct format')
    }
  }

  /**
   * Initialize the keys from file, or create keys and store to file.
   * @returns
   */
  async initKeys() {
    if (this.keys && this.signingKeys) {
      return
    }
    logger.info('Initializing keys...')
    try {
      const content = (await readFile(keyFilePath, 'utf-8')).split('\n')
      this.keys = {
        pk: new Uint8Array(Buffer.from(content[0], 'base64')),
        sk: new Uint8Array(Buffer.from(content[1], 'base64'))
      }
      this.signingKeys = {
        spk: new Uint8Array(Buffer.from(content[2], 'base64')),
        ssk: new Uint8Array(Buffer.from(content[3], 'base64'))
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('Keys not found. Creating keys...')
        this.keys = await pre_schema1_KeyGen()
        this.signingKeys = await pre_schema1_SigningKeyGen()
        if (!this.keys || !this.signingKeys) throw new Error('Failed to generate keys')
        const keysStr = `${Buffer.from(this.keys.pk).toString('base64')}\n${Buffer.from(this.keys.sk).toString('base64')}\n${Buffer.from(this.signingKeys.spk).toString('base64')}\n${Buffer.from(this.signingKeys.ssk).toString('base64')}`
        await writeFile(keyFilePath, keysStr)
      } else {
        throw error
      }
    }
    if (
      this.keys.pk.length !== 48 ||
      this.keys.sk.length !== 32 ||
      this.signingKeys.spk.length !== 32 ||
      this.signingKeys.ssk.length !== 64
    ) {
      throw new Error('Keys are not in correct format')
    }

    logger.info('Keys initialized.')
  }
  /**
   * Encrypt the message with the public key.
   * @param {string} message
   * @returns {Promise<string>} encrypted cipher
   */
  async encrypt(message) {
    this.checkInit()
    logger.info('Encrypting message...')
    const cipher = await pre_schema1_Encrypt(message, this.keys.pk, this.signingKeys)
    if (cipher === null) throw new Error('Failed to encrypt message')
    logger.debug(`cipher: ${cipher}`)
    logger.info('Message encrypted.')
    return {
      cipher: Buffer.from(cipher).toString('base64'),
      spk: Buffer.from(this.signingKeys.spk).toString('base64')
    }
  }

  /**
   * Decrypt the cipher with the private key.
   * @param {string} cipher
   * @param {string} spk
   * @param {boolean} proxied proxied by server or not, default as false
   * @returns {Promise<string | Uint8Array>} decrypted message
   */
  async decrypt(cipher, spk, proxied = false, toArray = false) {
    this.checkInit()
    logger.debug(`cipher: ${cipher}`)
    logger.debug(`spk: ${spk}`)
    logger.info('Decrypting message...')
    const cipherArray = new Uint8Array(Buffer.from(cipher, 'base64'))
    const spkArray = new Uint8Array(Buffer.from(spk, 'base64'))
    let messageArray
    if (proxied) {
      messageArray = await pre_schema1_DecryptLevel2(cipherArray, this.keys.sk, spkArray)
    } else {
      messageArray = await pre_schema1_DecryptLevel1(cipherArray, this.keys.sk, spkArray)
    }
    if (messageArray === null) throw new Error('Failed to decrypt cipher')
    logger.info('Message decrypted.')
    if (toArray) {
      return messageArray
    }
    const message = Buffer.from(messageArray).toString('base64')
    logger.debug(`decrypted message: ${message}`)
    return message
  }

  /**
   * Generate reencryption key based on requester's public key.
   * @param {string} requesterPublicKey
   * @param {string} spk
   * @returns {Promise<string>} rekey
   */
  async rekeyGen(requesterPublicKey, spk) {
    // currently only single signkey for all files
    this.checkInit()
    logger.info('Generating rekey...')
    const reqPublicKeyArray = new Uint8Array(Buffer.from(requesterPublicKey, 'base64'))
    // const spkArray = new Uint8Array(Buffer.from(spk, 'base64'))
    const rekeyArray = await pre_schema1_ReKeyGen(this.keys.sk, reqPublicKeyArray, this.signingKeys)
    if (rekeyArray === null) throw new Error('Failed to generate rekey')
    const rekey = Buffer.from(rekeyArray).toString('base64')
    logger.debug(`rekey: ${rekey}`)
    logger.info('Rekey generated.')
    return rekey
  }

  /**
   * Generate a random message and its corresponding cipher.
   * @returns {Promise<{ messageArray: Uint8Array, message: string, cipher: string, spk: string }>}
   */
  async randCipher() {
    this.checkInit()
    // Test fixing random cipher
    // const messageArray = new Uint8Array(
    //   Buffer.from(
    //     'VXh/2QRN306gbqEwMp3v4qjHxMLXfNvAayBtPEMIRWUs3Wcgv9ZWxi8XCiZXEwkY/AXiuMZmkJTbcUCqx8P09PaZk66n9ooXAq2meyIvvrL3K87CxZAdnEni97359TkBKNagpjhf0Z37WJYVGNGxSba1xoVaMIs4FjuOcUl4jPksP06sH2aqo3YtBMNeW7UNF4WaKiypJgoC7yjoDmQSzvwsOHodoU0x/GHXucUGtLrQ323UcAJhX7ia+Ol0+3cELG8maBjsZU+SxNHLT7MpEBenAy/cLia54eT4VE5sn/iOeinFLh3puTnXQxIrp/wEQ3rq/uOXLzBQX8K09jUqeoF+iJcGQBNGLu0dowQQPaaCYRqK7e5pqr7U8Z3akx4APQADPuVJqFI9SLApYLpBCXAsyKC/Q7zGfV6YNTEv2Tnxt/qmZ8yHUPWsV/w1JXILRN6DfrEH5T3WgHwuTh64sgXm9NV1X01iOOPGZ51brL+rlpZX0+PfmDtWACQPASQYnLJPCrWvDrLwBMO5WGdUG896fgvw+uRoYjYMvMrkKg4nqTTkx3RVdlP8whYm0eQFKfKJ3/WawSNYLfh7EBaQI19fI+jrnAeqJw9DzemzHouNZqYuAlMzYXuDF+FdVwQCY1Lf4xUfRrmPuCfxOtJBabSfvoZ0IlYyYLocNM2CwvikxGVY+U9eqyBJwDcAiUsYvUesjbJhD4DyA0DRgC2bhh/VpiaKeZRmbCPEpC3NnENm96r4Hhrdn8vgaoKvQpkE',
    //     'base64'
    //   )
    // )
    const messageArray = await pre_schema1_MessageGen()
    const cipher = await pre_schema1_Encrypt(messageArray, this.keys.pk, this.signingKeys)
    if (cipher === null) throw new Error('Failed to encrypt message')
    return {
      messageArray,
      cipher: Buffer.from(cipher).toString('base64'),
      spk: Buffer.from(this.signingKeys.spk).toString('base64')
    }
  }
  /**
   * get public key as strings
   * @returns {string} public key
   */
  getPublicKeyString() {
    this.checkInit()
    return Buffer.from(this.keys.pk).toString('base64')
  }

  /**
   * Get keys
   * @returns 
   */
  getKeys() {
    this.checkInit()
    return this.keys
  }

  /**
   * Get signing keys
   * @returns 
   */
  getSigningKeys() {
    this.checkInit()
    return this.signingKeys
  }

  /**
   * Get the serialized keys
   * @returns
   */
  getKeyStrings() {
    this.checkInit()
    return {
      pk: Buffer.from(this.keys.pk).toString('base64'),
      sk: Buffer.from(this.keys.sk).toString('base64'),
      spk: Buffer.from(this.signingKeys.spk).toString('base64'),
      ssk: Buffer.from(this.signingKeys.ssk).toString('base64')
    }
  }
}

export default KeyManager
