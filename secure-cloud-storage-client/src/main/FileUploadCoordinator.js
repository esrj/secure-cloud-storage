/**
 * This file coordinates for both file upload and hash completion,
 * then is able to upload file info to blockchain.
 */
import { logger } from './Logger'
import BlockchainManager from './BlockchainManager'
import { unlinkSync } from 'node:fs'

export default class FileUploadCoordinator {
  #resolveReadyPromise
  /**
   * Initialize
   * @param {BlockchainManager} blockchainManager
   * @param {string} metadata
   */
  constructor(blockchainManager, metadata) {
    this.blockchainManager = blockchainManager
    this.uploadFinished = false
    this.hashFinished = false
    this.uploadInstantiated = false

    this.metadata = metadata

    this.readyPromise = new Promise((resolve) => {
      this.#resolveReadyPromise = resolve
    })
  }

  /**
   * Called when the file is uploaded to the server successfully.
   * Will remove the temporate encrypted file.
   * @param {string} fileId
   * @param {string} tempEncryptedFilePath
   */
  finishUpload(fileId, tempEncryptedFilePath) {
    this.uploadFinished = true
    this.fileId = fileId
    try {
      unlinkSync(tempEncryptedFilePath)
    } catch (error) {
      logger.error(error)
    }
    this.#checkReady()
  }

  /**
   * Called when hash calculation is finished.
   * @param {string} digest sha256 hash in hex format
   */
  finishHash(digest) {
    this.hashFinished = true
    this.digest = digest
    this.#checkReady()
  }

  /**
   * Check if both upload and hash calculation have finished.
   */
  #checkReady() {
    if (this.uploadFinished && this.hashFinished && !this.uploadInstantiated) {
      this.uploadInstantiated = true
      this.#resolveReadyPromise()
    }
  }

  /**
   * Upload file info to blockchain. Will throw error.
   */
  async uploadToBlockchainWhenReady() {
    await this.readyPromise
    await this.blockchainManager.uploadFileInfo(this.fileId, this.digest, this.metadata)
  }
}
