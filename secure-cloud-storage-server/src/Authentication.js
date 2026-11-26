/**
 * This file wires client authentication socket events to the real server services.
 * The authentication state machine lives in AuthenticationService.js.
 */
import {
  AddUserAndGetId,
  deleteUserById,
  getUserByEmail,
  getUserByKey,
  userStatusType,
  userRoleType
} from './StorageDatabase.js'
import {
  InvalidArgumentErrorMsg,
  InternalServerErrorMsg,
  NoEmailAuthFirstErrorMsg,
  EmailAuthExpiredErrorMsg,
  EmailAuthNotMatchErrorMsg,
  EmailNotRegisteredErrorMsg,
  checkLoggedIn,
  NotLoggedInErrorMsg,
  EmailAlreadyRegisteredErrorMsg
} from './Utils.js'
import {
  logInvalidSchemaWarning,
  logSocketError,
  logSocketInfo,
  logSocketWarning
} from './Logger.js'
import CryptoHandler from './CryptoHandler.js'
import ConfigManager from './ConfigManager.js'
import BlockchainManager from './BlockchainManager.js'
import { retrieveUserShares, storeUserShares } from './SecretShareDatabase.js'
import { listRecoveryMethods } from './RecoveryManager.js'
import { sendEmailAuth } from './SMTPManager.js'
import {
  checkLoginBlocked,
  userLoginFailure,
  userLogin,
  checkUserLoggedIn
} from './UserLoginInfo.js'
import { createAuthenticationBinder } from './AuthenticationService.js'

const authenticationBinder = createAuthenticationBinder({
  db: { AddUserAndGetId, deleteUserById, getUserByEmail, getUserByKey },
  crypto: CryptoHandler,
  blockchain: BlockchainManager,
  secretShare: { retrieveUserShares, storeUserShares },
  recovery: { listRecoveryMethods },
  smtp: { sendEmailAuth },
  loginStore: { checkLoginBlocked, userLoginFailure, userLogin, checkUserLoggedIn },
  checkLoggedIn,
  config: {
    adminEmails: ConfigManager.admin.emails,
    emailAuthLength: ConfigManager.settings.emailAuthLength,
    emailAuthExpireTimeMin: ConfigManager.settings.emailAuthExpireTimeMin,
    smtpEnabled: ConfigManager.smtp.enabled,
    uploadDir: ConfigManager.uploadDir
  },
  log: {
    info: logSocketInfo,
    warn: logSocketWarning,
    error: logSocketError,
    invalidSchema: logInvalidSchemaWarning
  },
  errorMsgs: {
    invalidArgument: InvalidArgumentErrorMsg,
    internalServerError: InternalServerErrorMsg,
    notLoggedIn: NotLoggedInErrorMsg,
    emailNotRegistered: EmailNotRegisteredErrorMsg,
    emailAlreadyRegistered: EmailAlreadyRegisteredErrorMsg,
    noEmailAuthFirst: NoEmailAuthFirstErrorMsg,
    emailAuthExpired: EmailAuthExpiredErrorMsg,
    emailAuthNotMatch: EmailAuthNotMatchErrorMsg
  },
  userStatusType,
  userRoleType
})

export default authenticationBinder
console.debug('Authentication.js loaded.')
