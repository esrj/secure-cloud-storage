/**
 * Idempotent PostgreSQL schema initialization for all databases used by the server.
 *
 * Called once at server startup (index.js: `await initializeSchemas()`).
 * Every DDL statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so it is
 * completely safe to run against an already-provisioned database.
 *
 * Covered databases:
 *   • Main storage DB  — users, folders, files, requests, responses,
 *                        ABSE tables (ctw_table / ct_table / ctstar_table),
 *                        file_tags, file_attrs, download_logs,
 *                        agent_conversations, agent_messages
 *   • secret_share1/2/3 — secret_share table in each (keyed by userid + method_id)
 *
 * The Trusted Authority uses SQLite (better-sqlite3) and already creates its
 * own tables with IF NOT EXISTS inside Database.js — no changes needed there.
 */
import { Client } from 'pg'
import ConfigManager from './ConfigManager.js'
import { logger } from './Logger.js'
import { RECOVERY_METHOD_TABLE_SQL, SECRET_SHARE_SQLS } from './RecoverySchema.js'

// ─── Main storage database schema ─────────────────────────────────────────
//
// Tables are listed in dependency order so foreign keys always reference
// tables that already exist.

const MAIN_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id        TEXT        PRIMARY KEY NOT NULL,
  pk        TEXT        NOT NULL,
  address   TEXT        NOT NULL,
  name      TEXT        NOT NULL,
  email     TEXT        NOT NULL,
  status    TEXT        NOT NULL,
  role      TEXT        NOT NULL DEFAULT 'user',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS folders (
  id             TEXT        PRIMARY KEY NOT NULL,
  name           TEXT        NOT NULL,
  ownerid        TEXT        NOT NULL,
  permissions    INTEGER     NOT NULL,
  parentfolderid TEXT,
  timestamp      TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (ownerid)        REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY (parentfolderid) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS files (
  id                TEXT        PRIMARY KEY NOT NULL,
  name              TEXT        NOT NULL,
  ownerid           TEXT        NOT NULL,
  originownerid     TEXT,
  permissions       INTEGER     NOT NULL,
  cipher            TEXT,
  spk               TEXT,
  parentfolderid    TEXT,
  size              INTEGER,
  description       TEXT        NOT NULL DEFAULT '',
  infoblocknumber   INTEGER     NOT NULL DEFAULT 0,
  verifyblocknumber INTEGER     NOT NULL DEFAULT 0,
  timestamp         TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (ownerid)        REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY (originownerid)  REFERENCES users(id)   ON DELETE SET NULL,
  FOREIGN KEY (parentfolderid) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id          TEXT        PRIMARY KEY NOT NULL,
  fileid      TEXT        NOT NULL,
  requester   TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (fileid)    REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (requester) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS responses (
  id          TEXT        PRIMARY KEY NOT NULL,
  requestid   TEXT        NOT NULL,
  agreed      BOOLEAN     NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (requestid) REFERENCES requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ctw_table (
  fileid TEXT    NOT NULL,
  j      INTEGER NOT NULL,
  ctw    TEXT    NOT NULL,
  PRIMARY KEY (fileid, j),
  FOREIGN KEY (fileid) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ct_table (
  fileid TEXT    NOT NULL,
  i      INTEGER NOT NULL,
  ct     TEXT    NOT NULL,
  PRIMARY KEY (fileid, i),
  FOREIGN KEY (fileid) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ctstar_table (
  fileid TEXT PRIMARY KEY NOT NULL,
  ctstar TEXT NOT NULL,
  FOREIGN KEY (fileid) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_tags (
  fileid TEXT NOT NULL,
  tag    TEXT NOT NULL,
  PRIMARY KEY (fileid, tag),
  FOREIGN KEY (fileid) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_attrs (
  fileid TEXT    NOT NULL,
  attrid INTEGER NOT NULL,
  PRIMARY KEY (fileid, attrid),
  FOREIGN KEY (fileid) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS download_logs (
  id                   TEXT        PRIMARY KEY NOT NULL,
  fileid               TEXT        NOT NULL,
  downloaderuserid     TEXT        NOT NULL,
  ownerid              TEXT,
  mode                 TEXT        NOT NULL,
  watermarkvisible     BOOLEAN     DEFAULT FALSE,
  watermarkinvisible   BOOLEAN     DEFAULT FALSE,
  watermarkpayloadhash TEXT,
  requestid            TEXT,
  timestamp            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_conversations (
  id         TEXT        PRIMARY KEY NOT NULL,
  userid     TEXT        NOT NULL,
  provider   TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_at    TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (userid) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_conversations_userid_idx ON agent_conversations (userid);

CREATE TABLE IF NOT EXISTS agent_messages (
  seq              BIGSERIAL   PRIMARY KEY,
  id               TEXT        NOT NULL UNIQUE,
  conversationid   TEXT        NOT NULL,
  role             TEXT        NOT NULL,
  content          TEXT        NOT NULL,
  matched_file_ids TEXT[]      NOT NULL DEFAULT '{}',
  timestamp        TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (conversationid) REFERENCES agent_conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_messages_conversationid_idx ON agent_messages (conversationid);
`

// Conservative additions for databases that were created before these
// columns existed (ALTER TABLE is a no-op when the column already exists).
const MAIN_COLUMN_ADDITIONS = [
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS infoblocknumber  INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS verifyblocknumber INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`,
  // Fingerprint / security-key recovery (see RecoverySchema.js)
  RECOVERY_METHOD_TABLE_SQL,
]

// ─── Secret-share database schema ─────────────────────────────────────────
// Defined in RecoverySchema.js: the table is keyed by (userid, method_id), and older
// tables keyed by userid alone are upgraded in place (existing rows = password method).

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Strip pool-specific keys so the config object is suitable for pg.Client.
 * @param {object} poolCfg
 * @returns {object}
 */
function toClientCfg(poolCfg) {
  return {
    user: poolCfg.user,
    host: poolCfg.host,
    database: poolCfg.database,
    password: poolCfg.password,
    port: poolCfg.port,
    ssl: poolCfg.ssl,
  }
}

// Once we discover SSL is unsupported we cache that fact so every subsequent
// connection skips the SSL handshake entirely.
let _sslDisabled = false

/**
 * Connect a pg.Client, automatically falling back to ssl:false if the server
 * reports it does not support SSL.
 *
 * @param {object} cfg  pg client config
 * @returns {Promise<import('pg').Client>}  a connected Client (caller must .end() it)
 */
async function connectClient(cfg) {
  const effectiveCfg = _sslDisabled ? { ...cfg, ssl: false } : cfg
  const client = new Client(effectiveCfg)
  try {
    await client.connect()
    return client
  } catch (err) {
    if (!_sslDisabled && err.message && err.message.includes('SSL') && cfg.ssl) {
      _sslDisabled = true
      logger.warn(
        `[SchemaInitializer] PostgreSQL SSL not supported — switching to non-SSL for all connections.`
      )
      await client.end().catch(() => {})
      const noSslClient = new Client({ ...cfg, ssl: false })
      await noSslClient.connect()
      return noSslClient
    }
    await client.end().catch(() => {})
    throw err
  }
}

/**
 * Open a temporary pg.Client, run each SQL string in order, then close it.
 *
 * @param {object} cfg    pg client config
 * @param {string} label  human-readable label used in log messages
 * @param {string[]} sqls SQL strings to execute sequentially
 * @throws {Error} on connection or SQL error
 */
async function runWithClient(cfg, label, sqls) {
  let client
  try {
    client = await connectClient(cfg)
  } catch (err) {
    logger.error(`[SchemaInitializer] Cannot connect to ${label}: ${err.message}`)
    throw err
  }
  try {
    logger.info(`[SchemaInitializer] Connected to ${label}`)
    for (const sql of sqls) {
      await client.query(sql)
    }
    logger.info(`[SchemaInitializer] Schema OK — ${label}`)
  } catch (err) {
    logger.error(`[SchemaInitializer] SQL error on ${label}: ${err.message}`)
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

// pg error codes that indicate the role or database hasn't been created yet.
const MISSING_ROLE_CODE = '28000' // invalid_authorization_specification
const MISSING_DB_CODE   = '3D000' // invalid_catalog_name

/**
 * Build a human-readable block of manual setup SQL.
 * Shown when automatic bootstrap fails so the user knows exactly what to run.
 */
function manualSetupHint(mainCfg, shareConfigs) {
  const dbs = [mainCfg.database, ...shareConfigs.map((c) => c.database)]
  const uniqueDbs = [...new Set(dbs)]
  const lines = [
    `-- Run these as a PostgreSQL superuser (e.g. psql -U postgres):`,
    `CREATE ROLE "${mainCfg.user}" WITH LOGIN PASSWORD '${mainCfg.password}';`,
    ...uniqueDbs.map((db) => `CREATE DATABASE "${db}" OWNER "${mainCfg.user}";`),
  ]
  return lines.join('\n  ')
}

/**
 * Create the application role (if missing) and every required database
 * (if missing) using an already-connected privileged client.
 * Idempotent: existence is checked before each CREATE.
 *
 * @param {import('pg').Client} client   connected maintenance-DB client
 * @param {object}   mainCfg      toClientCfg result for the main database
 * @param {object[]} shareConfigs toClientCfg results for secret-share DBs
 */
async function createRoleAndDatabases(client, mainCfg, shareConfigs) {
  // Create role if it doesn't already exist
  const roleRow = await client.query(
    `SELECT 1 FROM pg_roles WHERE rolname = $1`,
    [mainCfg.user]
  )
  if (roleRow.rowCount === 0) {
    await client.query(
      `CREATE ROLE "${mainCfg.user}" WITH LOGIN PASSWORD '${mainCfg.password}'`
    )
    logger.info(`[SchemaInitializer] Created PostgreSQL role "${mainCfg.user}".`)
  } else {
    logger.info(`[SchemaInitializer] Role "${mainCfg.user}" already exists.`)
  }

  // Create databases if they don't already exist.
  // CREATE DATABASE cannot run inside a transaction, so each is a separate query.
  const allDbs = [mainCfg.database, ...shareConfigs.map((c) => c.database)]
  const uniqueDbs = [...new Set(allDbs)]
  for (const dbName of uniqueDbs) {
    const dbRow = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    )
    if (dbRow.rowCount === 0) {
      await client.query(
        `CREATE DATABASE "${dbName}" OWNER "${mainCfg.user}"`
      )
      logger.info(`[SchemaInitializer] Created database "${dbName}".`)
    } else {
      logger.info(`[SchemaInitializer] Database "${dbName}" already exists.`)
    }
  }
}

/**
 * Bootstrap: create the application role and all required databases if they
 * don't already exist, trying several credential candidates in order:
 *   1. the configured application user (works when the role already exists
 *      and was granted CREATEDB — no superuser guessing needed)
 *   2. postgres / postgres          (common Linux / Docker default)
 *   3. <OS user> / ''               (macOS Homebrew — trust auth, no password)
 *   4. <OS user> / <OS user>        (some Homebrew setups with peer/md5)
 *
 * A candidate that connects but lacks privileges (e.g. no CREATEDB) is
 * skipped and the next one is tried.  If every candidate fails, a
 * descriptive error with manual SQL is thrown.
 *
 * @param {object}   mainCfg      toClientCfg result for the main database
 * @param {object[]} shareConfigs toClientCfg results for secret-share DBs
 */
async function bootstrapRoleAndDatabases(mainCfg, shareConfigs) {
  logger.info(
    `[SchemaInitializer] Role or database missing — attempting automatic bootstrap…`
  )

  const osUser = process.env.USER || process.env.LOGNAME || ''
  const seen = new Set()
  const candidates = [
    { user: mainCfg.user, password: mainCfg.password },
    { user: 'postgres', password: 'postgres' },
    ...(osUser ? [
      { user: osUser, password: '' },
      { user: osUser, password: osUser },
    ] : []),
  ].filter((c) => {
    const key = `${c.user}\n${c.password}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let lastErr = null
  for (const cred of candidates) {
    const cfg = {
      user: cred.user,
      host: mainCfg.host,
      port: mainCfg.port,
      database: 'postgres',
      password: cred.password,
      ssl: false,
    }
    let client
    try {
      client = await connectClient(cfg)
    } catch (err) {
      lastErr = err
      continue // this candidate cannot even connect — try the next one
    }
    try {
      logger.info(`[SchemaInitializer] Bootstrap connected as "${cred.user}".`)
      await createRoleAndDatabases(client, mainCfg, shareConfigs)
      logger.info(`[SchemaInitializer] Bootstrap complete (as "${cred.user}").`)
      return
    } catch (err) {
      // Connected but insufficient privilege (e.g. no CREATEDB) — try next.
      lastErr = err
      logger.warn(`[SchemaInitializer] Bootstrap as "${cred.user}" failed: ${err.message}`)
    } finally {
      await client.end().catch(() => {})
    }
  }

  const hint = manualSetupHint(mainCfg, shareConfigs)
  throw new Error(
    `[SchemaInitializer] Automatic bootstrap failed` +
    (lastErr ? ` (last error: ${lastErr.message})` : ``) + `.\n` +
    `Please create the role and databases manually, then restart the server:\n\n  ${hint}`
  )
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize all PostgreSQL schemas required by the server.
 *
 * Safe to call against an already-provisioned database — every DDL statement
 * is guarded by IF NOT EXISTS or ADD COLUMN IF NOT EXISTS.
 *
 * @throws {Error} if the main database is unreachable (startup should abort).
 *   Failures for individual secret-share databases are logged as warnings and
 *   do not abort startup (the main feature set remains available).
 */
export async function initializeSchemas() {
  logger.info('[SchemaInitializer] Starting schema initialization…')

  const mainCfg    = toClientCfg(ConfigManager.dbPoolConfig)
  const shareConfigs = (ConfigManager.secretShareDbConfigs ?? []).map(toClientCfg)

  // ── Main storage database ──────────────────────────────────────────────
  const mainLabel = `main DB "${mainCfg.database}" @ ${mainCfg.host}:${mainCfg.port}`
  try {
    await runWithClient(mainCfg, mainLabel, [MAIN_TABLES_SQL, ...MAIN_COLUMN_ADDITIONS])
  } catch (err) {
    if (err.code === MISSING_ROLE_CODE || err.code === MISSING_DB_CODE) {
      // Role or database doesn't exist yet — bootstrap then retry once.
      await bootstrapRoleAndDatabases(mainCfg, shareConfigs)
      await runWithClient(mainCfg, mainLabel, [MAIN_TABLES_SQL, ...MAIN_COLUMN_ADDITIONS])
    } else {
      throw err
    }
  }

  // ── Secret-share databases ─────────────────────────────────────────────
  // The main DB may exist while a share DB is still missing (so the main-DB
  // path above never bootstrapped) — run bootstrap here too, at most once.
  let shareBootstrapDone = false
  for (let i = 0; i < shareConfigs.length; i++) {
    const cfg   = shareConfigs[i]
    const label = `secret_share DB #${i + 1} "${cfg.database}" @ ${cfg.host}:${cfg.port}`
    try {
      await runWithClient(cfg, label, SECRET_SHARE_SQLS)
    } catch (err) {
      if (err.code === MISSING_ROLE_CODE || err.code === MISSING_DB_CODE) {
        // Missing role/database — bootstrap (idempotent), then retry once.
        // Failures stay non-fatal: the main feature set remains available.
        try {
          if (!shareBootstrapDone) {
            await bootstrapRoleAndDatabases(mainCfg, shareConfigs)
            shareBootstrapDone = true
          }
          await runWithClient(cfg, label, SECRET_SHARE_SQLS)
        } catch (retryErr) {
          logger.warn(`[SchemaInitializer] ${label} init skipped after bootstrap retry: ${retryErr.message}`)
        }
      } else {
        // A secret-share DB being temporarily unavailable is non-fatal.
        logger.warn(`[SchemaInitializer] ${label} init skipped: ${err.message}`)
      }
    }
  }

  logger.info('[SchemaInitializer] All schemas initialized successfully.')
}
