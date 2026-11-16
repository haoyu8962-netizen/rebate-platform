-- Up Migration
-- CT-13l: a deletion path for the expired rows of app.link_logs_default (BR-ID-30 ② link_logs 90 天,
-- 按日分区删除; BR-ATTR-14 默认值 被工单引用的记录在分区删除前复制到 link_log_evidence; orchestrator rulings
-- D10-1623, D10-1624, D10-1625, D10-1649, D10-1693, D10-1825). Day partitions are dropped whole by
-- app.drop_expired_day_partitions (0012, replaced by 0144); rows that landed in the DEFAULT partition
-- had no deletion path.
--
-- 1. app.reject_link_logs_update_delete() — the append-only guard of app.link_logs only
--    app.link_logs carries the row trigger link_logs_append_only (0006, BEFORE UPDATE OR DELETE,
--    FOR EACH ROW), cloned onto every partition; until now it ran the shared app.reject_update_delete(),
--    which the append-only triggers of audit_logs, commission_*, ledger_*, order_* and other funds
--    tables run too. That shared function is not touched here, and no other table's trigger changes.
--    This migration creates a link_logs-only trigger function and points link_logs_append_only at it
--    (CREATE OR REPLACE TRIGGER on the partitioned table: the clones on its partitions follow; name,
--    timing, events and FOR EACH ROW stay as they were). The new function:
--    - UPDATE: always rejected, exactly as before (23001 restrict_violation, same message text).
--    - DELETE: rejected the same way unless ALL four conditions hold (D10-1825 ②):
--      (i)   the row is in app.link_logs_default (TG_TABLE_SCHEMA 'app', TG_TABLE_NAME
--            'link_logs_default'): rows of a day partition never pass (those go by DROP), and a
--            DELETE through the parent reaches the trigger with the partition's name;
--      (ii)  current_user is the owner of app.purge_expired_link_logs_default(timestamptz) (read from
--            pg_proc, couli_migrator): it is current_user only inside that SECURITY DEFINER function;
--            couli_app, couli_maint, couli_payout and couli_readonly never are (they have no DELETE
--            privilege on link_logs either, so for them PostgreSQL already refuses with 42501);
--      (iii) the transaction-local setting couli.link_logs_default_purge_before is set: the purge
--            function sets it with set_config(…, true) right before its DELETE and resets it to ''
--            right after, so it is never visible once the function has returned — not even in the
--            caller's explicit transaction — and a rolled-back call (or savepoint) undoes it too;
--      (iv)  OLD.created_at is strictly before the cutoff carried in that setting (checked again by
--            the trigger, so a wider DELETE would still be refused row by row).
--      Why this is enough: any role can set a custom setting, so (iii) alone proves nothing; (ii)
--      limits the exception to the owner, and the only code running as the owner that business roles
--      can reach and that deletes link_logs rows is the purge function below (EXECUTE for couli_maint
--      only), whose DELETE is limited to the DEFAULT partition and the same cutoff. The owner itself
--      (migrations) could drop the trigger anyway, so the exception gives it nothing new.
--    - Guard kind (db/AGENTS.md rule 8): still a "no UPDATE / DELETE" trigger; the one exception is
--      the retention deletion BR-ID-30 requires.
--
-- 2. app.purge_expired_link_logs_default(p_now timestamptz) RETURNS bigint
--    Cutoff: word for word the expression app.drop_expired_day_partitions uses for link_logs —
--    00:00 (+08:00) of p_now's +08:00 calendar day − 90 days (the 90 days live only in these two
--    functions; fixed UTC+08:00, the session TimeZone changes nothing). Deletes the rows of
--    app.link_logs_default with created_at strictly before the cutoff, across every app_id, and
--    returns their number. Rows at or after the cutoff (future dates beyond the pre-created day
--    partitions included), every day partition and every other table stay as they are.
--    Order, in the caller's transaction (one statement in the worker, so one implicit transaction):
--    a transaction-level advisory lock serialises calls; app.copy_referenced_link_logs (0144, the
--    copy the partition drop uses) copies every expired DEFAULT row that some
--    claim_items.evidence_link_log_ids references (whatever the item's decision) into
--    app.link_log_evidence; then the DELETE, which also skips any expired row that is referenced
--    but has no evidence row (a reference committed between the two statements: that row stays for
--    the next run instead of being lost). A failing copy or delete raises out of the function and
--    rolls everything back. NULL p_now → 22004, non-finite → 22023, nothing copied or deleted.
--    Locks: the advisory lock, row locks on the deleted rows, RowExclusive on app.link_logs_default
--    and app.link_log_evidence, AccessShare on what it reads. No table lock on app.link_logs or
--    app.users and no DDL: link registration, opens and inserts into link_logs (DEFAULT included) go
--    on during the call. Waits are bounded by the function-level `SET lock_timeout = '5s'`, the same
--    value and form as app.drop_expired_day_partitions (0012 / 0144); on expiry 55P03 and the whole
--    call rolls back, the worker counts the failure and retries in its next run of the same day.
--    No function-level statement_timeout: 0140 / 0142 / 0144 set none on their maintenance functions,
--    and a function-level SET statement_timeout does not bound the statement that calls the function
--    (measured on PG 18: SET statement_timeout = '200ms' on a function that sleeps 1s lets it finish).
--    The bound is set by the caller instead (D10-1826): the worker's section P runs the call in a
--    short transaction after set_config('statement_timeout', '60s', true); on 57014 the whole call
--    rolls back like any other failure and the next run tries again.
--
--    Tried first and withdrawn (D10-1802 (a), withdrawn by D10-1825 after code review r1): under
--    ACCESS EXCLUSIVE on app.link_logs, DETACH the DEFAULT partition (which drops the cloned trigger),
--    delete, ATTACH it again. It restored link_logs_default's own catalogue exactly, but detaching
--    and attaching create and drop the action triggers of link_logs' two foreign keys on app.users,
--    and ATTACH takes ACCESS EXCLUSIVE on app.users while link_logs is locked — a deadlock with link
--    registration and a stall for every users reader; and the DELETE plus ATTACH's validation scan of
--    the whole partition ran under that exclusive lock without any bound.
--
-- Function settings: both plpgsql with search_path = pg_catalog, pg_temp. The purge function is
--   SECURITY DEFINER, owner couli_migrator, settings as 0012 / 0140 / 0142 / 0144 (search_path,
--   lock_timeout 5s, DateStyle, TimeZone UTC); REVOKE ALL FROM PUBLIC; EXECUTE to couli_maint only.
--   The trigger function: owner couli_migrator, REVOKE ALL FROM PUBLIC (a trigger function needs no
--   EXECUTE grant). No table grant changes.
--
-- Compatibility: link_logs keeps rejecting every UPDATE and every DELETE except the purge's; the
--   trigger keeps its name and definition apart from the function. Additive otherwise.
-- Recovery: no down migration. Stop calling the purge, then a corrective migration points
--   link_logs_append_only back at app.reject_update_delete() (CREATE OR REPLACE TRIGGER) and drops
--   the two functions; DEFAULT rows already deleted can only be recovered from a backup (the
--   referenced ones stay in app.link_log_evidence).
--
-- Timeouts: CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on app.link_logs and its partitions
-- (a catalogue change, no scan): 5s lock wait so it fails fast instead of queueing link writes; 30s
-- overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.reject_link_logs_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_before text;
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_SCHEMA = 'app' AND TG_TABLE_NAME = 'link_logs_default' THEN
    v_before := current_setting('couli.link_logs_default_purge_before', true);
    IF v_before IS NOT NULL AND v_before <> ''
      AND current_user = (
        SELECT pg_get_userbyid(p.proowner)
        FROM pg_proc p
        WHERE p.oid = to_regprocedure('app.purge_expired_link_logs_default(timestamp with time zone)')
      )
      AND OLD.created_at < v_before::timestamptz
    THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% on %.% is not allowed: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

REVOKE ALL ON FUNCTION app.reject_link_logs_update_delete() FROM PUBLIC;

CREATE OR REPLACE TRIGGER link_logs_append_only
  BEFORE UPDATE OR DELETE ON app.link_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_link_logs_update_delete();

CREATE FUNCTION app.purge_expired_link_logs_default(p_now timestamptz)
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

  DELETE FROM ONLY app.link_logs_default l
  WHERE l.created_at < v_cutoff
    AND (
      l.id NOT IN (
        SELECT r.id
        FROM app.claim_items ci
        CROSS JOIN LATERAL unnest(ci.evidence_link_log_ids) AS r(id)
        WHERE r.id IS NOT NULL
      )
      OR l.id IN (SELECT e.id FROM app.link_log_evidence e)
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('couli.link_logs_default_purge_before', '', true);

  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.purge_expired_link_logs_default(timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.purge_expired_link_logs_default(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_link_logs_default(timestamptz) TO couli_maint;
