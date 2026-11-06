/**
 * Secret-share storage across the share databases, grouped by recovery method.
 *
 * Pure factory (no config or logger imports) so it can be tested against throwaway
 * databases. SecretShareDatabase.js wires it to the configured pools.
 */
import { PASSWORD_METHOD_ID } from './RecoverySchema.js'

/**
 * @param {Array<import('pg').Pool>} pools one pool per share database
 * @param {{ error: Function }} [logger]
 */
export function createSecretShareStore(pools, logger = console) {
  /**
   * Shares of one method, at most one per database. A database that is down is skipped;
   * recovery still works as long as the Shamir threshold is met.
   * @returns {Promise<string[]>}
   */
  async function retrieveUserShares(userId, methodId = PASSWORD_METHOD_ID) {
    const shares = []
    for (const pool of pools) {
      try {
        const result = await pool.query(
          `SELECT share FROM secret_share WHERE userid = $1 AND method_id = $2 AND retrievable = TRUE;`,
          [userId, methodId]
        )
        if (result.rowCount > 0) shares.push(result.rows[0].share)
      } catch (error) {
        logger.error(error)
      }
    }
    return shares
  }

  /**
   * Delete a user's shares. Without methodId every method is removed (account deletion).
   */
  async function deleteUserShares(userId, methodId) {
    for (const pool of pools) {
      try {
        if (methodId === undefined) {
          await pool.query(`DELETE FROM secret_share WHERE userid = $1;`, [userId])
        } else {
          await pool.query(`DELETE FROM secret_share WHERE userid = $1 AND method_id = $2;`, [
            userId,
            methodId
          ])
        }
      } catch (error) {
        logger.error(error)
      }
    }
  }

  /**
   * Store the first shares, one per database. If a database fails, the same share is
   * offered to the next database.
   * @returns {Promise<number>} how many shares were stored
   */
  async function storeUserShares(userId, shares, methodId = PASSWORD_METHOD_ID) {
    let i = 0
    let j = 0
    while (i < shares.length && j < pools.length) {
      try {
        await pools[j].query(
          `INSERT INTO secret_share (userid, method_id, share, retrievable) VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (userid, method_id) DO UPDATE SET share = excluded.share`,
          [userId, methodId, shares[i]]
        )
        i++
      } catch (error) {
        logger.error(error)
      }
      j++
    }
    return i
  }

  /**
   * Which methods currently have at least one retrievable share.
   * @returns {Promise<Set<string>>}
   */
  async function listUserShareMethodIds(userId) {
    const ids = new Set()
    for (const pool of pools) {
      try {
        const result = await pool.query(
          `SELECT method_id FROM secret_share WHERE userid = $1 AND retrievable = TRUE;`,
          [userId]
        )
        for (const row of result.rows) ids.add(row.method_id)
      } catch (error) {
        logger.error(error)
      }
    }
    return ids
  }

  return { retrieveUserShares, deleteUserShares, storeUserShares, listUserShareMethodIds }
}
