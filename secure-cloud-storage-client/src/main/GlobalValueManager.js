/**
 * This file handles config and global value settings.
 */
import { logger } from './Logger'
import path, { join, dirname, resolve } from 'node:path'
import { app } from 'electron'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'

// const localDir = '' // For linux, running from where this file is located as portable
logger.debug(`app path: ${app.getAppPath()}`)
logger.debug(`exe path: ${app.getPath('exe')}`)
logger.debug(`userData path: ${app.getPath('userData')}`)
logger.debug(`temp path: ${app.getPath('temp')}`)
logger.debug(`execute path: ${process.execPath}`)
logger.debug(`resource path: ${process.resourcesPath}`)
logger.debug(`cwd path: ${process.cwd()}`)
logger.debug(`dirname: ${__dirname}`)
logger.debug(`log path: ${app.getPath('logs')}`)
process.env['NODE_CONFIG_DIR'] =
  `${app.getAppPath()}/config${path.delimiter}${join(app.getPath('userData'), 'config')}`
const config = require('config')

class GlobalValueManager {
  /**
   * Initialize global values from config file
   */
  constructor() {
    try {
      this.serverConfig = config.get('server')
      this.keysConfig = config.get('keys')
      this.userConfig = config.get('user')
      this.requestConfig = config.get('request')
      this.userListConfig = config.get('userList')
      this.tempPath = app.getPath('temp')

      this.keyPath = resolve(app.getPath('userData'), config.get('keys.path'))

      // Blockchain
      this.blockchain = new Object()
      this.blockchain.abi = config.get('blockchain.abi')
      this.blockchain.jsonRpcUrl = config.get('blockchain.jsonRpcUrl')
      this.blockchain.contractAddr = config.get('blockchain.contractAddr')
      this.blockchain.walletKeyPath = resolve(
        app.getPath('userData'),
        config.get('blockchain.walletKeyFilename')
      )

      this.blockchain.blockRangeLimit = config.get('blockchain.blockRangeLimit')
      this.blockchain.enabled = config.get('blockchain.enabled')

      // Trusted Authority
      this.trustedAuthority = {}
      this.trustedAuthority.url = `https://${config.get('trustedAuthority.url')}`

      this.configFilePath = join(app.getPath('userData'), 'config', 'local.yaml')
      // Create and store some setting in local.yaml if not exist
      if (!existsSync(this.configFilePath)) {
        this.updateConfigFile('blockchain', {
          jsonRpcUrl: this.blockchain.jsonRpcUrl,
          contractAddr: this.blockchain.contractAddr
        })
        this.updateConfigFile('server', {
          protocol: this.serverConfig.protocol,
          host: this.serverConfig.host
        })
      }
    } catch (error) {
      logger.error(`Failed to load config: ${error}`)
    }

    // global values
    this.mainWindow = null
    this.curFolderId = null
    this._userInfo = {}
    this._loggedIn = false
    logger.info('Global value manager initialized')
    logger.debug(`userData path: ${app.getPath('userData')}`)
  }

  get httpsUrl() {
    return `https://${this.serverConfig.host}:${this.serverConfig.port.https}`
  }

  get userDataPath() {
    return app.getPath('userData')
  }

  get userId() {
    if (this.userInfo) {
      return this.userInfo.userId
    }
    return null
  }

  get dbPath() {
    return path.resolve(this.userDataPath, 'database.db')
  }

  set loggedIn(loggedIn) {
    this._loggedIn = loggedIn
    this.mainWindow?.webContents.send('login-status', { loggedIn })
  }

  get loggedIn() {
    return this._loggedIn
  }

  set userInfo(userInfo) {
    this._userInfo = userInfo
    this.mainWindow?.webContents.send('user-info', userInfo)
  }

  get userInfo() {
    return this._userInfo
  }

  // get keyPath() {
  //   return resolve(app.getPath('userData'), 'user.keys')
  // }

  reLogin() {
    // Should be injected by LoginManager.
    this.loginManager?.login()
  }

  /**
   * Update the config file with value for a certain field
   * @param {string} field
   * @param {*} value
   */
  updateConfigFile(field, value) {
    try {
      let currentStr = '{}'
      try {
        currentStr = readFileSync(this.configFilePath, 'utf-8')
      } catch (error) {
        if (error.code === 'ENOENT') {
          logger.info('Creating config file at ' + this.configFilePath)
          mkdirSync(dirname(this.configFilePath), { recursive: true })
        } else {
          throw error
        }
      }

      const current = yaml.load(currentStr)
      current[field] = value
      writeFileSync(this.configFilePath, yaml.dump(current))
    } catch (error) {
      logger.error(`Failed to update config: ${error}`)
    }
  }

  /**
   * Update user info to config. Actually not called anymore.
   * @param {*} user
   */
  updateUser(user) {
    try {
      this.updateConfigFile('user', user)
      this.userConfig = config.get('user')
      this.mainWindow?.webContents.send('notice', 'Success to update user info', 'success')
    } catch (error) {
      logger.error(`Failed to update user: ${error}`)
      this.mainWindow?.webContents.send('notice', 'Failed to update user info', 'error')
    }
  }

  /**
   * Update white list and black list to config
   * @param {*} users
   */
  updateUserList(users) {
    //? Maybe should handle checks here
    try {
      this.updateConfigFile('userList', users)
      this.userListConfig = users
      console.log(this.userListConfig)
      // this.mainWindow?.webContents.send('notice', 'Success to update user list', 'success')
    } catch (error) {
      logger.error(`Failed to update user list: ${error}`)
      // this.mainWindow?.webContents.send('notice', 'Failed to update user list', 'error')
    }
  }

  /**
   * Update the number of seen request/response
   * @param {*} req
   */
  updateRequest(req) {
    try {
      this.updateConfigFile('request', req)
      this.requestConfig = req
      // this.mainWindow?.webContents.send('notice', 'Success to update request info', 'success')
    } catch (error) {
      logger.error(`Failed to update request: ${error}`)
      // this.mainWindow?.webContents.send('notice', 'Failed to update request info', 'error')
    }
  }

  /**
   * Show a toast on user interface
   * @param {string} message
   * @param {'success'|'error'|'normal'} level
   * @example GlobalValueManager.sendNotice(`Failed to upload file when requesting to upload: ${response.errorMsg}`, 'error')
   */
  sendNotice(message, level) {
    this.mainWindow?.webContents.send('notice', message, level)
  }
}

export default new GlobalValueManager()
