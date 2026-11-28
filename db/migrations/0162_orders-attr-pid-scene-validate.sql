-- Up Migration
-- Validates orders_attr_pid_scene_check, added NOT VALID by the previous migration
-- (orders-attr-pid-scene: the promotion-slot scene at match time, 规划/08 BR-CALC-19; D10-3808).
-- Task B1-08zzi.
-- Precedent 0159 / 0160: an attribution table takes no squawk exception, so the validation of a new
-- constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The column is new and
-- existing rows hold NULL, which the CHECK accepts, so no existing row can fail. On the partitioned
-- app.orders the validation recurses to its partitions.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans the rows; 5s lock wait
-- so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.orders VALIDATE CONSTRAINT orders_attr_pid_scene_check;
