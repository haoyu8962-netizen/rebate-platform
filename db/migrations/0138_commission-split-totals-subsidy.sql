-- Up Migration
-- The subsidy commission each commission version was valued on (08 BR-CALC-27 存储 and 细则「仅补贴变化的
-- 版本」, BR-CALC-15). Task B1-18f; orchestrator rulings D10-1258 (step 3) and D10-1259.
-- app.commission_split_totals gains subsidy_commission_fen bigint: the subsidy class commission that
-- went into this version's n_total_fen (n_total_fen = N + subsidy_commission_fen). Version 1 records
-- the snapshot's frozen subsidy (the same value as commission_splits.subsidy_commission_fen); a later
-- version records the order's subsidy at the time the version is written (orders.subsidy_commission_fen,
-- NULL counted as 0). The N of a stored version is n_total_fen − this column, so a version written with
-- a subsidy other than the frozen one is not misread as a change of N.
-- Compatibility: additive. Nullable, no default, no constraint, no backfill: NULL marks a row written
-- before this column existed, and readers fall back to the order's frozen commission_splits subsidy
-- (D10-1259 ③), which is what such a row was valued on. Existing inserts that omit the column keep
-- working. The append-only trigger commission_split_totals_append_only (BEFORE UPDATE OR DELETE) is
-- unaffected. Grants are unchanged: the table-level SELECT / INSERT of couli_app and SELECT of
-- couli_readonly (0036) cover the new column.
-- Recovery: no down migration. app.commission_split_totals is a commission (funds) table, so the
-- column is never dropped by a migration; to stop using it, the application stops writing it and
-- reads NULL as the frozen subsidy again.
--
-- Timeouts: ADD COLUMN without a default is a catalog-only change (no table rewrite, no scan) but
-- takes ACCESS EXCLUSIVE on app.commission_split_totals, held to commit since the runner uses one
-- transaction. 5s lock wait so a blocked deploy fails fast instead of queueing commission writes
-- behind it; 30s overall as a ceiling for the catalog change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.commission_split_totals ADD COLUMN subsidy_commission_fen bigint;

COMMENT ON COLUMN app.commission_split_totals.subsidy_commission_fen IS
  'BR-CALC-27: subsidy commission this version was valued on (n_total_fen = N + this); NULL = row written before 0138, read as commission_splits.subsidy_commission_fen';
