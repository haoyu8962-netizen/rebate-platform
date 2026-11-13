// Partition maintenance of the worker (ADR-0001 §4.2 第 4 项 分区维护, 第 5 项 分区粒度, 第 8 项
// couli_maint, 第 16 项 event_log 留存 ≥190 天; 规划/02 §15.1 PG 一行; BR-ID-30 ⑫、⑯、⑰ (功能对照
// G-14)). Task B1-01j implements everything below in two steps (规划/11 §2.3, db/AGENTS.md): first the
// migration (section A), then — after the orchestrator has run the migration and `pnpm db:snapshot`
// outside the sandbox — this module (sections B–H). The rule tests in test/spec/db/partitions/** and
// test/spec/platform/maintenance/** import this file by path and call the SQL functions by name; the
// names, signatures and semantics written here are the contract. Values that no document fixes are
// marked 待编排会话确认 (suggested defaults).
//
// A. Migration — `db/migrations/0011_partition-maintenance.sql`
//    Rules of db/AGENTS.md apply: first line `-- Up Migration`, no down section, recovery in the header
//    comment, no date-dependent DDL (the migration creates no partition), grants in this migration,
//    `app.ensure_month_partition` is NOT redefined (its allow-list stays event_log, orders).
//    IMPORTANT: packages/db/src/migrations.test.ts reads the LAST text `IF p_table NOT IN (…) THEN` of
//    all migrations as the allow-list of ensure_month_partition; the new functions must not contain
//    that text (use `= ANY (ARRAY[…])` or CASE).
//    Both functions: LANGUAGE plpgsql, SECURITY DEFINER, `SET search_path = pg_catalog, pg_temp`,
//    owned by couli_migrator (the role that runs migrations; a non-owner cannot drop partitions,
//    ADR-0001 §4.2 #4), `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO couli_maint` and to no other
//    role: their ACL is exactly {couli_maint=X/couli_migrator, couli_migrator=X/couli_migrator}.
//    Errors are raised with exactly the SQLSTATE and message given here (`%` = the argument).
//
//    A1. `app.drop_expired_month_partitions(p_table text, p_now timestamptz) RETURNS text[]`
//        Function-level settings: lock_timeout = '5s' (technical limit), DateStyle = 'ISO, YMD',
//        TimeZone = 'UTC'; bound rendering/parsing is independent of caller session settings.
//        A lock wait timeout raises SQLSTATE 55P03 (lock_not_available), rolling back the entire
//        statement, including any earlier drops; no partition is reported as dropped on failure.
//        Drops the month partitions of `app.<p_table>` whose whole range is past the retention period
//        and returns their names. Checks, in this order:
//          a. p_table or p_now NULL → 22004 null_value_not_allowed
//             `drop_expired_month_partitions: p_table and p_now are required`
//          b. p_now is ±infinity → 22023 invalid_parameter_value
//             `drop_expired_month_partitions: p_now must be finite`
//          c. p_table is exactly (case-sensitive, no trimming) one of the RETAINED tables below →
//             55000 object_not_in_prerequisite_state
//             `drop_expired_month_partitions: partitions of app.% are kept until their retention period is confirmed`
//             — whether or not the table exists yet (most of them do not).
//          d. p_table is not exactly a key of the RETENTION table below → 22023 invalid_parameter_value
//             `drop_expired_month_partitions: table "%" has no partition retention rule`
//             (any other name: link_logs, a partition name, 'EVENT_LOG', ' event_log', 'app.event_log', '').
//          e. app.<p_table> is not a partitioned table → 42P01 undefined_table
//             `drop_expired_month_partitions: app.% is not a partitioned table`
//        RETAINED (BR-ID-30 ⑫ 账务记录, ⑰ 订单类记录 — "确认前不设自动删除任务，也不删除这些表的分区";
//        ⑧ audit_logs "确认前不设自动删除任务"; 规划/02 §15.1 "保管期限确认前分区维护任务不得对它们执行
//        删除"): orders, order_keys, order_status_history, order_rights, order_settlements,
//        commission_splits, settle_bills, settle_batches, settle_batch_items, settle_adjustments,
//        claims, claim_items, ledger_vouchers, ledger_entries, withdrawals, payout_attempts, audit_logs.
//        (⑰'s "金额版本与受益人事件" tables have no names yet: they fall under d, also refused.)
//        RETENTION (days): event_log 190 (ADR-0001 §4.2 #16 "留存 ≥190 天"; BR-ID-30 ⑯ "190 天").
//        Nothing else is droppable in this task: link_logs (day partitions, BR-ID-30 ② 90 天) gets its
//        day-partition maintenance in a later task (0006 header), until then it falls under d.
//        Cutoff (BR-ID-30: "删除条件为 created_at < 运行当日 00:00（+08:00）− 留存天数"): let D be the
//        calendar date of p_now at UTC+08:00 (fixed offset; the session TimeZone changes nothing);
//        cutoff = 00:00 of (D − retention days) at +08:00. A partition is dropped exactly when BOTH
//          (i)  ALL rows it can hold by its partition key are older than the cutoff: its upper bound
//               (the first instant of the next UTC month of `occurred_at`) ≤ cutoff, AND
//          (ii) no row in it has `created_at` ≥ cutoff (BR-ID-30 judges by created_at; occurred_at,
//               the partition key, can be earlier than created_at for an event recorded late).
//        A partition that passes (i) but not (ii) is kept (whole; rows are never deleted one by one)
//        and not reported; a later call drops it once its NEWEST created_at is older than the cutoff
//        (one row at or after the cutoff keeps the whole partition, whatever the other rows are).
//        Example: event_log_p202603 ([2026-03-01Z, 2026-04-01Z)) holding only rows created in March is
//        kept for any p_now ≤ 2026-10-08T15:59:59.999Z and dropped from p_now = 2026-10-08T16:00:00Z
//        (= 2026-10-09 00:00 +08:00, cutoff 2026-04-02 00:00 +08:00) on. If it also holds a row with
//        created_at 2026-10-08T16:00:00Z, it is kept up to p_now 2027-04-17T15:59:59.999Z (cutoff
//        2026-10-09 00:00 +08:00 equals that created_at: not older) and dropped from
//        2027-04-17T16:00:00Z on.
//        Only children of app.<p_table> named exactly `<p_table>_pYYYYMM` (the partitions
//        app.ensure_month_partition creates) are considered; the DEFAULT partition and any other child
//        are never dropped. Dropping is `DROP TABLE` of the partition (DDL; the append-only trigger of
//        event_log does not fire), in the same transaction as the call.
//        Result: the dropped names in ascending order; '{}' (never NULL) when nothing was dropped.
//        Concurrency: absent a lock timeout, simultaneous calls for the same table both succeed
//        and every partition is dropped and reported exactly once (e.g. a transaction-level advisory
//        lock per table taken before listing the partitions, and the per-partition lock key that
//        ensure_month_partition uses, `'app.ensure_month_partition:' || <partition name>`).
//        Concurrent writers (BR-ID-30 created_at rule must hold against them): for a partition that
//        passes (i), first precheck (ii) without requesting an exclusive lock; skip a partition
//        already holding a recent row. If no candidates remain, return without a parent exclusive
//        lock. Otherwise acquire creation advisory locks, then the parent's exclusive lock before
//        `LOCK TABLE app.<partition> IN ACCESS EXCLUSIVE MODE` (waiting for writers to end).
//        THEN recheck (ii) under that lock
//        with a statement that starts after the lock was granted, and drops only if (ii) still holds.
//        So a row inserted by a transaction that commits while the call waits is seen and keeps the
//        partition; the precheck never replaces the check under lock.
//
//    A2. `app.partition_default_rows() RETURNS TABLE (table_name text, default_partition text, row_count bigint)`
//        One row for every partitioned table of schema `app` that has a DEFAULT partition (read from
//        pg_partitioned_table, so tables added later are covered without a new migration), ordered by
//        table_name (COLLATE "C"): the table, its DEFAULT partition, and the exact number of rows in
//        that DEFAULT partition. Rows there mean a partition was missing (ADR-0001 §4.2 #4 "其中有数据即
//        告警"). Today: event_log, link_logs, orders. Note: link_logs has no day partitions yet, so every
//        link_logs row sits in its DEFAULT partition and is reported (待编排会话确认: suggested default —
//        report it; the day-partition task removes the cause).
//
// B. Module API (this file) — `createPartitionMaintenance(options)` → `PartitionMaintenance`
//    options: a plain object with exactly these keys —
//      db          REQUIRED. A Kysely handle whose sessions are the role couli_maint (ADR-0001 §4.2
//                  #4, #8). Accepted when it is a non-null object; the role is checked by runOnce.
//      logger      REQUIRED. A RootLogger (an object with functions info, warn and error).
//      clock       REQUIRED. The process Clock (an object with a function now).
//      intervalMs  optional integer 100..86 400 000; default MAINTENANCE_INTERVAL_MS (3 600 000, one
//                  hour; 待编排会话确认 — see section F).
//    Anything else (missing required key, unknown key, wrong type, intervalMs out of range, a fraction,
//    NaN, a string) → throws MaintenanceError('invalid_option') synchronously. Opens no connection,
//    reads no time, logs nothing.
//
// C. `runOnce()` → Promise<MaintenanceReport> — one maintenance run, in this order:
//    1. Role: `SELECT current_user`. Unless it is exactly 'couli_maint', rejects
//       MaintenanceError('wrong_role') having done nothing else (no function called, no log line).
//    2. Time: reads `clock.now()` exactly once; that instant (`now`) is used by every step below. No
//       other time source (no Date.now(), new Date() without argument, performance.now(), SQL now()).
//    3. Pre-create (ADR-0001 §4.2 #4 "按月的表预建未来 3 个月"): for each table of
//       MONTH_PARTITIONED_TABLES (@couli/db, in that order: event_log, orders) and each month of
//       monthsToEnsure(now, MONTHS_AHEAD) (UTC months: the month of `now` and the 3 following, in
//       ascending order): `SELECT app.ensure_month_partition(<table>, '<YYYY-MM-01>'::date)` as its
//       own short transaction, first running SELECT set_config('lock_timeout', '5s', true).
//       A success appends the returned name to `ensured`; a failure (e.g. 23514 when
//       the DEFAULT partition holds rows of that month) logs `partition_ensure_failed`, counts in
//       `failed`, and the run continues with the next month / table. On 55P03, skip the remaining
//       months of that table for this run; other tables continue and the next run tries again.
//    4. Drop (ADR-0001 §4.2 #4 "建和删分区"; BR-ID-30 ⑯ and "由每日 04:00（+08:00）删除任务…执行"):
//       ONLY when the time of day of `now` at UTC+08:00 is 04:00:00.000 or later (so between 00:00 and
//       03:59:59.999 +08:00 this step is skipped entirely: no call, no log line, `dropped` empty).
//       Pre-creation (3) and the DEFAULT check (5) run in every run; deletion is a daily step whose
//       first chance each day is the first run at or after 04:00 +08:00 (with the hourly schedule:
//       between 04:00 and 05:00). Later runs of the same day call the function again; it is idempotent
//       and normally drops nothing more ("同一日只删一次" holds by result).
//       For each table of DROPPABLE_TABLES (exactly ['event_log']; never a RETAINED table)
//       `SELECT app.drop_expired_month_partitions(<table>, <now>)`; each returned name is appended to
//       `dropped` and logged `partition_dropped`; a failure logs `partition_drop_failed` and counts in
//       `failed`.
//       Lock timeout 55P03 follows the same failure path: one partition_drop_failed with
//       { table: 'event_log', sqlstate: '55P03' }, failed += 1, continue DEFAULT checking;
//       no immediate retry, the next scheduled run attempts deletion again.
//       Example: with event_log_p202602 and p202603 (rows created in their months), a run at
//       2026-10-09 03:59:59.999 +08:00 drops nothing; a run at 2026-10-09 04:00:00.000 +08:00 drops both.
//    5. DEFAULT check: `SELECT * FROM app.partition_default_rows()` in its own short transaction,
//       first running SELECT set_config('lock_timeout', '5s', true). A 55P03 follows the failure
//       path below; the timeout setting never outlives the transaction.
//       Every row with row_count > 0 is
//       appended to `defaultRows` and logged `partition_default_has_rows` (one line per table per run,
//       so the alert repeats every run while the rows stay). A failure logs
//       `partition_default_check_failed` and counts in `failed`.
//    6. Logs `partition_maintenance_done` and resolves with the report.
//    Any rejection other than wrong_role (e.g. the database cannot be reached at step 1) is passed on
//    unchanged by runOnce (start() logs it, section D). runOnce may be called at any time, also
//    without start() and after stop().
//    MaintenanceReport: a plain object with exactly
//      ensured      string[]  names returned by ensure_month_partition, in call order
//      dropped      string[]  names returned by drop_expired_month_partitions, in call order
//      defaultRows  { table, partition, rows }[]  rows: a JS number (safe integer), only rows > 0,
//                   ordered by table as the function returns them
//      failed       number    failed statements of steps 3–5
//
// D. Schedule — `start()`, `stop()`
//    The queue contract (platform/queue §5.3: "No cron schedules yet (schedule:false)") offers no
//    scheduled jobs, so this module schedules itself with timers (待编排会话确认 — suggested default):
//    - start(): rejects MaintenanceError('already_started') when called before. Otherwise performs the
//      first run at once and resolves after it settled: when that run rejects wrong_role, start()
//      rejects with that MaintenanceError and nothing is scheduled; when it rejects with anything
//      else, logs `partition_maintenance_failed` and resolves. From then on a run starts intervalMs
//      after the previous one settled (never two runs of one instance at once); a rejected scheduled
//      run logs `partition_maintenance_failed` and the schedule goes on.
//    - stop(): from the first call no further run starts; awaits the run of this schedule that is in
//      progress (also the first run inside start(): start() then settles as above after that run, and
//      nothing is scheduled) and resolves only after that run has settled — so the caller may close
//      the db handle right after; resolves with undefined, never rejects; a second or concurrent call
//      resolves together with the first; also before start() (then start() afterwards rejects
//      already_started). Runs started by calling runOnce() directly are not awaited.
//    - Several worker processes may run the schedule at the same time: the SQL functions are
//      idempotent and serialised by advisory locks, so each partition is created and dropped once.
//      A deletion lock timeout is logged as a failure and retried on the next run (A1, C.4).
//
// E. Log lines — only through `options.logger` itself (no child logger, no extra bindings), message =
//    the event name, fields exactly as listed (flat; no error object, message, stack, SQL text,
//    connection parameters or row contents — the DEFAULT rows can carry personal data):
//      partition_ensure_failed        error  { table, month, sqlstate }  month 'YYYY-MM-01'
//      partition_dropped              info   { table, partition }
//      partition_drop_failed          error  { table, sqlstate }
//      partition_default_has_rows     warn   { table, partition, rows }  rows a number
//      partition_default_check_failed error  { sqlstate }
//      partition_maintenance_done     info   { ensured, dropped, failed }  the three counts
//      partition_maintenance_failed   error  { sqlstate }
//    sqlstate: the error's `code` when it is a string of five characters [0-9A-Z], else null.
//
// F. Open points (待编排会话确认, suggested defaults written above):
//    - Scheduling without pg-boss cron (D). Hourly runs pre-create and check DEFAULT partitions;
//      deletion waits for 04:00 +08:00 each day (C.4, BR-ID-30 每日 04:00 删除任务), so it happens at
//      most one interval after 04:00.
//    - Retention of event_log by partition bound AND created_at (A1 (i), (ii)): BR-ID-30 names
//      created_at, the partitions follow occurred_at; a partition goes only when both say so.
//    - Wiring is outside this task's paths: the worker entry (apps/api/src/entry.ts) and a couli_maint
//      connection variable (platform/config, platform/db) — a follow-up task starts the schedule in the
//      worker entry and stops it before the queue on SIGTERM.
//    - DEFAULT check over every partitioned table of app, link_logs included (A2).
//
// G. Errors — `MaintenanceError`: name 'MaintenanceError', `code`, the fixed message of
//    MAINTENANCE_ERROR_MESSAGES; own properties exactly stack, message, name and code; no `cause`.
//
// H. Rules for the implementation
//    - This directory is compiled by the `test` project too (erasableSyntaxOnly, no decorators):
//      erasable syntax only, no NestJS, `import type` for type-only imports, relative imports with
//      `.ts`. Runtime imports only: `node:*`, `kysely`, `@couli/db` and files of this directory;
//      `../clock/clock.ts` and `../logging/logger.ts` type-only. No pg-boss.
//    - No `process.env`; no wall clock (section C.2); logs only through `options.logger`.
//    - Implementation-side unit tests go next to the code (`*.test.ts`, no database).
//
// I. Day partitions (task B1-01s). Basis: ADR-0001 §4.2 #4 ("按日的表预建
//    未来 14 天"; DEFAULT 分区兜底，有数据须先迁出才能建对应区间的分区), #5 (link_logs 按日), #8
//    (couli_maint); BR-ID-30 (删除条件 created_at < 运行当日 00:00（+08:00）− 留存天数; ② link_logs 90 天，
//    按日分区删除，不得短于 W_claim + W_backfill = 720 h + 360 h = 45 天); 规划/04 §3.2 (link_logs 按日分区).
//    Two steps as in B1-01j: first the migration (I1), then — after `pnpm db:snapshot` outside the
//    sandbox — this module (I2). Rule tests: test/spec/db/partitions/day-*.ts and
//    test/spec/platform/maintenance/day-*.ts. Sections A–H stay valid unchanged.
//
//    Day: the calendar day at the FIXED offset UTC+08:00 (never a session or host time zone; the
//    month partitions of section A keep their UTC months). The partition of day D of table T is
//    named `T_pYYYYMMDD` (D's date) and holds [D 00:00:00+08:00, D+1 00:00:00+08:00); rendered under
//    TimeZone UTC its bound is exactly
//      FOR VALUES FROM ('<D−1> 16:00:00+00') TO ('<D> 16:00:00+00').
//
// I1. Migration — the next free number (待编排会话核对; today `0012_link-logs-day-partitions.sql`).
//    Rules of section A apply: `-- Up Migration`, no down section, recovery in the header, the
//    migration creates no partition (packages/db/src/migrations.test.ts also rejects a LINE that
//    starts with `CREATE TABLE … PARTITION OF … FOR VALUES`: keep such text inside a format string),
//    grants in the same migration. NOT redefined: app.ensure_month_partition (its allow-list stays
//    event_log, orders; it keeps rejecting link_logs with 22023), app.drop_expired_month_partitions
//    (keeps rejecting link_logs with 22023) and app.partition_default_rows. The new text must not
//    contain `IF p_table NOT IN (` (migrations.test.ts reads the last one as the month allow-list):
//    use `= ANY (ARRAY[…])`, `<>` or CASE.
//    Both new functions: exactly one overload each, LANGUAGE plpgsql, SECURITY DEFINER, owned by
//    couli_migrator, function-level settings exactly, in this order (pg_proc.proconfig):
//      search_path=pg_catalog, pg_temp | lock_timeout=5s | DateStyle=ISO, YMD | TimeZone=UTC
//    (as app.drop_expired_month_partitions; 待编排会话确认), `REVOKE ALL … FROM PUBLIC`,
//    `GRANT EXECUTE … TO couli_maint` and to no other role: ACL exactly
//    {couli_maint=X/couli_migrator, couli_migrator=X/couli_migrator}. couli_app, couli_payout and
//    couli_readonly get 42501; couli_maint itself still has no DDL on link_logs (42501).
//    Day-partitioned tables (allow-list of both functions): exactly 'link_logs' (case-sensitive, no
//    trimming). `events` does not exist yet; the migration that creates it extends both lists.
//    Errors are raised with exactly the SQLSTATE and message given here (`%` = the argument).
//
//    I1a. `app.ensure_day_partition(p_table text, p_day date) RETURNS text`
//         Creates the partition of day p_day of app.<p_table> and returns its name; when a partition
//         of app.<p_table> with that name already exists, returns the name and does nothing else
//         (no DDL, no table lock: it returns at once even while another session holds a lock on the
//         table). Checks, in this order:
//           a. p_table or p_day NULL → 22004
//              `ensure_day_partition: p_table and p_day are required`
//           b. p_table is not exactly 'link_logs' → 22023
//              `ensure_day_partition: table "%" is not day-partitioned`
//              (event_log, orders, events, 'LINK_LOGS', ' link_logs', 'app.link_logs', a partition
//              name, '' …)
//           c. p_day before 2000-01-01 or after 9999-12-31 (also ±infinity) → 22023
//              `ensure_day_partition: p_day must be between 2000-01-01 and 9999-12-31`
//              (range 待编排会话确认: keeps the name at exactly 8 digits)
//           d. app.<p_table> is not a partitioned table → 42P01
//              `ensure_day_partition: app.% is not a partitioned table`
//           e. a relation app.<name> exists that is not a partition of app.<p_table> → 42P07
//              `ensure_day_partition: app.% exists but is not a partition of app.%` (name, table)
//         Creation: `CREATE TABLE app.<name> PARTITION OF app.<p_table> FOR VALUES FROM (…) TO (…)`
//         with the bounds of "Day" above (e.g. literals 'YYYY-MM-DD 00:00:00+08'). When the DEFAULT
//         partition holds a row of that day, PostgreSQL rejects it with 23514 (check_violation);
//         the error propagates unchanged and nothing is created (rows outside that day do not
//         matter: they stay in DEFAULT and the partition is created).
//         Locks: an advisory lock per partition name (suggested key
//         `hashtextextended('app.ensure_day_partition:' || <name>, 0)`) serialises callers of the
//         same day; creating takes locks on the parent, on its DEFAULT partition (scanned) and on
//         app.users (link_logs' foreign keys are cloned onto the new partition: an open transaction
//         that writes app.users makes the creation wait, measured on PG 18). Every one of these
//         waits is bounded by the function's lock_timeout (5 s): on expiry the call fails with 55P03
//         (lock_not_available), nothing is created and no lock request of it stays queued.
//         Concurrency: simultaneous calls for the same day all succeed, return the same name, and
//         the partition is created exactly once.
//
//    I1b. `app.drop_expired_day_partitions(p_table text, p_now timestamptz) RETURNS text[]`
//         Drops the day partitions of app.<p_table> whose whole range is past the retention period
//         and returns their names. Checks, in this order:
//           a. p_table or p_now NULL → 22004
//              `drop_expired_day_partitions: p_table and p_now are required`
//           b. p_now is ±infinity → 22023 `drop_expired_day_partitions: p_now must be finite`
//           c. p_table is not exactly 'link_logs' → 22023
//              `drop_expired_day_partitions: table "%" has no partition retention rule`
//              (also event_log, orders and every RETAINED name of A1: this function never drops
//              them)
//           d. app.<p_table> is not a partitioned table → 42P01
//              `drop_expired_day_partitions: app.% is not a partitioned table`
//         Retention: link_logs 90 days, written in the SQL function (BR-ID-30 ②; as event_log's 190
//         days in A1).
//         Cutoff: let D be the calendar date of p_now at UTC+08:00 (session TimeZone changes
//         nothing); cutoff = 00:00 of (D − 90 days) at +08:00. A child of app.<p_table> named
//         exactly `<p_table>_pYYYYMMDD` is dropped exactly when the upper bound of its ACTUAL range
//         (catalogue, not the name) ≤ cutoff. The partition key of link_logs is created_at, so then
//         every row it holds has created_at < cutoff: BR-ID-30's created_at condition holds
//         without reading rows (unlike A1 (ii)). The DEFAULT partition (and its rows, however old)
//         and any other child are never dropped. Dropping is `DROP TABLE` of the partition (the
//         append-only trigger does not fire), in the caller's transaction.
//         Example: p_now 2026-10-08T15:59:59.999Z (D = 2026-10-08, cutoff 2026-07-10 00:00 +08:00)
//         drops up to link_logs_p20260709; from p_now 2026-10-08T16:00:00Z (D = 2026-10-09,
//         cutoff 2026-07-11 00:00 +08:00) link_logs_p20260710 goes too; p20260711 stays.
//         Result: the dropped names in ascending order; '{}' (never NULL) when nothing was dropped.
//         Locks: a transaction-level advisory lock per table (suggested key
//         `hashtextextended('app.drop_expired_day_partitions:' || p_table, 0)`) before listing; when
//         no partition qualifies, returns '{}' WITHOUT requesting any table lock (so it returns at
//         once even while another session holds a lock on the table). Otherwise the creation
//         advisory locks of I1a for every candidate, then `LOCK TABLE ONLY app.<p_table> IN ACCESS
//         EXCLUSIVE MODE`, then re-list under that lock and drop. Every wait is bounded by
//         lock_timeout 5 s: on expiry 55P03, the whole statement rolls back (nothing dropped,
//         nothing reported), no lock request stays queued.
//         Concurrency: simultaneous calls all succeed; every partition is dropped and reported
//         exactly once.
//
// I2. Module — option `dayPartitions` of createPartitionMaintenance (section B)
//    - Optional. When present it must be exactly true or false; any other value (undefined, null,
//      'true', 1, a Boolean object …) → MaintenanceError('invalid_option') synchronously.
//    - Absent or false: everything exactly as sections B–H and their addenda (no day function is
//      called; report, logs and counts unchanged). The worker wiring (worker.ts) does not change in
//      this task: B1-01w turns the option on and removes the link_logs DEFAULT exemption.
//    - true — runOnce, with the same single `now` (C.2):
//      C.3b after step C.3: for each table of DAY_PARTITIONED_TABLES (exactly ['link_logs'], frozen)
//           and each day of dayPartitionDays(now) (ascending): `SELECT app.ensure_day_partition(
//           <table>, '<YYYY-MM-DD>'::date)` as its own statement (lock waits bounded by the
//           function). Success appends the returned name to `ensured` (after the month names;
//           existing partitions are listed too). A failure logs `partition_ensure_failed` (error)
//           { table, day, sqlstate } with day 'YYYY-MM-DD' (待编排会话确认: `day` instead of
//           `month`), failed += 1, and the next day follows; on 55P03 the remaining days of that
//           table are skipped in this run (as months, lock-wait addendum).
//      C.4  unchanged gate (04:00:00.000 +08:00 or later); after DROPPABLE_TABLES (which stays
//           exactly ['event_log']), for each table of DAY_PARTITIONED_TABLES
//           `SELECT app.drop_expired_day_partitions(<table>, <now>)`: each returned name is
//           appended to `dropped` (after event_log's) and logged `partition_dropped`
//           { table, partition }; a failure (55P03 included) logs `partition_drop_failed`
//           { table, sqlstate }, failed += 1, and the run goes on.
//      C.5, C.6 unchanged; `partition_maintenance_done` counts include the day partitions.
//      Example: a run at 2026-11-20T03:04:05Z on a fresh database reports ensured = the 8 month
//      names, then link_logs_p20261120 … link_logs_p20261204 (15), and logs done(23, 0, 0).
//    - `dayPartitionDays(now)`: the 'YYYY-MM-DD' dates (+08:00) of the day containing `now` and the
//      DAYS_AHEAD (14) following days, ascending (15 strings). An invalid Date → RangeError. Pure:
//      reads no clock. 2026-11-19T15:59:59.999Z → 2026-11-19 … 2026-12-03;
//      2026-11-19T16:00:00Z → 2026-11-20 … 2026-12-04.
//    - Rules of H apply.
//
// J. Open attempts retention (task B1-01zk). Basis: BR-ID-30 正文 (删除条件 created_at < 运行当日
//    00:00（+08:00）− 留存天数) and ② (打开尝试记录 link_open_attempts：与 link_logs 同期，按 open 成功时刻
//    删除). Rule tests: test/spec/platform/maintenance/open-attempts-*.int.test.ts (its file header is
//    the contract of the SQL function) and recheck-*.int.test.ts (event_log index, SQL only).
//    Migration `0022_open-attempts-retention-event-log-created-index.sql` (stage 1, committed):
//    `app.delete_expired_link_open_attempts(p_now timestamptz, p_batch_size integer) RETURNS bigint`
//    deletes at most p_batch_size (1..10000) rows whose opened_at < 00:00 (+08:00) of p_now's day
//    − 90 days and returns how many it deleted (SECURITY DEFINER, EXECUTE for couli_maint only;
//    rows locked by a writer are skipped and picked up later).
//    Module — only when `dayPartitions` is true (so also createWorkerMaintenance), inside the C.4
//    gate (04:00:00.000 +08:00 or later; nothing before), right after the day-partition drop of
//    link_logs of the same run, with the same single `now` (C.2; the clock is still read once):
//      call `SELECT app.delete_expired_link_open_attempts(<now>, OPEN_ATTEMPTS_BATCH_SIZE)` as its own
//      statement (one implicit transaction per batch; never inside an explicit transaction, so a
//      one-connection pool suffices), repeatedly until it returns 0 or OPEN_ATTEMPTS_MAX_BATCHES
//      calls were made in this run (a larger backlog continues in the next run).
//      - Report unchanged in shape: the deleted rows are not part of `dropped`, `ensured` or the
//        counts of `partition_maintenance_done`.
//      - When at least one row was deleted: one info line `open_attempts_deleted`
//        { table: 'link_open_attempts', rows, batches } (rows a number) after the batches.
//        When the batch limit was reached with the last call still returning > 0, that line is a
//        warn line `open_attempts_backlog` with the same fields instead. Nothing is logged when
//        nothing was deleted (existing runs keep their exact log lines).
//      - A failing call (55P03 included): the line above for the rows deleted before it (if any),
//        then `open_attempts_delete_failed` (error) { table: 'link_open_attempts', sqlstate },
//        failed += 1, no further batch in this run; the run goes on with C.5.
//
// K. Retention cleanup, first batch (task B1-15zb). Basis: BR-ID-30 正文, ⑥ ⑩ ⑮ ⑯ ⑱; orchestrator
//    rulings D10-451, D10-454, D10-457, D10-458. The contract is the header of
//    test/spec/platform/retention/kit.ts; the SQL functions are in `0102_retention-cleanup.sql`.
//    Module — only when `dayPartitions` is true, inside the C.4 gate, right after section J, with
//    the same single `now`:
//    - Configuration is read once per run, never cached, in its own short transaction with the
//      5 s lock timeout of C.3, through `app.read_retention_settings('couli')`: couli_maint has
//      EXECUTE on that function (0102) and no privilege on app.config_items itself, and
//      createWorkerMaintenance takes no reader while platform may not depend on the content module.
//      A failing read skips the whole cleanup (the switch below is unknown, so nothing may be
//      deleted): one `retention_purge_failed` { table: 'config_items', sqlstate }, failed += 1, and
//      the run goes on with C.5.
//    - retention.purge.enabled exactly false: nothing below runs. Any other value, or no row: on.
//    - retention.<table>_days: an integer at or above the table's BR-ID-30 value is used; a missing
//      or invalid value falls back to that BR-ID-30 value, without a failure. A value above the
//      functions' ceiling of 36500 is capped there, not refused: whoever set it wants rows kept
//      longer, so falling back to the shorter BR-ID-30 value would delete what they meant to keep.
//    - Each table: batches of RETENTION_BATCH_SIZE, each its own statement, until 0 or
//      RETENTION_MAX_BATCHES; a failing table does not stop the others.
//    - Report and `partition_maintenance_done` unchanged. Log lines as in the kit header: nothing
//      when nothing was deleted and nothing failed.
//
// L. union_raw_payloads retention (task B1-15zc). Basis: BR-ID-30 正文, ⑦; orchestrator rulings
//    D10-451, D10-454, D10-458. The contract is the header of
//    test/spec/platform/retention-partitions/kit.ts; the SQL function is in
//    `0105_union-raw-payloads-retention.sql`. DROPPABLE_TABLES stays exactly ['event_log'].
//    Module — only when `dayPartitions` is true, inside section K's one configuration read, so the
//    switch, the days and a failing read work as there; first in that cleanup, because it is one
//    statement while the row batches below it can run long:
//    - `SELECT app.drop_expired_union_raw_payload_partitions(<now>, <days>)` once per run. Days as in
//      section K, floor 180. It drops partitions rather than rows, so its results follow C.4 and not
//      section K: each name goes into `dropped` and `partition_dropped` { table, partition }; a
//      failure logs `partition_drop_failed` { table, sqlstate }, failed += 1, no immediate retry, and
//      the rest of the run goes on.
//
// M. Agent trace retention (task B3-08s, FU-AGENT-TRACE-PURGE). Basis: BR-ID-30 正文, ① (每日 03:00
//    (+08:00) 的 Agent trace 清理任务, 190 天, agent.trace.retention_days 不得小于 184), BR-AI-19, BR-AI-22;
//    orchestrator rulings D10-454, D10-971, D10-999. The contract is the header of
//    test/spec/platform/agent-trace-retention/kit.ts; the SQL function is in
//    `0134_agent-trace-purge.sql` (`app.delete_expired_agent_traces(p_now, p_days, p_batch_size)
//    RETURNS TABLE (table_name, deleted)`: one batch per table, children before parents, nine rows in
//    AGENT_TRACE_TABLES order).
//    Module — only when `dayPartitions` is true, with the same single `now`, after section K / L and
//    before C.5:
//    - Gate: the +08:00 time of day of `now` is 03:00:00.000 or later (its own gate; sections J, K, L
//      keep 04:00). Later runs of the same day call again; the function is idempotent.
//    - Configuration: the one read of section K per run (from 04:00 shared with it; between 03:00 and
//      04:00 this section makes that read itself, at the same place in the run). A failing read is
//      logged and counted once, as in section K (`retention_purge_failed` { table: 'config_items' }),
//      and this section then does nothing. retention.purge.enabled exactly false: nothing.
//      agent.trace.retention_days: an integer ≥ 184 is used (capped at 36500); missing, not an integer
//      or below 184 falls back to 190, without a failure.
//    - Calls of AGENT_TRACE_BATCH_SIZE, each its own statement (no explicit transaction), until all nine
//      counts are 0 or AGENT_TRACE_MAX_BATCHES calls were made in this run.
//    - Logs per table with rows > 0 after the calls: `agent_trace_purged` (info) { table, rows }, or
//      `agent_trace_purge_backlog` (warn) { table, rows } when the call limit was reached with that
//      table's last count still > 0. A failing call: those lines for the rows deleted before it, then
//      `agent_trace_purge_failed` (error) { sqlstate }, failed += 1, no further call in this run.
//      Nothing when nothing was deleted and nothing failed. Report and `partition_maintenance_done`
//      unchanged.
//
// N. Events retention (task CT-13f). Basis: BR-ID-30 正文 and ③ (events 90 天); orchestrator rulings
//    D10-1488 (1), D10-1500 (a). The contract is test/spec/platform/events-retention/**; the SQL
//    functions are in `0140_analytics-events.sql` (ensure_events_day_partition(p_day),
//    drop_expired_events_day_partitions(p_now), purge_expired_events_default(p_now)) and
//    `0142_events-dedup-purge.sql` (purge_expired_event_dedup(p_now)). No configuration item: the 90
//    days live only in those functions, so retention.purge.enabled does not apply (like link_logs).
//    Module — only when `dayPartitions` is true, with the same single `now`:
//    - Pre-create, every run, right after I2's link_logs days: `SELECT
//      app.ensure_events_day_partition(<day>)` for each day of dayPartitionDays(now), one statement
//      each (the function bounds its lock waits). The first failure stops the events pre-creation and
//      skips the events cleanup of this run.
//    - Cleanup, after section M and before C.5: gate 04:00 (+08:00) as C.4, and at most one
//      successful cleanup per +08:00 day per instance (a failed one is tried again by the next run).
//      Strictly one after the other, each awaited: drop_expired_events_day_partitions(now) →
//      purge_expired_events_default(now) → purge_expired_event_dedup(now) (events before their dedup
//      rows, D10-1488 (1)). The first failure stops the remaining steps.
//    - Logs: each dropped partition `partition_dropped` (info) { table: 'events', partition } (also
//      appended to `dropped`); `retention_purged` (info) { table: 'events_default' | 'event_dedup',
//      rows } when rows > 0. Events partitions are not counted in `ensured` (its count stays the C.3
//      and I2 tables).
//    - Errors are not swallowed: a failure logs `events_retention_failed` (error) { table, sqlstate },
//      counts in `failed`, the rest of the run (other tables, C.5, the done line) still goes on, and
//      runOnce then rejects with that very error instead of resolving the report.
import {
  MONTH_PARTITIONED_TABLES,
  MONTHS_AHEAD,
  monthStartDate,
  monthsToEnsure,
  type DB,
} from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';

/** Default interval between two runs of one instance (section B, D). */
export const MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Tables whose expired partitions the run drops (section C.4). */
export const DROPPABLE_TABLES: readonly string[] = Object.freeze(['event_log']);

/** Tables partitioned by +08:00 day, maintained when `dayPartitions` is on (section I2). */
export const DAY_PARTITIONED_TABLES: readonly string[] = Object.freeze(['link_logs']);

/** Rows deleted per call of app.delete_expired_link_open_attempts (section J). */
export const OPEN_ATTEMPTS_BATCH_SIZE = 1000;

/** Most deletion batches of link_open_attempts in one run (section J). */
export const OPEN_ATTEMPTS_MAX_BATCHES = 100;

/** Rows per call of the retention functions (section K). */
const RETENTION_BATCH_SIZE = 1000;

/** Most batches per table in one run; a larger backlog continues in the next run (section K). */
const RETENTION_MAX_BATCHES = 100;

/** Upper limit of p_days in the retention functions (section K). */
const RETENTION_MAX_DAYS = 36_500;

/** The app whose config_items rows hold the retention settings (section K). */
const RETENTION_APP_ID = 'couli';

const RETENTION_ENABLED_KEY = 'retention.purge.enabled';

/** Tables purged by created_at, with their BR-ID-30 values (⑥ ⑮ ⑯ ⑱), also the floors. */
const RETENTION_TABLES: readonly { readonly table: string; readonly floorDays: number }[] = [
  { table: 'login_logs', floorDays: 180 },
  { table: 'device_registrations', floorDays: 180 },
  { table: 'inbox_messages', floorDays: 180 },
  { table: 'notify_logs', floorDays: 190 },
  { table: 'sms_send_attempts', floorDays: 190 },
];

/**
 * Dropped by month partition through its own SQL function, not through DROPPABLE_TABLES (section
 * L); floorDays is BR-ID-30 ⑦.
 */
const RAW_PAYLOADS_RETENTION = { table: 'union_raw_payloads', floorDays: 180 } as const;

/** The configured retention of one table, or its floor when unusable (section K). */
function retentionDays(value: unknown, floorDays: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < floorDays) return floorDays;
  return Math.min(value, RETENTION_MAX_DAYS);
}

/** The nine agent_* tables in the order app.delete_expired_agent_traces returns them (section M). */
const AGENT_TRACE_TABLES: readonly string[] = [
  'agent_tool_calls',
  'agent_cards',
  'agent_result_deliveries',
  'agent_messages',
  'agent_result_sets',
  'agent_runs',
  'agent_clarify_asks',
  'agent_result_chains',
  'agent_sessions',
];

/** Rows per table per call of app.delete_expired_agent_traces (section M). */
const AGENT_TRACE_BATCH_SIZE = 1000;

/** Most calls of app.delete_expired_agent_traces in one run (section M). */
const AGENT_TRACE_MAX_BATCHES = 100;

const AGENT_TRACE_DAYS_KEY = 'agent.trace.retention_days';

/** BR-ID-30 ①: the configured value may not go below 184; 190 when unusable (section M). */
const AGENT_TRACE_FLOOR_DAYS = 184;
const AGENT_TRACE_DEFAULT_DAYS = 190;

/** The configured Agent trace retention, or 190 when unusable (section M). */
function agentTraceDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < AGENT_TRACE_FLOOR_DAYS) {
    return AGENT_TRACE_DEFAULT_DAYS;
  }
  return Math.min(value, RETENTION_MAX_DAYS);
}

/** A row count returned by an events cleanup function as a safe non-negative number (section N). */
function deletedCount(rows: readonly { deleted?: bigint | number | string | null }[]): number {
  // A scalar SELECT yields one row; an absent row is read as nothing deleted.
  const value = rows[0]?.deleted ?? 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('deleted row count out of range');
  }
  return count;
}

/** Days pre-created after the current +08:00 day (section I2; ADR-0001 §4.2 #4). */
export const DAYS_AHEAD = 14;

/** 'YYYY-MM-DD' (+08:00) of the day of `now` and the DAYS_AHEAD following days (section I2). */
export function dayPartitionDays(now: Date): string[] {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: '+08:00',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // A fixed-offset day is always 24 hours; format only the supplied instant, never a clock read.
  return Array.from({ length: DAYS_AHEAD + 1 }, (_, offset) => {
    const parts = formatter.formatToParts(now.getTime() + offset * 86_400_000);
    return ['year', 'month', 'day']
      .map((type) =>
        parts.find((part) => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0'),
      )
      .join('-');
  });
}

export interface PartitionMaintenanceOptions {
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly clock: Clock;
  readonly intervalMs?: number;
  /** Tables with expected DEFAULT rows (worker contract addendum). */
  readonly quietDefaultTables?: readonly string[];
  /** Day-partition maintenance of DAY_PARTITIONED_TABLES (section I2); default false. */
  readonly dayPartitions?: boolean;
}

export interface DefaultRows {
  readonly table: string;
  readonly partition: string;
  readonly rows: number;
}

export interface MaintenanceReport {
  readonly ensured: readonly string[];
  readonly dropped: readonly string[];
  readonly defaultRows: readonly DefaultRows[];
  readonly failed: number;
}

export interface PartitionMaintenance {
  runOnce(): Promise<MaintenanceReport>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type MaintenanceErrorCode = 'invalid_option' | 'wrong_role' | 'already_started';

/** The fixed message of each code (section G). */
export const MAINTENANCE_ERROR_MESSAGES: Readonly<Record<MaintenanceErrorCode, string>> =
  Object.freeze({
    invalid_option: 'invalid partition maintenance option',
    wrong_role: 'partition maintenance must run as couli_maint',
    already_started: 'partition maintenance has already been started',
  });

export class MaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;

  constructor(code: MaintenanceErrorCode) {
    super(MAINTENANCE_ERROR_MESSAGES[code]);
    this.name = 'MaintenanceError';
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function validateOptions(options: unknown): asserts options is PartitionMaintenanceOptions {
  if (!isObject(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new MaintenanceError('invalid_option');
  }
  const allowed = new Set<PropertyKey>([
    'db',
    'logger',
    'clock',
    'intervalMs',
    'quietDefaultTables',
    'dayPartitions',
  ]);
  const logger = options['logger'];
  const quiet = options['quietDefaultTables'];
  if (
    (Object.hasOwn(options, 'dayPartitions') && typeof options['dayPartitions'] !== 'boolean') ||
    (Object.hasOwn(options, 'quietDefaultTables') &&
      (!Array.isArray(quiet) ||
        quiet.length > 32 ||
        Array.from(quiet).some(
          (name: unknown) => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name),
        ) ||
        new Set(quiet).size !== quiet.length)) ||
    Reflect.ownKeys(options).some((key) => !allowed.has(key)) ||
    !['db', 'logger', 'clock'].every((key) => Object.hasOwn(options, key)) ||
    !isObject(options['db']) ||
    !isObject(logger) ||
    !['info', 'warn', 'error'].every((key) => typeof logger[key] === 'function') ||
    !isObject(options['clock']) ||
    typeof options['clock']['now'] !== 'function' ||
    (Object.hasOwn(options, 'intervalMs') &&
      (typeof options['intervalMs'] !== 'number' ||
        !Number.isInteger(options['intervalMs']) ||
        options['intervalMs'] < 100 ||
        options['intervalMs'] > 86_400_000))
  ) {
    throw new MaintenanceError('invalid_option');
  }
}

function sqlstate(error: unknown): string | null {
  return isObject(error) && typeof error['code'] === 'string' && /^[0-9A-Z]{5}$/.test(error['code'])
    ? error['code']
    : null;
}

export function createPartitionMaintenance(
  options: PartitionMaintenanceOptions,
): PartitionMaintenance {
  validateOptions(options);
  const {
    db,
    logger,
    clock,
    intervalMs = MAINTENANCE_INTERVAL_MS,
    dayPartitions = false,
  } = options;
  const quietDefaultTables = new Set(options.quietDefaultTables ?? []);
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled: Promise<void> | undefined;
  /** The +08:00 day ('YYYY-MM-DD') of this instance's last successful events cleanup (section N). */
  let eventsCleanedDay: string | undefined;

  /** Section N: pre-create the events day partitions; the first failure rejects. */
  async function ensureEventsDays(days: readonly string[]): Promise<void> {
    for (const day of days) {
      try {
        // The SQL function bounds its lock waits for this independent statement.
        await sql`SELECT app.ensure_events_day_partition(${day}::date) AS partition`.execute(db);
      } catch (error) {
        logger.error({ table: 'events', sqlstate: sqlstate(error) }, 'events_retention_failed');
        throw error;
      }
    }
  }

  /** Section N: the three cleanup functions strictly in order; the first failure rejects. */
  async function cleanupEvents(now: Date, dropped: string[]): Promise<void> {
    let table = 'events';
    try {
      const partitions = await sql<{ partitions: string[] | null }>`
        SELECT app.drop_expired_events_day_partitions(${now}::timestamptz) AS partitions
      `.execute(db);
      for (const partition of partitions.rows[0]?.partitions ?? []) {
        dropped.push(partition);
        logger.info({ table, partition }, 'partition_dropped');
      }
      // Events rows go before their dedup rows (D10-1488 (1)).
      table = 'events_default';
      const purged = await sql<{ deleted: bigint }>`
        SELECT app.purge_expired_events_default(${now}::timestamptz) AS deleted
      `.execute(db);
      const defaultRows = deletedCount(purged.rows);
      if (defaultRows > 0) logger.info({ table, rows: defaultRows }, 'retention_purged');
      table = 'event_dedup';
      const dedup = await sql<{ deleted: bigint }>`
        SELECT app.purge_expired_event_dedup(${now}::timestamptz) AS deleted
      `.execute(db);
      const dedupRows = deletedCount(dedup.rows);
      if (dedupRows > 0) logger.info({ table, rows: dedupRows }, 'retention_purged');
    } catch (error) {
      logger.error({ table, sqlstate: sqlstate(error) }, 'events_retention_failed');
      throw error;
    }
  }

  /** Section J: bounded batches, each its own statement; resolves false when a batch failed. */
  async function deleteExpiredOpenAttempts(now: Date): Promise<boolean> {
    const table = 'link_open_attempts';
    let rows = 0;
    let batches = 0;
    let last = 0;
    try {
      while (batches < OPEN_ATTEMPTS_MAX_BATCHES) {
        // No explicit transaction: every batch commits on its own and needs one connection only.
        const result = await sql<{ deleted: bigint | number | string }>`
          SELECT app.delete_expired_link_open_attempts(
            ${now}::timestamptz, ${OPEN_ATTEMPTS_BATCH_SIZE}::integer
          ) AS deleted
        `.execute(db);
        batches += 1;
        last = Number(result.rows[0]!.deleted);
        if (!Number.isSafeInteger(last) || last < 0 || last > OPEN_ATTEMPTS_BATCH_SIZE) {
          throw new RangeError('deleted row count out of range');
        }
        rows += last;
        if (last === 0) break;
      }
    } catch (error) {
      if (rows > 0) logger.info({ table, rows, batches }, 'open_attempts_deleted');
      logger.error({ table, sqlstate: sqlstate(error) }, 'open_attempts_delete_failed');
      return false;
    }
    if (rows > 0) {
      if (last > 0) logger.warn({ table, rows, batches }, 'open_attempts_backlog');
      else logger.info({ table, rows, batches }, 'open_attempts_deleted');
    }
    return true;
  }

  /** Section K: one table's bounded batches; resolves false when a batch failed. */
  async function purgeTable(
    table: string,
    deleteBatch: () => Promise<{ rows: { deleted: bigint | number | string }[] }>,
  ): Promise<boolean> {
    let rows = 0;
    let batches = 0;
    let last = 0;
    try {
      while (batches < RETENTION_MAX_BATCHES) {
        // No explicit transaction: every batch commits on its own and needs one connection only.
        const result = await deleteBatch();
        batches += 1;
        last = Number(result.rows[0]!.deleted);
        if (!Number.isSafeInteger(last) || last < 0 || last > RETENTION_BATCH_SIZE) {
          throw new RangeError('deleted row count out of range');
        }
        rows += last;
        if (last === 0) break;
      }
    } catch (error) {
      if (rows > 0) logger.info({ table, rows }, 'retention_purged');
      logger.error({ table, sqlstate: sqlstate(error) }, 'retention_purge_failed');
      return false;
    }
    if (rows > 0) {
      if (last > 0) logger.warn({ table, rows }, 'retention_purge_backlog');
      else logger.info({ table, rows }, 'retention_purged');
    }
    return true;
  }

  /** Section L: one call; appends the names to `dropped`; resolves false when it failed. */
  async function dropExpiredRawPayloads(
    now: Date,
    days: number,
    dropped: string[],
  ): Promise<boolean> {
    const { table } = RAW_PAYLOADS_RETENTION;
    try {
      const result = await sql<{ partitions: string[] }>`
        SELECT app.drop_expired_union_raw_payload_partitions(
          ${now}::timestamptz, ${days}::integer
        ) AS partitions
      `.execute(db);
      for (const partition of result.rows[0]!.partitions) {
        dropped.push(partition);
        logger.info({ table, partition }, 'partition_dropped');
      }
      return true;
    } catch (error) {
      logger.error({ table, sqlstate: sqlstate(error) }, 'partition_drop_failed');
      return false;
    }
  }

  /**
   * Section K's configuration read, also used by section M; resolves null when it failed (logged
   * here, counted by the caller once per run).
   */
  async function readRetentionSettings(): Promise<ReadonlyMap<string, unknown> | null> {
    try {
      const result = await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('lock_timeout', '5s', true)`.execute(trx);
        return sql<{ key: string; value: unknown }>`
          SELECT key, value FROM app.read_retention_settings(${RETENTION_APP_ID}::text)
        `.execute(trx);
      });
      return new Map(result.rows.map((row) => [row.key, row.value]));
    } catch (error) {
      // The switch is unknown, so nothing may be deleted in this run.
      logger.error({ table: 'config_items', sqlstate: sqlstate(error) }, 'retention_purge_failed');
      return null;
    }
  }

  /** Sections K and L: the retention cleanup of one run; resolves the number of failures. */
  async function retentionCleanup(
    now: Date,
    dropped: string[],
    settings: ReadonlyMap<string, unknown> | null,
  ): Promise<number> {
    // A failed read was logged and counted where it was made.
    if (settings === null || settings.get(RETENTION_ENABLED_KEY) === false) return 0;

    let failures = 0;
    const rawDays = retentionDays(
      settings.get(`retention.${RAW_PAYLOADS_RETENTION.table}_days`),
      RAW_PAYLOADS_RETENTION.floorDays,
    );
    if (!(await dropExpiredRawPayloads(now, rawDays, dropped))) failures += 1;
    for (const { table, floorDays } of RETENTION_TABLES) {
      const days = retentionDays(settings.get(`retention.${table}_days`), floorDays);
      const purged = await purgeTable(table, () =>
        sql<{ deleted: bigint }>`
          SELECT ${sql.id('app', `delete_expired_${table}`)}(
            ${now}::timestamptz, ${days}::integer, ${RETENTION_BATCH_SIZE}::integer
          ) AS deleted
        `.execute(db),
      );
      if (!purged) failures += 1;
    }
    const identities = await purgeTable('deleted_identities', () =>
      sql<{ deleted: bigint }>`
        SELECT app.delete_expired_deleted_identities(
          ${now}::timestamptz, ${RETENTION_BATCH_SIZE}::integer
        ) AS deleted
      `.execute(db),
    );
    if (!identities) failures += 1;
    return failures;
  }

  /** Section M: bounded calls, each its own statement; resolves the number of failures (0 or 1). */
  async function purgeAgentTraces(
    now: Date,
    settings: ReadonlyMap<string, unknown> | null,
  ): Promise<number> {
    // A failed read was logged and counted where it was made.
    if (settings === null || settings.get(RETENTION_ENABLED_KEY) === false) return 0;
    const days = agentTraceDays(settings.get(AGENT_TRACE_DAYS_KEY));
    const totals = AGENT_TRACE_TABLES.map(() => 0);
    let last = AGENT_TRACE_TABLES.map(() => 0);
    const report = (): void => {
      AGENT_TRACE_TABLES.forEach((table, index) => {
        const rows = totals[index]!;
        if (rows === 0) return;
        if (last[index]! > 0) logger.warn({ table, rows }, 'agent_trace_purge_backlog');
        else logger.info({ table, rows }, 'agent_trace_purged');
      });
    };
    let calls = 0;
    try {
      while (calls < AGENT_TRACE_MAX_BATCHES) {
        // No explicit transaction: every call commits on its own and needs one connection only.
        const result = await sql<{ table_name: string; deleted: bigint | number | string }>`
          SELECT table_name, deleted
          FROM app.delete_expired_agent_traces(
            ${now}::timestamptz, ${days}::integer, ${AGENT_TRACE_BATCH_SIZE}::integer
          )
        `.execute(db);
        calls += 1;
        if (result.rows.length !== AGENT_TRACE_TABLES.length) {
          throw new RangeError('unexpected agent trace purge result');
        }
        const counts = result.rows.map((row, index) => {
          const deleted = Number(row.deleted);
          if (
            row.table_name !== AGENT_TRACE_TABLES[index] ||
            !Number.isSafeInteger(deleted) ||
            deleted < 0 ||
            deleted > AGENT_TRACE_BATCH_SIZE
          ) {
            throw new RangeError('unexpected agent trace purge result');
          }
          return deleted;
        });
        counts.forEach((deleted, index) => {
          totals[index] = totals[index]! + deleted;
        });
        last = counts;
        if (counts.every((deleted) => deleted === 0)) break;
      }
    } catch (error) {
      // Rows deleted by the calls before the failure stay deleted: report them as purged.
      last = AGENT_TRACE_TABLES.map(() => 0);
      report();
      logger.error({ sqlstate: sqlstate(error) }, 'agent_trace_purge_failed');
      return 1;
    }
    // When the loop stopped on nine zeros, `last` is all zero; otherwise the call limit was reached.
    report();
    return 0;
  }

  async function runOnce(): Promise<MaintenanceReport> {
    const role = await sql<{ role: string }>`SELECT current_user AS role`.execute(db);
    if (role.rows[0]?.role !== 'couli_maint') throw new MaintenanceError('wrong_role');

    const now = clock.now();
    const months = monthsToEnsure(now, MONTHS_AHEAD).map(monthStartDate);
    const ensured: string[] = [];
    const dropped: string[] = [];
    const defaultRows: DefaultRows[] = [];
    let failed = 0;
    // Section N: the first events failure, passed on after the rest of the run.
    let eventsFailure: { readonly error: unknown } | undefined;
    // Section K's configuration: read at most once per run, on first use (K from 04:00, M from 03:00).
    let settings: ReadonlyMap<string, unknown> | null | undefined;
    const loadSettings = async (): Promise<ReadonlyMap<string, unknown> | null> => {
      if (settings === undefined) {
        settings = await readRetentionSettings();
        if (settings === null) failed += 1;
      }
      return settings;
    };
    // Fixed +08:00 hour, independent of the host/session timezone.
    const hour = (now.getUTCHours() + 8) % 24;

    // Each short transaction bounds lock waits without changing pooled session settings.
    for (const table of MONTH_PARTITIONED_TABLES) {
      for (const month of months) {
        try {
          const result = await db.transaction().execute(async (trx) => {
            await sql`SELECT set_config('lock_timeout', '5s', true)`.execute(trx);
            return sql<{ partition: string }>`
              SELECT app.ensure_month_partition(${table}, ${month}::date) AS partition
            `.execute(trx);
          });
          ensured.push(result.rows[0]!.partition);
        } catch (error) {
          failed += 1;
          const code = sqlstate(error);
          logger.error({ table, month, sqlstate: code }, 'partition_ensure_failed');
          if (code === '55P03') break;
        }
      }
    }

    const days = dayPartitionDays(now);
    if (dayPartitions) {
      for (const table of DAY_PARTITIONED_TABLES) {
        for (const day of days) {
          try {
            // The SQL function bounds lock waits for this independent statement.
            const result = await sql<{ partition: string }>`
              SELECT app.ensure_day_partition(${table}, ${day}::date) AS partition
            `.execute(db);
            ensured.push(result.rows[0]!.partition);
          } catch (error) {
            failed += 1;
            const code = sqlstate(error);
            logger.error({ table, day, sqlstate: code }, 'partition_ensure_failed');
            if (code === '55P03') break;
          }
        }
      }
      try {
        await ensureEventsDays(days);
      } catch (error) {
        failed += 1;
        eventsFailure = { error };
      }
    }

    // SQL owns retention checks.
    if (hour >= 4) {
      for (const table of DROPPABLE_TABLES) {
        try {
          const result = await sql<{ partitions: string[] }>`
            SELECT app.drop_expired_month_partitions(${table}, ${now}::timestamptz) AS partitions
          `.execute(db);
          for (const partition of result.rows[0]!.partitions) {
            dropped.push(partition);
            logger.info({ table, partition }, 'partition_dropped');
          }
        } catch (error) {
          failed += 1;
          logger.error({ table, sqlstate: sqlstate(error) }, 'partition_drop_failed');
        }
      }
      if (dayPartitions) {
        for (const table of DAY_PARTITIONED_TABLES) {
          try {
            const result = await sql<{ partitions: string[] }>`
              SELECT app.drop_expired_day_partitions(${table}, ${now}::timestamptz) AS partitions
            `.execute(db);
            for (const partition of result.rows[0]!.partitions) {
              dropped.push(partition);
              logger.info({ table, partition }, 'partition_dropped');
            }
          } catch (error) {
            failed += 1;
            logger.error({ table, sqlstate: sqlstate(error) }, 'partition_drop_failed');
          }
        }
        if (!(await deleteExpiredOpenAttempts(now))) failed += 1;
        // Load first: `failed += await …` would read `failed` before loadSettings counts a failure.
        const loaded = await loadSettings();
        failed += await retentionCleanup(now, dropped, loaded);
      }
    }

    // Section M: its own 03:00 (+08:00) gate; from 04:00 it shares section K's configuration read.
    if (dayPartitions && hour >= 3) {
      const loaded = await loadSettings();
      failed += await purgeAgentTraces(now, loaded);
    }

    // Section N: once per +08:00 day from 04:00, only after the events days were ensured.
    const today = days[0]!;
    if (dayPartitions && hour >= 4 && eventsFailure === undefined && eventsCleanedDay !== today) {
      try {
        await cleanupEvents(now, dropped);
        eventsCleanedDay = today;
      } catch (error) {
        failed += 1;
        eventsFailure = { error };
      }
    }

    try {
      const result = await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('lock_timeout', '5s', true)`.execute(trx);
        return sql<{
          table_name: string;
          default_partition: string;
          row_count: bigint;
        }>`SELECT * FROM app.partition_default_rows()`.execute(trx);
      });
      for (const row of result.rows) {
        // The report explicitly uses numbers; never silently round a PG bigint count.
        const rows = Number(row.row_count);
        if (!Number.isSafeInteger(rows) || rows < 0) {
          throw new RangeError('partition row count is not a safe non-negative integer');
        }
        if (rows > 0) {
          const alert = { table: row.table_name, partition: row.default_partition, rows };
          defaultRows.push(alert);
          if (quietDefaultTables.has(row.table_name)) {
            logger.info(alert, 'partition_default_rows_expected');
          } else {
            logger.warn(alert, 'partition_default_has_rows');
          }
        }
      }
    } catch (error) {
      failed += 1;
      logger.error({ sqlstate: sqlstate(error) }, 'partition_default_check_failed');
    }

    logger.info(
      { ensured: ensured.length, dropped: dropped.length, failed },
      'partition_maintenance_done',
    );
    // Section N: never swallowed — the caller gets the original error.
    if (eventsFailure !== undefined) throw eventsFailure.error;
    return { ensured, dropped, defaultRows, failed };
  }

  async function scheduledRun(first: boolean): Promise<void> {
    try {
      await runOnce();
    } catch (error) {
      if (first && error instanceof MaintenanceError && error.code === 'wrong_role') {
        stopped = true;
        throw error;
      }
      logger.error({ sqlstate: sqlstate(error) }, 'partition_maintenance_failed');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          timer = undefined;
          scheduled = scheduledRun(false);
        }, intervalMs);
      }
    }
  }

  return {
    runOnce,
    async start() {
      if (started || stopped) throw new MaintenanceError('already_started');
      started = true;
      scheduled = scheduledRun(true);
      await scheduled;
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Includes the initial run, but deliberately excludes callers of runOnce().
      await scheduled?.catch(() => undefined);
    },
  };
}
