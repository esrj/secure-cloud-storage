/**
 * This file handles express server and socketio initializations.
 */
import express from 'express'
import helmet from 'helmet'
// Servers
import { Server } from 'socket.io'
// Logger
import { logger, logSocketInfo } from './Logger.js'
// File operation binders
import { allFileBinder } from './FileManager.js'
import authenticationBinder from './Authentication.js'
import { requestBinder } from './RequestManager.js'
import { adminBinder } from './AdminManager.js'
import { agentLogBinder } from './AgentLogManager.js'
import { recoveryBinder } from './RecoveryManager.js'
import ConfigManager from './ConfigManager.js'
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { userLogout } from './UserLoginInfo.js'

const app = express()
// 'trust proxy' stays at its default (off): clients reach this port directly, there is no
// reverse proxy in front, so X-Forwarded-For is whatever the caller chose to send.
// Security headers on every HTTPS response; this also removes X-Powered-By.
app.use(helmet())
logger.info(`Express app created.`)

const options = {
  key: readFileSync(ConfigManager.serverKeyPath),
  cert: readFileSync(ConfigManager.serverCertPath),
  maxHttpBufferSize: 1e8, // 100 MB
  minVersion: 'TLSv1.2'
}
const server = createServer(options, app)

server.listen(ConfigManager.httpsPort, () => {
  logger.info(`Server is running on port ${ConfigManager.httpsPort}`)
})

// No CORS headers: every client is a Node process (the Electron main process, the trusted
// authority), which CORS does not apply to, and no web page should be calling this server.
const io = new Server(server)

// Client connects
io.on('connection', (socket) => {
  socket.ip = socket.handshake.address
  // May need to get address from header if server is behind a proxy
  // See https://socket.io/how-to/get-the-ip-address-of-the-client
  socket.use(([event], next) => {
    socket.event = event
    next()
  })
  logSocketInfo(socket, 'Client connected.')

  socket.on('message', (message) => {
    logSocketInfo(socket, 'Received message.', { message })
    socket.emit('message', message + ' received by server.')
  })

  socket.on('disconnect', () => {
    // Maybe move to Authentication.js?
    userLogout(socket)

    logSocketInfo(socket, 'Client disconnected.', { event: undefined })
  })

  authenticationBinder(socket)
  allFileBinder(socket)
  requestBinder(socket, io)
  agentLogBinder(socket)
  adminBinder(socket)
  recoveryBinder(socket)
})

const emitToSocket = (socketId, event, ...data) => {
  return io.to(socketId).emit(event, ...data)
}
const disconnectSocket = (socketId) => {
  return io.sockets.sockets.get(socketId).disconnect(true)
}

// export default io
export { emitToSocket, disconnectSocket, app }
console.debug('SocketIO.js loaded.')
