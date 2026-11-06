// Must stay the first import: redirects userData when CLIENT_PROFILE is set.
import './profile'
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { sendMessage } from './MessageManager'
import LoginManager from './LoginManager'
import { logger } from './Logger'
import FileManager from './FileManager'
import RequestManager from './RequestManager'
import GlobalValueManager from './GlobalValueManager'
import AESModule from './AESModule'
import BlockchainManager from './BlockchainManager'
import KeyManager from './KeyManager'
import ABSEManager from './ABSEManager'
import DatabaseManager from './DatabaseManager'
import { registerClassifierIpcOnce } from './services/classifierIpcRegistration.js'
import {
  registerUploadPostIpcOnce,
  setFileManagerForUploadPostIpc
} from './ipc/uploadPostProcessIpc.js'
import {
  registerAgentIpcOnce,
  setDatabaseManagerForAgentIpc,
  setFileManagerForAgentIpc
} from './ipc/agentIpc.js'
import { registerAdminIpcOnce } from './ipc/adminIpc.js'
import { registerRecoveryIpcOnce } from './ipc/recoveryIpc.js'
import BatchDownloadManager from './BatchDownloadManager'

// Initilize class instances
const keyManager = new KeyManager()
keyManager.initKeys()

const requestManager = new RequestManager(keyManager)
const aesModule = new AESModule(keyManager)
const blockchainManager = new BlockchainManager()
const abseManager = new ABSEManager(keyManager)
abseManager.init()
const databaseManager = new DatabaseManager(keyManager)
const fileManager = new FileManager(aesModule, blockchainManager, abseManager, databaseManager)
const batchDownloadManager = new BatchDownloadManager(fileManager)
const loginManager = new LoginManager(
  blockchainManager,
  fileManager,
  keyManager,
  requestManager,
  databaseManager
)

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  GlobalValueManager.mainWindow = mainWindow
  mainWindow.setBackgroundColor('#fff')

  mainWindow.on('ready-to-show', async () => {
    mainWindow.show()
    let pp
    try {
      pp = await abseManager.getPP()
    } catch (error) {
      logger.error(error)
    }

    try {
      await loginManager.login()
      fileManager.getFileListProcess(null)
    } catch (error) {
      logger.error(error)
      GlobalValueManager.sendNotice(error.message, 'error')
    }
    GlobalValueManager.mainWindow?.webContents.send('request-value', {
      seenReplies: GlobalValueManager.requestConfig.seenReplies,
      seenRequests: GlobalValueManager.requestConfig.seenRequests
    })
    GlobalValueManager.mainWindow?.webContents.send('user-list', {
      whiteList: GlobalValueManager.userListConfig.whiteList,
      blackList: GlobalValueManager.userListConfig.blackList
    })
    GlobalValueManager.mainWindow?.webContents.send('global-attrs', {
      globalAttrs: pp ? pp.U.filter((attr) => attr != 'None') : []
    })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.on('send-message', () => sendMessage('test message'))

  ipcMain.handle('login', async () => {
    return await loginManager.login()
  })
  ipcMain.handle('register', async (_event, registerInfo) => {
    return await loginManager.register(registerInfo)
  })
  ipcMain.on('upload', (_event, parentFolderId) => fileManager.uploadFileProcess(parentFolderId))
  ipcMain.on('change-cur-folder', (_event, curFolderId) => {
    GlobalValueManager.curFolderId = curFolderId
    if (GlobalValueManager.loggedIn) fileManager.getFileListProcess(curFolderId)
  })
  ipcMain.on('download', (_event, fileId) => fileManager.downloadFileProcess(fileId))
  ipcMain.on('download-with-options', (_event, opts) =>
    fileManager.downloadFileWithOptionsProcess(opts)
  )

  // Native dialogs MUST be parented to the main window: a parentless dialog on
  // macOS can open behind the app window, leaving the awaiting IPC handler (and
  // the renderer's busy spinner) stuck forever with no log trace.
  const showOpenDialogModal = (opts) => {
    const win = GlobalValueManager.mainWindow
    return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
  }

  // Batch download — pick destination folder once, sequentially process all files.
  ipcMain.handle('pick-download-folder', async (_event, defaultPath) => {
    const useDefault =
      typeof defaultPath === 'string' && defaultPath.length > 0 && existsSync(defaultPath)
    const result = await showOpenDialogModal({
      title: '選擇批次下載儲存資料夾',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: useDefault ? defaultPath : app.getPath('downloads')
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle('download-batch-with-options', async (_event, opts) => {
    let destDir = opts?.destDir
    // If no directory chosen yet, prompt now (skip extra round-trip from renderer).
    if (!destDir || !existsSync(destDir) || !statSync(destDir).isDirectory()) {
      const result = await showOpenDialogModal({
        title: '選擇批次下載儲存資料夾',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('downloads')
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      destDir = result.filePaths[0]
    }
    const batchId = batchDownloadManager.start({ ...opts, destDir })
    return { batchId, destDir }
  })
  ipcMain.on('download-batch-cancel', (_event, batchId) => {
    batchDownloadManager.cancel(batchId)
  })
  ipcMain.on('show-item-in-folder', (_event, p) => {
    if (typeof p === 'string' && p.length > 0) shell.openPath(p)
  })
  ipcMain.on('delete', (_event, fileId) => fileManager.deleteFileProcess(fileId))
  ipcMain.on('add-folder', (_event, curPath, folderName) =>
    fileManager.addFolderProcess(curPath, folderName)
  )
  ipcMain.on('delete-folder', (_event, folderId) => fileManager.deleteFolderProcess(folderId))
  ipcMain.on('change-protocol', () => {
    if (process.env.FILE_PROTOCOL === 'https') {
      process.env.FILE_PROTOCOL = 'ftps'
    } else {
      process.env.FILE_PROTOCOL = 'https'
    }
    logger.info(`File protocol changed to ${process.env.FILE_PROTOCOL}`)
  })
  ipcMain.on('get-request-list', () => requestManager.getRequestListProcess())
  ipcMain.on('get-requested-list', () => requestManager.getRequestedListProcess())
  ipcMain.on('delete-request', (_event, uuid) => {
    requestManager.deleteRequestProcess(uuid)
  })
  ipcMain.on('request-file', (_event, requestInfo) => {
    requestManager.requestFileProcess(requestInfo)
  })
  ipcMain.on('respond-request', (_event, responseInfo) => {
    requestManager.respondRequestProcess(responseInfo)
  })
  ipcMain.handle('get-folders', async () => {
    return await fileManager.getAllFoldersProcess()
  })
  ipcMain.on('move-file', (_event, uuid, targetFolderId) =>
    fileManager.moveFileProcess(uuid, targetFolderId)
  )
  ipcMain.handle('get-public-files', async () => {
    return await fileManager.getAllPublicFilesProcess()
  })
  ipcMain.handle('search-files', async (_event, values) => {
    return await fileManager.searchFilesProcess(values)
  })
  ipcMain.handle('decode-watermark-uid', async (_event, value) => {
    return await fileManager.decodeWatermarkUidProcess(value)
  })
  ipcMain.on('update-user-config', (_event, config) => {
    GlobalValueManager.updateUser(config)
  })
  ipcMain.on('update-request-value', (_event, values) => {
    GlobalValueManager.updateRequest(values)
  })
  ipcMain.on('update-user-list', (_event, users) => {
    GlobalValueManager.updateUserList(users)
    requestManager.getRequestedListProcess()
  })
  ipcMain.on('update-file-desc-perm', (_event, values) => {
    fileManager.updateFileDescPermProcess(values)
  })
  ipcMain.handle('batch-update-file-desc-perm', async (_event, values) => {
    return await fileManager.batchUpdateFileDescPermProcess(values)
  })
  // Secret sharing
  ipcMain.handle('share-secret', (_event, values) => {
    return loginManager.shareSecret(values)
  })
  ipcMain.handle('recover-secret', (_event, values) => {
    return loginManager.recoverSecret(values)
  })
  ipcMain.handle('email-auth', (_event, values) => {
    return loginManager.onEmailAuth(values)
  })
  ipcMain.handle('recover-extra-key', (_event, values) => {
    return loginManager.onRecoverExtraKey(values)
  })

  // Smart-classify IPC: toggle state (classifier:set-enabled, classifier:set-upload-batch-smart-classify, …)
  registerClassifierIpcOnce()

  // Post-upload IPC: classify-documents, preupload-classify-snapshot,
  // file-manager:start-upload, file-manager:refresh-list, ask-batch-update-file-desc-perm
  registerUploadPostIpcOnce()
  setFileManagerForUploadPostIpc(fileManager)

  // Agent search IPC: agent:query
  registerAgentIpcOnce()
  setDatabaseManagerForAgentIpc(databaseManager)
  setFileManagerForAgentIpc(fileManager)

  // Admin IPC: admin:list-users, admin:export-conversations, admin:user-download-logs
  registerAdminIpcOnce()

  // Security-key (fingerprint) recovery IPC: recovery:* (see ipc/recoveryIpc.js)
  registerRecoveryIpcOnce(loginManager)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Upload the encrypted database backup before quitting. On macOS, Cmd+Q quits without
// emitting window-all-closed, so without this a Mac client never uploaded its backup.
let backupUploadedForQuit = false
app.on('before-quit', (event) => {
  if (backupUploadedForQuit || !GlobalValueManager.loggedIn) return
  backupUploadedForQuit = true
  event.preventDefault()
  Promise.race([
    databaseManager.encryptToServer(),
    new Promise((resolve) => setTimeout(resolve, 10000)) // never block quitting for long
  ]).finally(() => app.quit())
})

app.on('window-all-closed', async () => {
  await databaseManager.encryptToServer()
  if (process.platform !== 'darwin') {
    backupUploadedForQuit = true
    app.quit()
  } else {
    databaseManager.init()
  }
})

app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('allow-insecure-localhost', 'true')
