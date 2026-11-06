-- Up Migration
-- Pairs part with last_outcome on app.settle_runs (08 BR-FUND-04 ⑦, BR-TEXT-09: CREDITED idempotency
-- key settle_run_id:part; orchestrator ruling D10-719 ③; launch gap 28 FU-B204ZFA-PAIR-CHECK). Task
-- B2-04zw. part = 0 exactly when last_outcome is NULL (nothing published for the run yet); part >= 1
-- exactly when last_outcome holds the outcome of the last publish.
-- Compatibility: no shape change. No column, primary key or default changes; existing rows are not
--   rewritten.
--   settle_runs_part_outcome_check: added NOT VALID (new and updated rows are checked at once); the
--     next migration only validates it (funds table: no VALIDATE in the adding transaction; precedent
--     0119 / 0120). The only writer (settlement, saveRunPart) writes part >= 1 with an outcome and new
--     rows start at part 0 with no outcome, so no existing row can violate it.
-- Grants: unchanged. couli_app keeps the grants of 0108 / 0127; no other role (D10-492 ②).
-- Recovery: restore from backup; no down migration. (Undoing it would be a later migration that drops
-- the CHECK by name.)
--
-- Timeouts: ADD CONSTRAINT … NOT VALID is catalog-only (no scan, no rewrite) but takes ACCESS
-- EXCLUSIVE on app.settle_runs, held to commit (the runner uses one transaction); 5s lock wait so a
-- blocked deploy fails fast instead of queueing settle run publishes behind it, 30s overall as a
-- ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.settle_runs ADD CONSTRAINT settle_runs_part_outcome_check
  CHECK ((part = 0) = (last_outcome IS NULL)) NOT VALID;
