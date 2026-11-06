/**
 * Socket wiring for fingerprint / security-key recovery. The flows live in
 * RecoveryService.js; this file injects the real databases, config and login check.
 */
import ConfigManager from './ConfigManager.js'
import { logSocketError, logSocketInfo, logSocketWarning } from './Logger.js'
import { createRecoveryMethodStore } from './RecoveryMethodStore.js'
import { RecoveryError, createRecoveryService } from './RecoveryService.js'
import {
  deleteUserShares,
  listUserShareMethodIds,
  retrieveUserShares,
  storeUserShares
} from './SecretShareDatabase.js'
import { pool } from './StorageDatabase.js'
import { InternalServerErrorMsg, checkLoggedIn } from './Utils.js'

const service = createRecoveryService({
  methodStore: createRecoveryMethodStore(pool),
  shareStore: { deleteUserShares, listUserShareMethodIds, retrieveUserShares, storeUserShares },
  config: ConfigManager.fido,
  isLoggedIn: checkLoggedIn
})

/** Recovery methods of a user, for the OTP step of secret-recover. */
export const listRecoveryMethods = service.listMethods

export function recoveryBinder(socket) {
  for (const [event, handler] of Object.entries(service.handlers)) {
    socket.on(event, async (request, cb) => {
      if (typeof cb !== 'function') return
      try {
        // Request bodies are not logged: they contain secret shares.
        logSocketInfo(socket, `Client asks ${event}.`)
        cb(await handler(socket, request))
      } catch (error) {
        if (error instanceof RecoveryError) {
          logSocketWarning(socket, `${event} rejected: ${error.message}`, error.detail ?? {})
          cb({ errorMsg: error.message })
          return
        }
        logSocketError(socket, error)
        cb({ errorMsg: InternalServerErrorMsg })
      }
    })
  }
}

console.debug('RecoveryManager.js loaded.')
