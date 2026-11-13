-- Up Migration
-- B1-34q (01 F-ADM-26 ②, contract AdminDashboardYesterday; orchestrator rulings D10-1401,
-- D10-1403): the workbench's yesterday overview, aggregated after the accounting day instead of
-- live. One row per (app_id, stat_date), written only by the admin module's aggregation
-- (apps/api/src/modules/admin/application/dashboard-days.ts):
--   links          link_logs of event=convert created in the day (D10-1403 Q2)
--   orders         sub-orders whose paid_at falls in the day, whatever their status is now
--   est_rebate_fen beneficiaries' shares of those sub-orders still ESTIMATED and not DEPOSIT_PAID at
--                  as_of (BR-TEXT-21 ESTIMATED, D10-1403 Q1), priced by BR-CALC-02 like the wallet
--   new_users      users rows created in the day (a deleted account keeps its row and counts)
--   as_of          the aggregation instant (the injected Clock, never the SQL clock)
-- The day is the +08:00 accounting day [D 00:00, D+1 00:00). An app without data still gets a row
-- of true zeros, so "aggregated, nothing happened" differs from "not aggregated" (no row). A rerun
-- overwrites the four figures and as_of in place (upsert on the primary key), hence UPDATE on those
-- columns only.
--
-- Three indexes so that the counts are range scans instead of full scans:
--   orders_paid_idx       app.orders (app_id, paid_at)       — partitioned by attr_at: the index
--                         has to lead with app_id and carry paid_at, no partition is pruned
--   users_created_idx     app.users (app_id, created_at)
--   link_logs_created_idx app.link_logs (app_id, created_at) — partitioned by created_at, so the day
--                         range also prunes to one month partition
-- orders and link_logs are funds / attribution tables (tools/ci/lint-migrations.ts): the indexes are
-- named, no squawk exception is used, and a new index is not a guard rebuild (no
-- APPROVED_GUARD_CHANGES entry). A plain CREATE INDEX on a partitioned table (no ONLY, as 0132)
-- builds and attaches a child index on every partition that exists, so the parent index is valid at
-- commit; partitions created later by app.ensure_month_partition get theirs automatically.
--
-- Compatibility: additive (one new table, three new indexes); no existing column, constraint, data
-- or grant changes.
-- Recovery: no down migration. A failed run (lock or statement timeout) rolls the deploy transaction
-- back and changes nothing; run the deploy again. The table only holds derived figures: a wrong row
-- is repaired by aggregating (app, day) again.
--
-- Locks and timeouts: the runner applies all pending migrations in one transaction, so the builds
-- cannot be CONCURRENTLY (require-concurrent-index-creation is excluded in .squawk.toml for that
-- reason). Each CREATE INDEX takes a SHARE lock on its table and partitions, held to commit: writes
-- to orders (order sync), users (registration) and link_logs (link conversion) wait while the
-- indexes build and until the deploy commits; reads are not blocked. Before launch the three tables
-- are small and the builds take seconds. 5s lock wait so a deploy blocked by a long write
-- transaction fails fast and is retried instead of queueing writers behind it; 5min overall as a
-- ceiling for the three builds (as 0132). After launch, a further index on these large tables needs
-- its own window agreed with the orchestrator (D10-853 ②).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE app.admin_dashboard_days (
  app_id text NOT NULL,
  stat_date date NOT NULL,
  links bigint NOT NULL,
  orders bigint NOT NULL,
  est_rebate_fen bigint NOT NULL,
  new_users bigint NOT NULL,
  as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_dashboard_days_pkey PRIMARY KEY (app_id, stat_date),
  CONSTRAINT admin_dashboard_days_links_check CHECK (links >= 0),
  CONSTRAINT admin_dashboard_days_orders_check CHECK (orders >= 0),
  CONSTRAINT admin_dashboard_days_est_rebate_fen_check CHECK (est_rebate_fen >= 0),
  CONSTRAINT admin_dashboard_days_new_users_check CHECK (new_users >= 0)
);

GRANT SELECT, INSERT ON app.admin_dashboard_days TO couli_app;
GRANT UPDATE (links, orders, est_rebate_fen, new_users, as_of, updated_at)
  ON app.admin_dashboard_days TO couli_app;
GRANT SELECT ON app.admin_dashboard_days TO couli_readonly;

CREATE INDEX orders_paid_idx ON app.orders (app_id, paid_at);
CREATE INDEX users_created_idx ON app.users (app_id, created_at);
CREATE INDEX link_logs_created_idx ON app.link_logs (app_id, created_at);
