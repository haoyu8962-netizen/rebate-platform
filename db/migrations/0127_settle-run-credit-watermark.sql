-- Up Migration
-- Count watermark of settle.run_done (08 BR-FUND-04 ⑦, BR-TEXT-09 「0 笔不发」; orchestrator rulings
-- D10-726 / D10-732; task B2-04zy). Whether an execution of a settle run credited anything is
-- decided by counts, never by comparing timestamps (worker clocks may differ):
--
-- app.settle_batches.credited_count (writer: settlement batch executor, couli_app): +1 on the item
--   transaction whose item result is 'credited' (order and beneficiary items alike), in the same
--   transaction as the item row; skipped / deferred items and rolled-back item transactions add
--   nothing. The increment does not touch row_version.
-- app.settle_runs.published_credited_count (writer: the same executor): the sum of credited_count
--   over the run's batches (same app_id and settle_run_id) as of the last published
--   settle.run_done. A resting run publishes only when the current sum is greater; the publish
--   (first INSERT or row_version CAS) writes the sum on the publishing transaction.
--
-- Compatibility: additive, two columns with a constant default and a named CHECK; no existing
-- object changes, no backfill (0 is read as "nothing counted / nothing published"). Code that does
-- not know the columns keeps working.
-- Grants: column UPDATE of the two new columns to couli_app. The table-level SELECT / INSERT of
-- 0066 (settle_batches) and 0108 (settle_runs) already cover reading and inserting them; the
-- read-only roles' table-level SELECT on settle_batches covers credited_count; settle_runs stays
-- without any other role (D10-492 ②).
-- Recovery: restore from backup; no down migration.
--
-- Timeouts: ADD COLUMN takes an ACCESS EXCLUSIVE lock on each table, held to commit (the runner
-- uses one transaction); the constant default is catalog only and the inline CHECKs scan tables
-- that hold no real rows before launch. 5s lock wait so a blocked deploy fails fast instead of
-- queueing batch executors behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.settle_batches
  ADD COLUMN credited_count integer NOT NULL DEFAULT 0
    CONSTRAINT settle_batches_credited_count_check CHECK (credited_count >= 0);

ALTER TABLE app.settle_runs
  ADD COLUMN published_credited_count integer NOT NULL DEFAULT 0
    CONSTRAINT settle_runs_published_credited_count_check CHECK (published_credited_count >= 0);

GRANT UPDATE (credited_count) ON app.settle_batches TO couli_app;
GRANT UPDATE (published_credited_count) ON app.settle_runs TO couli_app;
