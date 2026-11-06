/**
 * Admin-only socket events.
 *
 * Every handler requires a logged-in socket whose role is 'admin' (set at
 * login from users.role). The renderer hides admin pages for normal users,
 * but the real boundary is `checkAdmin` here.
 *
 *   admin-list-users            → { users: [{ id, name, email, role, status, timestamp, fileCount, conversationCount }] }
 *   admin-export-conversations  → { user, messageCount, sessionCount, messages: [...] }
 *                                 messages are flattened across sessions and
 *                                 sorted oldest-first, each carrying its own
 *                                 conversationId for traceability.
 *   admin-user-download-logs    → { logs: [{ id, fileId, fileName, ownerId, mode, watermarkVisible, watermarkInvisible, timestamp }] }
 */
import { logInvalidSchemaWarning, logSocketError, logSocketInfo, logSocketWarning } from './Logger.js'
import {
  checkAdmin,
  checkLoggedIn,
  InternalServerErrorMsg,
  InvalidArgumentErrorMsg,
  NotAdminErrorMsg,
  NotLoggedInErrorMsg
} from './Utils.js'
import {
  getAllUsersWithStats,
  getUserById,
  getAgentMessagesByUserId,
  getDownloadLogsByUserId
} from './StorageDatabase.js'
import { AdminUserIdRequestSchema } from './Validation.js'

// Upper bound for one JSON export. Far above any realistic demo volume; a
// clipped export keeps the newest messages.
const EXPORT_MESSAGE_LIMIT = 5000

/**
 * Shared precondition: logged in AND admin. Replies with the proper error
 * message and returns false when the caller must stop.
 */
const requireAdmin = (socket, actionStr, request, cb) => {
  if (!checkLoggedIn(socket)) {
    logSocketWarning(socket, actionStr + ' but is not logged in.', request)
    cb({ errorMsg: NotLoggedInErrorMsg })
    return false
  }
  if (!checkAdmin(socket)) {
    logSocketWarning(socket, actionStr + ' but is not an admin.', request)
    cb({ errorMsg: NotAdminErrorMsg })
    return false
  }
  return true
}

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role || 'user',
  status: u.status,
  timestamp: u.timestamp
})

export const adminBinder = (socket) => {
  /**
   * List every user with file / conversation counts.
   */
  socket.on('admin-list-users', async (request, cb) => {
    try {
      const actionStr = 'Admin asks to list users'
      logSocketInfo(socket, actionStr + '.')
      if (!requireAdmin(socket, actionStr, request, cb)) return

      const rows = await getAllUsersWithStats()
      const users = rows.map((u) => ({
        ...publicUser(u),
        fileCount: u.filecount ?? 0,
        conversationCount: u.conversationcount ?? 0
      }))
      cb({ users })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Export all smart-search conversations of one user (for the JSON download).
   */
  socket.on('admin-export-conversations', async (request, cb) => {
    try {
      const actionStr = 'Admin asks to export conversations'
      logSocketInfo(socket, actionStr + '.', request)
      if (!requireAdmin(socket, actionStr, request, cb)) return

      const result = AdminUserIdRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { userId } = result.data

      const target = await getUserById(userId)
      if (!target) {
        cb({ errorMsg: 'User not found.' })
        return
      }
      const rows = await getAgentMessagesByUserId(userId, EXPORT_MESSAGE_LIMIT)
      // The message id is UNIQUE in the table, so this can only ever be a
      // no-op — kept as a guard so an export can never show a turn twice.
      const seen = new Set()
      const messages = rows.filter((m) => !seen.has(m.id) && seen.add(m.id))
      const sessionCount = new Set(messages.map((m) => m.conversationId)).size
      logSocketInfo(socket, 'Exported user conversations.', {
        targetUserId: userId,
        messages: messages.length,
        sessions: sessionCount
      })
      cb({
        user: publicUser(target),
        exportedBy: socket.userId,
        exportedAt: new Date().toISOString(),
        messageCount: messages.length,
        sessionCount,
        messages
      })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Download audit trail of one user (used by the watermark trace page after
   * a uid has been decoded to a user).
   */
  socket.on('admin-user-download-logs', async (request, cb) => {
    try {
      const actionStr = 'Admin asks for user download logs'
      logSocketInfo(socket, actionStr + '.', request)
      if (!requireAdmin(socket, actionStr, request, cb)) return

      const result = AdminUserIdRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { userId } = result.data
      const logs = await getDownloadLogsByUserId(userId, 200)
      cb({ logs })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}

console.debug('AdminManager.js loaded.')
