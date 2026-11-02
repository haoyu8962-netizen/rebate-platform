-- Up Migration
-- Validates audit_logs_actor_check and audit_logs_system_actor_check, added NOT VALID by the
-- previous migration (audit-logs-system-actor: D10-552). Task B1-34p. Precedent 0113 / 0114.
-- Compatibility: no shape change; existing rows are checked, not rewritten. Every existing row has
-- admin_id (the column was NOT NULL) and NULL system_actor (the column is new), so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the scans run under the ACCESS EXCLUSIVE lock the
-- previous migration took; applied on its own, this file blocks no reads or writes.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.audit_logs, a
-- table that only grows; 5s lock wait so a blocked deploy fails fast, 120s overall as a ceiling for
-- the two scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app.audit_logs VALIDATE CONSTRAINT audit_logs_actor_check;

ALTER TABLE app.audit_logs VALIDATE CONSTRAINT audit_logs_system_actor_check;
