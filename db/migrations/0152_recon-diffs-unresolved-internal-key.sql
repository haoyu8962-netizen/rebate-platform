-- Up Migration
-- B2-02zc (BR-FUND-19 细则「账务自检异常」, couli 8c4ffe5; orchestrator rulings D10-2219, D10-2224 B ①,
-- D10-2275): an unresolved internal self-check difference is not registered again on later accounting
-- days. While a ledger_mismatch ticket of an app and ref_id is open or processing, no second open or
-- processing ledger_mismatch with the same (app_id, ref_id) may exist, whatever its period.
--
-- Only the internal self-check type is constrained, and within it only the account-level
-- (ref_type ledger_account) and voucher-level (ref_type voucher, the global ② included) tickets
-- (D10-2295): a ticket grouped by sub-order (ref_type order) can name several beneficiaries, and while
-- it is unresolved another beneficiary of the same sub-order may turn negative; deduplicating by the
-- ticket would leave that user's withdrawals unblocked (withdraw_holds has no unique key to top a hold
-- up idempotently, and the payout side is out of this change). Order-level tickets therefore keep one
-- per accounting day, each with its holds — more holds rather than a missed one
-- (FU-B2-02ZC-ORDER-LEVEL-DEDUP).
-- External differences (union_mismatch,
-- channel_mismatch, platform_restore, ...) keep one ticket per (app_id, type, period, ref_id) under
-- recon_diffs_business_key. A concluded ticket (adjusted, written_off, closed) leaves the index, so the
-- same difference found again later opens a new ticket.
--
-- The writer (apps/api ledger registerReconDiffOnce) inserts with ON CONFLICT DO NOTHING and no conflict
-- target, so this index is an arbiter like the other unique keys: a conflicting concurrent insert is
-- waited for, and the existing unresolved ticket is read back with inserted = false (no second hold).
--
-- Existing rows: this migration changes no business data — it does not conclude, rewrite or delete any
-- ticket and does not touch withdraw_holds. If an app already holds two or more unresolved
-- account- or voucher-level ledger_mismatch tickets with the same ref_id (registered on different
-- days before this change), the index build fails with 23505 and the whole migration rolls back; that
-- is intended (fail closed). Before deploying, find such groups with
--   SELECT app_id, ref_id, count(*) FROM app.recon_diffs
--    WHERE type = 'ledger_mismatch' AND status IN ('open', 'processing') AND ref_type <> 'order'
--    GROUP BY app_id, ref_id HAVING count(*) > 1;
-- and conclude the surplus tickets through the console first (D10-2275 ③).
--
-- squawk: require-concurrent-index-creation is excluded globally in .squawk.toml (the runner applies
-- migrations in one transaction, precedent 0132). CREATE INDEX takes a SHARE lock on app.recon_diffs:
-- registrations wait for the build. 5s lock wait so a blocked deploy fails fast; 5min ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE UNIQUE INDEX recon_diffs_unresolved_internal_key
  ON app.recon_diffs (app_id, type, ref_id)
  WHERE type = 'ledger_mismatch' AND status IN ('open', 'processing') AND ref_type <> 'order';
