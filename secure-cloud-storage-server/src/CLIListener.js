import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import { logger } from './Logger.js'
import { getOnlineUsers } from './UserLoginInfo.js'

const app = express()
app.use(express.json())

// Remove old socket if it exists
const SOCKET_PATH = '/tmp/log.sock'
if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH)

// Simple /logs endpoint
app.post('/logs', async (req, res) => {
  logger.log(req.body)
  res.json({ status: 'ok' })
})

// /online endpoint to let CLI get online users
app.get('/online', (req, res) => {
  res.json(getOnlineUsers())
})

// Create an HTTP server bound to the socket
const server = http.createServer(app)

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600) // owner-only access
  logger.info(`Log server listening on ${SOCKET_PATH}`)
})
