-- Up Migration
-- Reconciliation diff type blacklist_after_credit (规划/08 BR-ATTR-26, BR-FUND-01 R8 BLACKLIST_CONFIRMED;
-- orchestrator rulings D10-1095, D10-1101). Task B2-04zzlt, the test-change ahead of B2-04zzl.
--   recon_diffs_type_check: the 11 types of 0082 (same order, unchanged) plus blacklist_after_credit,
--     the manual-review worklist row for an already credited order that later hit the blacklist
--     (source R3, already allowed by recon_diffs_source_check).
-- Compatibility: the CHECK only widens; every existing row and writer stays valid. It is dropped and
-- added back under the same name NOT VALID here; the next migration (recon-diff-type-blacklist-validate)
-- validates it (precedent 0081 / 0082: a funds table takes no squawk exception, so the validation is
-- its own migration). No column, index, trigger or grant changes.
-- Guard: recon_diffs is a funds table and the CHECK is rebuilt under the same name with a different
-- definition, so this file is registered by hash in APPROVED_GUARD_CHANGES of
-- tools/ci/lint-migrations.ts (separate chore/guard-change PR, D10-1101). Any later edit of this file
-- needs a new registration.
-- Recovery: restore from backup; no down migration. Narrowing the CHECK back is a new migration and
-- fails while any blacklist_after_credit diff exists.
--
-- Timeouts: DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on recon_diffs; catalog-only, no scan.
-- 5s lock wait so a blocked deploy fails fast, 60s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.recon_diffs DROP CONSTRAINT recon_diffs_type_check;

ALTER TABLE app.recon_diffs
  ADD CONSTRAINT recon_diffs_type_check CHECK (type IN (
    'union_mismatch', 'channel_mismatch', 'ledger_mismatch', 'platform_restore',
    'month_end_unbalanced', 'settle_amount_mismatch', 'settle_missing', 'appeal_restore',
    'estimate_changed_after_credit',
    'pay_mismatch', 'pay_anomaly',
    'blacklist_after_credit'
  )) NOT VALID;
