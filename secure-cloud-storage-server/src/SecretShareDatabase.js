/**
 * This file handles communication with secret share databases.
 * The queries live in SecretShareStore.js; this module binds them to the configured pools.
 */
import { Pool } from 'pg'
import ConfigManager from './ConfigManager.js'
import { logger } from './Logger.js'
import { createSecretShareStore } from './SecretShareStore.js'

export { PASSWORD_METHOD_ID } from './RecoverySchema.js'

//--  Setup --//
export const secretShareDbPools = []
for (const secretShareDbConfig of ConfigManager.secretShareDbConfigs) {
  try {
    const pool = new Pool(secretShareDbConfig)
    pool.on('error', (err) => {
      logger.error(err)
    })
    secretShareDbPools.push(pool)
  } catch (error) {
    logger.error(error)
  }
}

const store = createSecretShareStore(secretShareDbPools, logger)

/**
 * Get user's shared secrets of one recovery method (default: password) from the share databases.
 * @param {string} userId
 * @param {string} [methodId]
 * @returns {Promise<Array<string>>} secret shares
 */
export const retrieveUserShares = store.retrieveUserShares

/**
 * Delete user's shared secrets. Without methodId every recovery method is removed.
 * @param {string} userId
 * @param {string} [methodId]
 */
export const deleteUserShares = store.deleteUserShares

/**
 * Store user's shared secrets of one recovery method (default: password).
 * @param {string} userId
 * @param {Array<string>} shares
 * @param {string} [methodId]
 * @returns {Promise<number>} how many shares were stored
 */
export const storeUserShares = store.storeUserShares

/**
 * Recovery method ids that currently have shares for this user.
 * @param {string} userId
 * @returns {Promise<Set<string>>}
 */
export const listUserShareMethodIds = store.listUserShareMethodIds

// Pools are closed in ShutdownHandler.js
console.debug('SecretShareDatabase.js loaded.')
