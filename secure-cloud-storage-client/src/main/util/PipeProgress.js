/**
 * This file handles a pipe that calculate the progress
 */
import { PassThrough } from 'node:stream'

const createPipeProgress = (options, logger) => {
  options = options || {}
  if (!options.total) {
    throw new Error('total is required')
  }
  // const total = options.total
  let current = 0
  const progress = new PassThrough(options)
  progress.on('data', (chunk) => {
    current += chunk.length
    logger.info(`Progress: ${current}/${options.total}`)
  })
  progress.on('end', () => {
    logger.info(`Pipe progress ended.`)
  })

  return progress
}

export { createPipeProgress }
