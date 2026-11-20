-- Up Migration
-- Opens app.export_tasks to the withdrawals export: CT-24zzp adds withdrawals to the contract enum
-- export_resource (D10-2017 ③), so the resource CHECK also takes withdrawals. Task CT-24zzpa,
-- 编排裁定 D10-2169 (lands before CT-24zzp, as CT-24zzma did for ledger). BR-ID-42.
-- app.export_tasks is not a fund table: it holds export task metadata only.
-- Compatibility: widening only. Every row the old CHECK accepted is accepted by the new one; no
-- column, default or index changes. Writer: admin (couli_app), as before.
-- export_tasks_audit_masked_check and every other constraint stay unchanged.
-- The new CHECK is added NOT VALID (new rows and updates are checked at once) and validated by the
-- next migration (precedent 0146 / 0147): squawk's constraint-missing-not-valid applies, and the
-- two statements below are one replacement of the same name.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration. (Undoing it is a later migration that narrows
-- the CHECK again, once no withdrawals row remains.)
--
-- Timeouts: DROP CONSTRAINT and ADD CONSTRAINT … NOT VALID are catalog-only but take ACCESS
-- EXCLUSIVE on app.export_tasks, held to commit (the runner uses one transaction); 5s lock wait so
-- a blocked deploy fails fast instead of queueing requests behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.export_tasks DROP CONSTRAINT export_tasks_resource_check;

ALTER TABLE app.export_tasks ADD CONSTRAINT export_tasks_resource_check
  CHECK (resource IN ('users', 'audit_logs', 'tax_withdrawals', 'ledger', 'withdrawals')) NOT VALID;
