/**
 * SQL for fingerprint / security-key account recovery (指紋復原計劃，階段 2).
 *
 * Kept free of side-effect imports so SchemaInitializer and the tests share the exact
 * same statements.
 */

/** Method id used for the original extra-password backup. */
export const PASSWORD_METHOD_ID = 'password'

/**
 * Main database. One row per bound security key. Nothing in here is secret:
 * the credential public key and the hmac-secret salt are useless without the
 * physical key, the fingerprint (or PIN), and the email OTP.
 */
export const RECOVERY_METHOD_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS recovery_method (
  id            TEXT        PRIMARY KEY NOT NULL,
  userid        TEXT        NOT NULL,
  type          TEXT        NOT NULL,
  label         TEXT        NOT NULL DEFAULT '',
  credential_id TEXT        NOT NULL UNIQUE,
  public_key    TEXT        NOT NULL,
  sign_count    BIGINT      NOT NULL DEFAULT 0,
  salt          TEXT        NOT NULL,
  aaguid        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  FOREIGN KEY (userid) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS recovery_method_userid_idx ON recovery_method (userid);
`

/**
 * Secret-share databases. Shares are grouped by recovery method, so one user can hold
 * the password shares and one set per bound security key at the same time.
 */
export const SECRET_SHARE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS secret_share (
  userid      TEXT    NOT NULL,
  method_id   TEXT    NOT NULL DEFAULT '${PASSWORD_METHOD_ID}',
  share       TEXT    NOT NULL,
  retrievable BOOLEAN NOT NULL,
  PRIMARY KEY (userid, method_id)
);
`

/**
 * Upgrade a secret_share table created before recovery methods existed
 * (PRIMARY KEY (userid)). Existing rows become the password method.
 * Idempotent, and runs as one implicit transaction.
 */
export const SECRET_SHARE_MIGRATION_SQL = `
ALTER TABLE secret_share ADD COLUMN IF NOT EXISTS method_id TEXT NOT NULL DEFAULT '${PASSWORD_METHOD_ID}';
DO $$
DECLARE
  pk_name TEXT;
  pk_cols INT;
BEGIN
  SELECT conname, array_length(conkey, 1) INTO pk_name, pk_cols
    FROM pg_constraint
   WHERE conrelid = 'secret_share'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL AND pk_cols = 1 THEN
    EXECUTE format('ALTER TABLE secret_share DROP CONSTRAINT %I', pk_name);
    pk_name := NULL;
  END IF;
  IF pk_name IS NULL THEN
    ALTER TABLE secret_share ADD PRIMARY KEY (userid, method_id);
  END IF;
END $$;
`

export const SECRET_SHARE_SQLS = [SECRET_SHARE_TABLE_SQL, SECRET_SHARE_MIGRATION_SQL]
