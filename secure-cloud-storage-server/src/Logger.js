/**
 * This file handles logging to terminal. As the deployment position is in Kubenetes, logs are only written to terminal but not to files.
 */
import winston, { format } from 'winston'
import Transport from 'winston-transport'
import http from 'node:http'

const SOCKET_PATH = '/tmp/log.sock'
const url = `http://unix:${SOCKET_PATH}:/logs`

/**
 * Send data from CLI to main process via unix socket.
 * @param {string} socketPath
 * @param {string} path
 * @param {string} data
 * @returns
 */
const postToUnixSocket = (socketPath, path, data) => {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', resolve)
      }
    )

    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/**
 * Custom transport to log from CLI to main server process.
 */
class RemoteTransport extends Transport {
  constructor(opts = {}) {
    super(opts)
    this.url = opts.url // e.g. http://unix:/tmp/log.sock:/logs
  }

  async log(info, callback) {
    setImmediate(() => this.emit('logged', info))

    try {
      await postToUnixSocket(SOCKET_PATH, '/logs', JSON.stringify(info))
    } catch (err) {
      console.error('Failed to send remote log:', err.message)
    }

    callback()
  }
}

// create logger with format and transport
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(format.errors({ stack: true }), format.timestamp(), format.json()),
  transports: [
    process.env.IS_CLI ? new RemoteTransport({ url }) : new winston.transports.Console({})
  ]
})

logger.info('Logging initialized.')

const getSocketMeta = (socket, metaObj) => {
  return { ip: socket.ip, userId: socket.userId, event: socket.event, ...metaObj }
}

/**
 * Log info in socket events.
 * @param {Socket} socket
 * @param {String} message
 * @param {Object} metaObj
 */
export const logSocketInfo = (socket, message, metaObj = {}) => {
  logger.info(message, getSocketMeta(socket, metaObj))
}

/**
 * Log warning in socket events.
 * @param {Socket} socket
 * @param {String} message
 * @param {Object} metaObj
 */
export const logSocketWarning = (socket, message, metaObj = {}) => {
  logger.warn(message, getSocketMeta(socket, metaObj))
}

/**
 * Log error in socket events.
 * @param {Socket} socket
 * @param {Error} error
 * @param {Object} metaObj
 */
export const logSocketError = (socket, error, metaObj = {}) => {
  logger.error(error, getSocketMeta(socket, metaObj))
}

/**
 * Log invalid schema warning after checking against a schema.
 * @param {Socket} socket
 * @param {string} action The action is happening.
 * @param {Array} issues The issue of the parse result.
 * @param {Object} metaObj
 * @example
 * if(!result.success) {
 *   logInvalidSchemaWarn(socket, 'Client login', result.error.issues, request)
 *   cb({ errorMsg: InvalidArgumentErrorMsg })
 *   return
 * }
 */
export const logInvalidSchemaWarning = (socket, action, issues, metaObj = {}) => {
  logSocketWarning(socket, action + ' with invalid arguments.', { issues, ...metaObj })
}

// FtpsServer.js
const getFtpsMeta = (data, metaObj) => {
  return {
    ip: data.connection.ip,
    userId: data.userId,
    protocol: 'ftps',
    ...(data.password != 'guest' && { fileId: data.password }),
    ...metaObj
  }
}

export const logFtpsInfo = (data, message, metaObj = {}) => {
  logger.info(message, getFtpsMeta(data, metaObj))
}

export const logFtpsWarning = (data, message, metaObj = {}) => {
  logger.warn(message, getFtpsMeta(data, metaObj))
}

export const logFtpsError = (data, error, metaObj = {}) => {
  logger.error(error, getFtpsMeta(data, metaObj))
}

// HttpsServer.js
const getHttpsMeta = (req, metaObj) => {
  return {
    ip: req.ip,
    userId: req.userId,
    protocol: 'https',
    fileId: req.headers?.fileid,
    ...metaObj
  }
}

export const logHttpsInfo = (req, message, metaObj = {}) => {
  logger.info(message, getHttpsMeta(req, metaObj))
}

export const logHttpsWarning = (req, message, metaObj = {}) => {
  logger.warn(message, getHttpsMeta(req, metaObj))
}

export const logHttpsError = (req, error, metaObj = {}) => {
  logger.error(error, getHttpsMeta(req, metaObj))
}

// SftpServer.js
const getSftpMeta = (ip, userId, fileId, metaObj) => {
  return {
    ip,
    userId,
    protocol: 'sftp',
    fileId,
    ...metaObj
  }
}

export const logSftpInfo = (ip, userId, fileId, message, metaObj = {}) => {
  logger.info(message, getSftpMeta(ip, userId, fileId, metaObj))
}

export const logSftpWarning = (ip, userId, fileId, message, metaObj = {}) => {
  logger.warn(message, getSftpMeta(ip, userId, fileId, metaObj))
}

export const logSftpError = (ip, userId, fileId, error, metaObj = {}) => {
  logger.error(error, getSftpMeta(ip, userId, fileId, metaObj))
}
