/**
 * recovery_method table access (main database). Pure factory for testability;
 * RecoveryManager.js wires it to the main pool from StorageDatabase.js.
 */

const toMethod = (row) =>
  row && {
    id: row.id,
    userId: row.userid,
    type: row.type,
    label: row.label,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    signCount: Number(row.sign_count),
    salt: row.salt,
    aaguid: row.aaguid,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }

/**
 * @param {{ query: Function }} db a pg Pool or Client
 */
export function createRecoveryMethodStore(db) {
  async function addFidoMethod({
    id,
    userId,
    label,
    credentialId,
    publicKey,
    signCount,
    salt,
    aaguid
  }) {
    await db.query(
      `INSERT INTO recovery_method
         (id, userid, type, label, credential_id, public_key, sign_count, salt, aaguid)
       VALUES ($1, $2, 'fido', $3, $4, $5, $6, $7, $8)`,
      [id, userId, label ?? '', credentialId, publicKey, signCount ?? 0, salt, aaguid ?? null]
    )
  }

  async function listByUser(userId) {
    const result = await db.query(
      `SELECT * FROM recovery_method WHERE userid = $1 ORDER BY created_at, id`,
      [userId]
    )
    return result.rows.map(toMethod)
  }

  async function countByUser(userId, type) {
    const result = await db.query(
      `SELECT COUNT(*)::int AS n FROM recovery_method WHERE userid = $1 AND type = $2`,
      [userId, type]
    )
    return result.rows[0].n
  }

  async function getById(id) {
    const result = await db.query(`SELECT * FROM recovery_method WHERE id = $1`, [id])
    return toMethod(result.rows[0]) ?? null
  }

  /**
   * Record a successful recovery. The counter only moves forward, so a concurrent
   * stale update cannot roll it back.
   */
  async function recordUse(id, signCount) {
    await db.query(
      `UPDATE recovery_method
          SET sign_count = GREATEST(sign_count, $2), last_used_at = NOW()
        WHERE id = $1`,
      [id, signCount]
    )
  }

  /** @returns {Promise<boolean>} whether a row of this user was deleted */
  async function deleteForUser(id, userId) {
    const result = await db.query(`DELETE FROM recovery_method WHERE id = $1 AND userid = $2`, [
      id,
      userId
    ])
    return result.rowCount > 0
  }

  return { addFidoMethod, listByUser, countByUser, getById, recordUse, deleteForUser }
}
