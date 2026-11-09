-- Up Migration
-- Validates recon_diffs_type_check, rebuilt NOT VALID by the previous migration
-- (recon-diff-type-blacklist: + blacklist_after_credit; 规划/08 BR-ATTR-26; D10-1101). Task B2-04zzlt.
-- Precedent 0081 / 0082: a funds table takes no squawk exception, so the validation of a rebuilt
-- constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The CHECK only widens
-- (every former value is still listed), so no existing row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans the rows, which are few
-- before launch; 5s lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.recon_diffs VALIDATE CONSTRAINT recon_diffs_type_check;
