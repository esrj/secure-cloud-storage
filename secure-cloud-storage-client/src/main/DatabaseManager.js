/**
 * Local SQLite database for client-side backup.
 *
 * NOTE: tag_table and attr_table have been REMOVED.
 * Tags and attribute IDs are now stored in the server-side PostgreSQL
 * (file_tags / file_attrs tables) and returned as part of the file-list response.
 *
 * This class is kept solely for the encrypted DB backup / recovery feature
 * (encryptToServer / recoverFromServer). The SQLite file itself is essentially
 * empty now and can be thought of as a placeholder.
 */
import Database from 'better-sqlite3'
import GlobalValueManager from './GlobalValueManager'
import { basename } from 'node:path'
import KeyManager from './KeyManager'
import { deriveAESKeyIvFromBuffer } from './Utils'
import { createReadStream } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { net } from 'electron'
import { socket } from './MessageManager'
import { logger } from './Logger'
import crypto from 'node:crypto'
import FormData from 'form-data'

class DatabaseManager {
  keyManager
  /**
   *
   * @param {KeyManager} keyManager
   */
  constructor(keyManager) {
    this.keyManager = keyManager
    this.init()
  }

  /**
   * Initialize database.
   * Old tag_table / attr_table rows are cleaned up on first run so the
   * SQLite file stays lean after the migration to PostgreSQL.
   */
  init() {
    this.db = Database(GlobalValueManager.dbPath)

    // Remove legacy tables if they still exist (one-time migration cleanup)
    try {
      this.db.prepare('DROP TABLE IF EXISTS tag_table').run()
      this.db.prepare('DROP TABLE IF EXISTS attr_table').run()
    } catch (e) {
      logger.warn(`[DatabaseManager] Could not drop legacy tables: ${e.message}`)
    }
  }

  // ── Stub methods kept for call-site compatibility ────────────────────────
  // Any code that still calls these will silently no-op rather than throw.

  /** @deprecated tags are now stored in PostgreSQL */
  getTagsOfFile(_fileId) {
    return []
  }

  /** @deprecated attrIds are now stored in PostgreSQL */
  getAttrIdsOfFile(_fileId) {
    return []
  }

  /** @deprecated tags are now stored in PostgreSQL */
  storeTagAttr(_fileId, _tags, _attrIds) {
    logger.debug('[DatabaseManager] storeTagAttr is a no-op: data lives in PostgreSQL now.')
  }

  // ── Backup / Recovery ────────────────────────────────────────────────────

  /**
   * Encrypt the database and store on server.
   */
  async encryptToServer() {
    try {
      this.db.close()
      const sk = this.keyManager.getKeys().sk
      const { key, iv } = await deriveAESKeyIvFromBuffer(sk)
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
      const fileStream = createReadStream(GlobalValueManager.dbPath)
      fileStream.pipe(cipher)
      logger.info('Upload encrypted database to server.')
      const form = new FormData()
      form.append('file', cipher, basename(GlobalValueManager.dbPath))
      const request = net.request({
        method: 'POST',
        url: `${GlobalValueManager.httpsUrl}/uploadDb`,
        headers: {
          ...form.getHeaders(),
          socketid: socket.id
        }
      })
      request.chunkedEncoding = true
      form.pipe(request)

      return new Promise((resolve, reject) => {
        request.on('response', (response) => {
          logger.info(`STATUS: ${response.statusCode}`)
          response.on('data', (chunk) => {
            logger.debug(`BODY: ${chunk}`)
          })
          response.on('end', () => {
            if (response.statusCode === 200) {
              logger.info('Succesfully upload encrypted database to server.')
            } else {
              logger.error(
                `Https received status code ${response.statusCode} and status message ${response.statusMessage}.`
              )
            }
          })
          resolve()
        })

        request.on('error', (error) => {
          logger.error(error)
          resolve()
        })
        form.on('error', (error) => {
          logger.error(error)
          resolve()
        })
      })
    } catch (error) {
      logger.error(error)
    }
  }

  /**
   * Download the encrypted database backup from the server and restore it.
   * The local database is replaced only after the whole backup downloaded and decrypted,
   * so a missing or broken backup never leaves a half-written file behind.
   * @returns {Promise<{ restored: boolean, reason?: 'no-backup' | 'error' }>}
   *   restored false means the current local database was kept as it is.
   */
  async recoverFromServer() {
    let encrypted
    try {
      encrypted = await this.#downloadBackup()
    } catch (error) {
      logger.error(`Database backup download failed: ${error.message}`)
      return { restored: false, reason: 'error' }
    }
    if (encrypted === null) {
      logger.info('The server has no database backup for this account yet.')
      return { restored: false, reason: 'no-backup' }
    }

    let plain
    try {
      const sk = this.keyManager.getKeys().sk
      const { key, iv } = await deriveAESKeyIvFromBuffer(sk)
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
    } catch (error) {
      logger.error(`Database backup could not be decrypted: ${error.message}`)
      return { restored: false, reason: 'error' }
    }

    this.db.close()
    try {
      const tempPath = `${GlobalValueManager.dbPath}.restore`
      await writeFile(tempPath, plain)
      await rename(tempPath, GlobalValueManager.dbPath)
      logger.info('Database successfully recovered')
      return { restored: true }
    } catch (error) {
      logger.error(`Database backup could not be written: ${error.message}`)
      return { restored: false, reason: 'error' }
    } finally {
      this.init()
    }
  }

  /**
   * @returns {Promise<Buffer|null>} the encrypted backup, or null when the server has none
   */
  #downloadBackup() {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: `${GlobalValueManager.httpsUrl}/downloadDb`,
        headers: { socketid: socket.id }
      })
      request.on('response', (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          logger.info(`Database backup download status: ${response.statusCode}`)
          if (response.statusCode === 200) resolve(Buffer.concat(chunks))
          else if (response.statusCode === 404) resolve(null)
          else reject(new Error(`HTTP ${response.statusCode} ${response.statusMessage}`))
        })
      })
      request.on('error', reject)
      request.end()
    })
  }
}

export default DatabaseManager
