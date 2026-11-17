-- Up Migration
-- CT-13o: app.purge_expired_link_logs_default deletes in bounded batches (BR-ID-30 正文 每日 04:00
-- (+08:00) 删除任务, ② link_logs 90 天; BR-ATTR-14 默认值 被工单引用的记录在分区删除前复制到
-- link_log_evidence; orchestrator rulings D10-1832, D10-1874; CT-13l code review r2b S2 on 0145).
-- 0145 deleted every expired row of app.link_logs_default in one statement. Each deleted row passes
-- the row trigger link_logs_append_only, so a DEFAULT partition holding millions of expired rows (day
-- partitions not pre-created for weeks) could hit the worker's 60s statement_timeout (section P of
-- apps/api/src/modules/platform/maintenance/index.ts, D10-1826) on every run, roll back as a whole and
-- never shrink.
--
-- What changes: only the body of app.purge_expired_link_logs_default(p_now timestamptz), replaced
-- with CREATE OR REPLACE FUNCTION. One call now deletes at most PURGE_BATCH = 10000 expired rows and
-- returns how many it deleted in this call (0 = nothing deletable is left for this cutoff). The worker
-- calls it again, each call in its own short transaction, until it returns 0 or its per-run batch cap
-- is reached; the rest is left for the next run.
--
-- Unchanged, word for word as 0145: the signature and result type (the trigger function
-- app.reject_link_logs_update_delete() finds the owner through
-- to_regprocedure('app.purge_expired_link_logs_default(timestamp with time zone)'), so the signature
-- must stay; CT-13l's single-argument callers stay valid), LANGUAGE plpgsql VOLATILE SECURITY DEFINER,
-- the four function-level settings (search_path, lock_timeout 5s, DateStyle, TimeZone UTC) in the
-- same order, the NULL / non-finite checks and their SQLSTATEs, the cutoff expression (00:00 (+08:00)
-- of p_now's +08:00 calendar day − 90 days), the dedicated transaction-level advisory lock, the copy
-- app.copy_referenced_link_logs('link_logs_default', v_cutoff, p_now) before the DELETE (every call
-- copies every expired referenced row, so whatever batch a referenced row is deleted in, its evidence
-- row was committed with or before it; ON CONFLICT DO NOTHING in the copy makes repeated calls add no
-- duplicate), the condition that skips an expired row referenced by a claim item but without an
-- evidence row (a reference committed between the two statements: that row stays), and the
-- transaction-local marker couli.link_logs_default_purge_before set right before the DELETE and reset
-- to '' right after it. Owner (couli_migrator) and ACL (EXECUTE for couli_maint only) are kept by
-- CREATE OR REPLACE with the same signature (PostgreSQL keeps ownership and permissions of a replaced
-- function), so no ALTER OWNER / REVOKE / GRANT is repeated here.
-- Not touched: app.reject_link_logs_update_delete() and its four conditions, the trigger
-- link_logs_append_only, the shared app.reject_update_delete(), every table, index and grant.
--
-- The batch: the DELETE removes the rows whose ctid is in an array of at most PURGE_BATCH ctids of
-- app.link_logs_default, picked by a subquery with exactly 0145's conditions (created_at < cutoff,
-- and not referenced-without-evidence). The rows are picked by physical row id, not by id: link_logs'
-- key is (id, created_at), id alone is not unique (a replayed id can occur on many rows), so matching
-- by id could delete more than one batch. The ctid of a row cannot change during the statement: the
-- subquery and the DELETE share one snapshot, link_logs refuses every UPDATE, every other DELETE is
-- this function's (serialised by the advisory lock), and VACUUM FULL / CLUSTER would need a lock that
-- conflicts with the DELETE's. The DELETE checks created_at < cutoff again (the trigger checks it a
-- third time). The skip condition sits in the subquery, so skipped rows never fill a batch: a call
-- returns 0 only when no deletable expired row is left, never while deletable rows remain behind
-- skipped ones. No ORDER BY: which expired rows go first does not matter, and ordering would need a
-- sort of the whole backlog on every call.
-- Why 10000: one call must stay far below the worker's 60s statement_timeout even on a slow or busy
-- host, because a timeout rolls the whole batch back and nothing is gained. The per-row cost is the
-- trigger (plpgsql, one pg_proc lookup per row) plus the heap and three index deletions; measured on
-- PG 18.6 (local throwaway container, 1,000,000 expired DEFAULT rows, no vacuum between calls) one
-- 10000-row call took about 0.1 s and 100 calls about 10 s, a margin of more than 100x below 60s
-- for a slower host, wider rows and concurrent load. The rule tests bound one call at 20000; half
-- of that keeps the margin and keeps what one call holds (row locks on its batch, the advisory
-- lock) short, while the worker's 100 calls per run still remove up to 1,000,000 rows per run, so a
-- backlog of millions goes within a few hourly runs. Same order as the worker's other bounded
-- deletion app.delete_expired_link_open_attempts (at most 10000 rows per call).
-- Locks per call: unchanged in kind from 0145 (advisory lock, row locks on the deleted rows,
-- RowExclusive on app.link_logs_default and app.link_log_evidence, AccessShare on what it reads); no
-- table lock on app.link_logs or app.users, no DDL. Waits bounded by the function-level lock_timeout
-- 5s; the caller bounds the statement (section P, 60s).
--
-- Compatibility: same signature, result and grants. A backlog under PURGE_BATCH behaves exactly as
-- 0145 (one call deletes it all, the next returns 0); a larger one needs several calls.
-- Recovery: no down migration. A corrective migration restores 0145's body with CREATE OR REPLACE;
-- DEFAULT rows already deleted can only be recovered from a backup (the referenced ones stay in
-- app.link_log_evidence).
--
-- Timeouts: one function definition replaced, no lock on a table's rows; 5s lock wait and 30s overall
-- as ceilings.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.purge_expired_link_logs_default(p_now timestamptz)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET DateStyle = 'ISO, YMD'
SET TimeZone = 'UTC'
AS $$
DECLARE
  -- Most rows one call deletes (CT-13o; the reason is in the header of migration 0148).
  PURGE_BATCH CONSTANT integer := 10000;
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'purge_expired_link_logs_default: p_now is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'purge_expired_link_logs_default: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30: midnight of the supplied +08:00 calendar day minus 90 days — the same expression as
  -- app.drop_expired_day_partitions for link_logs. Rows strictly before it are expired.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- Serialise calls of this function.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.purge_expired_link_logs_default', 0));

  -- BR-ATTR-14: the referenced expired rows go to the evidence table first, in this transaction.
  -- A failing copy raises: nothing is deleted.
  PERFORM app.copy_referenced_link_logs('link_logs_default', v_cutoff, p_now);

  -- The only DELETE app.reject_link_logs_update_delete() lets through: owner (this SECURITY DEFINER
  -- function), DEFAULT partition, rows before the cutoff carried here, transaction-local and reset
  -- right after the statement.
  PERFORM set_config('couli.link_logs_default_purge_before', v_cutoff::text, true);

  -- One batch: at most PURGE_BATCH rows, picked by physical row id (id alone is not unique).
  DELETE FROM ONLY app.link_logs_default l
  WHERE l.ctid = ANY (ARRAY(
      SELECT c.ctid
      FROM ONLY app.link_logs_default c
      WHERE c.created_at < v_cutoff
        AND (
          c.id NOT IN (
            SELECT r.id
            FROM app.claim_items ci
            CROSS JOIN LATERAL unnest(ci.evidence_link_log_ids) AS r(id)
            WHERE r.id IS NOT NULL
          )
          OR c.id IN (SELECT e.id FROM app.link_log_evidence e)
        )
      LIMIT PURGE_BATCH
    ))
    AND l.created_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('couli.link_logs_default_purge_before', '', true);

  RETURN v_deleted;
END
$$;
