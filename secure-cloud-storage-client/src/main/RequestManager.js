/**
 * This file handles operation and communication with server related to requests.
 * Including requesting file, responding to request, deleting request, get request list.
 */
import { socket } from './MessageManager'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'
import KeyManager from './KeyManager'

class RequestManager {
  keyManager
  /**
   *
   * @param {KeyManager} keyManager
   */
  constructor(keyManager) {
    this.keyManager = keyManager

    socket.on('rekey-ask', async (pk, cb) => {
      const rekey = await keyManager.rekeyGen(pk)
      cb(rekey)
    })
    socket.on('new-request', () => {
      logger.info('New request coming')
      this.getRequestedListProcess()
    })
    socket.on('new-response', () => {
      logger.info('New response coming')
      this.getRequestListProcess()
    })
  }

  /**
   * Ask to request certain file.
   * @param {*} requestInfo
   */
  requestFileProcess(requestInfo) {
    logger.info(`Asking to request file ${requestInfo.fileId}...`)
    socket.emit('request-file', requestInfo, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to request file ${requestInfo.fileId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to request file', 'error')
      } else {
        logger.info(`Success to request file ${requestInfo.fileId}`)
        this.getRequestListProcess()
        GlobalValueManager.sendNotice('Success to request file', 'success')
      }
    })
  }

  /**
   * Ask to get all request list (client is requester)
   */
  getRequestListProcess() {
    logger.info('Getting request list...')
    socket.emit('get-request-list', (response) => {
      const { requests, errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to get request list: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to get request list', 'error')
      } else {
        logger.info(`Success to get request list`)
        GlobalValueManager.mainWindow?.webContents.send('request-list-res', requests)
      }
    })
  }

  /**
   * Ask to get all requested list (client is file owner.)
   */
  getRequestedListProcess() {
    socket.emit('get-requested-list', (response) => {
      const { requests, errorMsg } = response
      logger.info('Getting requested list...')
      if (errorMsg) {
        logger.error(`Failed to get requested list: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to get requested list', 'error')
      } else {
        logger.info(`Success to get requested list`)
        this.autoReplyProcess(requests)
        GlobalValueManager.mainWindow?.webContents.send('requested-list-res', requests)
      }
    })
  }

  /**
   * Auto reply to requests based on the set whitelist and blacklist.
   * @param {*} result
   */
  async autoReplyProcess(result) {
    let changed = false
    const resultList = JSON.parse(result)
    for (const item of resultList) {
      if (item.agreed === null || item.agreed === undefined) {
        console.log('item not responded')
        console.log(item.requester)
        // Check if in black list
        if (GlobalValueManager.userListConfig.blackList.includes(item.requester)) {
          // console.log('blacklisted item')
          changed = true
          await this.respondRequestProcess(
            {
              requestId: item.requestId,
              agreed: false,
              description: '',
              pk: item.pk,
              spk: item.spk
            },
            false
          )
          // item.agreed = 0
        } else if (GlobalValueManager.userListConfig.whiteList.includes(item.requester)) {
          changed = true
          // console.log('whitelist item')
          await this.respondRequestProcess(
            {
              requestId: item.requestId,
              agreed: true,
              description: '',
              pk: item.pk,
              spk: item.spk
            },
            false
          )
          // item.agreed = 1
        }
      }
    }
    if (changed) {
      this.getRequestedListProcess()
    }
  }

  /**
   * Ask to delete request.
   * @param {*} requestId
   */
  deleteRequestProcess(requestId) {
    logger.info(`Deleting request for ${requestId}...`)
    socket.emit('delete-request', { requestId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to delete request for ${requestId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to delete request', 'error')
      } else {
        logger.info(`Success to delete request for ${requestId}`)
        this.getRequestListProcess()
        GlobalValueManager.sendNotice('Success to delete request', 'success')
      }
    })
  }

  /**
   * Ask to respond to request.
   * @param {*} responseInfo
   * @param {*} refresh
   * @returns
   */
  async respondRequestProcess(responseInfo, refresh = true) {
    logger.info(`Respond request for ${responseInfo.requestId}...`)
    // If agreed, we generate rekey for the requester.
    let rekey = null
    if (responseInfo.agreed) {
      try {
        rekey = await this.keyManager.rekeyGen(responseInfo.pk, responseInfo.spk)
      } catch (error) {
        logger.error(`Failed to generate rekey: ${error}`)
        GlobalValueManager.sendNotice('Failed to respond request', 'error')
        return
      }
    }
    delete responseInfo.pk
    delete responseInfo.spk
    return new Promise((resolve, reject) => {
      socket.emit('respond-request', { ...responseInfo, rekey }, (response) => {
        const { errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to respond request for ${responseInfo.requestId}: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to respond request', 'error')
          resolve()
        } else {
          logger.info(`Success to respond request for ${responseInfo.requestId}`)
          if (refresh) {
            this.getRequestedListProcess()
          }
          GlobalValueManager.sendNotice('Success to respond request', 'success')
          resolve()
        }
      })
    })
  }
}

export default RequestManager
