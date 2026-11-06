/** In-memory stand-ins with the same contract as RecoveryMethodStore / SecretShareStore. */
import { PASSWORD_METHOD_ID } from '../../src/RecoverySchema.js'

export function memoryMethodStore() {
  const rows = new Map()
  return {
    rows,
    async addFidoMethod(m) {
      for (const r of rows.values()) {
        if (r.credentialId === m.credentialId) throw new Error('duplicate credential_id')
      }
      rows.set(m.id, {
        ...m,
        type: 'fido',
        signCount: m.signCount ?? 0,
        createdAt: new Date(),
        lastUsedAt: null
      })
    },
    async listByUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId)
    },
    async countByUser(userId, type) {
      return [...rows.values()].filter((r) => r.userId === userId && r.type === type).length
    },
    async getById(id) {
      return rows.get(id) ?? null
    },
    async recordUse(id, signCount) {
      const r = rows.get(id)
      r.signCount = Math.max(r.signCount, signCount)
      r.lastUsedAt = new Date()
    },
    async deleteForUser(id, userId) {
      const r = rows.get(id)
      if (!r || r.userId !== userId) return false
      rows.delete(id)
      return true
    }
  }
}

/** `down` lists database indexes that reject every query. */
export function memoryShareStore({ dbCount = 3, down = [] } = {}) {
  const dbs = Array.from({ length: dbCount }, () => new Map())
  const key = (userId, methodId) => `${userId}\u0000${methodId}`
  return {
    dbs,
    async retrieveUserShares(userId, methodId = PASSWORD_METHOD_ID) {
      return dbs
        .filter((_, j) => !down.includes(j))
        .map((db) => db.get(key(userId, methodId)))
        .filter(Boolean)
    },
    async deleteUserShares(userId, methodId) {
      dbs.forEach((db, j) => {
        if (down.includes(j)) return
        for (const k of [...db.keys()]) {
          const [u, m] = k.split('\u0000')
          if (u === userId && (methodId === undefined || m === methodId)) db.delete(k)
        }
      })
    },
    async storeUserShares(userId, shares, methodId = PASSWORD_METHOD_ID) {
      let i = 0
      for (let j = 0; i < shares.length && j < dbs.length; j++) {
        if (down.includes(j)) continue
        dbs[j].set(key(userId, methodId), shares[i])
        i++
      }
      return i
    },
    async listUserShareMethodIds(userId) {
      const ids = new Set()
      dbs.forEach((db, j) => {
        if (down.includes(j)) return
        for (const k of db.keys()) {
          const [u, m] = k.split('\u0000')
          if (u === userId) ids.add(m)
        }
      })
      return ids
    }
  }
}
