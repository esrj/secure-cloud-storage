/**
 * This file handles logging to file and to terminal.
 */
import winston, { format } from 'winston'
import 'winston-daily-rotate-file'

export const logger = winston.createLogger({
  level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
  format: winston.format.combine(
    format.errors({ stack: true }),
    format.timestamp(/*{ format: timezoned }*/),
    format.json()
  ),
  transports: [
    
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    
    new winston.transports.DailyRotateFile({
      filename: '%DATE%-error.log',
      datePattern: 'YYYY-MM-DD',
      dirname: 'data',
      level: 'error'
    }),
    new winston.transports.DailyRotateFile({
      filename: '%DATE%-combined.log',
      datePattern: 'YYYY-MM-DD',
      dirname: 'data'
    }),
    new winston.transports.Console({})
  ]
})


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