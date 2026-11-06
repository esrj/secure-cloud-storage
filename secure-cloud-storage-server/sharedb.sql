-- This file describes the scheme for share key databases.
-- Shares are grouped by recovery method: 'password' for the extra-password backup,
-- or a recovery_method.id (main database) for a bound security key.
-- The server creates and upgrades this table at startup (src/RecoverySchema.js).
CREATE TABLE secret_share (
    userid TEXT NOT NULL,
    method_id TEXT NOT NULL DEFAULT 'password',
    share TEXT NOT NULL,
    retrievable BOOLEAN NOT NULL,
    PRIMARY KEY (userid, method_id)
);

-- Rollback to the single-method layout (drops every security-key share):
--   DELETE FROM secret_share WHERE method_id <> 'password';
--   ALTER TABLE secret_share DROP CONSTRAINT secret_share_pkey;
--   ALTER TABLE secret_share DROP COLUMN method_id;
--   ALTER TABLE secret_share ADD PRIMARY KEY (userid);
