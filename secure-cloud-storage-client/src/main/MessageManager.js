/**
 * This file handles socket initialization and connection events.
 */
import io from 'socket.io-client'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'
logger.info(`Connecting to server...: ${GlobalValueManager.httpsUrl}`)

// localhost
// const socket = io(GlobalValueManager.httpsUrl, {
//   // reconnectionAttempts: 10,
//   rejectUnauthorized: false
// })


// 測試上線
const socket = io(GlobalValueManager.httpsUrl,{
  transports: ["polling"],   // ✅ 先固定 polling
  upgrade: false,            // ✅ 不要升級 websocket
  rejectUnauthorized: false, // 你用 self-signed 就留著
});

  socket.on("connect", () => {
    logger.info(`socket.id=${socket.id}`)
  })
  socket.on("connect_error", (e) => {
    logger.error(`connect_error=${e.message}`)
  })


socket.on('message', (message) => {
  // console.log(message)
  // logger.log('info', `received message from server: ${message}`)
  GlobalValueManager.sendNotice(message, 'normal')
})

socket.on('connect', () => {
  logger.info('connected to server')
})

socket.on('connect_error', (error) => {
  if (socket.active) {
    // temporary failure, the socket will automatically try to reconnect
    logger.debug(error.message)
    logger.info("Can't connect to server. Trying to reconnect...")
  } else {
    // the connection was denied by the server
    // in that case, `socket.connect()` must be manually called in order to reconnect
    logger.error(`connection failed with following error: ${error.message}`)
    // console.log(error.message);
  }
})

socket.io.on('reconnect_failed', () => {
  logger.error('reconnection failed. The server might be down.')
})

socket.io.on('reconnect', () => {
  logger.info('server reconnected')
  GlobalValueManager.sendNotice('Server reconnected', 'success')
  GlobalValueManager.reLogin()
  // login() <- could cause circular reference problem.
})

socket.io.on('close', () => {
  logger.info('connection closed')
  GlobalValueManager.loggedIn = false
  GlobalValueManager.sendNotice('Server connection closed', 'error')
})

export function sendMessage(message) {
  socket.emit('message', message)
}

export { socket }
