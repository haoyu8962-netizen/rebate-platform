-- Up Migration
-- Two more counts on the monthly settlement bill (08 BR-FUND-04 ④ as rewritten 2026-11-21, owner
-- confirmed; task B2-18a; orchestrator rulings D10-2415, D10-2449):
--
-- app.settle_bills.unsettled_count (writer: settlement bill-day job, couli_app): the number of
--   sub-orders of the bill month (settle_period = M, not held, no rights case) that still had no
--   union settlement data when generation started — 「应结未结」. They are only counted, no
--   difference ticket is opened. Each platform's bill-day job adds its own count to the bill row in
--   the same UPDATE, transaction and row lock as error_count / held_count; a platform that issued
--   its main batches always writes a number (0 when none). Supplement rounds do not write it.
-- app.settle_bills.amount_mismatch_count: reserved for B2-18 (orders still mismatched after the
--   commission snapshot is regenerated); nothing writes it yet.
--
-- Compatibility: additive. Both columns are nullable integers with no default and no backfill:
-- bill rows created before this migration keep NULL in both, and readers treat NULL as "not
-- recorded". Each has a named CHECK (>= 0). No existing column, constraint or index changes.
-- Grants: column UPDATE of the two new columns to couli_app, the same way 0066 granted
-- error_count / held_count. The table-level SELECT / INSERT of couli_app and SELECT of
-- couli_readonly (0066) already cover the new columns.
-- Recovery: no down migration. app.settle_bills is a funds table, so the columns are never dropped
-- by a migration; to stop using them, the application stops writing them (NULL stays readable).
--
-- Timeouts: ADD COLUMN without a default is catalog only, but takes ACCESS EXCLUSIVE on
-- app.settle_bills held to commit (the runner uses one transaction), and the inline CHECKs scan the
-- table (one row per bill month, a few rows). 5s lock wait so a blocked deploy fails fast instead
-- of queueing bill-day jobs behind it; 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.settle_bills
  ADD COLUMN unsettled_count integer
    CONSTRAINT settle_bills_unsettled_count_check CHECK (unsettled_count >= 0),
  ADD COLUMN amount_mismatch_count integer
    CONSTRAINT settle_bills_amount_mismatch_count_check CHECK (amount_mismatch_count >= 0);

GRANT UPDATE (unsettled_count, amount_mismatch_count) ON app.settle_bills TO couli_app;
