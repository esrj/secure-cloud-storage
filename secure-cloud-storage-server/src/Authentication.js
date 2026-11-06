/**
 * This file handles client communications related to authentication.
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
  EmailAlreadyRegisteredErrorMsg,
  ShouldNotReachErrorMsg
} from './Utils.js'
import {
  logInvalidSchemaWarning,
  logSocketError,
  logSocketInfo,
  logSocketWarning
} from './Logger.js'
import CryptoHandler from './CryptoHandler.js'
import { mkdir, rmdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import ConfigManager from './ConfigManager.js'
import {
  AuthResRequestSchema,
  EmailAuthResRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  SecretRecoverRequestSchema,
  SecretShareRequestSchema
} from './Validation.js'
import BlockchainManager from './BlockchainManager.js'
import { retrieveUserShares, storeUserShares } from './SecretShareDatabase.js'
import { listRecoveryMethods } from './RecoveryManager.js'
import { sendEmailAuth } from './SMTPManager.js'
import { randomInt } from 'node:crypto'
import { checkLoginBlocked, userLoginFailure, userLogin, checkUserLoggedIn } from './UserLoginInfo.js'

/**
 * Whether an email is in the configured admin bootstrap list (case-insensitive).
 */
const isAdminEmail = (email) =>
  ConfigManager.admin.emails.some(
    (e) => e.trim().toLowerCase() === String(email ?? '').trim().toLowerCase()
  )

const authenticationBinder = (socket) => {
  /**
   * Register event
   */
  socket.on('register', async (request, cb) => {
    try {
      const actionStr = 'Client asks to register'
      logSocketInfo(socket, actionStr + '.', {...request, name: undefined, email: undefined})

      const result = RegisterRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { publicKey, blockchainAddress, name, email } = result.data

      const userInfo = await getUserByKey(publicKey)
      if (userInfo) {
        socket.userId = userInfo.id
        logSocketWarning(socket, actionStr + ' but is already registered.', request)
        cb({ errorMsg: 'Already registered.' })
        return
      }

      const emailUserInfo = await getUserByEmail(email)
      if (emailUserInfo) {
        logSocketWarning(socket, actionStr + ' but email is already registered.', request)
        cb({ errorMsg: EmailAlreadyRegisteredErrorMsg })
        return
      }

      const { message, cipher, spk } = await CryptoHandler.verifyGen(publicKey)
      socket.randKey = message
      socket.pk = publicKey
      socket.name = name
      socket.email = email
      socket.blockchainAddress = blockchainAddress
      socket.askRegister = true
      logSocketInfo(socket, 'Asking client to respond with correct authentication key.')
      cb({ cipher, spk })
      // Wait for auth-res
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Login event
   */
  socket.on('login', async (request, cb) => {
    try {
      const actionStr = 'Client asks to login'
      logSocketInfo(socket, actionStr + '.', request)
      
      const result = LoginRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { publicKey } = result.data

      if (socket.authed) {
        logSocketWarning(socket, actionStr + ' but is already logged in.', request)
        cb({ errorMsg: 'Already logged in.' })
        return
      }

      if (socket.askLogin) {
        logSocketWarning(socket, actionStr + ' but already asked to log in.', request)
        cb({ errorMsg: 'Already asked to log in.' })
        return
      }

      const userInfo = await getUserByKey(publicKey)
      if (!userInfo) {
        logSocketWarning(socket, actionStr + ' but is not registered.', request)
        cb({ errorMsg: 'Not registered.' })
        return
      }
      socket.userId = userInfo.id
      if (userInfo.status === userStatusType.stopped) {
        logSocketWarning(socket, actionStr + ' but the account is stopped.', request)
        cb({ errorMsg: 'Account is stopped.' })
        return
      }

      if (checkUserLoggedIn(socket.userId)) {
        logSocketWarning(socket, actionStr + ' but is logged in from another client side.', request)
        cb({ errorMsg: 'Already logged in from another client.' })
        return
      }


      // Check login attempts
      if (checkLoginBlocked(socket.userId)) {
        logSocketWarning(socket, actionStr + ' but failed too many login attempts.', {
          ...request
        })
        cb({ errorMsg: 'Failed too many login attempts.' })
        return
      }

      const { message, cipher, spk } = await CryptoHandler.verifyGen(publicKey)
      socket.userId = userInfo.id
      socket.role = userInfo.role === userRoleType.admin ? userRoleType.admin : userRoleType.user
      socket.randKey = message
      socket.pk = publicKey
      socket.name = userInfo.name
      socket.email = userInfo.email
      socket.blockchainAddress = userInfo.address
      socket.askLogin = true
      logSocketInfo(socket, 'Asking client to respond with correct authentication key.')
      cb({ cipher, spk })
    } catch (error) {
      logSocketError(socket, error, request)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Authentication response event for register and login
   */
  socket.on('auth-res', async (request, cb) => {
    try {
      const actionStr = 'Client responds to authentication'
      logSocketInfo(socket, actionStr + '.', {...request, decryptedValue: undefined})

      const result = AuthResRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { decryptedValue } = result.data

      if (!socket.askLogin && !socket.askRegister) {
        logSocketWarning(socket, actionStr + ' without asking to login or register.', request)
        cb({ errorMsg: 'Did not ask to login or register first.' })
        return
      }

      if (socket.randKey !== decryptedValue) {
        logSocketWarning(socket, actionStr + ' with incorrect authentication key.', {
          ...request,
          randKey: socket.randKey
        })
        if (socket.userId) userLoginFailure(socket.userId)
        cb({ errorMsg: 'Incorrect authentication key.' })
        return
      }
      logSocketInfo(socket, 'Authentication key correct. Client is authenticated.')

      if (socket.askLogin) {
        delete socket.askLogin
        delete socket.recoverVerified
        delete socket.fidoRecover
        userLogin(socket.userId, socket)
        socket.authed = true
        cb({
          userInfo: {
            userId: socket.userId,
            name: socket.name,
            email: socket.email,
            role: socket.role || userRoleType.user
          }
        })
        // Ensure CLIENT_ROLE is present on-chain — cheap read + write only if missing.
        // Acts as a safety net if setClientStatus failed/timed-out during registration.
        BlockchainManager.ensureClientRole(socket.blockchainAddress).catch((err) => {
          logSocketError(socket, err, { blockchainAddress: socket.blockchainAddress })
        })
        return
      } else if (socket.askRegister) {
        // Send email auth
        socket.emailAuth = await createSendEmailAuth(socket.email, socket.name)
        cb({}) // Wait for email auth
        return
      }
      throw new Error(ShouldNotReachErrorMsg)
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Secret share event
   */
  socket.on('secret-share', async (request, cb) => {
    try {
      const actionStr = 'Client asks to share secret'
      logSocketInfo(socket, actionStr + '.', request)

      const result = SecretShareRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { shares } = result.data

      if (!checkLoggedIn(socket)) {
        logSocketWarning(socket, actionStr + ' but is not logged in.', request)
        cb({ errorMsg: NotLoggedInErrorMsg })
        return
      }

      logSocketInfo(socket, 'Storing client secret share to databases.')
      await storeUserShares(socket.userId, shares)
      cb({}) // ok
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Secret recover event
   */
  socket.on('secret-recover', async (request, cb) => {
    try {
      const actionStr = 'Client asks to recover secret'
      logSocketInfo(socket, actionStr + '.', {...request, email: undefined})

      const result = SecretRecoverRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { email } = result.data

      const userInfo = await getUserByEmail(email)
      if (!userInfo) {
        logInvalidSchemaWarning(socket, actionStr + ' but the email is not registered.', request)
        cb({ errorMsg: EmailNotRegisteredErrorMsg })
        return
      }
      // Ask and wait for email authentication
      delete socket.recoverVerified
      delete socket.fidoRecover
      socket.userId = userInfo.id
      socket.emailAuth = await createSendEmailAuth(email, userInfo.name)
      socket.email = email
      socket.askRecover = true
      socket.emailAuthStartTime = Date.now()
      cb({})
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })

  /**
   * Email authentication event for register and secret recover
   */
  socket.on('email-auth-res', async (request, cb) => {
    try {
      const actionStr = 'Client asks to respond to email auth'
      logSocketInfo(socket, actionStr + '.', request)

      const result = EmailAuthResRequestSchema.safeParse(request)
      if (!result.success) {
        logInvalidSchemaWarning(socket, actionStr, result.error.issues, request)
        cb({ errorMsg: InvalidArgumentErrorMsg })
        return
      }
      const { emailAuth } = result.data

      if (!socket.emailAuth) {
        logSocketWarning(socket, actionStr + ' but did not ask for one first.')
        cb({ errorMsg: NoEmailAuthFirstErrorMsg })
        return
      }

      if (
        Date.now() - socket.emailAuthStartTime >
        ConfigManager.settings.emailAuthExpireTimeMin * 60 * 1000
      ) {
        cb({ errorMsg: EmailAuthExpiredErrorMsg })
        return
      }

      if (emailAuth !== socket.emailAuth && ConfigManager.smtp.enabled) {
        logSocketWarning(socket, actionStr + ' but the response did not match.', {
          emailAuth,
          socketEmailAuth: socket.emailAuth
        })
        cb({ errorMsg: EmailAuthNotMatchErrorMsg })
        return
      }
      delete socket.emailAuth

      if (socket.askRecover) {
        delete socket.askRecover
        // Security-key recovery (fido-recover-*) is allowed for this user for a limited time.
        socket.recoverVerified = { userId: socket.userId, at: Date.now(), failures: 0 }
        logSocketInfo(socket, 'Retrieving user secret shares')
        const [shares, methods] = await Promise.all([
          retrieveUserShares(socket.userId),
          listRecoveryMethods(socket.userId)
        ])
        // `shares` are the password method's, as before; `methods` lists every option.
        cb({ shares, methods: methods.map(({ id, type, label }) => ({ id, type, label })) })
        return
      } else if (socket.askRegister) {
        delete socket.askRegister
        await registerProcess(socket)
        cb({ userId: socket.userId })
        return
      }

      throw new Error(ShouldNotReachErrorMsg)
    } catch (error) {
      logSocketError(socket, error)
      cb({ errorMsg: InternalServerErrorMsg })
    }
  })
}
const authChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/**
 * Create and send an email authentication code to user's email
 * @param {string} email
 * @returns The email authentication code
 */
async function createSendEmailAuth(email, name) {
  let emailAuth = ''
  for (let i = 0; i < ConfigManager.settings.emailAuthLength; i++) {
    emailAuth += authChars.charAt(randomInt(authChars.length))
  }
  await sendEmailAuth(email, name, emailAuth)

  return emailAuth
}

/**
 * Add user to database, set status on blockchain, create folder
 * @param {*} socket
 */
async function registerProcess(socket) {
  // register
  let idToDeleteFolder = null
  let idToRemoveDb = null
  try {
    // Add user to database
    const { id, info } = await AddUserAndGetId(
      socket.pk,
      socket.blockchainAddress,
      socket.name,
      socket.email,
      isAdminEmail(socket.email) ? userRoleType.admin : userRoleType.user
    )
    if (info.rowCount === 0) {
      throw new Error('Failed to add user to database. Might be id collision.')
    }
    socket.userId = id
    idToRemoveDb = socket.userId

    logSocketInfo(socket, 'Creating folder for user.')
    try {
      // Create upload folder for user.
      await mkdir(resolve(ConfigManager.uploadDir, id))
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }
    idToDeleteFolder = socket.userId

    logSocketInfo(socket, 'User registered.', {
      name: socket.name,
      email: socket.email,
      pk: socket.pk,
      blockchainAddress: socket.blockchainAddress
    })

    // Activate client on blockchain asynchronously.
    // Registration (DB entry + folder) is already complete and is the source of
    // truth. The blockchain record is an audit trail; a slow or temporarily
    // unavailable chain must not block the registration response to the client.
    BlockchainManager.setClientStatus(socket.blockchainAddress, true).catch((err) => {
      logSocketError(socket, err, {
        blockchainAddress: socket.blockchainAddress
      })
    })
  } catch (error) {
    // Error when registering
    logSocketError(socket, error, {
      name: socket.name,
      email: socket.email,
      pk: socket.pk,
      blockchainAddress: socket.blockchainAddress
    }) // Did not re-throw because need to log extra information
    // Reverting register
    if (idToRemoveDb) await deleteUserById(idToRemoveDb)
    try {
      if (idToDeleteFolder) await rmdir(resolve(ConfigManager.uploadDir, idToDeleteFolder))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export default authenticationBinder
console.debug('Authentication.js loaded.')
