import { logger } from './src/Logger.js'
import ConfigManager from './src/ConfigManager.js'
import BlockchainManager from './src/BlockchainManager.js'
import { initializeSchemas } from './src/SchemaInitializer.js'
import { ensureAdminRoles } from './src/StorageDatabase.js'
import './src/SocketIO.js'
import ftpServer from './src/FtpsServer.js'
import './src/HttpsServer.js'
import './src/SftpServer.js'
import './src/SecretShareDatabase.js'
import './src/CLIListener.js'
import './src/ShutdownHandler.js'

await initializeSchemas()
await ensureAdminRoles(ConfigManager.admin.emails)
await ftpServer.listen()
logger.info(`Ftp server listening on port ${ConfigManager.ftps.controlPort}`)
BlockchainManager.diagnose().catch((err) => logger.warn(`Blockchain diagnosis error: ${err.message}`))
