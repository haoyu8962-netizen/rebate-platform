-- Up Migration
-- Audit rows of the system's own actions (D10-551 ②, D10-552; contract CT-24zj; 规划/08 BR-FUND-06:
-- the risk engine's automatic hold is written with actor system:risk). Task B1-34p.
-- Compatibility: expand only. Existing readers keep working; nothing is renamed, retyped or dropped.
--   audit_logs.admin_id  now NULL-able: a system row names no account. The foreign key
--     audit_logs_admin_fkey (app_id, admin_id) stays and skips NULL (MATCH SIMPLE), so an account
--     row is checked exactly as before.
--   audit_logs.system_actor  text NULL, no default: the system identity of a system row (contract
--     enum audit_system_actor, values of the form system:<name>); NULL on an account row. Written
--     once at insert: the table stays insert-only (trigger audit_logs_append_only).
--   audit_logs_actor_check  exactly one of admin_id and system_actor is set.
--   audit_logs_system_actor_check  system_actor matches ^system:[a-z_]+$ (NULL passes; the check
--     above requires it on a system row). The enum grows later, so the format is what is fixed here.
--   Both CHECKs are added NOT VALID (new rows are checked at once) and validated by the next
--     migration (precedent 0113 / 0114). Every existing row has admin_id and NULL system_actor, so
--     none can violate them.
-- Writer: admin (couli_app; infra/system-audit.ts on the caller's transaction). No personal data:
-- system_actor is a fixed code.
-- Grants: unchanged. The new column is covered by the table-level grants of 0016 (couli_app SELECT,
-- INSERT; couli_readonly SELECT); no UPDATE or DELETE.
-- Recovery: restore from backup; no down migration. (Undoing it would be a later migration that,
-- once nothing writes system rows, drops the constraints and the column and restores NOT NULL.)
--
-- Timeouts: DROP NOT NULL, ADD COLUMN without default and ADD CONSTRAINT … NOT VALID are
-- catalog-only (no scan, no rewrite) but take ACCESS EXCLUSIVE on app.audit_logs, held to commit
-- (the runner uses one transaction); 5s lock wait so a blocked deploy fails fast instead of queueing
-- requests behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A system row has no account (D10-552). Readers are changed in this same task, and the new
-- audit_logs_actor_check keeps every row with exactly one actor, so no constraint is lost.
-- squawk-ignore ban-drop-not-null
ALTER TABLE app.audit_logs ALTER COLUMN admin_id DROP NOT NULL;

ALTER TABLE app.audit_logs ADD COLUMN system_actor text;

ALTER TABLE app.audit_logs ADD CONSTRAINT audit_logs_actor_check
  CHECK ((admin_id IS NULL) <> (system_actor IS NULL)) NOT VALID;

ALTER TABLE app.audit_logs ADD CONSTRAINT audit_logs_system_actor_check
  CHECK (system_actor ~ '^system:[a-z_]+$') NOT VALID;
