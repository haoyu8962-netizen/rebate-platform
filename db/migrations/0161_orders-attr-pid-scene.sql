-- Up Migration
-- orders.attr_pid_scene: the promotion-slot scene (union_pids.pid_scene) the order matched when it was
-- imported or last re-matched while unattributed (规划/08 BR-CALC-19 我方淘礼金订单; orchestrator rulings
-- D10-3552 / D10-3808: the first commission snapshot judges taolijin by the scene at match time, an admin
-- edit of the same union_pids row afterwards does not change it). Task B1-08zzi.
--   attr_pid_scene: nullable text, no default. Written by orders (couli_app) on first import and on an
--     unattributed re-run that hits a slot; never written once the order is attributed. Existing rows are
--     not backfilled and stay NULL (readers fall back to looking up the slot row, as before).
--   orders_attr_pid_scene_check: the same value set as union_pids_pid_scene_check (self_buy, agent, share,
--     taolijin, fallback, query), plus NULL.
-- Compatibility: expand only. A new nullable column without default is catalog-only (no table rewrite);
-- old code that does not name the column keeps working. Grants: the table-level UPDATE couli_app already
-- holds on app.orders covers the new column, so no GRANT is written.
-- Guard: app.orders is a funds / attribution table and takes no squawk exception, so the CHECK is added
-- NOT VALID here and validated by the next migration (orders-attr-pid-scene-validate; precedent 0159 /
-- 0160). Adding a new named constraint is not a change of an existing guard definition, so no
-- APPROVED_GUARD_CHANGES entry is needed. On the partitioned app.orders the column and the CHECK recurse
-- to its partitions.
-- Recovery: restore from backup; no down migration.
--
-- Timeouts: ADD COLUMN (nullable, no default) and ADD CONSTRAINT … NOT VALID are catalog-only but take
-- ACCESS EXCLUSIVE on app.orders and its partitions, held to commit (the runner uses one transaction);
-- 5s lock wait so a blocked deploy fails fast instead of queueing order sync behind it, 30s overall as a
-- ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.orders ADD COLUMN attr_pid_scene text;

ALTER TABLE app.orders ADD CONSTRAINT orders_attr_pid_scene_check
  CHECK (attr_pid_scene IN ('self_buy', 'agent', 'share', 'taolijin', 'fallback', 'query')) NOT VALID;
