/**
 * This file handles operations related to blockchain. Including initializing wallet, communicating with smart contract.
 */
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import ConfigManager from './ConfigManager.js'
import { logger } from './Logger.js'
import { bigIntToUuid } from './Utils.js'

const TX_WAIT_TIMEOUT_MS = 60_000

/**
 * Converts a UUID string to a BigInt for use in smart contracts.
 * The UUID string should be in the standard format (e.g., "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").
 *
 * @param {string} uuidString The UUID string to convert.
 * @returns {bigint} The BigInt representation of the UUID.
 * @throws {Error} If the UUID string format is invalid.
 */
export function uuidToBigInt(uuidString) {
  // Basic validation for UUID format
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRegex.test(uuidString)) {
    throw new Error(`Invalid UUID string format: ${uuidString}`)
  }

  // Remove hyphens and convert to BigInt
  const hexString = uuidString.replaceAll('-', '')
  return BigInt('0x' + hexString)
}

/**
 * Race tx.wait() against a timeout so write-txs never hang the server forever.
 * @param {import('ethers').TransactionResponse} tx
 * @returns {Promise<import('ethers').TransactionReceipt>}
 */
async function waitWithTimeout(tx) {
  const receipt = await Promise.race([
    tx.wait(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`tx ${tx.hash} not mined within ${TX_WAIT_TIMEOUT_MS / 1000}s`)),
        TX_WAIT_TIMEOUT_MS
      )
    )
  ])
  return receipt
}

/**
 * Manages smart contract communication
 */
class BlockchainManager {
  /**
   * Connect to blockchain and smart contract
   */
  constructor() {
    if (!ConfigManager.blockchain.enabled) return
    try {
      const abi = readFileSync(ConfigManager.blockchain.abiPath, 'utf-8')
      const url = ConfigManager.blockchain.jsonRpcUrl
      const contractAddr = ConfigManager.blockchain.contractAddr
      this.provider = new JsonRpcProvider(url)
      const wallet = this.readOrCreateWallet(ConfigManager.blockchain.walletKeyPath, this.provider)
      this.wallet = wallet
      this.contract = new Contract(contractAddr, abi, wallet)
      logger.info(`Blockchain Manager initialized with wallet address: ${wallet.address}.`)
    } catch (error) {
      logger.error(error)
    }
  }

  /**
   * Run once at startup — log wallet balance and role status so operators can
   * immediately see if the server wallet is misconfigured.
   * Also resets the nonce counter to the on-chain confirmed value.
   */
  async diagnose() {
    if (!ConfigManager.blockchain.enabled || !this.wallet) return
    try {
      const addr = this.wallet.address
      const balance = await this.provider.getBalance(addr)
      logger.info(`[Blockchain] Server wallet ${addr} balance: ${formatEther(balance)} ETH`)

      const feeData = await this.provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? 0n
      logger.info(`[Blockchain] Chain gas price: ${gasPrice}`)

      if (balance === 0n && gasPrice > 0n) {
        logger.warn(
          `[Blockchain] Server wallet has 0 ETH and chain gas price is ${gasPrice} — ` +
            `write transactions will fail. Please fund the wallet.`
        )
      } else if (balance === 0n) {
        logger.info(`[Blockchain] Server wallet has 0 ETH but chain gas price is 0 — transactions should still work.`)
      }

      const confirmed = await this.provider.getTransactionCount(addr, 'latest')
      const pending = await this.provider.getTransactionCount(addr, 'pending')
      if (pending !== confirmed) {
        logger.warn(
          `[Blockchain] Nonce mismatch — confirmed: ${confirmed}, pending: ${pending}. ` +
            `Will use confirmed nonce to avoid "nonce too distant" errors.`
        )
      }
      logger.info(`[Blockchain] Confirmed nonce: ${confirmed}`)

      const serverRole = await this.contract.SERVER_ROLE()
      const hasServer = await this.contract.hasRole(serverRole, addr)
      logger.info(`[Blockchain] Server wallet has SERVER_ROLE: ${hasServer}`)
      if (!hasServer) {
        logger.error(
          `[Blockchain] Server wallet ${addr} does NOT have SERVER_ROLE on contract ` +
            `${ConfigManager.blockchain.contractAddr}. ` +
            `setClientStatus / setFileVerification calls will revert. ` +
            `Ask the contract admin to run: grantRole(SERVER_ROLE, "${addr}").`
        )
      }
    } catch (err) {
      logger.warn(`[Blockchain] Startup diagnosis failed: ${err.message}`)
    }
  }

  /**
   * Get the next nonce from the confirmed on-chain count, bypassing the node's
   * "pending" pool which may contain stale transactions from prior server runs.
   * @returns {Promise<number>}
   */
  async #freshNonce() {
    return await this.provider.getTransactionCount(this.wallet.address, 'latest')
  }

  /**
   * Reads the wallet key and create wallet from path.
   * If key file not found, create a random wallet and store the key in key file.
   * @param {string} filepath the file path to the wallet key
   * @param {JsonRpcProvider} provider the provider of connected blockchain
   * @returns a wallet connect to the provider
   * @throws Any error occurred.
   */
  readOrCreateWallet(filepath, provider) {
    try {
      const key = readFileSync(filepath, 'utf-8').trim()
      return new Wallet(key, provider)
    } catch (error) {
      if (error.code == 'ENOENT') {
        const wallet = Wallet.createRandom(provider)
        writeFileSync(filepath, wallet.privateKey)
        return wallet
      } else {
        throw error
      }
    }
  }

  /**
   * Bind a listener to a certain event of the contract
   * @param {string} eventName Name of the event
   * @param {(...args)=> void | Promise<void>} listener The listener to bind to the contract
   * @throws Any error occurred.
   */
  bindEventListener(eventName, listener) {
    if (!ConfigManager.blockchain.enabled) return
    this.contract.on(eventName, listener)
  }

  // Error should be handled in layer above
  /**
   * Set or remove privilege of client in smart contract
   * @param {string} clientAddr blockchain address of the client
   * @param {boolean} status to add or remove privilege
   * @throws Any error occurred.
   */
  async setClientStatus(clientAddr, status) {
    if (!ConfigManager.blockchain.enabled) return
    const nonce = await this.#freshNonce()
    const tx = await this.contract.setClientStatus(clientAddr, status, { nonce })
    await waitWithTimeout(tx)
    logger.info(`set client ${clientAddr} status to ${status}`)
  }

  /**
   * Check whether a client address already holds CLIENT_ROLE on the contract.
   * Uses a read-only call — no gas consumed.
   * @param {string} clientAddr blockchain address of the client
   * @returns {Promise<boolean>}
   * @throws Any error occurred.
   */
  async hasClientRole(clientAddr) {
    if (!ConfigManager.blockchain.enabled) return true
    const role = await this.contract.CLIENT_ROLE()
    return await this.contract.hasRole(role, clientAddr)
  }

  /**
   * Ensure a client has CLIENT_ROLE on the contract.
   * Checks first (free read call); only submits a write transaction if the role
   * is actually missing. Safe to call on every login as a safety net.
   * @param {string} clientAddr blockchain address of the client
   * @throws Any error occurred.
   */
  async ensureClientRole(clientAddr) {
    if (!ConfigManager.blockchain.enabled) return
    const alreadyGranted = await this.hasClientRole(clientAddr)
    if (!alreadyGranted) {
      logger.info(`CLIENT_ROLE missing for ${clientAddr} — granting via setClientStatus.`)
      await this.setClientStatus(clientAddr, true)
      logger.info(`CLIENT_ROLE granted to ${clientAddr}.`)
    }
  }

  /**
   * Set verification for a file.
   * @param {string} fileId UUID of the file.
   * @param {string} fileOwnerAddr Blockchain address of the file owner.
   * @param {'success' | 'fail'} verificationInfo Verification information.
   * @returns the transaction receipt
   * @throws Any error occurred.
   */
  async setFileVerification(fileId, fileOwnerAddr, verificationInfo) {
    if (!ConfigManager.blockchain.enabled) return
    const nonce = await this.#freshNonce()
    const tx = await this.contract.setFileVerification(
      uuidToBigInt(fileId),
      fileOwnerAddr,
      verificationInfo,
      { nonce }
    )
    logger.info(`set verification for ${fileId}`)
    return await waitWithTimeout(tx)
  }

  /**
   * Add authorization record for a file, requestor, and authorizer.
   * @param {string} fileId UUID of the file.
   * @param {string} requestorAddr Blockchain address of the requestor.
   * @param {string} authorizerAddr Blockchain address of the authorizer.
   * @param {'not-replied' | 'agreed' | 'rejected'} authInfo Authorization information.
   * @throws Any error occurred.
   */
  async addAuthRecord(fileId, requestorAddr, authorizerAddr, authInfo) {
    if (!ConfigManager.blockchain.enabled) return
    const nonce = await this.#freshNonce()
    const tx = await this.contract.addAuthorization(
      uuidToBigInt(fileId),
      requestorAddr,
      authorizerAddr,
      authInfo,
      { nonce }
    )
    await waitWithTimeout(tx)
    logger.info(`added authorization record for file ${fileId}`)
  }

  /**
   * Upload file information for a reencrypted file.
   * @param {string} fileId UUID of the file.
   * @param {string | BigInt} fileHash SHA256 hash of the file.
   * @param {string} metadata File metadata in JSON format.
   * @param {string} requestorAddr Blockchain address of the requestor.
   * @param {string} authorizerAddr Blockchain address of the authorizer.
   * @param {'success'} verificationInfo Verification information.
   * @param {'agreed'} authInfo Authorization information.
   * @returns The transaction receipt
   * @throws Any error occurred.
   */
  async reencryptFile(
    fileId,
    fileHash,
    metadata,
    requestorAddr,
    authorizerAddr,
    verificationInfo = 'success',
    authInfo = 'agreed'
  ) {
    if (!ConfigManager.blockchain.enabled) return
    const nonce = await this.#freshNonce()
    const tx = await this.contract.reencryptFile(
      uuidToBigInt(fileId),
      BigInt(fileHash),
      metadata,
      requestorAddr,
      authorizerAddr,
      verificationInfo,
      authInfo,
      { nonce }
    )
    logger.info(`Uploaded, verified and added record for reencrypted file ${fileId}.`)
    return await waitWithTimeout(tx)
  }

  /**
   * Get hash and metadata of a file.
   * @param {string} fileId UUID of the file.
   * @param {string} fileOwnerAddr Blockchain address of the file owner.
   * @returns Latest event arguments or null if not found.
   * @throws Any error occurred.
   */
  async getFileInfo(fileId, fileOwnerAddr) {
    if (!ConfigManager.blockchain.enabled) return null
    const events = await this.contract.queryFilter(
      this.contract.filters.FileUploaded(uuidToBigInt(fileId), fileOwnerAddr)
    )
    logger.info(`retrived fileInfo for fileId ${fileId}`)
    if (events.length == 0) {
      return null
    } else {
      const eventArgs = events.at(1).args
      return {
        fileId: bigIntToUuid(eventArgs.fileId),
        fileOwnerAddr: String(eventArgs.fileOwner),
        fileHash: BigInt(eventArgs.fileHash),
        metadata: String(eventArgs.metadata),
        timestamp: BigInt(eventArgs.timestamp)
      }
    }
  }
}

export default new BlockchainManager()
console.debug('BlockchainManager.js loaded.')