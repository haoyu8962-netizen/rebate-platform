-- Up Migration
-- 「输入已通过」的标记（08 BR-AI-05 细则「上下文块」⑤，BR-AI-19 细则「运行级字段」；04 §3.2）.
-- Task B3-08t (规划 11-12 A2); orchestrator ruling D10-2327.
-- app.agent_runs gains input_passed boolean NOT NULL DEFAULT false: true only when the run passed
--   step 1 of 「判定顺序」 (input review passed, not stopped by the refusal pre-check or the
--   prohibited-goods check). Written by the terminal transaction of the process that ran the run
--   (agent/stream/pg/finalize.ts, the same UPDATE as final_event, guarded by final_event IS NULL);
--   a run finished by another request (crash recovery, sweeper) keeps false.
-- Compatibility: additive. Existing inserts omit the column and read false; existing rows read
--   false (a constant default is stored as the missing value: no rewrite, no backfill), so no
--   earlier run enters a later context block.
-- The update trigger agent_runs_no_rewrite (0021 / 0023 / 0073) does not list the column; it is
--   write-once in practice because only the terminal UPDATE (final_event IS NULL) sets it.
-- Writer: agent (couli_app). No personal data.
-- Grants: couli_app's table-level SELECT / INSERT (0021) covers the new column for reads and
--   inserts; UPDATE (input_passed) is granted here, column by column as 0021 / 0023 did. couli_readonly
--   reads app.agent_runs by column list, so SELECT (input_passed) is added for it (a flag, not text).
-- Recovery: no down migration. To undo, a later migration drops the column once nothing reads or
--   writes it.
--
-- Timeouts: ADD COLUMN with a constant default is catalog-only (no scan, no rewrite) but takes
-- ACCESS EXCLUSIVE on app.agent_runs, held to commit since the runner uses one transaction. 5s lock
-- wait so a blocked deploy fails fast instead of queueing the live run writes behind it; 30s overall
-- as a ceiling for the catalog change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.agent_runs ADD COLUMN input_passed boolean NOT NULL DEFAULT false;

GRANT UPDATE (input_passed) ON app.agent_runs TO couli_app;

GRANT SELECT (input_passed) ON app.agent_runs TO couli_readonly;

COMMENT ON COLUMN app.agent_runs.input_passed IS
  'BR-AI-05 ⑤: the run passed step 1 of the decision order; written with the terminal state';
