-- Up Migration
-- CT-13f: retention cleanup of app.event_dedup (BR-ID-30 ③, events kept 90 days; orchestrator rulings
-- D10-1488 (1), D10-1500 (a)). No configuration item: the 90 days live only in the database functions,
-- and this function uses exactly the cutoff of 0140's app.drop_expired_events_day_partitions and
-- app.purge_expired_events_default — 00:00 (+08:00) of (the +08:00 calendar day of p_now − 90 days).
-- Rows with created_at strictly before the cutoff are deleted, across every app_id; the function
-- returns the number of deleted rows. The worker's daily 04:00 (+08:00) run calls, in this order,
-- the events day-partition drop, the events_default purge and then this function, so an event that
-- is still stored always keeps its dedup row (D10-1488 (1)). Should the retention ever change, one
-- migration replaces all three functions together.
--
-- Function: LANGUAGE plpgsql, SECURITY DEFINER, owner couli_migrator, fixed search_path / lock_timeout
-- / DateStyle / TimeZone like the 0140 events functions; NULL p_now → null_value_not_allowed (22004),
-- non-finite p_now → invalid_parameter_value (22023), nothing deleted in either case.
--
-- Grants (written here, ADR-0001 §4.2 #8): REVOKE ALL FROM PUBLIC; EXECUTE to couli_maint only.
-- couli_maint already holds SELECT, DELETE on app.event_dedup (0140); no table grant changes here.
--
-- Compatibility: additive (one new function); only the worker's maintenance run calls it.
-- Recovery: no down migration. Stop calling the function (remove the call from the maintenance run),
--   then apply a corrective migration (CREATE OR REPLACE or DROP FUNCTION); dedup rows already
--   deleted can only be recovered from a backup.
--
-- Timeouts: creating one function takes no lock on existing tables; 5s lock wait and 30s overall as
-- ceilings.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.purge_expired_event_dedup(p_now timestamptz)
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
    RAISE EXCEPTION 'purge_expired_event_dedup: p_now is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'purge_expired_event_dedup: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30 ③: the same cutoff as drop_expired_events_day_partitions and
  -- purge_expired_events_default — midnight of the supplied +08:00 calendar day minus 90 days.
  -- Rows strictly before it are expired.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- Served by event_dedup_created_idx; row locks held by concurrent writers are waited for at most 5s.
  DELETE FROM app.event_dedup WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.purge_expired_event_dedup(timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.purge_expired_event_dedup(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_event_dedup(timestamptz) TO couli_maint;
