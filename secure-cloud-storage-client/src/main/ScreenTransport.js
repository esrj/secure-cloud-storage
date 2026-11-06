/**
 * This file handles a logging transport to log to renderer.
 */
const Transport = require('winston-transport')
// const EventEmitter = require('events')
const { BrowserWindow } = require('electron')

class ScreenTransport extends Transport {
  constructor(opts) {
    super(opts)
    // this.logs = []
    // this.emitter = new EventEmitter()
  }

  log(info, callback) {
    // this.logs.push(info)
    // this.emitter.emit('log', info)
    // TODO: this might need to be fixed by storing main window id
    BrowserWindow.getAllWindows()[0]?.webContents.send('log', info)

    // console.log(`current log transport: ${info}`)
    // console.log(info)
    callback()
  }
}

export default ScreenTransport
