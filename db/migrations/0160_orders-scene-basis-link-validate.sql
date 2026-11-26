-- Up Migration
-- Validates orders_scene_basis_check, rebuilt NOT VALID by the previous migration
-- (orders-scene-basis-link: + link, 规划/08 BR-ATTR-09; BR-ATTR-08 拼多多单推广位). Task B1-08zza.
-- Precedent 0081 / 0082, 0119 / 0120: an attribution table takes no squawk exception, so the
-- validation of a rebuilt constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The CHECK only widens
-- (every former value is still listed), so no existing row can fail. On the partitioned app.orders
-- the validation recurses to its partitions.
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

ALTER TABLE app.orders VALIDATE CONSTRAINT orders_scene_basis_check;
