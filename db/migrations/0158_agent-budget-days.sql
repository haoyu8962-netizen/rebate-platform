-- Up Migration
-- 全平台日预算与成本记账（08 BR-AI-16「全局日预算与成本记账」及细则，2026-11-25 负责人取「甲」）.
-- Task B3-09m (B4 minimal slice, 取甲重做); orchestrator rulings D10-2970 第 7 条, D10-2975.
--
-- app.agent_budget_days holds one row per Asia/Shanghai natural day, platform-wide (one budget for
--   the whole platform, so no app_id; day is the accounting day the application computes with
--   packages/domain, no SQL clock). All of a run's cost is charged to the day the run was admitted.
--   reserved_mfen is the sum of per-run reservations R (agent.budget.reserve_mfen_per_run) still
--   outstanding for runs admitted that day; actual_mfen is the cost of runs admitted that day and
--   already settled. Both in mfen (0.001 fen), bigint, kept nonnegative by CHECKs so a double
--   release fails instead of going below zero.
--   Two bookings only, both inside existing transactions: (1) the admission transaction checks the
--   committed (actual + reserved) against the cap and, when under, adds R to reserved_mfen;
--   (2) the run's single finalization transaction subtracts R from reserved_mfen and adds the run's
--   cost to actual_mfen: the live process's in-memory spend U on a normal finish, R for any other
--   finish (another request, the sweeper, crash recovery, result unknown; BR-AI-23).
--   alert_80_at / alert_100_at are best-effort claim markers: the admission or finalization
--   transaction that first sees (actual + reserved) reach 80% / 100% claims the slot with a
--   conditional UPDATE … WHERE alert_80_at IS NULL and logs the alert. A rolled-back transaction may
--   alert again; the markers are not a breaker input and not an exactly-once guarantee.
-- Writer: agent (couli_app) only — run admission (stream/pg/admit.ts) and the run's finalization
--   (stream/pg/finalize.ts) via the agent budget module. agent_runs.cost_mfen / price_version are
--   already writable by couli_app (0021), so nothing is granted on agent_runs here.
-- Grants: couli_app SELECT, INSERT and UPDATE on exactly the two counters and two alert markers
--   (day is never rewritten); no DELETE or TRUNCATE. couli_readonly SELECT on the whole table
--   (daily totals and alert times only, no personal data, no user text). couli_payout and
--   couli_maint get nothing.
--
-- app.agent_budget_reservations holds one row per run that took a reservation, written by the
--   admission transaction: run_id is the agent_runs id; day the admission day (Asia/Shanghai);
--   reserved_mfen the R actually reserved then (mfen, bigint, >= 0; also the run's spending cap);
--   price_version the version of the one unit-price entry fixed for the run at admission (the whole
--   run is priced with it; NULL when none was fixed). settled_at is set once by the finalization:
--   UPDATE … SET settled_at = <now> WHERE run_id = $1 AND settled_at IS NULL RETURNING day,
--   reserved_mfen, and agent_budget_days moves only when a row comes back (no row = never reserved,
--   or already settled), so each run is settled at most once and releases exactly what it reserved
--   on the day it reserved it, whatever the current config says.
--   No per-call registration, pending worst-case or per-call booking columns: U is kept in process
--   memory only (BR-AI-16 细则「已花 U 怎么累加」).
-- No foreign key to agent_runs: account-deletion cleanup deletes agent_runs rows and must not be
--   blocked by this table; run_id alone is not personal data. Rule tests also call the budget
--   module directly with random run ids.
-- Grants: couli_app SELECT, INSERT and UPDATE (settled_at) only; no DELETE or TRUNCATE.
--   couli_readonly SELECT on the whole table (run ids, days, amounts, price versions; no user text).
--   couli_payout and couli_maint get nothing.
-- Retention: not purged for now; a cleanup policy is left to a follow-up (FU) task.
-- Named agent_budget_* : agent/** may only read and write app.agent_* tables (BR-AI-02, write-scope
--   guard [AC-CT-06zu#2/#5]).
-- Compatibility: additive (new tables only); nothing reads or writes them before this task's code.
-- No trigger and no function.
-- Recovery: no down migration. To undo, a later migration drops the tables once nothing reads or
--   writes them (they hold only derived daily totals and per-run reservation amounts).
--
-- Timeouts: only new tables with no foreign keys are created (catalog-only, no lock on existing
-- tables); 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.agent_budget_days (
  day date NOT NULL,
  actual_mfen bigint NOT NULL DEFAULT 0,
  reserved_mfen bigint NOT NULL DEFAULT 0,
  alert_80_at timestamptz NULL,
  alert_100_at timestamptz NULL,
  CONSTRAINT agent_budget_days_pkey PRIMARY KEY (day),
  CONSTRAINT agent_budget_days_actual_mfen_check CHECK (actual_mfen >= 0),
  CONSTRAINT agent_budget_days_reserved_mfen_check CHECK (reserved_mfen >= 0)
);

GRANT SELECT, INSERT ON app.agent_budget_days TO couli_app;
GRANT UPDATE (actual_mfen, reserved_mfen, alert_80_at, alert_100_at)
  ON app.agent_budget_days TO couli_app;

GRANT SELECT ON app.agent_budget_days TO couli_readonly;

COMMENT ON TABLE app.agent_budget_days IS
  'BR-AI-16 (取甲): platform-wide budget per Asia/Shanghai natural day, mfen; all of a run''s cost goes to its admission day; reserved = outstanding per-run reservations, actual = settled runs (live normal finish books actual spend, any other finish books the full reservation); alert_80_at / alert_100_at are best-effort claim markers, not a breaker input';

CREATE TABLE app.agent_budget_reservations (
  run_id uuid NOT NULL,
  day date NOT NULL,
  reserved_mfen bigint NOT NULL,
  price_version text NULL,
  settled_at timestamptz NULL,
  CONSTRAINT agent_budget_reservations_pkey PRIMARY KEY (run_id),
  CONSTRAINT agent_budget_reservations_reserved_mfen_check CHECK (reserved_mfen >= 0)
);

GRANT SELECT, INSERT ON app.agent_budget_reservations TO couli_app;
GRANT UPDATE (settled_at) ON app.agent_budget_reservations TO couli_app;

GRANT SELECT ON app.agent_budget_reservations TO couli_readonly;

COMMENT ON TABLE app.agent_budget_reservations IS
  'BR-AI-16 (取甲): per-run reservation taken at admission (admission day, reserved mfen = the run''s spending cap, the one unit-price version fixed for the run); settled_at set exactly once by the run''s finalization, which releases the reservation and books actual spend (live normal finish) or the full reservation (any other finish) to the admission day';
