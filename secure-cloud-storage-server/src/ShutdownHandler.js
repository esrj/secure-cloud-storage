/**
 * This file handles graceful shutdown
 */
import { logger } from './Logger.js'
import { secretShareDbPools } from './SecretShareDatabase.js'
import { pool } from './StorageDatabase.js'

/**
 * Close storage database and secret share database connections
 */
async function closeDatabaseConnections() {
  logger.info('SIGINT signal received: Closing PostgreSQL pool...')
  await pool.end()
  for (const sharePool of secretShareDbPools) {
    await sharePool.end()
  }
  logger.info('PostgreSQL pool closed. Exiting process.')
}

/**
 * Wrapper function for gracefully shutdown
 */
export async function gracefullyShutdown() {
  await closeDatabaseConnections()
}

// terminate signal
process.on('SIGINT', async () => {
  await gracefullyShutdown()
  process.exit(0)
})

// terminate signal
process.on('SIGTERM', async () => {
  await gracefullyShutdown()
  process.exit(0)
})
