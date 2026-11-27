-- Up Migration
-- orders.scene_basis takes 'link' (规划/08 BR-ATTR-09 scene_basis ∈ {pid, param, link, fallback};
-- BR-ATTR-08 拼多多单推广位: a pdd order's buy_type is decided by the link the server registered,
-- scene_basis=link; owner confirmation 2026-11-25, orchestrator rulings D10-2970 第 6 条 / D10-3278).
-- Task B1-08zza.
--   orders_scene_basis_check: the 0007 values pid / param / fallback plus link. NULL stays allowed
--     (unattributed pipeline paths never leave it NULL, but the column is nullable since 0007).
-- Compatibility: widening only. Every row the old CHECK accepted is accepted by the new one; no
-- column, default, index, trigger or grant changes. Writer: orders (couli_app), as before. The CHECK
-- is dropped and added back under the same name NOT VALID (new rows and updates are checked at
-- once); the next migration (orders-scene-basis-link-validate) validates it (precedent 0081 / 0082,
-- 0119 / 0120: orders is an attribution table and takes no squawk exception, so the validation is
-- its own migration). On the partitioned app.orders the drop and add recurse to its partitions.
-- Guard: app.orders is a funds / attribution table; its scene_basis CHECK is rebuilt under the same
-- name with a different definition, so this file must be registered by name and sha256 in
-- APPROVED_GUARD_CHANGES of tools/ci/lint-migrations.ts (class-3 protected path). Any later edit of
-- this file needs a new registration.
-- Recovery: restore from backup; no down migration. Narrowing the CHECK back is a new migration and
-- fails while any order has scene_basis = 'link'.
--
-- Timeouts: DROP / ADD CONSTRAINT … NOT VALID are catalog-only but take ACCESS EXCLUSIVE on app.orders
-- and its partitions, held to commit (the runner uses one transaction); 5s lock wait so a blocked
-- deploy fails fast instead of queueing order sync behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.orders DROP CONSTRAINT orders_scene_basis_check;

ALTER TABLE app.orders ADD CONSTRAINT orders_scene_basis_check
  CHECK (scene_basis IN ('pid', 'param', 'link', 'fallback')) NOT VALID;
