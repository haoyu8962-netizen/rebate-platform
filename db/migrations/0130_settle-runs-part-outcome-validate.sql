-- Up Migration
-- Validates settle_runs_part_outcome_check, added NOT VALID by the previous migration
-- (settle-runs-part-outcome-check: D10-719 ③). Task B2-04zw. Precedent 0119 / 0120.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The table only holds
-- (part 0, no outcome) and (part >= 1, an outcome), so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the scan runs under the ACCESS EXCLUSIVE lock the
-- previous migration took; applied on its own, this file blocks no reads or writes.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.settle_runs; 5s
-- lock wait so a blocked deploy fails fast, 30s overall as a ceiling for the scan (one row per
-- settle run, a small table).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.settle_runs VALIDATE CONSTRAINT settle_runs_part_outcome_check;
