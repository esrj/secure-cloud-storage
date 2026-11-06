/**
 * This file handles operations related to blockchain. Including initializing wallet and communicate with smart contract.
 */
import { JsonRpcProvider, Contract, Wallet } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'

const BLOCK_RANGE_LIMIT = GlobalValueManager.blockchain.blockRangeLimit

/**
 * Converts a UUID string to a BigInt for use in smart contracts.
 * The UUID string should be in the standard format (e.g., "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").
 *
 * @param {string} uuidString The UUID string to convert.
 * @returns {bigint} The BigInt representation of the UUID.
 * @throws {Error} If the UUID string format is invalid.
 */
function uuidToBigInt(uuidString) {
  // Basic validation for UUID format
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRegex.test(uuidString)) {
    throw new Error(`Invalid UUID string format: ${uuidString}`)
  }

  // Remove hyphens and convert to BigInt
  const hexString = uuidString.replace(/-/g, '')
  return BigInt('0x' + hexString)
}

/**
 * Converts a BigInt (representing a UUID) back to a standard UUID string.
 * This assumes the BigInt was originally derived from a 128-bit UUID.
 *
 * @param {bigint} uuidBigInt The BigInt to convert back to a UUID string.
 * @returns {string} The UUID string in standard format.
 * @throws {Error} If the BigInt is too large to be a 128-bit UUID.
 */
function bigIntToUuid(uuidBigInt) {
  // A 128-bit number's maximum value in hexadecimal is 16^32 - 1.
  // The maximum BigInt for a 128-bit UUID is 2^128 - 1, which is (2^64)^2 - 1.
  // This translates to 'ffffffffffffffffffffffffffffffff' in hex.
  const max128BitBigInt = (1n << 128n) - 1n // Calculate 2^128 - 1n

  if (uuidBigInt < 0n || uuidBigInt > max128BitBigInt) {
    throw new Error(`BigInt ${uuidBigInt} is out of the valid range for a 128-bit UUID.`)
  }

  // Convert BigInt to hexadecimal string, then pad with leading zeros if necessary
  let hexString = uuidBigInt.toString(16)

  // Ensure the hex string is 32 characters long (128 bits = 32 hex chars)
  hexString = hexString.padStart(32, '0')

  // Insert hyphens to format as a UUID
  return [
    hexString.substring(0, 8),
    hexString.substring(8, 12),
    hexString.substring(12, 16),
    hexString.substring(16, 20),
    hexString.substring(20, 32)
  ].join('-')
}

/**
 * Manages smart contract communication.
 */
class BlockchainManager {
  wallet
  provider
  contract
  /**
   * Connect to blockchain and smart contract.
   */
  constructor() {
    try {
      // if (!GlobalValueManager.blockchain.enabled) return
      const url = GlobalValueManager.blockchain.jsonRpcUrl
      const abi = GlobalValueManager.blockchain.abi
      const contractAddr = GlobalValueManager.blockchain.contractAddr
      this.provider = new JsonRpcProvider(url)
      this.wallet = this.readOrCreateWallet(
        GlobalValueManager.blockchain.walletKeyPath,
        this.provider
      )
      this.contract = new Contract(contractAddr, abi, this.wallet)
      logger.info(`Blockchain Manager initialized with wallet address: ${this.wallet.address}.`)
    } catch (error) {
      logger.error(error)
    }
  }

  /**
   * Restore the wallet with the provided private key
   * @param {string} privateKey
   */
  restoreWallet(privateKey) {
    writeFileSync(GlobalValueManager.blockchain.walletKeyPath, privateKey)
    this.wallet = new Wallet(privateKey, this.provider)
    this.contract = this.contract.connect(this.wallet)
  }

  /**
   * Reads the wallet key and create wallet from path.
   * If key file not found, create a random wallet and store the key in key file.
   * @param {string} filepath The file path to the wallet key.
   * @param {JsonRpcProvider} provider The provider of connected blockchain.
   * @returns A wallet connect to the provider.
   */
  readOrCreateWallet(filepath, provider) {
    try {
      const key = readFileSync(filepath, 'utf-8').trim()
      return new Wallet(key, provider)
    } catch (error) {
      if (error.code == 'ENOENT') {
        logger.info('wallet key file not found. creating wallet key file.')
        const wallet = Wallet.createRandom(provider)
        writeFileSync(filepath, wallet.privateKey)
        return wallet
      } else {
        throw error
      }
    }
  }

  // async printContractOwner() {
  //   logger.info(`The owner of contract is ${await this.contract.owner()}`)
  // }

  // Error should be handled by the layer above
  /**
   * Upload file hash and metadata to blockchain
   * @param {string | BigInt} fileId UUID of the file
   * @param {string | BigInt} fileHash sha256 hash of the file
   * @param {string} metadata file metadata in JSON format
   * @throws Any error occurred.
   */
  async uploadFileInfo(fileId, fileHash, metadata) {
    if (!GlobalValueManager.blockchain.enabled) return
    const bFileId = uuidToBigInt(fileId)
    const bFileHash = BigInt(fileHash)

    // Test upload error
    // throw new Error('Test upload error.')

    // Do upload
    const tx = await this.contract.uploadFile(bFileId, bFileHash, metadata)
    await tx.wait()
    logger.debug(
      `upload fileInfo with bfileId: ${bFileId}, bfileHash: ${bFileHash}, metadata: ${metadata}`
    )
    logger.info(`fileInfo of Id ${fileId} uploaded to blockchain successfully`)
  }

  /**
   * Get hash and metadata of a file.
   * @param {string} fileId UUID of the file.
   * @param {number} blockNumber the block number where the event is at.
   * @param {string | undefined} fileOwnerAddr Blockchain address of the file owner. Leave blank to use this client's address.
   * @returns Latest event arguments or null if not found.
   * @throws Any error occurred.
   */
  async getFileInfo(fileId, blockNumber, fileOwnerAddr) {
    if (!GlobalValueManager.blockchain.enabled) return null
    if (!fileOwnerAddr) fileOwnerAddr = this.wallet.address
    // const latestBlock = await this.provider.getBlockNumber()
    // let toBlock = latestBlock
    // while (toBlock > 0) {
    // const fromBlock = Math.max(0, toBlock - BLOCK_RANGE_LIMIT)

    const events = await this.contract.queryFilter(
      this.contract.filters.FileUploaded(uuidToBigInt(fileId), fileOwnerAddr),
      blockNumber,
      blockNumber
    )
    // logger.debug(`Retriving fileInfo from block ${fromBlock} to block ${toBlock}.`)
    if (events.length > 0) {
      logger.info(`Retrived fileInfo for fileId ${fileId}.`)
      const eventArgs = events[events.length - 1].args
      return {
        fileId: bigIntToUuid(eventArgs.fileId),
        fileHash: BigInt(eventArgs.fileHash),
        metadata: String(eventArgs.metadata),
        fileOwnerAddr: String(eventArgs.fileOwner),
        timestamp: BigInt(eventArgs.timestamp)
      }
    }
    // toBlock = fromBlock - 1
    // }

    logger.info(`FileInfo not found for fileId ${fileId}.`)
    return null
  }

  // /**
  //  * Get file hash and metadata of a reencrypted file.
  //  * @param {string} fileId UUID of the file.
  //  * @param {string | undefined} fileOwnerAddr Blockchain address of the reencrypted file owner. Leave blank to use this client's address.
  //  * @returns Latest event arguments or null if not found.
  //  * @throws Any error occurred.
  //  */
  // async getReencryptFileInfo(fileId, fileOwnerAddr) {
  //   if (!fileOwnerAddr) fileOwnerAddr = this.wallet.address
  //   const events = await this.contract.queryFilter(
  //     this.contract.filters.ReencryptFileUploaded(uuidToBigInt(fileId), fileOwnerAddr)
  //   )
  //   logger.info(`retrived reencrypt fileInfo for fileId ${fileId}`)
  //   if (events.length == 0) {
  //     return null
  //   } else {
  //     const eventArgs = events[events.length - 1].args
  //     return {
  //       fileId: bigIntToUuid(eventArgs.fileId),
  //       fileHash: BigInt(eventArgs.fileHash),
  //       metadata: String(eventArgs.metadata),
  //       uploaderAddr: String(eventArgs.uploader),
  //       fileOwnerAddr: String(eventArgs.fileOwner),
  //       timestamp: BigInt(eventArgs.timestamp)
  //     }
  //   }
  // }

  /**
   * Get verification information of a file.
   * @param {string} fileId UUID of the file.
   * @param {number} blockNumber the block number where the event is at.
   * @param {string  | undefined} fileOwnerAddr blockchain address of the file owner. Leave blank to use this client's address.
   * @returns Latest event arguments or null if not found.
   * @throws Any error occurred.
   */
  async getFileVerification(fileId, blockNumber, fileOwnerAddr) {
    if (!GlobalValueManager.blockchain.enabled) return null
    if (!fileOwnerAddr) fileOwnerAddr = this.wallet.address
    // const latestBlock = await this.provider.getBlockNumber()
    // let toBlock = latestBlock
    // while (toBlock > 0) {
    // const fromBlock = Math.max(0, toBlock - BLOCK_RANGE_LIMIT)
    const events = await this.contract.queryFilter(
      this.contract.filters.FileVerified(uuidToBigInt(fileId), fileOwnerAddr),
      blockNumber,
      blockNumber
    )
    // logger.debug(`Retriving file verification info from block ${fromBlock} to block ${toBlock}.`)
    if (events.length > 0) {
      logger.info(`Retrieved file verification info for fileId ${fileId}.`)
      const eventArgs = events[events.length - 1].args
      return {
        fileId: bigIntToUuid(eventArgs.fileId),
        fileOwnerAddr: String(eventArgs.fileOwner),
        verificationInfo: String(eventArgs.verificationInfo),
        verifierAddr: String(eventArgs.verifier),
        timestamp: BigInt(eventArgs.timestamp)
      }
    }
    // toBlock = fromBlock - 1
    // }
    logger.info(`File verification info not found for fileId ${fileId}.`)
    return null
  }

  /**
   * Get authentication records of a file.
   * @param {string} fileId UUID of the file.
   * @param {string | undefined} requestorAddr Blockchain address of the requestor. Leave blank to use this client's address
   * @returns Latest event arguments or null if not found.
   * @throws Any error occurred.
   */
  async getFileAuthRecord(fileId, requestorAddr) {
    if (!GlobalValueManager.blockchain.enabled) return null
    if (!requestorAddr) requestorAddr = this.wallet.address
    const latestBlock = await this.provider.getBlockNumber()
    let toBlock = latestBlock
    while (toBlock > 0) {
      const fromBlock = Math.max(0, toBlock - BLOCK_RANGE_LIMIT)
      const events = await this.contract.queryFilter(
        this.contract.filters.FileAuthorizationAdded(uuidToBigInt(fileId), requestorAddr),
        fromBlock,
        toBlock
      )
      logger.debug(`Retriving file auth record from block ${fromBlock} to block ${toBlock}.`)
      if (events.length > 0) {
        logger.info(`Retrieved file auth record for fileId ${fileId}.`)
        const eventArgs = events[events.length - 1].args
        return {
          fileId: bigIntToUuid(eventArgs.fileId),
          requestorAddr: String(eventArgs.requestor),
          authorizerAddr: String(eventArgs.authorizer),
          authorizationInfo: String(eventArgs.authorizationInfo),
          verifierAddr: String(eventArgs.verifier),
          timestamp: BigInt(eventArgs.timestamp)
        }
      }
      toBlock = fromBlock - 1
    }
    logger.info(`File auth record not found for fileId ${fileId}`)
    return null
  }
}

// const blockchainManager = new BlockchainManager()
// blockchainManager.printContractOwner().catch((error) => logger.error(error))
// blockchainManager
//   .uploadFileInfo('0x552', '0x899', 'this is a file')
//   .catch((error) => logger.error(error))

export default BlockchainManager
