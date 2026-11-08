-- Up Migration
-- The refund-quantity baseline of the R9 route (08 BR-FUND-01「R9 与 R9b 的判定」: refunded_quantity
-- increased in this sync → R9). Task B2-04zzf (FU-R9-REFUND-BASELINE); orchestrator rulings
-- D10-814 ⑤, D10-868 ② and D10-870 (couli-runs/FU-R9-REFUND-BASELINE/plan.md, option (a)).
-- app.orders gains refunded_quantity_r9_baseline integer: the refunded_quantity the last funds
-- decision on the refund count was made for. The clawback compares refunded_quantity with
-- COALESCE(refunded_quantity_r9_baseline, refunded_quantity_at_credit, 0) instead of the credit-time
-- snapshot alone, so a sync after an R9 that brings only a new settlement record goes to R10 and not
-- to R9 again. Sole writer: the settlement clawback (R8 / R9 / R10 writes move it in the same
-- statement; the R9 positive-skip and no-change exits move it alone, in the sync's transaction;
-- waiting for union commission does not move it). refunded_quantity_at_credit keeps its meaning
-- (frozen at credit; growth invite reward and BR-TEXT-03 still read it).
-- Compatibility: additive. Nullable, no default, no constraint; ALTER TABLE on the partitioned
-- parent (not ONLY) adds it to orders_default and to every partition created later. No backfill
-- (D10-870): the system is not live; NULL falls back to refunded_quantity_at_credit, so a staging
-- row that already had an R9 takes the old route one more time on its next changed sync, which is
-- accepted. Existing inserts and updates that omit the column keep working. Grants are unchanged:
-- the table-level SELECT / INSERT / UPDATE of couli_app and SELECT of couli_readonly cover the new
-- column.
-- Recovery: no down migration. app.orders is a funds / attribution table, so the column is never
-- dropped by a migration; to stop using it, the application stops reading and writing it.
--
-- Timeouts: ADD COLUMN without a default is a catalog-only change (no table rewrite, no scan) but
-- takes ACCESS EXCLUSIVE on app.orders and its partitions, held to commit since the runner uses one
-- transaction. 5s lock wait so a blocked deploy fails fast instead of queueing order sync traffic
-- behind it; 30s overall as a ceiling for the catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.orders ADD COLUMN refunded_quantity_r9_baseline integer;
