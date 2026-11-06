/**
 * This file handles logging to file and to renderer.
 */
import winston, { format } from 'winston'
import ScreenTransport from './ScreenTransport'
import { app } from 'electron'
import { join } from 'node:path'

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(format.errors({ stack: true }), format.timestamp(), format.json()),
  // defaultMeta: { service: 'user-service' },
  transports:
    process.env.NODE_ENV === 'test'
      ? []
      : [
          //
          // - Write all logs with importance level of `error` or less to `error.log`
          // - Write all logs with importance level of `info` or less to `combined.log`
          //
          new winston.transports.File({
            filename: join(app.getPath('logs'), 'error.log'),
            level: 'error'
          }),
          new winston.transports.File({
            filename: join(app.getPath('logs'), 'combined.log'),
            options: { flags: 'w' }
          }),
          new ScreenTransport()
        ]
})

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
      level: 'debug'
    })
  )
}

// export function logger {
//   return logger
// }

export { logger }
