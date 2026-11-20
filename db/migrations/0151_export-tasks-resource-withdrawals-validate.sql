-- Up Migration
-- Validates export_tasks_resource_check, re-added NOT VALID by the previous migration
-- (export-tasks-resource-withdrawals: export_resource gains withdrawals, CT-24zzp, D10-2017 ③;
-- task CT-24zzpa, 编排裁定 D10-2169). Precedent 0146 / 0147.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The new CHECK is wider
-- than the one it replaced, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.export_tasks; 5s
-- lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.export_tasks VALIDATE CONSTRAINT export_tasks_resource_check;
