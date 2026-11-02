-- Up Migration
-- A bad row of an order page gets a pending reason of its own (规划/08 BR-CALC-03: a field missing or
-- not a number sends the order to the pending table with an alert, no snapshot, never read as 0;
-- orchestrator rulings D10-522 ⑤, D10-570). Task B1-04zv.
-- Compatibility: expand only. No column changes; existing rows are not rewritten.
--   order_sync_pending_reason_check: dropped and added back under the same name with
--     ORDER_ROW_INVALID added, NOT VALID (new rows are checked at once); the next migration only
--     validates it. The nine values of 0035 stay, so no existing row can violate it.
-- Writer: orders (couli_app; application/row-quarantine.ts through infra/pipeline-store.ts). The
-- reason is a fixed code; no personal data.
-- Grants: unchanged. couli_app keeps SELECT, INSERT, UPDATE and couli_readonly SELECT (0035).
-- Guard: order_sync_pending is a funds and attribution table and the CHECK is rebuilt under the same
-- name with a different definition, so this file is registered by hash in APPROVED_GUARD_CHANGES of
-- tools/ci/lint-migrations.ts. Any later edit of this file needs a new registration.
-- Recovery: restore from backup; no down migration. (Undoing it would be a later migration that,
-- once no ORDER_ROW_INVALID row is left, rebuilds the CHECK without the value.)
--
-- Timeouts: DROP CONSTRAINT and ADD CONSTRAINT … NOT VALID are catalog-only (no scan, no rewrite) but
-- take ACCESS EXCLUSIVE on app.order_sync_pending, held to commit (the runner uses one transaction);
-- 5s lock wait so a blocked deploy fails fast instead of queueing the sync jobs behind it, 30s overall
-- as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.order_sync_pending DROP CONSTRAINT order_sync_pending_reason_check;

ALTER TABLE app.order_sync_pending ADD CONSTRAINT order_sync_pending_reason_check
  CHECK (reason IN (
    'UNMAPPED_STATUS',
    'UNFREEZE_SIGNAL',
    'ILLEGAL_TRANSITION',
    'NO_RECEIVED_AT',
    'CLAWBACK_NO_COMMISSION',
    'SERVICE_FEE_RATE_MISSING',
    'RULE_VERSION_PLATFORM_MISSING',
    'TLJ_FACE_VALUE_UNMATCHED',
    'AMOUNT_PARSE_FAILED',
    'ORDER_ROW_INVALID'
  )) NOT VALID;
