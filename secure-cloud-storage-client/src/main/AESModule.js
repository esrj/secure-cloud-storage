/**
 * This file handles file encryption/decryption with AES and creating file hash.
 */
import crypto from 'crypto'
import Stream, { Readable } from 'stream'
import KeyManager from './KeyManager'
import { logger } from './Logger'

class AESModule {
  keyManager
  /**
   *
   * @param {KeyManager} keyManager
   */
  constructor(keyManager) {
    this.keyManager = keyManager
  }

  /**
   * Encrypt the readstream with random AES key, and encrypt the AES key with user public key.
   * @param {*} readstream
   * @returns
   */
  async encrypt(readstream) {
    const { messageArray, cipher, spk } = await this.keyManager.randCipher()
    const key = messageArray.buffer.slice(0, 32)
    const iv = messageArray.buffer.slice(32, 48)
    const streamCipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    const encryptedStream = Readable.from(readstream.pipe(streamCipher))

    // Test for encryption error
    // encryptedStream.emit('error', new Error('Test encryption error.'))

    // encode key and iv
    return {
      cipher,
      spk,
      encryptedStream
    }
  }

  /**
   * Decrypt an encrypted buffer directly (non-streaming, for watermark post-processing).
   * @param {Buffer} encryptedBuffer
   * @param {string} cipher  Encrypted AES key
   * @param {string} spk     Signing public key
   * @param {boolean} proxied
   * @returns {Promise<Buffer>} Decrypted content
   */
  async decryptBuffer(encryptedBuffer, cipher, spk, proxied = false) {
    const message = await this.keyManager.decrypt(cipher, spk, proxied, true)
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      message.buffer.slice(0, 32),
      message.buffer.slice(32, 48)
    )
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()])
  }

  /**
   *  Decrypt the encrypted AES key with user's public key and create a decipher stream with the AES key.
   * @param {string} cipher
   * @param {string} spk
   * @param {boolean} proxied
   * @returns crypto.Decipher
   */
  async decrypt(cipher, spk, proxied = false) {
    const message = await this.keyManager.decrypt(cipher, spk, proxied, true)
    // decode key and iv
    const streamDecipher = crypto.createDecipheriv(
      'aes-256-cbc',
      message.buffer.slice(0, 32),
      message.buffer.slice(32, 48)
    )

    return streamDecipher
  }

  /**
   * Create a hash for the cipher stream with callback.
   * @param {Stream} cipherStream the stream to hash
   * @param {(digest:string)=>void | Promise<void>} callback the callback to call with digest
   */
  makeHash(cipherStream, callback) {
    const hash = crypto.createHash('sha256')
    cipherStream.pipe(hash)

    hash.on('finish', async () => {
      logger.info(`Finish hash calculation.`)
      try {
        const digest = '0x' + hash.digest('hex') // Append 0x for it to be able to convert to BigInt
        await callback(digest)
      } catch (error) {
        logger.error(error)
      }
    })
  }

  /**
   * Create a hash for the cipher stream with promise.
   * @param {Stream} cipherStream the stream to hash
   * @returns {Promise<string>} the stream to hash
   */
  // makeHashPromise(cipherStream) {
  //   return new Promise((resolve, reject) => {
  //     const hash = crypto.createHash('sha256')
  //     cipherStream.pipe(hash)

  //     hash.on('finish', () => {
  //       logger.info(`Finish hash calculation.`)
  //       // const digest = '0x' + hash.digest('hex')
  //       const digest = '0x12345'
  //       resolve(digest)
  //     })
  //     hash.on('error', (err) => {
  //       reject(err)
  //     })
  //     // Test hash error
  //     // hash.emit('error', new Error('Test hash error.'))
  //   })
  // }
  // secure-cloud-storage-client/src/main/AESModule.js
    makeHashPromise(cipherStream) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      cipherStream.pipe(hash)

      hash.on('finish', () => {
        logger.info(`Finish hash calculation.`)
        // 真的用 SHA-256 結果，不要再用假資料
        const digest = '0x' + hash.digest('hex') // 跟 makeHash 一樣
        resolve(digest)
      })

      hash.on('error', (err) => {
        reject(err)
      })

      // 如果要測錯誤就自己打開這行：
      // hash.emit('error', new Error('Test hash error.'))
    })
  }

}

export default AESModule
