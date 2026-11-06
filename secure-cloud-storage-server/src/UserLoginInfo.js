import ConfigManager from './ConfigManager.js'
import EvictingMap from './EvictingMap.js'
import { logSocketInfo, logSocketWarning } from './Logger.js'

const loginMap = new EvictingMap(ConfigManager.login.idleTimeoutMin * 60 * 1000) // For idle timeout
const socketToUserIdMap = new Map()

/**
 * Record user login information
 * @param {string} userId 
 * @param {*} socket 
 * @returns 
 */
export function userLogin(userId, socket) {
  if (loginMap.has(userId)) {
    // Already logged in
    logSocketWarning(socket, 'Multiple login for same account.')
    return false
  }
  loginMap.set(userId, { socket, loginTime: Date.now() })
  socketToUserIdMap.set(socket.id, userId)
  return true
}

/**
 * Remove user login information
 * @param {*} socket 
 */
export function userLogout(socket) {
  const userId = socketToUserIdMap.get(socket.id)
  if (userId) {
    socketToUserIdMap.delete(socket.id)
    loginMap.delete(userId)
    logSocketInfo(socket, 'User logged out.')
  }
}

/**
 * Check if user is logged in
 * @param {string} userId 
 * @returns 
 */
export function checkUserLoggedIn(userId) {
  return loginMap.has(userId)
}

/**
 * Get userId of certain socketId
 * @param {string} socketId 
 * @returns {string} userId
 */
export function getLoggedInUserIdOfSocket(socketId) {
  return socketToUserIdMap.get(socketId)
}

/**
 * Emit event to certain online user
 * @param {string} userId 
 * @param {string} event 
 * @param  {...any} data 
 */
export function emitToOnlineUser(userId, event, ...data) {
  if (loginMap.has(userId)) {
    loginMap.get(userId).socket.emit(event, ...data)
  }
}

/**
 * Get onine user information
 * @returns {Array<{userId: string, socketId: string, timestamp: number}>} online user info
 */
export function getOnlineUsers() {
  const info = []
  for (const [key, value] of loginMap) {
    info.push({ userId: key, socketId: value.socket.id, timestamp: value.loginTime })
  }
  return info
}

// Idle timeout, disconnect the user
loginMap.onExpired((key, value) => {
  logSocketInfo(
    value.socket,
    `Client Idle for ${ConfigManager.login.idleTimeoutMin} minutes. Disconnecting...`
  )
  userLogout(value.socket.id)
  value.socket.disconnect(true)
})

const loginFailureMap = new EvictingMap(ConfigManager.login.failedRecordRefreshMin * 60 * 1000) // 5 minute for failure record
const loginBlockedMap = new EvictingMap(ConfigManager.login.failedBlockTimeMin * 60 * 1000) // Block login for 15 minutes

/**
 * Check and record user login failure times
 * @param {string} userId 
 */
export function userLoginFailure(userId) {
  if (loginFailureMap.has(userId)) {
    const failureTimes = loginFailureMap.get(userId) + 1
    if (failureTimes >= ConfigManager.login.failedAttemptLimit) {
      loginBlockedMap.set(userId, 0)
    }
    loginFailureMap.set(userId, failureTimes)
  } else {
    loginFailureMap.set(userId, 1)
  }
}

/**
 * Check if login is blocked by too many failure
 * @param {string} userId 
 * @returns 
 */
export function checkLoginBlocked(userId) {
  return loginBlockedMap.has(userId)
}
