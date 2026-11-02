-- Up Migration
-- Validates order_sync_pending_reason_check, rebuilt NOT VALID by the previous migration
-- (order-sync-pending-row-invalid: D10-570). Task B1-04zv. Precedent 0117 / 0118.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The rebuilt CHECK keeps
-- every value of the old one, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the scan runs under the ACCESS EXCLUSIVE lock the
-- previous migration took; applied on its own, this file blocks no reads or writes.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans
-- app.order_sync_pending; 5s lock wait so a blocked deploy fails fast, 120s overall as a ceiling for
-- the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app.order_sync_pending VALIDATE CONSTRAINT order_sync_pending_reason_check;
