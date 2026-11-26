/**
 * Socket authentication flows: register, login, auth-res, secret-share, secret-recover,
 * email-auth-res.
 *
 * Security invariants:
 * - Pending state for login, registration and recovery is kept in separate, per-socket
 *   closure records (`pendingLogin`, `pendingRegister`, `pendingRecover`) rather than
 *   shared fields on `socket`. Each record carries its own target userId / identity and
 *   challenge / OTP so one flow can never overwrite another flow's identity.
 * - Authenticated session fields on `socket` (`socket.userId`, `socket.role`, `socket.authed`,
 *   etc.) are written in one place only: when a `login` challenge succeeds in `auth-res` AND
 *   `userLogin()` accepts the session.
 * - Once `socket.authed` is true, `login`, `register`, `auth-res`, `secret-recover` and
 *   `email-auth-res` are refused so an authenticated socket cannot re-enter unauthenticated
 *   flows or mutate its session identity.
 * - Starting a new unauthenticated flow clears any previous flow's pending challenge/OTP so
 *   `auth-res` and `email-auth-res` can never cross-match flows.
 *
 * Kept free of side-effect imports so the flows and attack scenarios can be tested directly.
 */
import { randomInt } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import {
  AuthResRequestSchema,
  EmailAuthResRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  SecretRecoverRequestSchema,
  SecretShareRequestSchema
} from './Validation.js'
import { resolveUserDir } from './UploadPath.js'

const AUTH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const DEFAULT_ERROR_MSGS = Object.freeze({
  invalidArgument: 'Invalid arguments.',
  internalServerError: 'Internal server error.',
  notLoggedIn: 'Not logged in.',
  emailNotRegistered: 'Email not registered.',
  emailAlreadyRegistered: 'Email already registered.',
  noEmailAuthFirst: 'Did not ask for email authentication first.',
  emailAuthExpired: 'Email authentication code is expired.',
  emailAuthNotMatch: 'Email authentication code did not match.'
})

const DEFAULT_USER_STATUS = Object.freeze({
  activate: 'activate',
  stopped: 'stopped'
})

const DEFAULT_USER_ROLE = Object.freeze({
  user: 'user',
  admin: 'admin'
})

/**
 * Create a socket binder for all authentication events.
 * @param {object} deps
 * @returns {(socket: object) => void}
 */
export function createAuthenticationBinder({
  db,
  crypto: cryptoHandler,
  blockchain,
  secretShare,
  recovery,
  smtp,
  loginStore,
  checkLoggedIn,
  config,
  log,
  fsOps = { mkdir, rmdir },
  errorMsgs = DEFAULT_ERROR_MSGS,
  userStatusType = DEFAULT_USER_STATUS,
  userRoleType = DEFAULT_USER_ROLE,
  now = () => Date.now()
}) {
  const isAdminEmail = (email) =>
    (config.adminEmails ?? []).some(
      (e) => e.trim().toLowerCase() === String(email ?? '').trim().toLowerCase()
    )

  async function createSendEmailAuth(email, name) {
    let code = ''
    for (let i = 0; i < config.emailAuthLength; i++) {
      code += AUTH_CHARS.charAt(randomInt(AUTH_CHARS.length))
    }
    await smtp.sendEmailAuth(email, name, code)
    return code
  }

  /**
   * Add a verified registration record to the database, create its upload folder,
   * and trigger on-chain activation. Reads only from the pending registration record
   * and never writes `socket.userId`.
   * @param {object} socket
   * @param {{ pk: string, blockchainAddress: string, name: string, email: string }} reg
   * @returns {Promise<string|null>} newly created userId, or null if reverted on error
   */
  async function registerProcess(socket, reg) {
    let idToDeleteFolder = null
    let idToRemoveDb = null
    try {
      const { id, info } = await db.AddUserAndGetId(
        reg.pk,
        reg.blockchainAddress,
        reg.name,
        reg.email,
        isAdminEmail(reg.email) ? userRoleType.admin : userRoleType.user
      )
      if (info.rowCount === 0) {
        throw new Error('Failed to add user to database. Might be id collision.')
      }
      idToRemoveDb = id

      log.info(socket, 'Creating folder for user.', { userId: id })
      const userDir = resolveUserDir(config.uploadDir, id)
      try {
        await fsOps.mkdir(userDir)
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error
        }
      }
      idToDeleteFolder = id

      log.info(socket, 'User registered.', {
        userId: id,
        name: reg.name,
        email: reg.email,
        pk: reg.pk,
        blockchainAddress: reg.blockchainAddress
      })

      // Activate client on blockchain asynchronously.
      // Registration (DB entry + folder) is already complete and is the source of
      // truth. The blockchain record is an audit trail; a slow or temporarily
      // unavailable chain must not block the registration response to the client.
      blockchain.setClientStatus(reg.blockchainAddress, true).catch((err) => {
        log.error(socket, err, {
          userId: id,
          blockchainAddress: reg.blockchainAddress
        })
      })

      return id
    } catch (error) {
      log.error(socket, error, {
        name: reg.name,
        email: reg.email,
        pk: reg.pk,
        blockchainAddress: reg.blockchainAddress
      })
      if (idToRemoveDb) await db.deleteUserById(idToRemoveDb)
      try {
        if (idToDeleteFolder) {
          await fsOps.rmdir(resolveUserDir(config.uploadDir, idToDeleteFolder))
        }
      } catch (rmdirError) {
        if (rmdirError.code !== 'ENOENT') throw rmdirError
      }
      return null
    }
  }

  return function authenticationBinder(socket) {
    // Per-socket pending auth state, strictly isolated from `socket.userId` and each other.
    let pendingLogin = null
    let pendingRegister = null
    let pendingRecover = null
    let loginInFlight = false
    let opSeq = 0

    const clearPendingFlows = () => {
      pendingLogin = null
      pendingRegister = null
      pendingRecover = null
    }

    /**
     * Register event
     */
    socket.on('register', async (request, cb) => {
      try {
        const actionStr = 'Client asks to register'
        log.info(socket, actionStr + '.', { ...request, name: undefined, email: undefined })

        const result = RegisterRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, {
            ...request,
            name: undefined,
            email: undefined
          })
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }

        if (socket.authed) {
          log.warn(socket, actionStr + ' but is already logged in.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }

        const { publicKey, blockchainAddress, name, email } = result.data

        const userInfo = await db.getUserByKey(publicKey)
        if (userInfo) {
          log.warn(socket, actionStr + ' but is already registered.', { userId: userInfo.id })
          cb({ errorMsg: 'Already registered.' })
          return
        }

        const emailUserInfo = await db.getUserByEmail(email)
        if (emailUserInfo) {
          log.warn(socket, actionStr + ' but email is already registered.')
          cb({ errorMsg: errorMsgs.emailAlreadyRegistered })
          return
        }

        const seq = ++opSeq
        const { message, cipher, spk } = await cryptoHandler.verifyGen(publicKey)
        if (socket.authed) {
          log.warn(socket, actionStr + ' but became logged in during challenge generation.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }
        if (seq !== opSeq) {
          log.warn(socket, actionStr + ' but was superseded by another authentication request.')
          cb({ errorMsg: 'Authentication state changed. Please try again.' })
          return
        }

        clearPendingFlows()
        delete socket.recoverVerified
        delete socket.fidoRecover
        pendingRegister = {
          stage: 'key',
          pk: publicKey,
          blockchainAddress,
          name,
          email,
          randKey: message,
          emailAuth: null,
          emailAuthStartTime: null
        }

        log.info(socket, 'Asking client to respond with correct authentication key.')
        cb({ cipher, spk })
      } catch (error) {
        log.error(socket, error)
        cb({ errorMsg: errorMsgs.internalServerError })
      }
    })

    /**
     * Login event
     */
    socket.on('login', async (request, cb) => {
      let claimedLoginFlight = false
      try {
        const actionStr = 'Client asks to login'
        log.info(socket, actionStr + '.', request)

        const result = LoginRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, request)
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }
        const { publicKey } = result.data

        if (socket.authed) {
          log.warn(socket, actionStr + ' but is already logged in.', request)
          cb({ errorMsg: 'Already logged in.' })
          return
        }

        if (loginInFlight || pendingLogin) {
          log.warn(socket, actionStr + ' but already asked to log in.', request)
          cb({ errorMsg: 'Already asked to log in.' })
          return
        }

        loginInFlight = true
        claimedLoginFlight = true
        const seq = ++opSeq

        const userInfo = await db.getUserByKey(publicKey)
        if (!userInfo) {
          log.warn(socket, actionStr + ' but is not registered.', request)
          cb({ errorMsg: 'Not registered.' })
          return
        }
        if (userInfo.status === userStatusType.stopped) {
          log.warn(socket, actionStr + ' but the account is stopped.', {
            ...request,
            userId: userInfo.id
          })
          cb({ errorMsg: 'Account is stopped.' })
          return
        }

        if (loginStore.checkUserLoggedIn(userInfo.id)) {
          log.warn(socket, actionStr + ' but is logged in from another client side.', {
            ...request,
            userId: userInfo.id
          })
          cb({ errorMsg: 'Already logged in from another client.' })
          return
        }

        if (loginStore.checkLoginBlocked(userInfo.id)) {
          log.warn(socket, actionStr + ' but failed too many login attempts.', {
            ...request,
            userId: userInfo.id
          })
          cb({ errorMsg: 'Failed too many login attempts.' })
          return
        }

        const { message, cipher, spk } = await cryptoHandler.verifyGen(publicKey)
        if (socket.authed) {
          log.warn(socket, actionStr + ' but became logged in during challenge generation.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }
        if (seq !== opSeq) {
          log.warn(socket, actionStr + ' but was superseded by another authentication request.')
          cb({ errorMsg: 'Authentication state changed. Please try again.' })
          return
        }

        clearPendingFlows()
        pendingLogin = {
          userId: userInfo.id,
          role: userInfo.role === userRoleType.admin ? userRoleType.admin : userRoleType.user,
          randKey: message,
          pk: publicKey,
          name: userInfo.name,
          email: userInfo.email,
          blockchainAddress: userInfo.address
        }

        log.info(socket, 'Asking client to respond with correct authentication key.', {
          userId: userInfo.id
        })
        cb({ cipher, spk })
      } catch (error) {
        log.error(socket, error, request)
        cb({ errorMsg: errorMsgs.internalServerError })
      } finally {
        if (claimedLoginFlight) {
          loginInFlight = false
        }
      }
    })

    /**
     * Authentication response event for register and login
     */
    socket.on('auth-res', async (request, cb) => {
      try {
        const actionStr = 'Client responds to authentication'
        log.info(socket, actionStr + '.', { ...request, decryptedValue: undefined })

        const result = AuthResRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, {
            ...request,
            decryptedValue: undefined
          })
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }

        if (socket.authed) {
          log.warn(socket, actionStr + ' but is already logged in.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }

        const { decryptedValue } = result.data

        if (pendingLogin) {
          if (loginStore.checkLoginBlocked(pendingLogin.userId)) {
            const blockedUserId = pendingLogin.userId
            pendingLogin = null
            log.warn(socket, actionStr + ' but account is blocked due to failed attempts.', {
              userId: blockedUserId
            })
            cb({ errorMsg: 'Failed too many login attempts.' })
            return
          }

          if (pendingLogin.randKey !== decryptedValue) {
            // Neither the answer nor the expected value is logged: the challenge is still open.
            const targetUserId = pendingLogin.userId
            log.warn(socket, actionStr + ' with incorrect authentication key.', {
              userId: targetUserId
            })
            loginStore.userLoginFailure(targetUserId)
            if (loginStore.checkLoginBlocked(targetUserId)) {
              pendingLogin = null
            }
            cb({ errorMsg: 'Incorrect authentication key.' })
            return
          }

          const login = pendingLogin
          pendingLogin = null

          if (!loginStore.userLogin(login.userId, socket)) {
            log.warn(socket, actionStr + ' but account is already logged in from another client.', {
              userId: login.userId
            })
            cb({ errorMsg: 'Already logged in from another client.' })
            return
          }

          clearPendingFlows()
          delete socket.recoverVerified
          delete socket.fidoRecover
          socket.userId = login.userId
          socket.role = login.role
          socket.pk = login.pk
          socket.name = login.name
          socket.email = login.email
          socket.blockchainAddress = login.blockchainAddress
          socket.authed = true

          log.info(socket, 'Authentication key correct. Client is authenticated.')
          cb({
            userInfo: {
              userId: login.userId,
              name: login.name,
              email: login.email,
              role: login.role || userRoleType.user
            }
          })
          // Ensure CLIENT_ROLE is present on-chain — cheap read + write only if missing.
          // Acts as a safety net if setClientStatus failed/timed-out during registration.
          blockchain.ensureClientRole(login.blockchainAddress).catch((err) => {
            log.error(socket, err, { blockchainAddress: login.blockchainAddress })
          })
          return
        }

        if (pendingRegister && pendingRegister.stage === 'key') {
          if (pendingRegister.randKey !== decryptedValue) {
            log.warn(socket, actionStr + ' with incorrect authentication key.')
            cb({ errorMsg: 'Incorrect authentication key.' })
            return
          }

          const reg = pendingRegister
          reg.stage = 'sending-email'
          reg.randKey = null
          const seq = ++opSeq
          log.info(socket, 'Authentication key correct. Client is authenticated.')

          let emailAuth
          try {
            emailAuth = await createSendEmailAuth(reg.email, reg.name)
          } catch (error) {
            if (pendingRegister === reg) {
              pendingRegister = null
            }
            throw error
          }

          if (socket.authed || seq !== opSeq || pendingRegister !== reg) {
            log.warn(socket, actionStr + ' but registration state changed while sending email.')
            cb({ errorMsg: 'Authentication state changed. Please try again.' })
            return
          }

          reg.stage = 'email'
          reg.emailAuth = emailAuth
          reg.emailAuthStartTime = now()
          cb({}) // Wait for email auth
          return
        }

        log.warn(socket, actionStr + ' without asking to login or register.')
        cb({ errorMsg: 'Did not ask to login or register first.' })
      } catch (error) {
        log.error(socket, error)
        cb({ errorMsg: errorMsgs.internalServerError })
      }
    })

    /**
     * Secret share event
     */
    socket.on('secret-share', async (request, cb) => {
      try {
        const actionStr = 'Client asks to share secret'
        log.info(socket, actionStr + '.', request)

        const result = SecretShareRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, request)
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }
        const { shares } = result.data

        if (!checkLoggedIn(socket)) {
          log.warn(socket, actionStr + ' but is not logged in.', request)
          cb({ errorMsg: errorMsgs.notLoggedIn })
          return
        }

        log.info(socket, 'Storing client secret share to databases.')
        await secretShare.storeUserShares(socket.userId, shares)
        cb({}) // ok
      } catch (error) {
        log.error(socket, error)
        cb({ errorMsg: errorMsgs.internalServerError })
      }
    })

    /**
     * Secret recover event
     */
    socket.on('secret-recover', async (request, cb) => {
      try {
        const actionStr = 'Client asks to recover secret'
        log.info(socket, actionStr + '.', { ...request, email: undefined })

        const result = SecretRecoverRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, {
            ...request,
            email: undefined
          })
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }

        if (socket.authed) {
          log.warn(socket, actionStr + ' but is already logged in.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }

        const { email } = result.data
        const seq = ++opSeq

        const userInfo = await db.getUserByEmail(email)
        if (!userInfo) {
          log.warn(socket, actionStr + ' but the email is not registered.')
          cb({ errorMsg: errorMsgs.emailNotRegistered })
          return
        }

        const emailAuth = await createSendEmailAuth(email, userInfo.name)
        if (socket.authed) {
          log.warn(socket, actionStr + ' but became logged in while sending recovery email.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }
        if (seq !== opSeq) {
          log.warn(socket, actionStr + ' but was superseded by another authentication request.')
          cb({ errorMsg: 'Authentication state changed. Please try again.' })
          return
        }

        clearPendingFlows()
        delete socket.recoverVerified
        delete socket.fidoRecover
        pendingRecover = {
          userId: userInfo.id,
          email,
          emailAuth,
          emailAuthStartTime: now()
        }
        cb({})
      } catch (error) {
        log.error(socket, error)
        cb({ errorMsg: errorMsgs.internalServerError })
      }
    })

    /**
     * Email authentication event for register and secret recover
     */
    socket.on('email-auth-res', async (request, cb) => {
      try {
        const actionStr = 'Client asks to respond to email auth'
        log.info(socket, actionStr + '.', { ...request, emailAuth: undefined })

        const result = EmailAuthResRequestSchema.safeParse(request)
        if (!result.success) {
          log.invalidSchema(socket, actionStr, result.error.issues, {
            ...request,
            emailAuth: undefined
          })
          cb({ errorMsg: errorMsgs.invalidArgument })
          return
        }

        if (socket.authed) {
          log.warn(socket, actionStr + ' but is already logged in.')
          cb({ errorMsg: 'Already logged in.' })
          return
        }

        const { emailAuth } = result.data
        const activeRecover = pendingRecover
        const activeRegister =
          pendingRegister && pendingRegister.stage === 'email' ? pendingRegister : null
        const activeFlow = activeRecover || activeRegister

        if (!activeFlow || !activeFlow.emailAuth) {
          log.warn(socket, actionStr + ' but did not ask for one first.')
          cb({ errorMsg: errorMsgs.noEmailAuthFirst })
          return
        }

        if (now() - activeFlow.emailAuthStartTime > config.emailAuthExpireTimeMin * 60 * 1000) {
          if (pendingRecover === activeFlow) pendingRecover = null
          if (pendingRegister === activeFlow) pendingRegister = null
          cb({ errorMsg: errorMsgs.emailAuthExpired })
          return
        }

        if (emailAuth !== activeFlow.emailAuth && config.smtpEnabled) {
          // Neither code is logged: the one that was sent is still valid for another try.
          log.warn(socket, actionStr + ' but the response did not match.')
          cb({ errorMsg: errorMsgs.emailAuthNotMatch })
          return
        }

        if (activeRecover) {
          pendingRecover = null
          const seq = ++opSeq
          log.info(socket, 'Retrieving user secret shares', { userId: activeRecover.userId })
          const [shares, methods] = await Promise.all([
            secretShare.retrieveUserShares(activeRecover.userId),
            recovery.listRecoveryMethods(activeRecover.userId)
          ])
          if (socket.authed || seq !== opSeq) {
            log.warn(socket, actionStr + ' but authentication state changed during recovery.')
            cb({ errorMsg: 'Authentication state changed. Please try again.' })
            return
          }
          // Security-key recovery (fido-recover-*) is allowed for this user for a limited time.
          socket.recoverVerified = { userId: activeRecover.userId, at: now(), failures: 0 }
          // `shares` are the password method's, as before; `methods` lists every option.
          cb({ shares, methods: methods.map(({ id, type, label }) => ({ id, type, label })) })
          return
        }

        if (activeRegister) {
          pendingRegister = null
          const userId = await registerProcess(socket, activeRegister)
          if (!userId) {
            cb({ errorMsg: errorMsgs.internalServerError })
            return
          }
          cb({ userId })
          return
        }
      } catch (error) {
        log.error(socket, error)
        cb({ errorMsg: errorMsgs.internalServerError })
      }
    })
  }
}
