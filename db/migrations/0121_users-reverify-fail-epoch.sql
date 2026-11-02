-- Up Migration
-- The generation of the self-service reverify failure count (08 BR-WDR-01 细则「旧手机号被二次放号时的
-- 提现加验」, D10-161, couli #174 r5: a release undoes its own reservation only, on the same day and
-- only if the count was not cleared meanwhile; task B1-02zp, money review r2). Neither the day nor
-- the reverified_devices rows can tell that: a pass on a device a concurrent pass just recorded
-- clears without a new row.
--
-- app.users.reverify_fail_epoch (writer: identity, couli_app): +1 on every reset of
--   reverify_fail_count (a pass, or the first reservation after the day changed). A reservation
--   keeps the value it saw; its release applies only if the value is still the same.
--
-- Compatibility: additive, one column with a constant default; no existing object changes, no
-- backfill (0 is a valid generation for every existing row). Code that does not know the column
-- keeps working.
-- Grants: unchanged. The table-level grants of 0005 on app.users (couli_app SELECT, INSERT, UPDATE,
-- DELETE; read roles SELECT) cover the new column, no column grant is added.
-- Recovery: restore from backup; no down migration.
--
-- Timeouts: ADD COLUMN takes an ACCESS EXCLUSIVE lock on app.users, held to commit (the runner uses
-- one transaction); the constant default is catalog only, nothing is rewritten or scanned. 5s lock
-- wait so a blocked deploy fails fast instead of queueing logins behind it, 60s overall as a
-- ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.users
  ADD COLUMN reverify_fail_epoch integer NOT NULL DEFAULT 0;
