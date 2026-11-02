--
-- PostgreSQL database dump
--

\restrict couli


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: pgboss; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgboss;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: job_state; Type: TYPE; Schema: pgboss; Owner: -
--

CREATE TYPE pgboss.job_state AS ENUM (
    'created',
    'retry',
    'active',
    'completed',
    'cancelled',
    'failed'
);


--
-- Name: delete_expired_deleted_identities(timestamp with time zone, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_deleted_identities(p_now timestamp with time zone, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_now and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30 ⑩: each row carries its own expiry, compared with the instant itself; no day
  -- boundary, and created_at and deleted_at do not matter.
  WITH victims AS (
    SELECT i.id
    FROM app.deleted_identities i
    WHERE i.expire_at < p_now
    ORDER BY i.expire_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.deleted_identities t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_device_registrations(timestamp with time zone, integer, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_device_registrations(p_now timestamp with time zone, p_days integer, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑱ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT d.app_id, d.user_id
    FROM app.device_registrations d
    WHERE d.created_at < v_cutoff
    ORDER BY d.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.device_registrations t
  USING victims v
  WHERE t.app_id = v.app_id AND t.user_id = v.user_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_inbox_messages(timestamp with time zone, integer, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_inbox_messages(p_now timestamp with time zone, p_days integer, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑮ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT m.message_id
    FROM app.inbox_messages m
    WHERE m.created_at < v_cutoff
    ORDER BY m.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.inbox_messages t
  USING victims v
  WHERE t.message_id = v.message_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_link_open_attempts(timestamp with time zone, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_now and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文: run day 00:00 +08:00 − 90 days).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- One bounded batch over every app_id. SKIP LOCKED: a row a writer holds is left for a
  -- later batch instead of making maintenance wait; table-level waits are capped by the
  -- function's lock_timeout.
  WITH victims AS (
    SELECT a.attempt_id
    FROM app.link_open_attempts a
    WHERE a.opened_at < v_cutoff
    ORDER BY a.opened_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.link_open_attempts t
  USING victims v
  WHERE t.attempt_id = v.attempt_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_login_logs(timestamp with time zone, integer, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_login_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- One bounded batch over every app_id. SKIP LOCKED: a row a writer holds is left for a later
  -- batch instead of making maintenance wait; table-level waits are capped by lock_timeout.
  WITH victims AS (
    SELECT l.id
    FROM app.login_logs l
    WHERE l.created_at < v_cutoff
    ORDER BY l.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.login_logs t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_notify_logs(timestamp with time zone, integer, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_notify_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ ⑯ itself: the second gate behind the configuration.
  IF p_days < 190 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_days must be between 190 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- Every channel (inbox, push, sms) has the same period.
  WITH victims AS (
    SELECT n.id
    FROM app.notify_logs n
    WHERE n.created_at < v_cutoff
    ORDER BY n.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.notify_logs t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: delete_expired_sms_send_attempts(timestamp with time zone, integer, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_sms_send_attempts(p_now timestamp with time zone, p_days integer, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ (D10-458) itself: the second gate behind the configuration.
  IF p_days < 190 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_days must be between 190 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT s.app_id, s.attempt_id
    FROM app.sms_send_attempts s
    WHERE s.created_at < v_cutoff
    ORDER BY s.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.sms_send_attempts t
  USING victims v
  WHERE t.app_id = v.app_id AND t.attempt_id = v.attempt_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: drop_expired_day_partitions(text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_table IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: p_table and p_now are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_table <> 'link_logs' THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: table "%" has no partition retention rule', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion calls before listing so each drop is reported once.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_day_partitions:' || p_table, 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  -- BR-ID-30: midnight of the supplied +08:00 calendar day minus 90 days.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ ('^' || p_table || '_p[0-9]{8}$')
    ORDER BY c.relname COLLATE "C"
  LOOP
    -- Use actual catalogue bounds, never infer age from a partition's name.
    -- DEFAULT, unbounded ranges and unfamiliar bound shapes are left untouched.
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NOT NULL AND isfinite(v_bounds[2]::timestamptz)
      AND v_bounds[2]::timestamptz <= v_cutoff THEN
      v_candidates := array_append(v_candidates, v_partition.name);
    END IF;
  END LOOP;

  -- Empty runs do not request a lock on link_logs or any of its partitions.
  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Take ALL candidate creation locks before the parent lock. Otherwise an
  -- ensure caller could hold a later candidate lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_day_partition:' || v_name, 0));
  END LOOP;

  -- Parent before children follows writer lock order; ONLY avoids unrelated and
  -- DEFAULT partitions. Every wait, including advisory locks, has a 5s bound.
  -- Do not catch 55P03: the whole statement must roll back, including earlier drops.
  EXECUTE format('LOCK TABLE ONLY app.%I IN ACCESS EXCLUSIVE MODE', p_table);

  -- Membership and actual bounds are checked again after the wait under lock.
  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text = ANY (v_candidates)
    ORDER BY c.relname COLLATE "C"
  LOOP
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT isfinite(v_bounds[2]::timestamptz) OR v_bounds[2]::timestamptz > v_cutoff THEN
      CONTINUE;
    END IF;

    -- created_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$_$;


--
-- Name: drop_expired_month_partitions(text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_latest     timestamptz;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_table IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: p_table and p_now are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Deny these names even before their tables exist. Everything else also needs an
  -- explicit retention rule below; adding a table must never implicitly enable deletion.
  IF p_table = ANY (ARRAY[
    'orders', 'order_keys', 'order_status_history', 'order_rights', 'order_settlements',
    'commission_splits', 'settle_bills', 'settle_batches', 'settle_batch_items',
    'settle_adjustments', 'claims', 'claim_items', 'ledger_vouchers', 'ledger_entries',
    'withdrawals', 'payout_attempts', 'audit_logs'
  ]) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: partitions of app.% are kept until their retention period is confirmed', p_table
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_table <> 'event_log' THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: table "%" has no partition retention rule', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion callers BEFORE inspecting the catalogue. Per-partition locks
  -- below share exactly the namespace used by ensure_month_partition.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_month_partitions:' || p_table, 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  -- A fixed transaction snapshot could hide a writer that committed while we waited
  -- for a lock. Refuse that mode rather than risk deleting a recently created row.
  -- VOLATILE + READ COMMITTED gives the post-lock statement a fresh snapshot.
  IF current_setting('transaction_isolation') = ANY (ARRAY['repeatable read', 'serializable']) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: requires read committed isolation'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone or a zone with historical DST.
  -- Subtract calendar days before converting local midnight back to an instant.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 190)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ ('^' || p_table || '_p[0-9]{4}(0[1-9]|1[0-2])$')
    ORDER BY c.relname COLLATE "C"
  LOOP
    -- Inspect the ACTUAL range, not a date inferred from the name. DEFAULT, unbounded
    -- ranges and unfamiliar bound shapes fail closed. pg_get_expr emits timestamptz
    -- values with their offsets, so parsing them preserves the actual boundary.
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NOT NULL AND isfinite(v_bounds[2]::timestamptz)
      AND v_bounds[2]::timestamptz <= v_cutoff THEN
      -- Read-only preflight: a recent row already rules out deletion, so do not
      -- queue an exclusive parent lock for this partition. Recheck under lock below
      -- because concurrent writers may commit after this snapshot.
      -- max() is answered from the end of the created_at index (one probe, no
      -- statistics needed); NULL means an empty partition.
      EXECUTE format('SELECT max(created_at) FROM app.%I', v_partition.name) INTO v_latest;
      IF v_latest IS NULL OR v_latest < v_cutoff THEN
        v_candidates := array_append(v_candidates, v_partition.name);
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Acquire all creation locks before taking exclusive relation locks: otherwise an ensure
  -- caller could hold a later partition's advisory lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));
  END LOOP;

  -- DROP also needs the parent's exclusive lock. Take it before child locks to avoid
  -- deadlocking writers that lock the parent first and then route into a child.
  -- ONLY avoids recursively locking unrelated/default partitions.
  -- Every lock wait is bounded by the function's 5s lock_timeout. Let SQLSTATE 55P03
  -- abort the statement (rolling back all its drops); the worker logs one failure
  -- and retries on its next run, without leaving a queued exclusive lock behind.
  EXECUTE format('LOCK TABLE ONLY app.%I IN ACCESS EXCLUSIVE MODE', p_table);

  -- Re-list after waiting, checking membership and bounds again under the parent lock.
  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text = ANY (v_candidates)
    ORDER BY c.relname COLLATE "C"
  LOOP
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT isfinite(v_bounds[2]::timestamptz) OR v_bounds[2]::timestamptz > v_cutoff THEN
      CONTINUE;
    END IF;

    EXECUTE format('LOCK TABLE app.%I IN ACCESS EXCLUSIVE MODE', v_partition.name);
    -- Separate statement AFTER lock acquisition: includes writers that committed while
    -- we waited. Equality keeps the entire partition; never delete individual rows.
    -- Same index-end probe as the preflight, so the exclusive lock is held only briefly.
    EXECUTE format('SELECT max(created_at) FROM app.%I', v_partition.name) INTO v_latest;
    IF v_latest IS NULL OR v_latest < v_cutoff THEN
      EXECUTE format('DROP TABLE app.%I', v_partition.name);
      v_dropped := array_append(v_dropped, v_partition.name);
    END IF;
  END LOOP;

  RETURN v_dropped;
END
$_$;


--
-- Name: drop_expired_union_raw_payload_partitions(timestamp with time zone, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.drop_expired_union_raw_payload_partitions(p_now timestamp with time zone, p_days integer) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_now IS NULL OR p_days IS NULL THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_now and p_days are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑦ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion calls before listing so each drop is reported once.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_union_raw_payload_partitions', 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'union_raw_payloads' AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: app.union_raw_payloads is not a partitioned table'
      USING ERRCODE = 'undefined_table';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ '^union_raw_payloads_p[0-9]{4}(0[1-9]|1[0-2])$'
    ORDER BY c.relname COLLATE "C"
  LOOP
    -- Use actual catalogue bounds, never infer age from a partition's name.
    -- DEFAULT, unbounded ranges and unfamiliar bound shapes are left untouched.
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NOT NULL AND isfinite(v_bounds[2]::timestamptz)
      AND v_bounds[2]::timestamptz <= v_cutoff THEN
      v_candidates := array_append(v_candidates, v_partition.name);
    END IF;
  END LOOP;

  -- Empty runs request no table lock: the hourly runs after 04:00 must not queue ahead of writers.
  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Take ALL candidate creation locks before the parent lock. Otherwise an ensure
  -- caller could hold a later candidate lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));
  END LOOP;

  -- Parent before children follows writer lock order; ONLY avoids the DEFAULT partition and
  -- the partitions that stay. Every wait, including advisory locks, has a 5s bound.
  -- Do not catch 55P03: the whole statement must roll back, including earlier drops.
  LOCK TABLE ONLY app.union_raw_payloads IN ACCESS EXCLUSIVE MODE;

  -- Membership and actual bounds are checked again after the wait under lock.
  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text = ANY (v_candidates)
    ORDER BY c.relname COLLATE "C"
  LOOP
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT isfinite(v_bounds[2]::timestamptz) OR v_bounds[2]::timestamptz > v_cutoff THEN
      CONTINUE;
    END IF;

    -- fetched_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$_$;


--
-- Name: ensure_day_partition(text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_day_partition(p_table text, p_day date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
  v_name   text;
  v_parent oid;
  v_child  oid;
  v_start  timestamptz;
  v_end    timestamptz;
BEGIN
  IF p_table IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'ensure_day_partition: p_table and p_day are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Extend only in a migration that adds another day-partitioned table.
  IF p_table <> 'link_logs' THEN
    RAISE EXCEPTION 'ensure_day_partition: table "%" is not day-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT isfinite(p_day) OR p_day < DATE '2000-01-01' OR p_day > DATE '9999-12-31' THEN
    RAISE EXCEPTION 'ensure_day_partition: p_day must be between 2000-01-01 and 9999-12-31'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_name := p_table || '_p' || to_char(p_day::timestamp, 'YYYYMMDD');

  -- Share this transaction lock with deletion. Catalogue queries after the wait
  -- see a preceding caller's committed DDL under READ COMMITTED.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_day_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_day_partition: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT c.oid INTO v_child
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = v_name;
  IF v_child IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = v_child AND i.inhparent = v_parent
    ) THEN
      -- No DDL or relation lock when the requested partition already exists.
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_day_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  -- Add a calendar day before converting to an instant, including 9999-12-31's
  -- upper boundary. Fixed offsets avoid session time zones and historical DST.
  v_start := p_day::timestamp AT TIME ZONE INTERVAL '8 hours';
  v_end := (p_day + 1)::timestamp AT TIME ZONE INTERVAL '8 hours';

  -- PostgreSQL checks DEFAULT rows and clones constraints/indexes/triggers.
  -- Propagate 23514 unchanged if DEFAULT contains rows of this day. All waits
  -- (advisory, parent, DEFAULT and referenced tables) are bounded by 5s; 55P03
  -- aborts the statement and releases its locks without a partial creation.
  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name, p_table, v_start, v_end
  );

  RETURN v_name;
END
$$;


--
-- Name: ensure_month_partition(text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_month_partition(p_table text, p_month date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_name   text;
  v_parent oid;
  v_child  oid;
BEGIN
  IF p_table IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: p_table and p_month are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Allow-list of month-partitioned tables (ADR-0001 §4.2 #5). Extend it in the migration
  -- that creates the next partitioned table.
  IF p_table NOT IN ('event_log', 'orders', 'union_raw_payloads', 'price_snapshot', 'ledger_entries') THEN
    RAISE EXCEPTION 'ensure_month_partition: table "%" is not month-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- date -> timestamp (without time zone) casts keep every step independent of the session
  -- time zone.
  v_start := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  v_end   := (v_start + interval '1 month')::date;
  v_name  := p_table || '_p' || to_char(v_start::timestamp, 'YYYYMM');

  -- Serialise concurrent callers for the same partition.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT c.oid INTO v_child
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = v_name;
  IF v_child IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = v_child AND i.inhparent = v_parent
    ) THEN
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_month_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name,
    p_table,
    to_char(v_start::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00'
  );

  RETURN v_name;
END
$$;


--
-- Name: partition_default_rows(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.partition_default_rows() RETURNS TABLE(table_name text, default_partition text, row_count bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_partition record;
BEGIN
  -- Discover every app DEFAULT partition, including tables added by later migrations.
  -- Count real rows (not pg_class estimates); return counts only, never row contents.
  FOR v_partition IN
    SELECT p.relname::text AS parent_name, d.relname::text AS child_name,
      dn.nspname::text AS child_schema
    FROM pg_partitioned_table pt
    JOIN pg_class p ON p.oid = pt.partrelid
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN pg_class d ON d.oid = pt.partdefid
    JOIN pg_namespace dn ON dn.oid = d.relnamespace
    WHERE pn.nspname = 'app'
    ORDER BY p.relname COLLATE "C"
  LOOP
    table_name := v_partition.parent_name;
    default_partition := v_partition.child_name;
    EXECUTE format('SELECT count(*) FROM %I.%I',
      v_partition.child_schema, v_partition.child_name) INTO row_count;
    RETURN NEXT;
  END LOOP;
END
$$;


--
-- Name: pay_orders_reject_immutable_update(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.pay_orders_reject_immutable_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.app_id IS DISTINCT FROM OLD.app_id
    OR NEW.out_trade_no IS DISTINCT FROM OLD.out_trade_no
    OR NEW.amount_fen IS DISTINCT FROM OLD.amount_fen
    OR NEW.pay_channel IS DISTINCT FROM OLD.pay_channel
    OR NEW.biz_type IS DISTINCT FROM OLD.biz_type
    OR NEW.biz_ref IS DISTINCT FROM OLD.biz_ref
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  THEN
    RAISE EXCEPTION 'pay_orders out_trade_no, amount_fen, pay_channel, biz_type, biz_ref and user_id cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: pay_refunds_reject_immutable_update(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.pay_refunds_reject_immutable_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.app_id IS DISTINCT FROM OLD.app_id
    OR NEW.out_refund_no IS DISTINCT FROM OLD.out_refund_no
    OR NEW.amount_fen IS DISTINCT FROM OLD.amount_fen
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
  THEN
    RAISE EXCEPTION 'pay_refunds out_refund_no, amount_fen, target_type and target_id cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: payout_accounts_reject_identifier_update(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.payout_accounts_reject_identifier_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF OLD.anonymized_at IS NOT NULL
    AND NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at
  THEN
    RAISE EXCEPTION 'payout_accounts anonymized_at cannot be changed once set'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL)
    AND (
      NEW.alipay_logon_id_cipher IS DISTINCT FROM OLD.alipay_logon_id_cipher
      OR NEW.alipay_hmac IS DISTINCT FROM OLD.alipay_hmac
      OR NEW.bank_card_no_cipher IS DISTINCT FROM OLD.bank_card_no_cipher
      OR NEW.bank_card_hmac IS DISTINCT FROM OLD.bank_card_hmac
      OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
      OR NEW.card_bin IS DISTINCT FROM OLD.card_bin
      OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
    )
  THEN
    RAISE EXCEPTION 'payout_accounts account columns can only change in the anonymizing update'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: payout_attempts_complete_once(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.payout_attempts_complete_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout_attempts rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.result <> 'pending' THEN
    RAISE EXCEPTION 'payout_attempts: a settled attempt never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.result = 'pending' THEN
    RAISE EXCEPTION 'payout_attempts: completing an attempt needs a settled result' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.app_id IS DISTINCT FROM OLD.app_id
     OR NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.request IS DISTINCT FROM OLD.request OR NEW.at IS DISTINCT FROM OLD.at THEN
    RAISE EXCEPTION 'payout_attempts: only the completion columns may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: read_retention_settings(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.read_retention_settings(p_app_id text) RETURNS TABLE(key text, value jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.key, c.value
  FROM app.config_items c
  WHERE c.app_id = p_app_id AND starts_with(c.key, 'retention.')
$$;


--
-- Name: reject_agent_card_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_card_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'data'::text - 'fallback_text'::text)
      IS DISTINCT FROM (to_jsonb(OLD) - 'data'::text - 'fallback_text'::text)
    OR (NEW.data IS DISTINCT FROM OLD.data AND NEW.data IS DISTINCT FROM '{}'::jsonb)
    OR (NEW.fallback_text IS DISTINCT FROM OLD.fallback_text
        AND NEW.fallback_text IS DISTINCT FROM '内容已删除'::text)
  THEN
    RAISE EXCEPTION 'agent_cards only permits clearing data to {} and fallback_text to the placeholder'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_agent_result_chain_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_result_chain_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'conditions'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'conditions'::text)
    OR (NEW.conditions IS DISTINCT FROM OLD.conditions
        AND NEW.conditions IS DISTINCT FROM jsonb_build_object('chain_id', OLD.chain_id))
  THEN
    RAISE EXCEPTION 'agent_result_chains only permits clearing conditions to its chain_id'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_agent_result_delivery_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_result_delivery_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'card'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'card'::text)
    OR (NEW.card IS DISTINCT FROM OLD.card AND NEW.card IS DISTINCT FROM '{}'::jsonb)
  THEN
    RAISE EXCEPTION 'agent_result_deliveries only permits clearing card to {}'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_agent_result_set_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_result_set_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'conditions'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'conditions'::text)
    OR (NEW.conditions IS DISTINCT FROM OLD.conditions
        AND NEW.conditions IS DISTINCT FROM '{}'::jsonb)
  THEN
    RAISE EXCEPTION 'agent_result_sets only permits clearing conditions to {}'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_agent_run_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_run_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.session_id, NEW.prompt_version, NEW.accepted_at,
         NEW.created_at, NEW.deadline_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.session_id, OLD.prompt_version, OLD.accepted_at,
          OLD.created_at, OLD.deadline_at)
    OR (NEW.quota_subjects IS DISTINCT FROM OLD.quota_subjects
        AND NOT COALESCE(
          array_ndims(NEW.quota_subjects) = 1
          AND cardinality(NEW.quota_subjects) = cardinality(OLD.quota_subjects)
          AND array_lower(NEW.quota_subjects, 1) = array_lower(OLD.quota_subjects, 1)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(OLD.quota_subjects, NEW.quota_subjects) AS s(old_subject, new_subject)
            WHERE old_subject IS DISTINCT FROM new_subject
              AND NOT COALESCE(
                old_subject ~ '^\["member","[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\]$'
                AND new_subject ~ '^\["member","[0-9a-f]{64}"\]$',
                false)
          ),
          false))
    OR (OLD.final_event IS NOT NULL
        AND NEW.final_event IS DISTINCT FROM OLD.final_event
        AND NOT CASE
          WHEN jsonb_typeof(OLD.final_event) = 'object'
            AND jsonb_typeof(NEW.final_event) = 'object'
            AND jsonb_typeof(OLD.final_event -> 'data') = 'object'
            AND jsonb_typeof(NEW.final_event -> 'data') = 'object'
          THEN COALESCE(
            (NEW.final_event - 'data'::text) = (OLD.final_event - 'data'::text)
            AND ((NEW.final_event -> 'data') - 'msg'::text - 'fallback_q'::text)
              = ((OLD.final_event -> 'data') - 'msg'::text - 'fallback_q'::text)
            AND ((NEW.final_event -> 'data') ? 'msg'::text)
              = ((OLD.final_event -> 'data') ? 'msg'::text)
            AND ((NEW.final_event -> 'data') ? 'fallback_q'::text)
              = ((OLD.final_event -> 'data') ? 'fallback_q'::text)
            AND COALESCE(
              (NEW.final_event -> 'data' -> 'msg') = (OLD.final_event -> 'data' -> 'msg')
              OR (NEW.final_event -> 'data' -> 'msg') = 'null'::jsonb,
              true)
            AND COALESCE(
              (NEW.final_event -> 'data' -> 'fallback_q') = (OLD.final_event -> 'data' -> 'fallback_q')
              OR (NEW.final_event -> 'data' -> 'fallback_q') = 'null'::jsonb,
              true),
            false)
          ELSE false
        END)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
    OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
    OR (OLD.settle_result IS NOT NULL AND NEW.settle_result IS DISTINCT FROM OLD.settle_result)
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (OLD.card_delivered AND NOT NEW.card_delivered)
    OR (OLD.settle_result IS NOT NULL AND NEW.card_delivered IS DISTINCT FROM OLD.card_delivered)
    OR (NEW.user_text IS NOT NULL AND NEW.user_text IS DISTINCT FROM OLD.user_text)
    OR (OLD.end_draft IS NOT NULL
        AND NEW.end_draft IS DISTINCT FROM OLD.end_draft
        AND NOT CASE
          WHEN jsonb_typeof(OLD.end_draft) = 'object'
            AND jsonb_typeof(NEW.end_draft) = 'object'
            AND jsonb_typeof(OLD.end_draft -> 'data') = 'object'
            AND jsonb_typeof(NEW.end_draft -> 'data') = 'object'
          THEN COALESCE(
            (NEW.end_draft - 'data'::text) = (OLD.end_draft - 'data'::text)
            AND ((NEW.end_draft -> 'data') - 'msg'::text - 'fallback_q'::text)
              = ((OLD.end_draft -> 'data') - 'msg'::text - 'fallback_q'::text)
            AND ((NEW.end_draft -> 'data') ? 'msg'::text)
              = ((OLD.end_draft -> 'data') ? 'msg'::text)
            AND ((NEW.end_draft -> 'data') ? 'fallback_q'::text)
              = ((OLD.end_draft -> 'data') ? 'fallback_q'::text)
            AND COALESCE(
              (NEW.end_draft -> 'data' -> 'msg') = (OLD.end_draft -> 'data' -> 'msg')
              OR (NEW.end_draft -> 'data' -> 'msg') = 'null'::jsonb,
              true)
            AND COALESCE(
              (NEW.end_draft -> 'data' -> 'fallback_q') = (OLD.end_draft -> 'data' -> 'fallback_q')
              OR (NEW.end_draft -> 'data' -> 'fallback_q') = 'null'::jsonb,
              true),
            false)
          ELSE false
        END)
    OR (OLD.cancel_requested_at IS NOT NULL
        AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  THEN
    RAISE EXCEPTION 'agent_runs ending facts are write-once except text redaction, user_text may only be cleared and quota_subjects only hash a member'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$_$;


--
-- Name: reject_agent_session_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_session_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.device_id, NEW.started_at, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.device_id, OLD.started_at, OLD.created_at)
    OR NEW.card_seq < OLD.card_seq
    OR (
      NEW.user_id IS DISTINCT FROM OLD.user_id
      AND NOT (
        OLD.user_id IS NOT NULL
        AND NEW.user_id IS NULL
        AND NEW.user_hash IS NOT NULL
        AND NEW.user_hash ~ '^[0-9a-f]{64}$'
      )
    )
    OR (OLD.user_id IS NULL AND NEW.user_hash IS DISTINCT FROM OLD.user_hash)
  THEN
    RAISE EXCEPTION 'agent_sessions owner is immutable except one-way detachment with a user hash, and card_seq never decreases'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$_$;


--
-- Name: reject_agent_tool_call_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_tool_call_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'args'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'args'::text)
    OR NEW.args IS NOT NULL
  THEN
    RAISE EXCEPTION 'agent_tool_calls only permits clearing args to NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_device_registration_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_device_registration_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF OLD.merged_into_user_id IS NOT NULL
    OR NEW.merged_into_user_id IS NULL
    OR ROW(NEW.app_id, NEW.device_hash, NEW.user_id, NEW.register_method, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.app_id, OLD.device_hash, OLD.user_id, OLD.register_method, OLD.created_at)
  THEN
    RAISE EXCEPTION 'device_registrations only permits setting an empty merge target once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_open_attempt_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_open_attempt_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.app_id, NEW.link_id, NEW.user_id, NEW.opened_at)
      IS DISTINCT FROM
      ROW(OLD.attempt_id, OLD.app_id, OLD.link_id, OLD.user_id, OLD.opened_at)
    OR (OLD.jump_reported_at IS NOT NULL
      AND NEW.jump_reported_at IS DISTINCT FROM OLD.jump_reported_at)
    OR (OLD.dismissed_at IS NOT NULL
      AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at)
  THEN
    RAISE EXCEPTION 'link_open_attempts identity is immutable and timestamps are write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_promo_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_promo_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (OLD.promo_url IS NOT NULL AND NEW.promo_url IS DISTINCT FROM OLD.promo_url)
    OR (OLD.promo_url_fetched_at IS NOT NULL
      AND NEW.promo_url_fetched_at IS DISTINCT FROM OLD.promo_url_fetched_at)
  THEN
    RAISE EXCEPTION 'links promotion link is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_quote_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_quote_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.link_id) IS DISTINCT FROM ROW(OLD.app_id, OLD.link_id)
    OR (OLD.quoted_final_price_fen IS NOT NULL
      AND NEW.quoted_final_price_fen IS DISTINCT FROM OLD.quoted_final_price_fen)
    OR (OLD.quoted_coupon_fen IS NOT NULL
      AND NEW.quoted_coupon_fen IS DISTINCT FROM OLD.quoted_coupon_fen)
    OR (OLD.quoted_coupon_id IS NOT NULL
      AND NEW.quoted_coupon_id IS DISTINCT FROM OLD.quoted_coupon_id)
    OR (OLD.quoted_at IS NOT NULL
      AND ROW(NEW.quoted_final_price_fen, NEW.quoted_coupon_fen, NEW.quoted_coupon_id, NEW.quoted_at)
        IS DISTINCT FROM
        ROW(OLD.quoted_final_price_fen, OLD.quoted_coupon_fen, OLD.quoted_coupon_id, OLD.quoted_at))
  THEN
    RAISE EXCEPTION 'links identity and written quote snapshot are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_order_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_order_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.order_id, NEW.app_id, NEW.platform, NEW.sub_order_id, NEW.attr_at)
      IS DISTINCT FROM
      ROW(OLD.order_id, OLD.app_id, OLD.platform, OLD.sub_order_id, OLD.attr_at)
    OR (OLD.product_key IS NOT NULL AND NEW.product_key IS DISTINCT FROM OLD.product_key)
    OR (OLD.settle_period IS NOT NULL AND NEW.settle_period IS DISTINCT FROM OLD.settle_period)
    OR (OLD.credit_requires_settle AND NOT NEW.credit_requires_settle)
  THEN
    RAISE EXCEPTION 'orders identity, written product/period and settlement requirement cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_product_ref_key_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_product_ref_key_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.product_key, NEW.platform)
    IS DISTINCT FROM ROW(OLD.app_id, OLD.product_key, OLD.platform)
  THEN
    RAISE EXCEPTION 'product_refs identity (app_id, product_key, platform) is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_rule_chunk_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_rule_chunk_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.chunk_id, NEW.app_id, NEW.article_id, NEW.published_version, NEW.seq, NEW.title,
         NEW."text", NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.chunk_id, OLD.app_id, OLD.article_id, OLD.published_version, OLD.seq, OLD.title,
          OLD."text", OLD.created_at)
    OR NOT (
      (
        NEW.status IS NOT DISTINCT FROM OLD.status
        AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at
      )
      OR (
        OLD.status = 'active'
        AND OLD.retired_at IS NULL
        AND NEW.status = 'retired'
        AND NEW.retired_at IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'agent_rule_chunks content is immutable; status may only go active -> retired together with retired_at'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_union_auth_session_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_union_auth_session_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.state, NEW.app_id, NEW.user_id, NEW.device_id, NEW.platform, NEW.mode,
         NEW.link_id, NEW.expire_at, NEW.created_at, NEW.client, NEW.auth_methods,
         NEW.auth_app_refs)
      IS DISTINCT FROM
      ROW(OLD.state, OLD.app_id, OLD.user_id, OLD.device_id, OLD.platform, OLD.mode,
          OLD.link_id, OLD.expire_at, OLD.created_at, OLD.client, OLD.auth_methods,
          OLD.auth_app_refs)
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
  THEN
    RAISE EXCEPTION 'union_auth_sessions are immutable and used_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_union_binding_conflict_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_union_binding_conflict_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.user_id, NEW.platform, NEW.union_account_id, NEW.kind,
         NEW.occurred_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.user_id, OLD.platform, OLD.union_account_id, OLD.kind,
          OLD.occurred_at)
    OR ((OLD.resolved_at IS NOT NULL OR OLD.resolution IS NOT NULL)
      AND ROW(NEW.resolved_at, NEW.resolution) IS DISTINCT FROM ROW(OLD.resolved_at, OLD.resolution))
  THEN
    RAISE EXCEPTION 'union_binding_conflicts are immutable and resolve at most once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_update_delete(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_update_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;


--
-- Name: create_queue(text, jsonb); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          pgboss.job_now(),
          pgboss.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $_$;


--
-- Name: delete_queue(text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$;


--
-- Name: job_now(); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_now() RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
      SELECT pg_catalog.now();
    $$;


--
-- Name: job_table_format(text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_format(command text, table_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $_$;


--
-- Name: job_table_run(text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$;


--
-- Name: job_table_run_async(text, integer, text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run_async(command_name text, version integer, command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_balances; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.account_balances (
    app_id text NOT NULL,
    account_id uuid NOT NULL,
    available_fen bigint NOT NULL,
    frozen_fen bigint NOT NULL,
    negative_since date,
    version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_balances_frozen_fen_check CHECK ((frozen_fen >= 0)),
    CONSTRAINT account_balances_version_check CHECK ((version >= 0))
);


--
-- Name: admin_permissions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.admin_permissions (
    id bigint NOT NULL,
    app_id text NOT NULL,
    admin_id uuid NOT NULL,
    permission_key text NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_permissions_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.admin_permissions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.admin_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: admin_union_auth_sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.admin_union_auth_sessions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    union_account_id uuid NOT NULL,
    state_hash bytea NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT admin_union_auth_sessions_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT admin_union_auth_sessions_lifecycle_check CHECK ((((status = 'pending'::text) AND (finished_at IS NULL) AND (error IS NULL)) OR ((status = 'succeeded'::text) AND (used_at IS NOT NULL) AND (finished_at IS NOT NULL) AND (error IS NULL)) OR ((status = 'failed'::text) AND (used_at IS NOT NULL) AND (finished_at IS NOT NULL) AND (error IS NOT NULL)) OR ((status = 'expired'::text) AND (used_at IS NULL) AND (finished_at IS NOT NULL)))),
    CONSTRAINT admin_union_auth_sessions_state_hash_check CHECK ((octet_length(state_hash) = 32)),
    CONSTRAINT admin_union_auth_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: admin_users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.admin_users (
    id uuid NOT NULL,
    app_id text NOT NULL,
    login_name text NOT NULL,
    password_hash text NOT NULL,
    totp_secret_cipher bytea,
    totp_bound_at timestamp with time zone,
    totp_last_step bigint,
    is_super boolean NOT NULL,
    status text NOT NULL,
    verify_phone_cipher bytea,
    verify_phone_hmac text,
    verify_phone_set_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    password_must_change boolean DEFAULT false NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    display_name text,
    CONSTRAINT admin_users_display_name_len_check CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 32)))),
    CONSTRAINT admin_users_failed_login_count_check CHECK ((failed_login_count >= 0))
);


--
-- Name: agent_cards; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_cards (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid NOT NULL,
    card_id text NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    link_id uuid,
    schema_version integer NOT NULL,
    fallback_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_cards_card_id_check CHECK ((card_id ~ '^c[1-9][0-9]*$'::text)),
    CONSTRAINT agent_cards_data_check CHECK ((jsonb_typeof(data) = 'object'::text)),
    CONSTRAINT agent_cards_earnings_no_amount_check CHECK (
CASE
    WHEN (type <> 'earnings_summary'::text) THEN true
    WHEN (jsonb_typeof(data) = 'object'::text) THEN (((data - 'as_of'::text) - 'actions'::text) = '{}'::jsonb)
    ELSE false
END),
    CONSTRAINT agent_cards_fallback_text_check CHECK ((fallback_text <> ''::text)),
    CONSTRAINT agent_cards_schema_version_check CHECK ((schema_version >= 1)),
    CONSTRAINT agent_cards_type_check CHECK ((type = ANY (ARRAY['product_list'::text, 'rebate_quote'::text, 'order_status'::text, 'claim_draft'::text, 'handoff'::text, 'auth_required'::text, 'notice'::text, 'rule_ref'::text, 'page_guide'::text, 'earnings_summary'::text])))
);


--
-- Name: agent_clarify_asks; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_clarify_asks (
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    chain_id text NOT NULL,
    slot text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_clarify_asks_chain_id_check CHECK ((chain_id <> ''::text)),
    CONSTRAINT agent_clarify_asks_slot_check CHECK ((slot = ANY (ARRAY['reference'::text, 'price'::text, 'platform'::text])))
);


--
-- Name: agent_messages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_messages (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    client_msg_id text,
    role text NOT NULL,
    text text,
    card_ids text[] DEFAULT '{}'::text[] NOT NULL,
    feedback text,
    feedback_at timestamp with time zone,
    reported boolean DEFAULT false NOT NULL,
    report_reason text,
    reported_at timestamp with time zone,
    report_status text,
    report_handler_id uuid,
    report_handled_at timestamp with time zone,
    report_note text,
    badcase boolean DEFAULT false NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_messages_assistant_client_check CHECK (((role <> 'assistant'::text) OR (client_msg_id IS NULL))),
    CONSTRAINT agent_messages_card_ids_check CHECK (
CASE
    WHEN (cardinality(card_ids) = 0) THEN true
    WHEN (array_ndims(card_ids) = 1) THEN
    CASE
        WHEN (array_position(card_ids, NULL::text) IS NULL) THEN ((array_to_string(card_ids, ','::text) ~ '^c[1-9][0-9]*(,c[1-9][0-9]*)*$'::text) AND (cardinality(string_to_array(array_to_string(card_ids, ','::text), ','::text)) = cardinality(card_ids)))
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_messages_down_badcase_check CHECK (((feedback IS DISTINCT FROM 'down'::text) OR badcase)),
    CONSTRAINT agent_messages_feedback_check CHECK ((feedback = ANY (ARRAY['up'::text, 'down'::text]))),
    CONSTRAINT agent_messages_feedback_pair_check CHECK (((feedback IS NULL) = (feedback_at IS NULL))),
    CONSTRAINT agent_messages_report_handled_check CHECK ((((NOT (report_status IS DISTINCT FROM 'handled'::text)) = (report_handled_at IS NOT NULL)) AND ((NOT (report_status IS DISTINCT FROM 'handled'::text)) = (report_handler_id IS NOT NULL)))),
    CONSTRAINT agent_messages_report_status_check CHECK ((report_status = ANY (ARRAY['pending'::text, 'handled'::text]))),
    CONSTRAINT agent_messages_report_status_pair_check CHECK ((reported = (report_status IS NOT NULL))),
    CONSTRAINT agent_messages_reported_pair_check CHECK ((reported = (reported_at IS NOT NULL))),
    CONSTRAINT agent_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT agent_messages_user_keys_check CHECK (((role <> 'user'::text) OR ((client_msg_id IS NOT NULL) AND (run_id IS NOT NULL)))),
    CONSTRAINT agent_messages_user_no_feedback_check CHECK (((role <> 'user'::text) OR ((feedback IS NULL) AND (feedback_at IS NULL) AND (NOT reported))))
);


--
-- Name: agent_result_chains; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_result_chains (
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    chain_id text NOT NULL,
    status text NOT NULL,
    conditions jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_result_chains_chain_id_check CHECK ((chain_id <> ''::text)),
    CONSTRAINT agent_result_chains_conditions_check CHECK (((conditions IS NULL) OR COALESCE(
CASE
    WHEN (jsonb_typeof(conditions) = 'object'::text) THEN ((jsonb_typeof((conditions -> 'chain_id'::text)) = 'string'::text) AND ((conditions ->> 'chain_id'::text) = chain_id))
    ELSE false
END, false))),
    CONSTRAINT agent_result_chains_has_products_check CHECK (((status <> 'has_products'::text) OR (conditions IS NOT NULL))),
    CONSTRAINT agent_result_chains_seq_check CHECK ((seq >= 1)),
    CONSTRAINT agent_result_chains_status_check CHECK ((status = ANY (ARRAY['searching'::text, 'awaiting_price'::text, 'has_products'::text])))
);


--
-- Name: agent_result_deliveries; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_result_deliveries (
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid NOT NULL,
    result_set_id uuid NOT NULL,
    "position" integer NOT NULL,
    card_id text NOT NULL,
    product_key text NOT NULL,
    platform text NOT NULL,
    final_price_fen bigint NOT NULL,
    card jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_result_deliveries_card_check CHECK ((jsonb_typeof(card) = 'object'::text)),
    CONSTRAINT agent_result_deliveries_card_id_check CHECK ((card_id ~ '^c[1-9][0-9]*$'::text)),
    CONSTRAINT agent_result_deliveries_final_price_fen_check CHECK ((final_price_fen >= 0)),
    CONSTRAINT agent_result_deliveries_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT agent_result_deliveries_position_check CHECK (("position" >= 1)),
    CONSTRAINT agent_result_deliveries_product_key_check CHECK ((product_key <> ''::text))
);


--
-- Name: agent_result_sets; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_result_sets (
    id uuid NOT NULL,
    app_id text NOT NULL,
    run_id uuid NOT NULL,
    conditions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_result_sets_conditions_check CHECK ((jsonb_typeof(conditions) = 'object'::text))
);


--
-- Name: agent_rule_chunks; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_rule_chunks (
    chunk_id uuid NOT NULL,
    app_id text NOT NULL,
    article_id uuid NOT NULL,
    published_version integer NOT NULL,
    seq integer NOT NULL,
    title text NOT NULL,
    text text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT agent_rule_chunks_published_version_check CHECK ((published_version >= 1)),
    CONSTRAINT agent_rule_chunks_retired_at_check CHECK (((status = 'retired'::text) = (retired_at IS NOT NULL))),
    CONSTRAINT agent_rule_chunks_seq_check CHECK ((seq >= 0)),
    CONSTRAINT agent_rule_chunks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text]))),
    CONSTRAINT agent_rule_chunks_text_check CHECK (((text <> ''::text) AND (char_length(text) <= 200))),
    CONSTRAINT agent_rule_chunks_title_check CHECK ((title <> ''::text))
);


--
-- Name: agent_runs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_runs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    user_text text,
    intent text,
    model text,
    model_snapshot text,
    prompt_version text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_mfen bigint,
    ttft_ms integer,
    latency_ms integer,
    finish_reason text,
    final_event jsonb,
    ended_at timestamp with time zone,
    output_filtered boolean DEFAULT false NOT NULL,
    filter_hits text[] DEFAULT '{}'::text[] NOT NULL,
    output_truncated boolean DEFAULT false NOT NULL,
    price_version text,
    result_check_provider text,
    judge_model text,
    page_guide_reject_reason text,
    accepted_at timestamp with time zone NOT NULL,
    quota_subjects text[] NOT NULL,
    end_reason text,
    card_delivered boolean DEFAULT false NOT NULL,
    settle_result text,
    settled_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone,
    end_draft jsonb,
    cancel_requested_at timestamp with time zone,
    finalize_hold text,
    finalize_hold_at timestamp with time zone,
    CONSTRAINT agent_runs_cancel_order_check CHECK ((cancel_requested_at >= accepted_at)),
    CONSTRAINT agent_runs_counts_check CHECK (((input_tokens >= 0) AND (output_tokens >= 0) AND (cost_mfen >= 0) AND (ttft_ms >= 0) AND (latency_ms >= 0))),
    CONSTRAINT agent_runs_deadline_order_check CHECK ((deadline_at >= accepted_at)),
    CONSTRAINT agent_runs_end_draft_check CHECK (((end_draft IS NULL) OR COALESCE(
CASE
    WHEN (jsonb_typeof(end_draft) = 'object'::text) THEN ((end_draft ?& ARRAY['type'::text, 'data'::text]) AND (((end_draft - 'type'::text) - 'data'::text) = '{}'::jsonb) AND (jsonb_typeof((end_draft -> 'type'::text)) = 'string'::text) AND ((end_draft ->> 'type'::text) = ANY (ARRAY['done'::text, 'error'::text])) AND (jsonb_typeof((end_draft -> 'data'::text)) = 'object'::text))
    ELSE false
END, false))),
    CONSTRAINT agent_runs_end_draft_reason_check CHECK (((end_draft IS NULL) OR (end_reason IS NOT NULL))),
    CONSTRAINT agent_runs_ended_order_check CHECK ((ended_at >= accepted_at)),
    CONSTRAINT agent_runs_filter_hits_check CHECK (
CASE
    WHEN (cardinality(filter_hits) = 0) THEN true
    WHEN (array_ndims(filter_hits) = 1) THEN
    CASE
        WHEN (array_position(filter_hits, NULL::text) IS NULL) THEN (filter_hits <@ ARRAY['amount'::text, 'url'::text, 'tpwd'::text])
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_runs_final_after_settle_check CHECK (((final_event IS NULL) OR (settle_result IS NOT NULL))),
    CONSTRAINT agent_runs_final_event_check CHECK (((final_event IS NULL) OR COALESCE(
CASE
    WHEN (jsonb_typeof(final_event) = 'object'::text) THEN ((final_event ?& ARRAY['type'::text, 'data'::text]) AND (((final_event - 'type'::text) - 'data'::text) = '{}'::jsonb) AND (jsonb_typeof((final_event -> 'type'::text)) = 'string'::text) AND ((final_event ->> 'type'::text) = ANY (ARRAY['done'::text, 'error'::text])) AND (jsonb_typeof((final_event -> 'data'::text)) = 'object'::text))
    ELSE false
END, false))),
    CONSTRAINT agent_runs_final_pair_check CHECK (((final_event IS NULL) = (ended_at IS NULL))),
    CONSTRAINT agent_runs_finalize_hold_check CHECK ((finalize_hold = ANY (ARRAY['stored_frame_invalid'::text, 'facts_inconsistent'::text]))),
    CONSTRAINT agent_runs_finalize_hold_open_check CHECK (((finalize_hold IS NULL) OR (final_event IS NULL))),
    CONSTRAINT agent_runs_finalize_hold_pair_check CHECK (((finalize_hold IS NULL) = (finalize_hold_at IS NULL))),
    CONSTRAINT agent_runs_finish_reason_check CHECK ((finish_reason = ANY (ARRAY['stop'::text, 'cancelled'::text, 'limit'::text, 'budget'::text, 'error'::text, 'auth_required'::text, 'safety'::text, 'fallback'::text, 'timeout'::text]))),
    CONSTRAINT agent_runs_intent_check CHECK ((intent = ANY (ARRAY['find_by_link'::text, 'search'::text, 'refine'::text, 'order_query'::text, 'rule_qa'::text, 'handoff'::text, 'clarify'::text, 'out_of_scope'::text, 'page_guide'::text, 'earnings_query'::text]))),
    CONSTRAINT agent_runs_output_filtered_check CHECK ((output_filtered = (cardinality(filter_hits) > 0))),
    CONSTRAINT agent_runs_page_guide_reject_reason_check CHECK ((page_guide_reject_reason = ANY (ARRAY['not_allowed'::text, 'extra_fields'::text, 'disabled'::text, 'untrusted_input'::text, 'params_requested'::text]))),
    CONSTRAINT agent_runs_quota_subjects_check CHECK (
CASE
    WHEN (array_ndims(quota_subjects) = 1) THEN
    CASE
        WHEN (array_position(quota_subjects, NULL::text) IS NULL) THEN ((cardinality(quota_subjects) >= 1) AND (cardinality(quota_subjects) <= 2))
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_runs_result_check_provider_check CHECK ((result_check_provider = ANY (ARRAY['rules'::text, 'jev'::text]))),
    CONSTRAINT agent_runs_settle_after_end_check CHECK (((settle_result IS NULL) OR (end_reason IS NOT NULL))),
    CONSTRAINT agent_runs_settle_pair_check CHECK (((settle_result IS NULL) = (settled_at IS NULL))),
    CONSTRAINT agent_runs_settle_result_check CHECK ((settle_result = ANY (ARRAY['counted'::text, 'refunded'::text])))
);


--
-- Name: agent_sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_sessions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_active_at timestamp with time zone NOT NULL,
    expired_at timestamp with time zone,
    card_seq integer DEFAULT 0 NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    run_lock_run_id uuid,
    run_lock_expires_at timestamp with time zone,
    user_hash text,
    CONSTRAINT agent_sessions_active_order_check CHECK ((last_active_at >= started_at)),
    CONSTRAINT agent_sessions_card_seq_check CHECK ((card_seq >= 0)),
    CONSTRAINT agent_sessions_expired_order_check CHECK ((expired_at > last_active_at)),
    CONSTRAINT agent_sessions_run_lock_pair_check CHECK (((run_lock_run_id IS NULL) = (run_lock_expires_at IS NULL))),
    CONSTRAINT agent_sessions_user_hash_check CHECK ((user_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: agent_tool_calls; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_tool_calls (
    id uuid NOT NULL,
    app_id text NOT NULL,
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    name text NOT NULL,
    args jsonb,
    result_digest text,
    status text NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_tool_calls_latency_check CHECK ((latency_ms >= 0)),
    CONSTRAINT agent_tool_calls_seq_check CHECK ((seq >= 1))
);


--
-- Name: agreements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agreements (
    id uuid NOT NULL,
    app_id text NOT NULL,
    type text NOT NULL,
    version integer NOT NULL,
    min_version integer NOT NULL,
    requires_resign boolean NOT NULL,
    article_id uuid NOT NULL,
    article_version integer NOT NULL,
    text_sha256 text NOT NULL,
    url text NOT NULL,
    legal_confirmed_by text NOT NULL,
    legal_confirm_note text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    published_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agreements_legal_confirm_check CHECK (((btrim(legal_confirmed_by) <> ''::text) AND (btrim(legal_confirm_note) <> ''::text))),
    CONSTRAINT agreements_min_version_check CHECK (((min_version >= 1) AND (min_version <= version))),
    CONSTRAINT agreements_requires_resign_check CHECK (
CASE
    WHEN (type = 'labor_agreement'::text) THEN (requires_resign = (min_version = version))
    ELSE (requires_resign = false)
END),
    CONSTRAINT agreements_text_sha256_check CHECK ((text_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agreements_type_check CHECK ((type = ANY (ARRAY['privacy'::text, 'agreement'::text, 'labor_agreement'::text, 'sdk_list'::text, 'collect_list'::text]))),
    CONSTRAINT agreements_url_check CHECK ((url ~ '^https://'::text)),
    CONSTRAINT agreements_version_check CHECK ((version >= 1))
);


--
-- Name: app_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.app_versions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    channel text NOT NULL,
    latest_version text NOT NULL,
    min_supported_version text,
    recommended_version text,
    update_title text NOT NULL,
    update_notes text NOT NULL,
    store_url text NOT NULL,
    default_store text NOT NULL,
    store_listings jsonb NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_versions_latest_version_check CHECK ((latest_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_min_supported_version_check CHECK ((min_supported_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'harmony'::text, 'h5'::text, 'admin'::text]))),
    CONSTRAINT app_versions_recommended_version_check CHECK ((recommended_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_store_listings_array_check CHECK ((jsonb_typeof(store_listings) = 'array'::text))
);


--
-- Name: appeal_claims; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.appeal_claims (
    id uuid NOT NULL,
    app_id text NOT NULL,
    appeal_id uuid NOT NULL,
    row_version integer NOT NULL,
    handler_id text NOT NULL,
    claimed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appeal_claims_row_version_check CHECK ((row_version >= 1))
);


--
-- Name: appeals; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.appeals (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    target_type text NOT NULL,
    request_type text,
    target_id text NOT NULL,
    related_phone_hmac text,
    prev_risk_state text,
    status text NOT NULL,
    content text NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    handler_id text,
    closed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    penalty_started_at timestamp with time zone,
    source text DEFAULT 'app'::text NOT NULL,
    registered_by text,
    CONSTRAINT appeals_account_target_check CHECK (((target_type <> 'account'::text) OR (target_id = (user_id)::text))),
    CONSTRAINT appeals_closed_check CHECK (((status = 'processing'::text) = (closed_at IS NULL))),
    CONSTRAINT appeals_handler_check CHECK (((status = 'processing'::text) OR (handler_id IS NOT NULL))),
    CONSTRAINT appeals_order_target_check CHECK (((target_type <> 'order'::text) OR (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT appeals_penalty_started_at_check CHECK (((penalty_started_at IS NULL) OR (target_type = 'account'::text))),
    CONSTRAINT appeals_prev_risk_state_check CHECK (
CASE
    WHEN (target_type = 'account'::text) THEN ((prev_risk_state IS NOT NULL) AND (prev_risk_state = ANY (ARRAY['banned'::text, 'frozen'::text])))
    ELSE (prev_risk_state IS NULL)
END),
    CONSTRAINT appeals_registered_by_check CHECK (((source = 'admin'::text) = (registered_by IS NOT NULL))),
    CONSTRAINT appeals_related_phone_check CHECK (
CASE
    WHEN (request_type = ANY (ARRAY['register'::text, 'phone_change'::text])) THEN (related_phone_hmac IS NOT NULL)
    WHEN (request_type IS NULL) THEN (related_phone_hmac IS NULL)
    ELSE true
END),
    CONSTRAINT appeals_request_check CHECK (((target_type = 'blocked_request'::text) = (request_type IS NOT NULL))),
    CONSTRAINT appeals_request_type_check CHECK ((request_type = ANY (ARRAY['register'::text, 'withdraw'::text, 'phone_change'::text, 'payout_account'::text]))),
    CONSTRAINT appeals_source_check CHECK ((source = ANY (ARRAY['app'::text, 'admin'::text]))),
    CONSTRAINT appeals_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'upheld'::text, 'revoked'::text]))),
    CONSTRAINT appeals_target_type_check CHECK ((target_type = ANY (ARRAY['account'::text, 'order'::text, 'blocked_request'::text]))),
    CONSTRAINT appeals_user_check CHECK (
CASE
    WHEN (request_type = 'register'::text) THEN (user_id IS NULL)
    ELSE (user_id IS NOT NULL)
END)
);


--
-- Name: articles; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.articles (
    id uuid NOT NULL,
    app_id text NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    published_at timestamp with time zone,
    notice_closable boolean NOT NULL,
    notice_content_version integer DEFAULT 1 NOT NULL,
    notice_end_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    help_section text,
    faq_rank integer,
    CONSTRAINT articles_category_check CHECK ((category = ANY (ARRAY['help'::text, 'rule'::text, 'notice'::text, 'agreement'::text]))),
    CONSTRAINT articles_faq_rank_category_check CHECK (((faq_rank IS NULL) OR (category = 'help'::text))),
    CONSTRAINT articles_faq_rank_check CHECK (((faq_rank IS NULL) OR ((faq_rank >= 1) AND (faq_rank <= 999)))),
    CONSTRAINT articles_help_section_category_check CHECK (((help_section IS NULL) OR (category = 'help'::text))),
    CONSTRAINT articles_help_section_check CHECK (((help_section IS NULL) OR (help_section = ANY (ARRAY['getting_started'::text, 'rebate_settlement'::text, 'orders_claims'::text, 'withdraw'::text, 'invite'::text, 'account_privacy'::text])))),
    CONSTRAINT articles_notice_content_version_check CHECK ((notice_content_version >= 1)),
    CONSTRAINT articles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'offline'::text]))),
    CONSTRAINT articles_version_check CHECK ((version >= 1))
);


--
-- Name: asset_snapshot_receivables; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.asset_snapshot_receivables (
    asset_snapshot_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    union_receivable_fen bigint NOT NULL,
    CONSTRAINT asset_snapshot_receivables_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text])))
);


--
-- Name: asset_snapshots; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.asset_snapshots (
    id uuid NOT NULL,
    app_id text NOT NULL,
    snapshot_date date NOT NULL,
    total_available_positive_fen bigint NOT NULL,
    total_negative_fen bigint NOT NULL,
    total_frozen_fen bigint NOT NULL,
    total_waiting_fen bigint NOT NULL,
    total_estimated_fen bigint NOT NULL,
    waiting_comparable boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.audit_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    admin_id uuid,
    action text NOT NULL,
    target text,
    before jsonb,
    after jsonb,
    ip inet,
    at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    system_actor text,
    CONSTRAINT audit_logs_actor_check CHECK (((admin_id IS NULL) <> (system_actor IS NULL))),
    CONSTRAINT audit_logs_system_actor_check CHECK ((system_actor ~ '^system:[a-z_]+$'::text))
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.audit_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: beneficiary_credits; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.beneficiary_credits (
    beneficiary_credit_id uuid NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    kind text NOT NULL,
    opened_by text NOT NULL,
    opened_ref text NOT NULL,
    origin_ledger_type text,
    origin_sub_type text,
    split_ref text NOT NULL,
    status text NOT NULL,
    closed_by text,
    closed_ref text,
    voucher_id uuid,
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT beneficiary_credits_closed_check CHECK ((((status = 'open'::text) = (closed_by IS NULL)) AND ((status = 'open'::text) = (closed_ref IS NULL)) AND ((status = 'open'::text) = (closed_at IS NULL)) AND (closed_by <> ''::text) AND (closed_ref <> ''::text))),
    CONSTRAINT beneficiary_credits_kind_check CHECK ((kind = ANY (ARRAY['first_credit'::text, 'reassign_credit'::text, 'deferred'::text]))),
    CONSTRAINT beneficiary_credits_opened_by_check CHECK ((((kind = 'first_credit'::text) AND (opened_by = 'R5'::text)) OR ((kind = 'reassign_credit'::text) AND (opened_by = 'R14'::text)) OR ((kind = 'deferred'::text) AND (opened_by = ANY (ARRAY['R10'::text, 'R13'::text]))))),
    CONSTRAINT beneficiary_credits_opened_ref_check CHECK ((opened_ref <> ''::text)),
    CONSTRAINT beneficiary_credits_origin_check CHECK ((((kind = 'deferred'::text) = (origin_ledger_type IS NOT NULL)) AND ((kind = 'deferred'::text) = (origin_sub_type IS NOT NULL)) AND (origin_ledger_type <> ''::text) AND (origin_sub_type <> ''::text))),
    CONSTRAINT beneficiary_credits_role_check CHECK ((role = ANY (ARRAY['self'::text, 'share'::text, 'direct'::text, 'indirect'::text]))),
    CONSTRAINT beneficiary_credits_split_ref_check CHECK ((split_ref <> ''::text)),
    CONSTRAINT beneficiary_credits_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'forfeited'::text, 'voided'::text]))),
    CONSTRAINT beneficiary_credits_voided_check CHECK (((closed_by IS NULL) OR ((status = 'voided'::text) = (closed_by = ANY (ARRAY['R8'::text, 'R14'::text]))))),
    CONSTRAINT beneficiary_credits_voucher_check CHECK (((voucher_id IS NULL) OR (status = ANY (ARRAY['done'::text, 'forfeited'::text]))))
);


--
-- Name: blocklist; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.blocklist (
    id uuid NOT NULL,
    app_id text NOT NULL,
    dimension text NOT NULL,
    value_hmac text,
    value text,
    violation_type text NOT NULL,
    reason text,
    platform text,
    union_account_id uuid,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    expire_at timestamp with time zone,
    status text NOT NULL,
    created_by text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blocklist_account_expire_check CHECK (((dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) OR (expire_at IS NOT NULL))),
    CONSTRAINT blocklist_channel_check CHECK (
CASE
    WHEN (dimension = 'channel'::text) THEN ((union_account_id IS NOT NULL) AND (start_at IS NOT NULL) AND ((end_at IS NULL) OR (end_at > start_at)))
    ELSE ((union_account_id IS NULL) AND (start_at IS NULL) AND (end_at IS NULL))
END),
    CONSTRAINT blocklist_device_check CHECK (((dimension <> 'device'::text) OR (value_hmac ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT blocklist_dimension_check CHECK ((dimension = ANY (ARRAY['phone'::text, 'id_no'::text, 'alipay'::text, 'bank_card'::text, 'wechat_openid'::text, 'device'::text, 'relation_id'::text, 'order_no_suffix'::text, 'channel'::text]))),
    CONSTRAINT blocklist_order_no_suffix_check CHECK (((dimension <> 'order_no_suffix'::text) OR ((platform = 'taobao'::text) AND (char_length(value) = 6)))),
    CONSTRAINT blocklist_platform_check CHECK (((dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) = (platform IS NOT NULL))),
    CONSTRAINT blocklist_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT blocklist_storage_check CHECK (
CASE
    WHEN (dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) THEN ((value IS NOT NULL) AND (value_hmac IS NULL))
    ELSE ((value_hmac IS NOT NULL) AND (value IS NULL))
END),
    CONSTRAINT blocklist_violation_type_check CHECK ((violation_type = ANY (ARRAY['malicious_rights'::text, 'fraud_invite'::text, 'other'::text])))
);


--
-- Name: category_blocklist; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.category_blocklist (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    category_id text NOT NULL,
    keyword text,
    reason text NOT NULL,
    status text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: claim_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.claim_items (
    id uuid NOT NULL,
    app_id text NOT NULL,
    claim_id uuid NOT NULL,
    applicant_user_id uuid NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    order_id uuid NOT NULL,
    evidence text,
    evidence_link_log_ids bigint[],
    decision text,
    reject_reason text,
    decided_by uuid,
    decided_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT claim_items_decided_pair_check CHECK ((((decision IS NULL) = (decided_at IS NULL)) AND ((decision IS NOT NULL) OR (decided_by IS NULL)))),
    CONSTRAINT claim_items_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT claim_items_evidence_check CHECK ((evidence = ANY (ARRAY['strong'::text, 'weak'::text, 'none'::text]))),
    CONSTRAINT claim_items_evidence_links_check CHECK ((((evidence IS NULL) AND (evidence_link_log_ids IS NULL)) OR ((evidence IS NOT NULL) AND (evidence_link_log_ids IS NOT NULL) AND (array_position(evidence_link_log_ids, NULL::bigint) IS NULL) AND
CASE
    WHEN (evidence = 'none'::text) THEN (cardinality(evidence_link_log_ids) = 0)
    ELSE (cardinality(evidence_link_log_ids) > 0)
END))),
    CONSTRAINT claim_items_reject_reason_check CHECK ((reject_reason = ANY (ARRAY['NO_EVIDENCE'::text, 'EXPIRED_CLICK'::text, 'NOT_TRACKED'::text, 'OTHER_TLJ'::text, 'FRAUD'::text, 'OTHER'::text, 'NOT_IN_POOL'::text, 'ORDER_INVALID'::text]))),
    CONSTRAINT claim_items_reject_reason_pair_check CHECK (((NOT (decision IS DISTINCT FROM 'rejected'::text)) = (reject_reason IS NOT NULL)))
);


--
-- Name: claims; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.claims (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    order_no text NOT NULL,
    order_no_type text NOT NULL,
    paid_date date NOT NULL,
    evidence_level text,
    status text NOT NULL,
    handler_admin_id uuid,
    reason text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT claims_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['strong'::text, 'weak'::text, 'none'::text]))),
    CONSTRAINT claims_evidence_status_check CHECK ((((status = 'submitted'::text) = (evidence_level IS NULL)) AND ((status <> 'auto_matched'::text) OR (evidence_level = 'strong'::text)) AND ((status <> 'manual_review'::text) OR (evidence_level = ANY (ARRAY['weak'::text, 'none'::text]))))),
    CONSTRAINT claims_order_no_check CHECK (((order_no <> ''::text) AND (strpos(order_no, ' '::text) = 0))),
    CONSTRAINT claims_order_no_type_check CHECK ((order_no_type = ANY (ARRAY['sub'::text, 'parent'::text]))),
    CONSTRAINT claims_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'auto_matched'::text, 'manual_review'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: commission_rule_reserves; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_rule_reserves (
    rule_version_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    reserve_bp smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rule_reserves_reserve_bp_check CHECK (((reserve_bp >= 0) AND (reserve_bp <= 10000)))
);


--
-- Name: commission_rule_trials; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_rule_trials (
    trial_id uuid NOT NULL,
    app_id text NOT NULL,
    rule_version_id uuid NOT NULL,
    base_version_id uuid,
    sample_from timestamp with time zone NOT NULL,
    sample_to timestamp with time zone NOT NULL,
    sample_count integer NOT NULL,
    sample_hash text NOT NULL,
    report jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT commission_rule_trials_report_check CHECK ((jsonb_typeof(report) = 'object'::text)),
    CONSTRAINT commission_rule_trials_sample_count_check CHECK ((sample_count >= 0)),
    CONSTRAINT commission_rule_trials_sample_hash_check CHECK ((sample_hash <> ''::text)),
    CONSTRAINT commission_rule_trials_sample_window_check CHECK ((sample_from < sample_to))
);


--
-- Name: commission_rule_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_rule_versions (
    rule_version_id uuid NOT NULL,
    app_id text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    effective_from timestamp with time zone,
    indirect_enabled boolean DEFAULT false NOT NULL,
    base_version_id uuid,
    drafter_id uuid,
    publisher_id uuid,
    published_at timestamp with time zone,
    revoked_at timestamp with time zone,
    indirect_approver_id uuid,
    indirect_approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rule_versions_effective_from_check CHECK (((status = 'draft'::text) OR (effective_from IS NOT NULL))),
    CONSTRAINT commission_rule_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'revoked'::text])))
);


--
-- Name: commission_rules; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_rules (
    rule_version_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    level text NOT NULL,
    order_type text NOT NULL,
    r_own_bp smallint NOT NULL,
    r_direct_bp smallint NOT NULL,
    r_indirect_bp smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rules_level_check CHECK ((level = ANY (ARRAY['L1'::text, 'L2'::text, 'L3'::text]))),
    CONSTRAINT commission_rules_order_type_check CHECK ((order_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT commission_rules_r_direct_bp_check CHECK (((r_direct_bp >= 0) AND (r_direct_bp <= 8000))),
    CONSTRAINT commission_rules_r_indirect_bp_check CHECK (((r_indirect_bp >= 0) AND (r_indirect_bp <= 8000))),
    CONSTRAINT commission_rules_r_own_bp_check CHECK (((r_own_bp >= 0) AND (r_own_bp <= 8000)))
);


--
-- Name: commission_split_amounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_split_amounts (
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    commission_version integer NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    base_fen bigint NOT NULL,
    amount_fen bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_split_amounts_amount_fen_check CHECK (((amount_fen >= 0) AND (amount_fen <= base_fen))),
    CONSTRAINT commission_split_amounts_base_fen_check CHECK ((base_fen >= 0)),
    CONSTRAINT commission_split_amounts_commission_version_check CHECK ((commission_version >= 1)),
    CONSTRAINT commission_split_amounts_role_check CHECK ((role = ANY (ARRAY['self'::text, 'share'::text, 'direct'::text, 'indirect'::text])))
);


--
-- Name: commission_split_beneficiary_events; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_split_beneficiary_events (
    event_seq bigint NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_split_beneficiary_events_role_check CHECK ((role = ANY (ARRAY['self'::text, 'share'::text, 'direct'::text, 'indirect'::text]))),
    CONSTRAINT commission_split_beneficiary_events_status_check CHECK ((status = ANY (ARRAY['active'::text, 'held'::text, 'forfeited'::text])))
);


--
-- Name: commission_split_beneficiary_events_event_seq_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.commission_split_beneficiary_events ALTER COLUMN event_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.commission_split_beneficiary_events_event_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: commission_split_totals; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_split_totals (
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    commission_version integer NOT NULL,
    n_total_fen bigint NOT NULL,
    pre_base_deduct_fen bigint NOT NULL,
    base_fen bigint NOT NULL,
    user_share_total_fen bigint NOT NULL,
    tlj_redpacket_fen bigint,
    platform_est_profit_fen bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_split_totals_base_fen_check CHECK ((base_fen >= 0)),
    CONSTRAINT commission_split_totals_commission_version_check CHECK ((commission_version >= 1)),
    CONSTRAINT commission_split_totals_platform_est_profit_fen_check CHECK ((((tlj_redpacket_fen IS NULL) AND (platform_est_profit_fen IS NULL)) OR ((tlj_redpacket_fen IS NOT NULL) AND (platform_est_profit_fen IS NOT NULL) AND (platform_est_profit_fen = ((n_total_fen - user_share_total_fen) - tlj_redpacket_fen))))),
    CONSTRAINT commission_split_totals_pre_base_deduct_fen_check CHECK ((pre_base_deduct_fen = (n_total_fen - base_fen))),
    CONSTRAINT commission_split_totals_tlj_redpacket_fen_check CHECK (((tlj_redpacket_fen IS NULL) OR (tlj_redpacket_fen >= 0))),
    CONSTRAINT commission_split_totals_user_share_total_fen_check CHECK (((user_share_total_fen >= 0) AND (user_share_total_fen <= base_fen)))
);


--
-- Name: commission_splits; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.commission_splits (
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    rule_version_id uuid NOT NULL,
    order_type text NOT NULL,
    activity_type text,
    rebate_mode text,
    paid_at timestamp with time zone NOT NULL,
    paid_at_source text NOT NULL,
    raw_n_fen bigint NOT NULL,
    subsidy_commission_fen bigint NOT NULL,
    reserve_bp smallint NOT NULL,
    reserve_fen bigint NOT NULL,
    tlj_deduct_fen bigint NOT NULL,
    base_fen bigint NOT NULL,
    platform_retain_fen bigint NOT NULL,
    beneficiaries jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_splits_base_fen_check CHECK ((base_fen >= 0)),
    CONSTRAINT commission_splits_beneficiaries_check CHECK (((jsonb_typeof(beneficiaries) = 'array'::text) AND (beneficiaries <> '[]'::jsonb))),
    CONSTRAINT commission_splits_order_type_check CHECK ((order_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT commission_splits_paid_at_source_check CHECK ((paid_at_source = ANY (ARRAY['platform'::text, 'platform_modified'::text, 'observed'::text]))),
    CONSTRAINT commission_splits_platform_retain_fen_check CHECK (((platform_retain_fen >= 0) AND (platform_retain_fen <= base_fen))),
    CONSTRAINT commission_splits_rebate_mode_check CHECK ((rebate_mode = ANY (ARRAY['none'::text, 'normal'::text]))),
    CONSTRAINT commission_splits_reserve_bp_check CHECK (((reserve_bp >= 0) AND (reserve_bp <= 10000))),
    CONSTRAINT commission_splits_reserve_fen_check CHECK ((reserve_fen >= 0)),
    CONSTRAINT commission_splits_tlj_deduct_fen_check CHECK ((tlj_deduct_fen >= 0))
);


--
-- Name: config_item_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.config_item_versions (
    app_id text NOT NULL,
    key text NOT NULL,
    version integer NOT NULL,
    value jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_by_admin_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_item_versions_version_check CHECK ((version >= 1))
);


--
-- Name: config_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.config_items (
    app_id text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_items_version_check CHECK ((version >= 1))
);


--
-- Name: consent_records; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.consent_records (
    id bigint NOT NULL,
    app_id text NOT NULL,
    subject_type text NOT NULL,
    user_id uuid,
    device_id uuid,
    type text NOT NULL,
    version integer NOT NULL,
    channel text NOT NULL,
    accepted boolean NOT NULL,
    client_at timestamp with time zone NOT NULL,
    server_at timestamp with time zone NOT NULL,
    text_sha256 text,
    signer_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version_label text,
    CONSTRAINT consent_records_channel_check CHECK ((channel = ANY (ARRAY['first_launch'::text, 'login_page'::text, 'h5_landing'::text, 'agent_sheet'::text, 'realname_sheet'::text, 'privacy_center'::text, 'login_merge'::text, 'withdraw_flow'::text]))),
    CONSTRAINT consent_records_labor_agreement_check CHECK (((type <> 'labor_agreement'::text) OR ((subject_type = 'user'::text) AND (text_sha256 IS NOT NULL) AND (signer_snapshot IS NOT NULL) AND (device_id IS NOT NULL)))),
    CONSTRAINT consent_records_subject_check CHECK ((((subject_type = 'user'::text) AND (user_id IS NOT NULL)) OR ((subject_type = 'device'::text) AND (device_id IS NOT NULL)))),
    CONSTRAINT consent_records_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'device'::text]))),
    CONSTRAINT consent_records_type_check CHECK ((type = ANY (ARRAY['privacy'::text, 'agreement'::text, 'ai_third_party'::text, 'id_verification'::text, 'personalization'::text, 'labor_agreement'::text, 'clipboard_auto_import'::text]))),
    CONSTRAINT consent_records_version_label_check CHECK ((((type = 'clipboard_auto_import'::text) AND (subject_type = 'device'::text) AND (version_label IS NOT NULL) AND (version = 0)) OR ((type <> 'clipboard_auto_import'::text) AND (version_label IS NULL))))
);


--
-- Name: consent_records_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.consent_records ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.consent_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: daily_balances; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.daily_balances (
    app_id text NOT NULL,
    account_id uuid NOT NULL,
    sub_account text NOT NULL,
    accounting_date date NOT NULL,
    opening_fen bigint NOT NULL,
    debit_fen bigint NOT NULL,
    credit_fen bigint NOT NULL,
    closing_fen bigint NOT NULL,
    computed_at timestamp with time zone NOT NULL,
    CONSTRAINT daily_balances_credit_fen_check CHECK ((credit_fen >= 0)),
    CONSTRAINT daily_balances_debit_fen_check CHECK ((debit_fen >= 0)),
    CONSTRAINT daily_balances_sub_account_check CHECK ((sub_account = ANY (ARRAY['available'::text, 'frozen'::text])))
);


--
-- Name: deleted_identities; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.deleted_identities (
    id bigint NOT NULL,
    app_id text NOT NULL,
    reason text NOT NULL,
    phone_hmac text,
    device_hash text,
    deleted_at timestamp with time zone NOT NULL,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deleted_identities_device_hash_check CHECK (((device_hash IS NULL) OR (device_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT deleted_identities_expiry_check CHECK ((expire_at > deleted_at)),
    CONSTRAINT deleted_identities_identifier_check CHECK ((num_nonnulls(phone_hmac, device_hash) >= 1)),
    CONSTRAINT deleted_identities_phone_changed_check CHECK (((reason <> 'phone_changed'::text) OR ((phone_hmac IS NOT NULL) AND (device_hash IS NULL)))),
    CONSTRAINT deleted_identities_phone_hmac_check CHECK (((phone_hmac IS NULL) OR (phone_hmac ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT deleted_identities_reason_check CHECK ((reason = ANY (ARRAY['account_deleted'::text, 'phone_changed'::text])))
);


--
-- Name: deleted_identities_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.deleted_identities ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.deleted_identities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: deletion_requests; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.deletion_requests (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    status text NOT NULL,
    apply_at timestamp with time zone NOT NULL,
    cooling_until timestamp with time zone NOT NULL,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    processed_at timestamp with time zone,
    balance_snapshot_fen bigint NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cleaned_at timestamp with time zone,
    apple_revoke_attempts smallint DEFAULT 0 NOT NULL,
    apple_revoke_result text,
    CONSTRAINT deletion_requests_apple_revoke_attempts_check CHECK (((apple_revoke_attempts >= 0) AND (apple_revoke_attempts <= 3))),
    CONSTRAINT deletion_requests_apple_revoke_result_check CHECK ((apple_revoke_result = ANY (ARRAY['revoked'::text, 'failed'::text, 'not_applicable'::text]))),
    CONSTRAINT deletion_requests_balance_snapshot_fen_check CHECK ((balance_snapshot_fen >= 0)),
    CONSTRAINT deletion_requests_cancel_reason_check CHECK ((cancel_reason = ANY (ARRAY['user'::text, 'negative_balance'::text]))),
    CONSTRAINT deletion_requests_cancel_reason_pair_check CHECK (((status = 'cancelled'::text) = (cancel_reason IS NOT NULL))),
    CONSTRAINT deletion_requests_cancelled_at_pair_check CHECK (((status = 'cancelled'::text) = (cancelled_at IS NOT NULL))),
    CONSTRAINT deletion_requests_cooling_window_check CHECK ((cooling_until > apply_at)),
    CONSTRAINT deletion_requests_done_pair_check CHECK (((status = 'done'::text) = (processed_at IS NOT NULL))),
    CONSTRAINT deletion_requests_negative_balance_window_check CHECK (((cancel_reason IS DISTINCT FROM 'negative_balance'::text) OR (cancelled_at >= cooling_until))),
    CONSTRAINT deletion_requests_processed_after_check CHECK (((processed_at IS NULL) OR (processed_at >= cooling_until))),
    CONSTRAINT deletion_requests_status_check CHECK ((status = ANY (ARRAY['cooling'::text, 'processing'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT deletion_requests_user_cancel_window_check CHECK (((cancel_reason IS DISTINCT FROM 'user'::text) OR (cancelled_at < cooling_until)))
);


--
-- Name: device_registrations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.device_registrations (
    app_id text NOT NULL,
    device_hash text NOT NULL,
    user_id uuid NOT NULL,
    register_method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merged_into_user_id uuid
);


--
-- Name: devices; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.devices (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_hash text NOT NULL,
    id_source text NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    last_login_sid text,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    install_secret_cipher bytea NOT NULL,
    CONSTRAINT devices_device_hash_check CHECK ((device_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT devices_id_source_check CHECK ((id_source = ANY (ARRAY['idfv'::text, 'android_id'::text, 'oaid'::text, 'odid'::text]))),
    CONSTRAINT devices_install_secret_present_check CHECK (((revoked_at IS NOT NULL) OR (octet_length(install_secret_cipher) > 0)))
);


--
-- Name: dict_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.dict_items (
    app_id text NOT NULL,
    dict text NOT NULL,
    code text NOT NULL,
    version integer NOT NULL,
    text text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dict_items_dict_check CHECK ((dict ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT dict_items_version_check CHECK ((version >= 1))
);


--
-- Name: event_log; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log (
    id bigint NOT NULL,
    app_id text NOT NULL,
    event_id uuid NOT NULL,
    name text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: event_log_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log_default (
    id bigint CONSTRAINT event_log_id_not_null NOT NULL,
    app_id text CONSTRAINT event_log_app_id_not_null NOT NULL,
    event_id uuid CONSTRAINT event_log_event_id_not_null NOT NULL,
    name text CONSTRAINT event_log_name_not_null NOT NULL,
    payload jsonb CONSTRAINT event_log_payload_not_null NOT NULL,
    occurred_at timestamp with time zone CONSTRAINT event_log_occurred_at_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT event_log_created_at_not_null NOT NULL
);


--
-- Name: event_log_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.event_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: export_tasks; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.export_tasks (
    id uuid NOT NULL,
    app_id text NOT NULL,
    public_id text NOT NULL,
    resource text NOT NULL,
    filters jsonb NOT NULL,
    filters_summary text NOT NULL,
    masked boolean NOT NULL,
    created_by uuid NOT NULL,
    status text NOT NULL,
    progress integer,
    failure_reason text,
    file_name text,
    object_key text,
    row_count integer,
    generated_at timestamp with time zone,
    expires_at timestamp with time zone,
    row_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT export_tasks_audit_masked_check CHECK (((resource <> 'audit_logs'::text) OR masked)),
    CONSTRAINT export_tasks_progress_check CHECK (((progress IS NULL) OR ((progress >= 0) AND (progress <= 100)))),
    CONSTRAINT export_tasks_resource_check CHECK ((resource = ANY (ARRAY['users'::text, 'audit_logs'::text, 'tax_withdrawals'::text]))),
    CONSTRAINT export_tasks_row_count_check CHECK (((row_count IS NULL) OR (row_count >= 0))),
    CONSTRAINT export_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: favorites; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.favorites (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    product_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.idempotency_keys (
    id bigint NOT NULL,
    app_id text NOT NULL,
    subject text NOT NULL,
    user_id uuid,
    method text NOT NULL,
    path text NOT NULL,
    key text NOT NULL,
    request_hash text,
    status text NOT NULL,
    response jsonb,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_request_data_check CHECK ((((status = 'abandoned'::text) AND (request_hash IS NULL) AND (response IS NULL)) OR ((status = ANY (ARRAY['processing'::text, 'completed'::text])) AND (request_hash IS NOT NULL)))),
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: idempotency_keys_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.idempotency_keys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.idempotency_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbox_messages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.inbox_messages (
    message_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    route jsonb,
    read_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invite_reward_budgets; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.invite_reward_budgets (
    app_id text NOT NULL,
    period text NOT NULL,
    reserved_fen bigint DEFAULT 0 NOT NULL,
    granted_fen bigint DEFAULT 0 NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_reward_budgets_day_reserved_check CHECK (((period = 'total'::text) OR (reserved_fen = 0))),
    CONSTRAINT invite_reward_budgets_granted_fen_check CHECK ((granted_fen >= 0)),
    CONSTRAINT invite_reward_budgets_period_check CHECK (((period = 'total'::text) OR (period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))),
    CONSTRAINT invite_reward_budgets_reserved_fen_check CHECK ((reserved_fen >= 0))
);


--
-- Name: invite_rewards; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.invite_rewards (
    app_id text NOT NULL,
    invitee_id uuid NOT NULL,
    inviter_id uuid NOT NULL,
    amount_fen bigint NOT NULL,
    qualified_at timestamp with time zone NOT NULL,
    bind_source text NOT NULL,
    bind_ip_hmac text NOT NULL,
    trigger_order_id uuid,
    triggered_at timestamp with time zone,
    status text NOT NULL,
    inviter_result text,
    invitee_result text,
    inviter_skip_reason text,
    invitee_skip_reason text,
    void_reason text,
    inviter_voucher_id uuid,
    invitee_voucher_id uuid,
    granted_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    eligibility_days integer NOT NULL,
    CONSTRAINT invite_rewards_amount_fen_check CHECK ((amount_fen >= 0)),
    CONSTRAINT invite_rewards_bind_ip_hmac_check CHECK ((bind_ip_hmac ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT invite_rewards_bind_source_check CHECK ((bind_source = ANY (ARRAY['landing'::text, 'register'::text, 'backfill'::text]))),
    CONSTRAINT invite_rewards_eligibility_days_check CHECK ((eligibility_days >= 1)),
    CONSTRAINT invite_rewards_invitee_result_check CHECK ((invitee_result = ANY (ARRAY['granted'::text, 'skipped'::text]))),
    CONSTRAINT invite_rewards_invitee_skip_pair_check CHECK (((NOT (invitee_result IS DISTINCT FROM 'skipped'::text)) = (invitee_skip_reason IS NOT NULL))),
    CONSTRAINT invite_rewards_invitee_skip_reason_check CHECK ((invitee_skip_reason = ANY (ARRAY['same_device'::text, 'same_ip'::text, 'deleted_phone_retained'::text, 'multi_account'::text, 'risk_restricted'::text, 'deleting'::text, 'minor'::text]))),
    CONSTRAINT invite_rewards_inviter_result_check CHECK ((inviter_result = ANY (ARRAY['granted'::text, 'skipped'::text]))),
    CONSTRAINT invite_rewards_inviter_skip_pair_check CHECK (((NOT (inviter_result IS DISTINCT FROM 'skipped'::text)) = (inviter_skip_reason IS NOT NULL))),
    CONSTRAINT invite_rewards_inviter_skip_reason_check CHECK ((inviter_skip_reason = ANY (ARRAY['same_device'::text, 'same_ip'::text, 'deleted_phone_retained'::text, 'multi_account'::text, 'risk_restricted'::text, 'deleting'::text, 'minor'::text]))),
    CONSTRAINT invite_rewards_processed_results_check CHECK (((status <> 'processed'::text) OR ((inviter_result IS NOT NULL) AND (invitee_result IS NOT NULL)))),
    CONSTRAINT invite_rewards_status_check CHECK ((status = ANY (ARRAY['qualified'::text, 'deferred'::text, 'processed'::text, 'voided'::text, 'expired'::text]))),
    CONSTRAINT invite_rewards_void_pair_check CHECK (((status = 'voided'::text) = (void_reason IS NOT NULL))),
    CONSTRAINT invite_rewards_void_reason_check CHECK ((void_reason = ANY (ARRAY['relation_changed'::text, 'order_clawed_back'::text, 'order_rights'::text])))
);


--
-- Name: landing_registrations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.landing_registrations (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    ip_hmac text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT landing_registrations_ip_hmac_check CHECK ((ip_hmac ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: ledger_accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ledger_accounts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    owner_type text NOT NULL,
    owner_id text NOT NULL,
    subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_accounts_owner_id_check CHECK ((owner_id <> ''::text)),
    CONSTRAINT ledger_accounts_owner_type_check CHECK ((owner_type = ANY (ARRAY['user'::text, 'platform'::text]))),
    CONSTRAINT ledger_accounts_subject_check CHECK ((((owner_type = 'user'::text) AND (subject = 'USER_BALANCE'::text)) OR ((owner_type = 'platform'::text) AND (owner_id = 'platform'::text) AND (subject <> ''::text) AND (subject <> 'USER_BALANCE'::text))))
);


--
-- Name: ledger_entries; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ledger_entries (
    id bigint NOT NULL,
    app_id text NOT NULL,
    voucher_id uuid NOT NULL,
    account_id uuid NOT NULL,
    sub_account text NOT NULL,
    amount_fen bigint NOT NULL,
    ledger_type text NOT NULL,
    sub_type text,
    income_type text,
    balance_after_fen bigint,
    account_version bigint,
    booked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_entries_account_version_check CHECK ((account_version >= 1)),
    CONSTRAINT ledger_entries_amount_fen_check CHECK ((amount_fen <> 0)),
    CONSTRAINT ledger_entries_balance_after_check CHECK (((balance_after_fen IS NULL) = (account_version IS NULL))),
    CONSTRAINT ledger_entries_income_type_check CHECK ((income_type = ANY (ARRAY['SERVICE_FEE'::text, 'INCIDENTAL'::text]))),
    CONSTRAINT ledger_entries_ledger_type_check CHECK ((ledger_type = ANY (ARRAY['REBATE_CREDIT'::text, 'SHARE_CREDIT'::text, 'REFERRAL_CREDIT'::text, 'CLAWBACK'::text, 'SETTLE_ADJUST'::text, 'WITHDRAW_FREEZE'::text, 'WITHDRAW_PAID'::text, 'WITHDRAW_RETURN'::text, 'WITHDRAW_FEE'::text, 'TAX_WITHHOLD'::text, 'REWARD'::text, 'ADMIN_ADJUST'::text, 'BAD_DEBT_WRITEOFF'::text, 'PAY_RECEIPT'::text, 'PAY_REFUND'::text, 'PAY_ANOMALY'::text, 'PAY_FEE'::text]))),
    CONSTRAINT ledger_entries_sub_account_check CHECK ((sub_account = ANY (ARRAY['available'::text, 'frozen'::text]))),
    CONSTRAINT ledger_entries_sub_type_check CHECK ((sub_type <> ''::text))
)
PARTITION BY RANGE (booked_at);


--
-- Name: ledger_entries_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ledger_entries_default (
    id bigint CONSTRAINT ledger_entries_id_not_null NOT NULL,
    app_id text CONSTRAINT ledger_entries_app_id_not_null NOT NULL,
    voucher_id uuid CONSTRAINT ledger_entries_voucher_id_not_null NOT NULL,
    account_id uuid CONSTRAINT ledger_entries_account_id_not_null NOT NULL,
    sub_account text CONSTRAINT ledger_entries_sub_account_not_null NOT NULL,
    amount_fen bigint CONSTRAINT ledger_entries_amount_fen_not_null NOT NULL,
    ledger_type text CONSTRAINT ledger_entries_ledger_type_not_null NOT NULL,
    sub_type text,
    income_type text,
    balance_after_fen bigint,
    account_version bigint,
    booked_at timestamp with time zone CONSTRAINT ledger_entries_booked_at_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT ledger_entries_created_at_not_null NOT NULL,
    CONSTRAINT ledger_entries_account_version_check CHECK ((account_version >= 1)),
    CONSTRAINT ledger_entries_amount_fen_check CHECK ((amount_fen <> 0)),
    CONSTRAINT ledger_entries_balance_after_check CHECK (((balance_after_fen IS NULL) = (account_version IS NULL))),
    CONSTRAINT ledger_entries_income_type_check CHECK ((income_type = ANY (ARRAY['SERVICE_FEE'::text, 'INCIDENTAL'::text]))),
    CONSTRAINT ledger_entries_ledger_type_check CHECK ((ledger_type = ANY (ARRAY['REBATE_CREDIT'::text, 'SHARE_CREDIT'::text, 'REFERRAL_CREDIT'::text, 'CLAWBACK'::text, 'SETTLE_ADJUST'::text, 'WITHDRAW_FREEZE'::text, 'WITHDRAW_PAID'::text, 'WITHDRAW_RETURN'::text, 'WITHDRAW_FEE'::text, 'TAX_WITHHOLD'::text, 'REWARD'::text, 'ADMIN_ADJUST'::text, 'BAD_DEBT_WRITEOFF'::text, 'PAY_RECEIPT'::text, 'PAY_REFUND'::text, 'PAY_ANOMALY'::text, 'PAY_FEE'::text]))),
    CONSTRAINT ledger_entries_sub_account_check CHECK ((sub_account = ANY (ARRAY['available'::text, 'frozen'::text]))),
    CONSTRAINT ledger_entries_sub_type_check CHECK ((sub_type <> ''::text))
);


--
-- Name: ledger_entries_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.ledger_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ledger_vouchers; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.ledger_vouchers (
    id uuid NOT NULL,
    app_id text NOT NULL,
    biz_type text NOT NULL,
    biz_id text NOT NULL,
    uniq_key text NOT NULL,
    accounting_date date NOT NULL,
    operator text NOT NULL,
    memo text,
    order_key text,
    beneficiary_user_id uuid,
    role text,
    voucher_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_vouchers_biz_type_check CHECK ((biz_type <> ''::text)),
    CONSTRAINT ledger_vouchers_uniq_key_check CHECK ((uniq_key <> ''::text))
);


--
-- Name: level_change_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.level_change_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    from_level text,
    to_level text NOT NULL,
    source text NOT NULL,
    operator text NOT NULL,
    reason text,
    effective_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT level_change_logs_admin_reason_check CHECK (((source <> 'admin'::text) OR (btrim(COALESCE(reason, ''::text)) <> ''::text))),
    CONSTRAINT level_change_logs_from_level_check CHECK ((from_level = ANY (ARRAY['L1'::text, 'L2'::text, 'L3'::text]))),
    CONSTRAINT level_change_logs_operator_check CHECK ((btrim(operator) <> ''::text)),
    CONSTRAINT level_change_logs_shape_check CHECK ((((source = 'register'::text) AND (from_level IS NULL)) OR ((source = 'admin'::text) AND (from_level IS NOT NULL) AND (from_level <> to_level)))),
    CONSTRAINT level_change_logs_source_check CHECK ((source = ANY (ARRAY['register'::text, 'admin'::text]))),
    CONSTRAINT level_change_logs_to_level_check CHECK ((to_level = ANY (ARRAY['L1'::text, 'L2'::text, 'L3'::text])))
);


--
-- Name: level_change_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.level_change_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.level_change_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: link_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    link_id uuid,
    event text NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false NOT NULL,
    expired boolean DEFAULT false NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: link_logs_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs_default (
    id bigint CONSTRAINT link_logs_id_not_null NOT NULL,
    app_id text CONSTRAINT link_logs_app_id_not_null NOT NULL,
    link_id uuid,
    event text CONSTRAINT link_logs_event_not_null NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false CONSTRAINT link_logs_cache_hit_not_null NOT NULL,
    expired boolean DEFAULT false CONSTRAINT link_logs_expired_not_null NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false CONSTRAINT link_logs_no_rebate_not_null NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer CONSTRAINT link_logs_result_code_not_null NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT link_logs_created_at_not_null NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
);


--
-- Name: link_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.link_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.link_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: link_open_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_open_attempts (
    attempt_id uuid NOT NULL,
    app_id text NOT NULL,
    link_id uuid NOT NULL,
    user_id uuid,
    opened_at timestamp with time zone NOT NULL,
    jump_reported_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: links; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.links (
    link_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id uuid,
    platform text NOT NULL,
    product_key text,
    raw_item_id text,
    raw_fetched_at timestamp with time zone,
    scene text NOT NULL,
    sub_scene text,
    pid_scene text,
    pid text,
    entry_source text,
    identity_snapshot jsonb,
    convert_result bytea,
    cache_hit boolean DEFAULT false NOT NULL,
    quoted_final_price_fen bigint,
    quoted_coupon_fen bigint,
    quoted_coupon_id text,
    quoted_at timestamp with time zone,
    expire_at timestamp with time zone NOT NULL,
    agent_session_id uuid,
    agent_card_id text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    promo_url text,
    promo_url_fetched_at timestamp with time zone,
    lk text,
    CONSTRAINT links_lk_check CHECK ((lk ~ '^[0-9a-z]{1,16}$'::text))
);


--
-- Name: login_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.login_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id_hash text NOT NULL,
    ip inet NOT NULL,
    method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    device_hash text,
    CONSTRAINT login_logs_device_hash_check CHECK ((device_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: login_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.login_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.login_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_settings; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notification_settings (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    service_push boolean NOT NULL,
    subscription_push boolean NOT NULL,
    marketing_push boolean NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notify_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notify_logs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    code text NOT NULL,
    channel text NOT NULL,
    dedupe_key text NOT NULL,
    planned_at timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    status text DEFAULT 'queued'::text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    suppress_reason text,
    sms_biz_id text,
    CONSTRAINT notify_logs_channel_check CHECK ((channel = ANY (ARRAY['inbox'::text, 'push'::text, 'sms'::text]))),
    CONSTRAINT notify_logs_dedupe_key_check CHECK ((dedupe_key <> ''::text)),
    CONSTRAINT notify_logs_sent_at_check CHECK ((((status <> 'success'::text) OR (sent_at IS NOT NULL)) AND ((status <> 'queued'::text) OR (sent_at IS NULL)))),
    CONSTRAINT notify_logs_sms_biz_id_check CHECK (((sms_biz_id IS NULL) OR ((sms_biz_id <> ''::text) AND (channel = 'sms'::text)))),
    CONSTRAINT notify_logs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'success'::text, 'failed'::text, 'suppressed'::text]))),
    CONSTRAINT notify_logs_suppress_reason_check CHECK (((suppress_reason IS NULL) OR (suppress_reason = 'push_disabled'::text))),
    CONSTRAINT notify_logs_suppressed_check CHECK ((((status = 'suppressed'::text) = (suppress_reason IS NOT NULL)) AND ((status <> 'suppressed'::text) OR (sent_at IS NULL))))
);


--
-- Name: notify_templates; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.notify_templates (
    app_id text NOT NULL,
    code text NOT NULL,
    category text NOT NULL,
    channels text[] NOT NULL,
    route jsonb,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    variant text DEFAULT 'default'::text NOT NULL,
    title_override text,
    body_override text,
    sms_sign_name text,
    sms_template_code text,
    sms_template_type text,
    sms_preview_text text,
    sms_pending_sign_name text,
    sms_pending_template_code text,
    sms_pending_template_type text,
    sms_pending_preview_text text,
    sms_test_status text,
    sms_tested_at timestamp with time zone,
    sms_pending_saved_at timestamp with time zone,
    CONSTRAINT notify_templates_body_override_check CHECK (((body_override IS NULL) OR (body_override ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_category_check CHECK ((category = ANY (ARRAY['service'::text, 'subscription'::text, 'marketing'::text]))),
    CONSTRAINT notify_templates_channels_check CHECK (((cardinality(channels) >= 1) AND (array_position(channels, NULL::text) IS NULL) AND (channels <@ ARRAY['inbox'::text, 'push'::text, 'sms'::text]))),
    CONSTRAINT notify_templates_code_check CHECK ((code ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'::text)),
    CONSTRAINT notify_templates_route_check CHECK (((route IS NULL) OR (jsonb_typeof(route) = 'object'::text))),
    CONSTRAINT notify_templates_sms_pending_check CHECK ((((sms_pending_sign_name IS NULL) AND (sms_pending_template_code IS NULL) AND (sms_pending_template_type IS NULL) AND (sms_pending_preview_text IS NULL) AND (sms_test_status IS NULL) AND (sms_tested_at IS NULL)) OR ((sms_pending_sign_name IS NOT NULL) AND (sms_pending_template_code IS NOT NULL) AND (sms_pending_template_type IS NOT NULL) AND (sms_pending_preview_text IS NOT NULL) AND (sms_test_status IS NOT NULL) AND (sms_tested_at IS NOT NULL)))),
    CONSTRAINT notify_templates_sms_pending_preview_text_check CHECK (((sms_pending_preview_text IS NULL) OR (sms_pending_preview_text ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_pending_sign_name_check CHECK (((sms_pending_sign_name IS NULL) OR (sms_pending_sign_name ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_pending_template_code_check CHECK (((sms_pending_template_code IS NULL) OR (sms_pending_template_code ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_pending_template_type_check CHECK (((sms_pending_template_type IS NULL) OR (sms_pending_template_type = ANY (ARRAY['verify'::text, 'notice'::text])))),
    CONSTRAINT notify_templates_sms_preview_text_check CHECK (((sms_preview_text IS NULL) OR (sms_preview_text ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_registration_check CHECK ((((sms_sign_name IS NULL) AND (sms_template_code IS NULL) AND (sms_template_type IS NULL) AND (sms_preview_text IS NULL)) OR ((sms_sign_name IS NOT NULL) AND (sms_template_code IS NOT NULL) AND (sms_template_type IS NOT NULL) AND (sms_preview_text IS NOT NULL)))),
    CONSTRAINT notify_templates_sms_sign_name_check CHECK (((sms_sign_name IS NULL) OR (sms_sign_name ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_template_code_check CHECK (((sms_template_code IS NULL) OR (sms_template_code ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_sms_template_type_check CHECK (((sms_template_type IS NULL) OR (sms_template_type = ANY (ARRAY['verify'::text, 'notice'::text])))),
    CONSTRAINT notify_templates_sms_test_status_check CHECK (((sms_test_status IS NULL) OR (sms_test_status = ANY (ARRAY['accepted'::text, 'failed'::text, 'not_sent_no_verify_phone'::text])))),
    CONSTRAINT notify_templates_title_override_check CHECK (((title_override IS NULL) OR (title_override ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'::text))),
    CONSTRAINT notify_templates_variant_check CHECK ((variant ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text))
);


--
-- Name: order_assignments; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_assignments (
    id uuid NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    to_user_id uuid NOT NULL,
    source text NOT NULL,
    reason text,
    admin_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_assignments_admin_id_check CHECK (((source <> 'admin'::text) OR (admin_id IS NOT NULL))),
    CONSTRAINT order_assignments_source_check CHECK ((source = ANY (ARRAY['claim'::text, 'admin'::text])))
);


--
-- Name: order_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_keys (
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    attr_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_rights; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_rights (
    id uuid NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    source text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    amount_fen bigint,
    deduction_commission_fen bigint,
    occurred_at timestamp with time zone NOT NULL,
    platform_rights_no text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone,
    CONSTRAINT order_rights_status_check CHECK ((status = ANY (ARRAY['PROCESSING'::text, 'WAIT_COMMISSION'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT order_rights_type_check CHECK ((type = ANY (ARRAY['RIGHTS'::text, 'PUNISH'::text, 'INVALID_AFTER_SETTLE'::text, 'REFUND_AFTER_SETTLE'::text])))
);


--
-- Name: order_settlements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_settlements (
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    seq integer NOT NULL,
    source text NOT NULL,
    settle_commission_fen bigint NOT NULL,
    settled_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_settlements_source_check CHECK ((source = ANY (ARRAY['API'::text, 'STATEMENT'::text])))
);


--
-- Name: order_status_history; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_status_history (
    id bigint NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    field text NOT NULL,
    from_status text,
    event text NOT NULL,
    to_status text NOT NULL,
    source text NOT NULL,
    at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_status_history_field_check CHECK ((field = ANY (ARRAY['platform'::text, 'rebate'::text]))),
    CONSTRAINT order_status_history_source_check CHECK ((source = ANY (ARRAY['sync'::text, 'admin'::text, 'claim'::text, 'system'::text])))
);


--
-- Name: order_status_history_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.order_status_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.order_status_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_sync_counters; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_counters (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    date date NOT NULL,
    counter text NOT NULL,
    count bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_sync_counters_count_check CHECK ((count >= 0)),
    CONSTRAINT order_sync_counters_counter_check CHECK ((counter = ANY (ARRAY['attr_param_invalid'::text, 'attr_binding_miss'::text, 'order_sync_no_mtime'::text])))
);


--
-- Name: order_sync_counters_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.order_sync_counters ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.order_sync_counters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_sync_drop_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_drop_keys (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_sync_drop_keys_reason_check CHECK ((reason <> ''::text))
);


--
-- Name: order_sync_drop_keys_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.order_sync_drop_keys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.order_sync_drop_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_sync_drops; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_drops (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    date date NOT NULL,
    reason text NOT NULL,
    count bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_sync_drops_count_check CHECK ((count >= 0)),
    CONSTRAINT order_sync_drops_reason_check CHECK ((reason <> ''::text))
);


--
-- Name: order_sync_drops_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.order_sync_drops ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.order_sync_drops_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_sync_pending; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_pending (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    order_id uuid,
    reason text NOT NULL,
    raw_status text,
    raw_payload_id bigint,
    detail text,
    detected_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_sync_pending_reason_check CHECK ((reason = ANY (ARRAY['UNMAPPED_STATUS'::text, 'UNFREEZE_SIGNAL'::text, 'ILLEGAL_TRANSITION'::text, 'NO_RECEIVED_AT'::text, 'CLAWBACK_NO_COMMISSION'::text, 'SERVICE_FEE_RATE_MISSING'::text, 'RULE_VERSION_PLATFORM_MISSING'::text, 'TLJ_FACE_VALUE_UNMATCHED'::text, 'AMOUNT_PARSE_FAILED'::text]))),
    CONSTRAINT order_sync_pending_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: order_sync_pending_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.order_sync_pending ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.order_sync_pending_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_sync_request_windows; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_request_windows (
    app_id text NOT NULL,
    sync_id uuid NOT NULL,
    seq integer NOT NULL,
    union_account_id uuid NOT NULL,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    status text NOT NULL,
    fetched_count integer DEFAULT 0 NOT NULL,
    stored_count integer DEFAULT 0 NOT NULL,
    error text,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_sync_request_windows_counts_check CHECK (((fetched_count >= 0) AND (stored_count >= 0))),
    CONSTRAINT order_sync_request_windows_finished_check CHECK (((status = ANY (ARRAY['done'::text, 'failed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT order_sync_request_windows_seq_check CHECK ((seq >= 0)),
    CONSTRAINT order_sync_request_windows_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT order_sync_request_windows_window_check CHECK ((((window_start IS NULL) AND (window_end IS NULL)) OR ((window_start IS NOT NULL) AND (window_end IS NOT NULL) AND (window_start < window_end))))
);


--
-- Name: order_sync_requests; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_sync_requests (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    mode text NOT NULL,
    "from" timestamp with time zone,
    "to" timestamp with time zone,
    status_filter text,
    order_nos text[],
    filter_digest text NOT NULL,
    status text NOT NULL,
    requested_by uuid NOT NULL,
    fetched_count integer DEFAULT 0 NOT NULL,
    stored_count integer DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT order_sync_requests_counts_check CHECK (((fetched_count >= 0) AND (stored_count >= 0))),
    CONSTRAINT order_sync_requests_filter_digest_check CHECK ((filter_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT order_sync_requests_finished_check CHECK (((status = ANY (ARRAY['done'::text, 'failed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT order_sync_requests_mode_check CHECK ((mode = ANY (ARRAY['window'::text, 'order_nos'::text]))),
    CONSTRAINT order_sync_requests_order_nos_check CHECK (((mode <> 'order_nos'::text) OR ((order_nos IS NOT NULL) AND (array_ndims(order_nos) = 1) AND ((cardinality(order_nos) >= 1) AND (cardinality(order_nos) <= 50)) AND ("from" IS NULL) AND ("to" IS NULL) AND (status_filter IS NULL)))),
    CONSTRAINT order_sync_requests_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT order_sync_requests_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT order_sync_requests_status_filter_check CHECK (((status_filter IS NULL) OR ((length(status_filter) >= 1) AND (length(status_filter) <= 64)))),
    CONSTRAINT order_sync_requests_window_check CHECK (((mode <> 'window'::text) OR (("from" IS NOT NULL) AND ("to" IS NOT NULL) AND ("from" < "to") AND (order_nos IS NULL))))
);


--
-- Name: orders; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders (
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text NOT NULL,
    hold boolean DEFAULT false NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    commission_version integer DEFAULT 0 NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    service_fee_fen bigint,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
)
PARTITION BY RANGE (attr_at);


--
-- Name: orders_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders_default (
    order_id uuid CONSTRAINT orders_order_id_not_null NOT NULL,
    app_id text CONSTRAINT orders_app_id_not_null NOT NULL,
    platform text CONSTRAINT orders_platform_not_null NOT NULL,
    sub_order_id text CONSTRAINT orders_sub_order_id_not_null NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text CONSTRAINT orders_raw_item_id_not_null NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text CONSTRAINT orders_platform_status_not_null NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text CONSTRAINT orders_rebate_status_not_null NOT NULL,
    hold boolean DEFAULT false CONSTRAINT orders_hold_not_null NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false CONSTRAINT orders_rights_pending_not_null NOT NULL,
    locked boolean DEFAULT false CONSTRAINT orders_locked_not_null NOT NULL,
    row_version integer DEFAULT 0 CONSTRAINT orders_row_version_not_null NOT NULL,
    commission_version integer DEFAULT 0 CONSTRAINT orders_commission_version_not_null NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false CONSTRAINT orders_is_presale_not_null NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone CONSTRAINT orders_attr_at_not_null NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false CONSTRAINT orders_credit_requires_settle_not_null NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT orders_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT orders_updated_at_not_null NOT NULL,
    service_fee_fen bigint,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
);


--
-- Name: page_preview_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.page_preview_tokens (
    token_hash text NOT NULL,
    app_id text NOT NULL,
    page_key text NOT NULL,
    version integer NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expire_at timestamp with time zone NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT page_preview_tokens_expire_at_check CHECK (((expire_at > created_at) AND (expire_at <= (created_at + '00:10:00'::interval)))),
    CONSTRAINT page_preview_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT page_preview_tokens_used_count_check CHECK ((used_count >= 0))
);


--
-- Name: page_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.page_versions (
    app_id text NOT NULL,
    page_key text NOT NULL,
    version integer NOT NULL,
    sections jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    render_count bigint DEFAULT 0 NOT NULL,
    error_count bigint DEFAULT 0 NOT NULL,
    publish_at timestamp with time zone,
    publisher uuid,
    created_by_admin_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_versions_counts_check CHECK (((render_count >= 0) AND (error_count >= 0))),
    CONSTRAINT page_versions_page_key_check CHECK ((page_key ~ '^(home|custom:[a-z0-9_-]{1,57})$'::text)),
    CONSTRAINT page_versions_publish_check CHECK ((((status = 'draft'::text) = (publish_at IS NULL)) AND ((publish_at IS NULL) = (publisher IS NULL)))),
    CONSTRAINT page_versions_sections_check CHECK ((jsonb_typeof(sections) = 'array'::text)),
    CONSTRAINT page_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'rolled_back'::text]))),
    CONSTRAINT page_versions_version_check CHECK ((version >= 1))
);


--
-- Name: pages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pages (
    app_id text NOT NULL,
    page_key text NOT NULL,
    current_version integer,
    gray_version integer,
    gray_percent smallint DEFAULT 0 NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    updated_by_admin_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_version integer,
    scheduled_gray_percent smallint,
    scheduled_at timestamp with time zone,
    scheduled_by_admin_id uuid,
    CONSTRAINT pages_gray_check CHECK ((((gray_version IS NULL) AND (gray_percent = 0)) OR ((gray_version IS NOT NULL) AND ((gray_percent >= 1) AND (gray_percent <= 99)) AND (current_version IS NOT NULL) AND (gray_version <> current_version)))),
    CONSTRAINT pages_gray_percent_check CHECK (((gray_percent >= 0) AND (gray_percent <= 100))),
    CONSTRAINT pages_page_key_check CHECK ((page_key ~ '^(home|custom:[a-z0-9_-]{1,57})$'::text)),
    CONSTRAINT pages_revision_check CHECK ((revision >= 0)),
    CONSTRAINT pages_scheduled_check CHECK ((((scheduled_version IS NULL) AND (scheduled_gray_percent IS NULL) AND (scheduled_at IS NULL) AND (scheduled_by_admin_id IS NULL)) OR ((scheduled_version IS NOT NULL) AND (scheduled_gray_percent IS NOT NULL) AND (scheduled_at IS NOT NULL) AND (scheduled_by_admin_id IS NOT NULL) AND ((scheduled_gray_percent >= 1) AND (scheduled_gray_percent <= 100)))))
);


--
-- Name: pay_anomalies; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_anomalies (
    id uuid NOT NULL,
    app_id text NOT NULL,
    pay_channel text NOT NULL,
    channel_trade_no text NOT NULL,
    out_trade_no text,
    pay_order_id uuid,
    amount_fen bigint NOT NULL,
    refunded_fen bigint DEFAULT 0 NOT NULL,
    evidence jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pay_anomalies_amount_fen_check CHECK ((amount_fen > 0)),
    CONSTRAINT pay_anomalies_channel_trade_no_check CHECK ((channel_trade_no <> ''::text)),
    CONSTRAINT pay_anomalies_pay_channel_check CHECK ((pay_channel = ANY (ARRAY['wechat_pay'::text, 'alipay'::text]))),
    CONSTRAINT pay_anomalies_refunded_fen_check CHECK (((refunded_fen >= 0) AND (refunded_fen <= amount_fen))),
    CONSTRAINT pay_anomalies_status_check CHECK ((status = ANY (ARRAY['open'::text, 'refunded'::text, 'closed'::text])))
);


--
-- Name: pay_fulfillments; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_fulfillments (
    id uuid NOT NULL,
    app_id text NOT NULL,
    biz_type text NOT NULL,
    biz_ref text NOT NULL,
    state text NOT NULL,
    last_pay_order_id uuid,
    refunded_fen bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pay_fulfillments_biz_ref_check CHECK ((biz_ref <> ''::text)),
    CONSTRAINT pay_fulfillments_biz_type_check CHECK ((biz_type <> ''::text)),
    CONSTRAINT pay_fulfillments_refunded_fen_check CHECK ((refunded_fen >= 0)),
    CONSTRAINT pay_fulfillments_state_check CHECK ((state = ANY (ARRAY['none'::text, 'active'::text, 'revoked'::text]))),
    CONSTRAINT pay_fulfillments_version_check CHECK ((version >= 0))
);


--
-- Name: pay_notifications; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_notifications (
    id uuid NOT NULL,
    app_id text NOT NULL,
    pay_channel text NOT NULL,
    notify_id text NOT NULL,
    out_trade_no text,
    out_refund_no text,
    payload_cipher bytea NOT NULL,
    verify_result text NOT NULL,
    handle_result text,
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pay_notifications_merchant_no_check CHECK (((out_trade_no IS NOT NULL) OR (out_refund_no IS NOT NULL))),
    CONSTRAINT pay_notifications_notify_id_check CHECK ((notify_id <> ''::text)),
    CONSTRAINT pay_notifications_pay_channel_check CHECK ((pay_channel = ANY (ARRAY['wechat_pay'::text, 'alipay'::text]))),
    CONSTRAINT pay_notifications_verify_result_check CHECK ((verify_result = ANY (ARRAY['ok'::text, 'failed'::text])))
);


--
-- Name: pay_orders; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_orders (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    biz_type text NOT NULL,
    biz_ref text NOT NULL,
    pay_channel text NOT NULL,
    amount_fen bigint NOT NULL,
    refunded_fen bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    out_trade_no text NOT NULL,
    channel_trade_no text,
    expire_at timestamp with time zone NOT NULL,
    launch_issued_at timestamp with time zone,
    closing boolean DEFAULT false NOT NULL,
    needs_manual boolean DEFAULT false NOT NULL,
    paid_at timestamp with time zone,
    closed_at timestamp with time zone,
    close_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pay_orders_amount_fen_check CHECK ((amount_fen > 0)),
    CONSTRAINT pay_orders_biz_ref_check CHECK ((biz_ref <> ''::text)),
    CONSTRAINT pay_orders_biz_type_check CHECK ((biz_type <> ''::text)),
    CONSTRAINT pay_orders_out_trade_no_check CHECK ((out_trade_no ~ '^[A-Za-z0-9]{1,32}$'::text)),
    CONSTRAINT pay_orders_pay_channel_check CHECK ((pay_channel = ANY (ARRAY['wechat_pay'::text, 'alipay'::text]))),
    CONSTRAINT pay_orders_refunded_fen_check CHECK (((refunded_fen >= 0) AND (refunded_fen <= amount_fen))),
    CONSTRAINT pay_orders_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'CLOSED'::text])))
);


--
-- Name: pay_query_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_query_attempts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    pay_order_id uuid,
    pay_refund_id uuid,
    kind text NOT NULL,
    request jsonb,
    response jsonb,
    result text,
    at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pay_query_attempts_kind_check CHECK ((kind = ANY (ARRAY['query'::text, 'close'::text, 'refund'::text, 'refund_query'::text]))),
    CONSTRAINT pay_query_attempts_target_check CHECK ((num_nonnulls(pay_order_id, pay_refund_id) = 1))
);


--
-- Name: pay_recon_days; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_recon_days (
    id uuid NOT NULL,
    app_id text NOT NULL,
    pay_channel text NOT NULL,
    bill_date date NOT NULL,
    reconciled_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pay_recon_days_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT pay_recon_days_pay_channel_check CHECK ((pay_channel = ANY (ARRAY['wechat_pay'::text, 'alipay'::text])))
);


--
-- Name: pay_refunds; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pay_refunds (
    id uuid NOT NULL,
    app_id text NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    out_refund_no text NOT NULL,
    amount_fen bigint NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    channel_refund_no text,
    operator text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    succeeded_at timestamp with time zone,
    failed_at timestamp with time zone,
    note text,
    CONSTRAINT pay_refunds_amount_fen_check CHECK ((amount_fen > 0)),
    CONSTRAINT pay_refunds_idempotency_key_check CHECK ((idempotency_key <> ''::text)),
    CONSTRAINT pay_refunds_operator_check CHECK ((operator <> ''::text)),
    CONSTRAINT pay_refunds_out_refund_no_check CHECK ((out_refund_no ~ '^[A-Za-z0-9]{1,32}$'::text)),
    CONSTRAINT pay_refunds_reason_code_check CHECK ((reason_code = ANY (ARRAY['USER_REQUEST'::text, 'DUPLICATE_PAYMENT'::text, 'ANOMALY_RECEIPT'::text, 'RECON_DIFF'::text, 'OTHER'::text]))),
    CONSTRAINT pay_refunds_status_check CHECK ((status = ANY (ARRAY['PROCESSING'::text, 'SUCCESS'::text, 'FAILED'::text]))),
    CONSTRAINT pay_refunds_target_type_check CHECK ((target_type = ANY (ARRAY['pay_order'::text, 'pay_anomaly'::text])))
);


--
-- Name: payout_account_changes; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_account_changes (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    old_payout_method text NOT NULL,
    new_payout_method text NOT NULL,
    old_hmac text NOT NULL,
    new_hmac text NOT NULL,
    operator text NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    limit_exempt_reason text,
    CONSTRAINT payout_account_changes_limit_exempt_reason_check CHECK (((limit_exempt_reason IS NULL) OR (limit_exempt_reason = 'realname_correction'::text))),
    CONSTRAINT payout_account_changes_new_method_check CHECK ((new_payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text]))),
    CONSTRAINT payout_account_changes_old_method_check CHECK ((old_payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text])))
);


--
-- Name: payout_account_changes_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.payout_account_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.payout_account_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payout_account_verify_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_account_verify_attempts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    verify_date date NOT NULL,
    status text NOT NULL,
    vendor_request_id text NOT NULL,
    request_fingerprint text NOT NULL,
    reserved_at timestamp with time zone NOT NULL,
    unknown_at timestamp with time zone,
    resolved_at timestamp with time zone,
    origin_action text NOT NULL,
    idempotency_key text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_account_verify_attempts_action_check CHECK ((origin_action = 'payout_account_change'::text)),
    CONSTRAINT payout_account_verify_attempts_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'matched'::text, 'mismatched'::text, 'unknown'::text, 'expired_unresolved'::text, 'released'::text])))
);


--
-- Name: payout_accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_accounts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    payout_method text NOT NULL,
    alipay_logon_id_cipher bytea,
    alipay_hmac text,
    bank_card_no_cipher bytea,
    bank_card_hmac text,
    bank_name text,
    card_bin text,
    payee_name text NOT NULL,
    is_current boolean NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    anonymized_at timestamp with time zone,
    CONSTRAINT payout_accounts_details_check CHECK ((((anonymized_at IS NULL) AND (((payout_method = 'alipay'::text) AND (alipay_logon_id_cipher IS NOT NULL) AND (alipay_hmac IS NOT NULL) AND (bank_card_no_cipher IS NULL) AND (bank_card_hmac IS NULL) AND (bank_name IS NULL) AND (card_bin IS NULL)) OR ((payout_method = 'bank_card'::text) AND (bank_card_no_cipher IS NOT NULL) AND (bank_card_hmac IS NOT NULL) AND (bank_name IS NOT NULL) AND (card_bin IS NOT NULL) AND (alipay_logon_id_cipher IS NULL) AND (alipay_hmac IS NULL)))) OR ((anonymized_at IS NOT NULL) AND (alipay_logon_id_cipher IS NULL) AND (alipay_hmac IS NULL) AND (bank_card_no_cipher IS NULL) AND (bank_card_hmac IS NULL) AND (card_bin IS NULL) AND (NOT is_current)))),
    CONSTRAINT payout_accounts_method_check CHECK ((payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text])))
);


--
-- Name: payout_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_attempts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    withdrawal_id uuid NOT NULL,
    kind text NOT NULL,
    request jsonb NOT NULL,
    response jsonb,
    resp_code text,
    resp_sub_code text,
    result text NOT NULL,
    latency_ms integer,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_attempts_kind_check CHECK ((kind = ANY (ARRAY['transfer'::text, 'query'::text, 'cancel'::text]))),
    CONSTRAINT payout_attempts_latency_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT payout_attempts_result_check CHECK ((result = ANY (ARRAY['pending'::text, 'success'::text, 'fail'::text, 'unknown'::text])))
);


--
-- Name: payout_batch_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_batch_items (
    id uuid NOT NULL,
    app_id text NOT NULL,
    batch_id uuid NOT NULL,
    withdrawal_id uuid NOT NULL,
    result text NOT NULL,
    reason text,
    moved_to_batch_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_batch_items_reason_check CHECK ((((result = ANY (ARRAY['skipped'::text, 'blocked'::text])) AND (reason IS NOT NULL) AND (reason <> ''::text) AND (moved_to_batch_id IS NULL)) OR ((result = 'moved_out'::text) AND (moved_to_batch_id IS NOT NULL) AND (moved_to_batch_id <> batch_id) AND (reason IS NULL)) OR ((result = 'paying'::text) AND (reason IS NULL) AND (moved_to_batch_id IS NULL)))),
    CONSTRAINT payout_batch_items_result_check CHECK ((result = ANY (ARRAY['paying'::text, 'skipped'::text, 'blocked'::text, 'moved_out'::text])))
);


--
-- Name: payout_batches; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_batches (
    id uuid NOT NULL,
    app_id text NOT NULL,
    kind text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_batches_created_by_check CHECK ((((kind = 'manual'::text) = (created_by IS NOT NULL)) AND ((created_by IS NULL) OR (created_by <> ''::text)))),
    CONSTRAINT payout_batches_kind_check CHECK ((kind = ANY (ARRAY['manual'::text, 'auto'::text])))
);


--
-- Name: payout_recon_runs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_recon_runs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    channel text NOT NULL,
    bill_date date NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    bill_rows integer NOT NULL,
    matched integer NOT NULL,
    diffs integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_recon_runs_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT payout_recon_runs_bill_rows_check CHECK ((bill_rows >= 0)),
    CONSTRAINT payout_recon_runs_channel_check CHECK ((channel = 'alipay'::text)),
    CONSTRAINT payout_recon_runs_diffs_check CHECK ((diffs >= 0)),
    CONSTRAINT payout_recon_runs_finished_at_check CHECK ((finished_at >= started_at)),
    CONSTRAINT payout_recon_runs_matched_check CHECK ((matched >= 0)),
    CONSTRAINT payout_recon_runs_status_check CHECK ((status = ANY (ARRAY['succeeded'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: payout_watermarks; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_watermarks (
    id uuid NOT NULL,
    app_id text NOT NULL,
    channel text NOT NULL,
    available_fen bigint NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    entered_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_watermarks_available_check CHECK ((available_fen >= 0)),
    CONSTRAINT payout_watermarks_channel_check CHECK ((channel = ANY (ARRAY['alipay'::text, 'bank_card'::text, 'wechat'::text]))),
    CONSTRAINT payout_watermarks_entered_by_check CHECK ((entered_by <> ''::text))
);


--
-- Name: personal_data_copies; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.personal_data_copies (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    delivery text NOT NULL,
    status text NOT NULL,
    retry_of uuid,
    object_key text,
    due_at timestamp with time zone NOT NULL,
    generated_at timestamp with time zone,
    delivered_at timestamp with time zone,
    expires_at timestamp with time zone,
    failure_reason text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_data_copies_delivery_check CHECK ((delivery = ANY (ARRAY['in_app_sms'::text, 'wecom_session'::text]))),
    CONSTRAINT personal_data_copies_failure_reason_check CHECK (((failure_reason IS NULL) OR (failure_reason ~ '[^[:space:]]'::text))),
    CONSTRAINT personal_data_copies_object_key_check CHECK (((object_key IS NULL) OR (object_key ~ '[^[:space:]]'::text))),
    CONSTRAINT personal_data_copies_row_version_check CHECK ((row_version >= 0)),
    CONSTRAINT personal_data_copies_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'delivered'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: platform_icon_uploads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.platform_icon_uploads (
    id uuid NOT NULL,
    app_id text NOT NULL,
    key text NOT NULL,
    sha256 text NOT NULL,
    format text NOT NULL,
    bytes integer NOT NULL,
    sanitized boolean NOT NULL,
    created_by_admin_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT platform_icon_uploads_bytes_check CHECK ((bytes > 0)),
    CONSTRAINT platform_icon_uploads_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT platform_icon_uploads_format_check CHECK ((format = ANY (ARRAY['svg'::text, 'png'::text]))),
    CONSTRAINT platform_icon_uploads_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: platform_icon_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.platform_icon_versions (
    app_id text NOT NULL,
    key text NOT NULL,
    version integer NOT NULL,
    upload_id uuid NOT NULL,
    sha256 text NOT NULL,
    format text NOT NULL,
    bytes integer NOT NULL,
    sanitized boolean NOT NULL,
    source_url text,
    downloaded_on date,
    ever_published boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    created_by_admin_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_icon_versions_bytes_check CHECK ((bytes > 0)),
    CONSTRAINT platform_icon_versions_format_check CHECK ((format = ANY (ARRAY['svg'::text, 'png'::text]))),
    CONSTRAINT platform_icon_versions_revision_check CHECK ((revision >= 1)),
    CONSTRAINT platform_icon_versions_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT platform_icon_versions_version_check CHECK ((version >= 1))
);


--
-- Name: platform_icons; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.platform_icons (
    app_id text NOT NULL,
    key text NOT NULL,
    current_version integer,
    revision integer DEFAULT 0 NOT NULL,
    updated_by text,
    updated_by_admin_id uuid,
    updated_at timestamp with time zone,
    CONSTRAINT platform_icons_key_check CHECK ((key ~ '^[a-z_]{1,32}$'::text)),
    CONSTRAINT platform_icons_revision_check CHECK ((revision >= 0))
);


--
-- Name: platforms; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.platforms (
    code text NOT NULL,
    key_prefix text,
    key_stability text NOT NULL,
    search_support text NOT NULL,
    convert_support text NOT NULL,
    order_sync_support text NOT NULL,
    stage text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platforms_code_check CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT platforms_convert_support_check CHECK ((convert_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_key_prefix_check CHECK ((key_prefix ~ '^[a-z0-9]+$'::text)),
    CONSTRAINT platforms_key_stability_check CHECK ((key_stability = ANY (ARRAY['unverified'::text, 'stable_24h'::text, 'stable_7d'::text, 'unstable'::text]))),
    CONSTRAINT platforms_order_sync_support_check CHECK ((order_sync_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_search_support_check CHECK ((search_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_stage_check CHECK ((stage = ANY (ARRAY['m_beta'::text, 'p1'::text, 'p2'::text])))
);


--
-- Name: pool_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.pool_items (
    app_id text NOT NULL,
    pool_id uuid NOT NULL,
    product_key text NOT NULL,
    platform text NOT NULL,
    raw_item_id text NOT NULL,
    title text NOT NULL,
    image text,
    price_fen bigint NOT NULL,
    coupon_fen bigint NOT NULL,
    final_price_fen bigint NOT NULL,
    quoted_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    invalid_reason text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_rate_bp integer,
    CONSTRAINT pool_items_commission_rate_bp_check CHECK ((commission_rate_bp >= 0)),
    CONSTRAINT pool_items_coupon_fen_check CHECK ((coupon_fen >= 0)),
    CONSTRAINT pool_items_final_price_fen_check CHECK ((final_price_fen >= 0)),
    CONSTRAINT pool_items_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT pool_items_price_fen_check CHECK ((price_fen >= 0)),
    CONSTRAINT pool_items_product_key_check CHECK ((product_key <> ''::text)),
    CONSTRAINT pool_items_raw_item_id_check CHECK ((raw_item_id <> ''::text)),
    CONSTRAINT pool_items_sort_check CHECK ((sort >= 0)),
    CONSTRAINT pool_items_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text]))),
    CONSTRAINT pool_items_validity_check CHECK ((end_at > start_at))
);


--
-- Name: price_snapshot; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.price_snapshot (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    product_key text NOT NULL,
    sku_key text,
    source_kind text NOT NULL,
    price_fen bigint NOT NULL,
    coupon_fen bigint NOT NULL,
    final_price_fen bigint NOT NULL,
    in_stock boolean NOT NULL,
    goods_sign_plan text,
    first_observed_at timestamp with time zone NOT NULL,
    last_observed_at timestamp with time zone NOT NULL,
    observation_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_snapshot_coupon_fen_check CHECK ((coupon_fen >= 0)),
    CONSTRAINT price_snapshot_final_price_fen_check CHECK ((final_price_fen > 0)),
    CONSTRAINT price_snapshot_observation_count_check CHECK ((observation_count >= 1)),
    CONSTRAINT price_snapshot_observed_order_check CHECK ((last_observed_at >= first_observed_at)),
    CONSTRAINT price_snapshot_price_fen_check CHECK ((price_fen > 0)),
    CONSTRAINT price_snapshot_source_kind_check CHECK ((source_kind = ANY (ARRAY['search'::text, 'detail'::text, 'quote'::text, 'convert'::text, 'watch'::text])))
)
PARTITION BY RANGE (first_observed_at);


--
-- Name: price_snapshot_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.price_snapshot_default (
    id bigint CONSTRAINT price_snapshot_id_not_null NOT NULL,
    app_id text CONSTRAINT price_snapshot_app_id_not_null NOT NULL,
    platform text CONSTRAINT price_snapshot_platform_not_null NOT NULL,
    product_key text CONSTRAINT price_snapshot_product_key_not_null NOT NULL,
    sku_key text,
    source_kind text CONSTRAINT price_snapshot_source_kind_not_null NOT NULL,
    price_fen bigint CONSTRAINT price_snapshot_price_fen_not_null NOT NULL,
    coupon_fen bigint CONSTRAINT price_snapshot_coupon_fen_not_null NOT NULL,
    final_price_fen bigint CONSTRAINT price_snapshot_final_price_fen_not_null NOT NULL,
    in_stock boolean CONSTRAINT price_snapshot_in_stock_not_null NOT NULL,
    goods_sign_plan text,
    first_observed_at timestamp with time zone CONSTRAINT price_snapshot_first_observed_at_not_null NOT NULL,
    last_observed_at timestamp with time zone CONSTRAINT price_snapshot_last_observed_at_not_null NOT NULL,
    observation_count integer CONSTRAINT price_snapshot_observation_count_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT price_snapshot_created_at_not_null NOT NULL,
    CONSTRAINT price_snapshot_coupon_fen_check CHECK ((coupon_fen >= 0)),
    CONSTRAINT price_snapshot_final_price_fen_check CHECK ((final_price_fen > 0)),
    CONSTRAINT price_snapshot_observation_count_check CHECK ((observation_count >= 1)),
    CONSTRAINT price_snapshot_observed_order_check CHECK ((last_observed_at >= first_observed_at)),
    CONSTRAINT price_snapshot_price_fen_check CHECK ((price_fen > 0)),
    CONSTRAINT price_snapshot_source_kind_check CHECK ((source_kind = ANY (ARRAY['search'::text, 'detail'::text, 'quote'::text, 'convert'::text, 'watch'::text])))
);


--
-- Name: price_snapshot_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.price_snapshot ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.price_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: processed_events; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.processed_events (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_key_aliases; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.product_key_aliases (
    old_key text NOT NULL,
    new_key text NOT NULL,
    reason text NOT NULL,
    adr_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_key_aliases_adr_id_check CHECK ((adr_id <> ''::text)),
    CONSTRAINT product_key_aliases_distinct_check CHECK ((old_key <> new_key)),
    CONSTRAINT product_key_aliases_new_key_check CHECK (((char_length(new_key) <= 128) AND (new_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_key_aliases_old_key_check CHECK (((char_length(old_key) <= 128) AND (old_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_key_aliases_reason_check CHECK ((reason <> ''::text))
);


--
-- Name: product_pools; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.product_pools (
    app_id text NOT NULL,
    pool_id uuid NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_pools_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT product_pools_name_check CHECK ((name <> ''::text)),
    CONSTRAINT product_pools_revision_check CHECK ((revision >= 0)),
    CONSTRAINT product_pools_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: product_refs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.product_refs (
    app_id text NOT NULL,
    product_key text NOT NULL,
    platform text NOT NULL,
    raw_item_id text NOT NULL,
    raw_fetched_at timestamp with time zone NOT NULL,
    canonical_url text,
    title text NOT NULL,
    shop_id text,
    shop_type text,
    source text NOT NULL,
    refreshed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_refs_product_key_check CHECK (((char_length(product_key) <= 128) AND (product_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_refs_raw_item_id_check CHECK ((raw_item_id <> ''::text)),
    CONSTRAINT product_refs_source_check CHECK ((source = ANY (ARRAY['search'::text, 'detail'::text, 'parse'::text, 'pool'::text])))
);


--
-- Name: push_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.push_tokens (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    bound_sid text,
    device_id uuid NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    token_set_at timestamp with time zone NOT NULL,
    acquired_by_move_at timestamp with time zone,
    frozen_until timestamp with time zone,
    revoked_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: realname; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.realname (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    name_cipher bytea,
    id_no_cipher bytea,
    id_no_hmac text,
    birth_date_cipher bytea,
    status text NOT NULL,
    provider text,
    verified_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_retained boolean DEFAULT false NOT NULL,
    CONSTRAINT realname_id_no_hmac_check CHECK (((id_no_hmac IS NULL) OR (id_no_hmac ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT realname_provider_check CHECK (((provider IS NULL) OR (provider ~ '[^[:space:]]'::text))),
    CONSTRAINT realname_status_check CHECK ((status = ANY (ARRAY['none'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT realname_unverified_cleared_check CHECK (((status = 'verified'::text) OR ((status = 'none'::text) AND tax_retained) OR ((name_cipher IS NULL) AND (id_no_cipher IS NULL) AND (id_no_hmac IS NULL) AND (birth_date_cipher IS NULL)))),
    CONSTRAINT realname_verified_check CHECK (((status <> 'verified'::text) OR ((name_cipher IS NOT NULL) AND (id_no_cipher IS NOT NULL) AND (id_no_hmac IS NOT NULL) AND (birth_date_cipher IS NOT NULL) AND (provider IS NOT NULL) AND (verified_at IS NOT NULL))))
);


--
-- Name: realname_prior_identities; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.realname_prior_identities (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    name_cipher bytea NOT NULL,
    id_no_cipher bytea NOT NULL,
    id_no_hmac text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    corrected_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT realname_prior_identities_id_no_hmac_check CHECK ((id_no_hmac ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: recon_channel; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.recon_channel (
    id uuid NOT NULL,
    app_id text NOT NULL,
    date date NOT NULL,
    bill_date date NOT NULL,
    out_biz_no text,
    channel_order_id text,
    our_status text,
    channel_status text,
    our_amount_fen bigint,
    channel_amount_fen bigint,
    result text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recon_channel_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT recon_channel_channel_amount_fen_check CHECK ((channel_amount_fen >= 0)),
    CONSTRAINT recon_channel_channel_order_id_check CHECK ((channel_order_id <> ''::text)),
    CONSTRAINT recon_channel_channel_status_check CHECK ((channel_status <> ''::text)),
    CONSTRAINT recon_channel_key_check CHECK (((out_biz_no IS NOT NULL) OR (channel_order_id IS NOT NULL))),
    CONSTRAINT recon_channel_our_amount_fen_check CHECK ((our_amount_fen >= 0)),
    CONSTRAINT recon_channel_our_status_check CHECK ((our_status = ANY (ARRAY['PENDING_REVIEW'::text, 'APPROVED'::text, 'PAYING'::text, 'REJECTED'::text, 'PAID_API'::text, 'PAID_MANUAL'::text, 'FAILED'::text]))),
    CONSTRAINT recon_channel_out_biz_no_check CHECK ((out_biz_no <> ''::text)),
    CONSTRAINT recon_channel_result_check CHECK ((result = ANY (ARRAY['matched'::text, 'paying_query'::text, 'paying_manual'::text, 'diff'::text])))
);


--
-- Name: recon_diffs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.recon_diffs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    type text NOT NULL,
    source text NOT NULL,
    period text NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    expected_fen bigint NOT NULL,
    actual_fen bigint NOT NULL,
    diff_fen bigint NOT NULL,
    status text NOT NULL,
    handler_id uuid,
    closed_at timestamp with time zone,
    dedupe_key text,
    resolution jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT recon_diffs_dedupe_key_check CHECK ((dedupe_key <> ''::text)),
    CONSTRAINT recon_diffs_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'::text)),
    CONSTRAINT recon_diffs_ref_id_check CHECK ((ref_id <> ''::text)),
    CONSTRAINT recon_diffs_ref_type_check CHECK ((ref_type <> ''::text)),
    CONSTRAINT recon_diffs_resolution_check CHECK ((jsonb_typeof(resolution) = 'object'::text)),
    CONSTRAINT recon_diffs_source_check CHECK ((source = ANY (ARRAY['R1'::text, 'R2'::text, 'R3'::text, 'R4'::text]))),
    CONSTRAINT recon_diffs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'processing'::text, 'adjusted'::text, 'written_off'::text, 'closed'::text]))),
    CONSTRAINT recon_diffs_type_check CHECK ((type = ANY (ARRAY['union_mismatch'::text, 'channel_mismatch'::text, 'ledger_mismatch'::text, 'platform_restore'::text, 'month_end_unbalanced'::text, 'settle_amount_mismatch'::text, 'settle_missing'::text, 'appeal_restore'::text, 'estimate_changed_after_credit'::text, 'pay_mismatch'::text, 'pay_anomaly'::text])))
);


--
-- Name: recon_union; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.recon_union (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    period text NOT NULL,
    order_key text NOT NULL,
    our_value bigint,
    union_value bigint,
    diff_fen bigint NOT NULL,
    result text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recon_union_diff_check CHECK (((our_value IS NULL) OR (union_value IS NULL) OR (diff_fen = (our_value - union_value)))),
    CONSTRAINT recon_union_order_key_check CHECK ((order_key <> ''::text)),
    CONSTRAINT recon_union_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'::text)),
    CONSTRAINT recon_union_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT recon_union_result_check CHECK ((result <> ''::text)),
    CONSTRAINT recon_union_values_check CHECK (((our_value IS NOT NULL) OR (union_value IS NOT NULL)))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.refresh_tokens (
    id uuid NOT NULL,
    app_id text NOT NULL,
    sid text NOT NULL,
    token_hash text NOT NULL,
    parent_hash text,
    rotated_at timestamp with time zone,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: relation_change_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.relation_change_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    from_parent_id uuid,
    to_parent_id uuid,
    source text NOT NULL,
    operator text NOT NULL,
    reason text,
    at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relation_change_logs_change_check CHECK ((from_parent_id IS DISTINCT FROM to_parent_id)),
    CONSTRAINT relation_change_logs_not_self_check CHECK (((to_parent_id IS NULL) OR (to_parent_id <> user_id))),
    CONSTRAINT relation_change_logs_operator_check CHECK ((btrim(operator) <> ''::text)),
    CONSTRAINT relation_change_logs_parent_deleted_check CHECK (((source <> 'parent_deleted'::text) OR (to_parent_id IS NULL))),
    CONSTRAINT relation_change_logs_source_check CHECK ((source = ANY (ARRAY['landing'::text, 'register'::text, 'backfill'::text, 'admin'::text, 'risk_same_device'::text, 'parent_deleted'::text])))
);


--
-- Name: relation_change_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.relation_change_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.relation_change_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reverified_devices; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.reverified_devices (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    device_hash text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reverified_devices_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT reverified_devices_device_hash_check CHECK ((device_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT reverified_devices_source_check CHECK ((source = ANY (ARRAY['self'::text, 'admin'::text])))
);


--
-- Name: rights_import_failures; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.rights_import_failures (
    app_id text NOT NULL,
    import_id uuid NOT NULL,
    row_no integer NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rights_import_failures_reason_check CHECK ((reason = ANY (ARRAY['invalid_row'::text, 'order_not_found'::text, 'sub_order_no_missing'::text, 'received_at_missing'::text, 'platform_mismatch'::text]))),
    CONSTRAINT rights_import_failures_row_no_check CHECK ((row_no > 0))
);


--
-- Name: rights_imports; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.rights_imports (
    id uuid NOT NULL,
    app_id text NOT NULL,
    kind text NOT NULL,
    platform text NOT NULL,
    union_account_id uuid,
    time_basis text,
    "from" timestamp with time zone,
    "to" timestamp with time zone,
    file_path text NOT NULL,
    status text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    succeeded_rows integer DEFAULT 0 NOT NULL,
    failed_rows integer DEFAULT 0 NOT NULL,
    skipped_rows integer DEFAULT 0 NOT NULL,
    duplicate_rows integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT rights_imports_channel_check CHECK (((kind <> 'channel'::text) OR ((union_account_id IS NOT NULL) AND (time_basis IS NULL) AND ("from" IS NULL) AND ("to" IS NULL)))),
    CONSTRAINT rights_imports_counts_check CHECK (((total_rows >= 0) AND (succeeded_rows >= 0) AND (failed_rows >= 0) AND (skipped_rows >= 0) AND (duplicate_rows >= 0))),
    CONSTRAINT rights_imports_file_path_check CHECK ((file_path <> ''::text)),
    CONSTRAINT rights_imports_finished_check CHECK (((status = ANY (ARRAY['done'::text, 'failed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT rights_imports_kind_check CHECK ((kind = ANY (ARRAY['rights'::text, 'punish'::text, 'channel'::text]))),
    CONSTRAINT rights_imports_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT rights_imports_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT rights_imports_time_basis_check CHECK (((time_basis IS NULL) OR (time_basis = ANY (ARRAY['paid'::text, 'received'::text])))),
    CONSTRAINT rights_imports_window_check CHECK ((((time_basis IS NULL) AND ("from" IS NULL) AND ("to" IS NULL)) OR ((time_basis IS NOT NULL) AND ("from" IS NOT NULL) AND ("to" IS NOT NULL) AND ("from" < "to"))))
);


--
-- Name: risk_hits; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.risk_hits (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    rule_id text NOT NULL,
    risk_action text NOT NULL,
    dimension text NOT NULL,
    value_hmac text NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    request_type text,
    related_phone_hmac text,
    related_phone_masked text,
    amount_fen bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_hits_amount_check CHECK (
CASE
    WHEN (request_type = 'withdraw'::text) THEN ((amount_fen IS NOT NULL) AND (amount_fen > 0))
    ELSE (amount_fen IS NULL)
END),
    CONSTRAINT risk_hits_ref_type_check CHECK ((ref_type = ANY (ARRAY['order'::text, 'withdrawal'::text, 'blocked_request'::text, 'invite_relation'::text, 'invite_reward'::text]))),
    CONSTRAINT risk_hits_related_phone_check CHECK (
CASE
    WHEN (request_type = ANY (ARRAY['register'::text, 'phone_change'::text])) THEN ((related_phone_hmac IS NOT NULL) AND (related_phone_masked IS NOT NULL))
    WHEN (ref_type <> 'blocked_request'::text) THEN ((related_phone_hmac IS NULL) AND (related_phone_masked IS NULL))
    ELSE ((related_phone_hmac IS NULL) = (related_phone_masked IS NULL))
END),
    CONSTRAINT risk_hits_request_check CHECK (((request_type IS NULL) OR (ref_type = 'blocked_request'::text))),
    CONSTRAINT risk_hits_request_type_check CHECK ((request_type = ANY (ARRAY['register'::text, 'withdraw'::text, 'phone_change'::text, 'payout_account'::text]))),
    CONSTRAINT risk_hits_risk_action_check CHECK ((risk_action = ANY (ARRAY['pass'::text, 'manual_review'::text, 'block'::text, 'void_commission'::text]))),
    CONSTRAINT risk_hits_user_check CHECK (
CASE
    WHEN (request_type = 'register'::text) THEN (user_id IS NULL)
    WHEN (request_type IS NOT NULL) THEN (user_id IS NOT NULL)
    ELSE true
END)
);


--
-- Name: risk_hits_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.risk_hits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.risk_hits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: risk_judgements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.risk_judgements (
    id bigint NOT NULL,
    app_id text NOT NULL,
    rule_id text NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    user_id uuid NOT NULL,
    marked boolean NOT NULL,
    result jsonb NOT NULL,
    judged_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_judgements_ref_type_check CHECK ((ref_type = ANY (ARRAY['order'::text, 'withdrawal'::text, 'blocked_request'::text, 'invite_reward'::text]))),
    CONSTRAINT risk_judgements_result_check CHECK (((jsonb_typeof(result) = 'object'::text) AND ((result -> 'marked'::text) = to_jsonb(marked))))
);


--
-- Name: risk_judgements_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.risk_judgements ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.risk_judgements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: risk_rules; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.risk_rules (
    id uuid NOT NULL,
    app_id text NOT NULL,
    rule_id text NOT NULL,
    scene text NOT NULL,
    conditions jsonb NOT NULL,
    risk_action text NOT NULL,
    status text NOT NULL,
    version integer NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_rules_risk_action_check CHECK ((risk_action = ANY (ARRAY['pass'::text, 'manual_review'::text, 'block'::text, 'void_commission'::text])))
);


--
-- Name: sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.sessions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    sid text NOT NULL,
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    login_method text,
    CONSTRAINT sessions_login_method_check CHECK ((login_method = ANY (ARRAY['sms'::text, 'wechat'::text, 'apple'::text, 'huawei'::text, 'merge'::text])))
);


--
-- Name: settle_adjust_batches; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_adjust_batches (
    batch_id uuid NOT NULL,
    app_id text NOT NULL,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_adjust_batches_confirmed_check CHECK (((confirmed_by IS NULL) = (confirmed_at IS NULL)))
);


--
-- Name: settle_adjustments; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_adjustments (
    id uuid NOT NULL,
    app_id text NOT NULL,
    batch_id uuid NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid,
    role text,
    commission_version integer NOT NULL,
    settle_seq integer NOT NULL,
    diff_fen bigint NOT NULL,
    reason text,
    status text NOT NULL,
    approver uuid,
    decided_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_adjustments_beneficiary_check CHECK (((user_id IS NULL) = (role IS NULL))),
    CONSTRAINT settle_adjustments_decision_check CHECK ((((status = 'pending'::text) AND (approver IS NULL) AND (decided_at IS NULL)) OR ((status = ANY (ARRAY['approved'::text, 'rejected'::text])) AND (approver IS NOT NULL) AND (decided_at IS NOT NULL)) OR ((status = ANY (ARRAY['voided_stale_seq'::text, 'voided_by_clawback'::text])) AND (decided_at IS NOT NULL)))),
    CONSTRAINT settle_adjustments_diff_check CHECK (((diff_fen <> 0) AND ((user_id IS NULL) OR (diff_fen > 0)))),
    CONSTRAINT settle_adjustments_reason_check CHECK ((reason <> ''::text)),
    CONSTRAINT settle_adjustments_role_check CHECK ((role = ANY (ARRAY['self'::text, 'share'::text, 'direct'::text, 'indirect'::text]))),
    CONSTRAINT settle_adjustments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'voided_stale_seq'::text, 'voided_by_clawback'::text])))
);


--
-- Name: settle_batch_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_batch_items (
    id uuid NOT NULL,
    app_id text NOT NULL,
    batch_id uuid NOT NULL,
    item_type text NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid,
    role text,
    beneficiary_credit_id uuid,
    settle_seq integer NOT NULL,
    b_settle_fen bigint,
    amount_fen bigint,
    result text,
    skip_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_batch_items_amount_check CHECK ((amount_fen >= 0)),
    CONSTRAINT settle_batch_items_deferred_check CHECK (((result <> 'deferred'::text) OR (item_type = 'beneficiary'::text))),
    CONSTRAINT settle_batch_items_item_type_check CHECK ((item_type = ANY (ARRAY['order'::text, 'beneficiary'::text]))),
    CONSTRAINT settle_batch_items_result_check CHECK ((result = ANY (ARRAY['credited'::text, 'skipped'::text, 'deferred'::text]))),
    CONSTRAINT settle_batch_items_role_check CHECK ((role = ANY (ARRAY['self'::text, 'share'::text, 'direct'::text, 'indirect'::text]))),
    CONSTRAINT settle_batch_items_shape_check CHECK ((((item_type = 'order'::text) AND (user_id IS NULL) AND (role IS NULL) AND (beneficiary_credit_id IS NULL) AND (b_settle_fen IS NOT NULL) AND (amount_fen IS NULL)) OR ((item_type = 'beneficiary'::text) AND (user_id IS NOT NULL) AND (role IS NOT NULL) AND (beneficiary_credit_id IS NOT NULL)))),
    CONSTRAINT settle_batch_items_skip_reason_check CHECK ((skip_reason <> ''::text))
);


--
-- Name: settle_batches; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_batches (
    batch_id uuid NOT NULL,
    app_id text NOT NULL,
    bill_id text NOT NULL,
    platform text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    settle_mode text NOT NULL,
    scheduled_at timestamp with time zone,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    cancelled_reason text,
    settle_run_id uuid,
    order_count integer NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    paused_by_switch_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_batches_cancelled_reason_check CHECK ((((status = 'CANCELLED'::text) = (cancelled_reason IS NOT NULL)) AND (cancelled_reason <> ''::text))),
    CONSTRAINT settle_batches_confirmed_check CHECK (((status <> ALL (ARRAY['CONFIRMED'::text, 'EXECUTING'::text, 'PARTIAL'::text, 'DONE'::text])) OR (confirmed_at IS NOT NULL))),
    CONSTRAINT settle_batches_confirmed_pair_check CHECK (((confirmed_by IS NULL) = (confirmed_at IS NULL))),
    CONSTRAINT settle_batches_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'supplement'::text]))),
    CONSTRAINT settle_batches_order_count_check CHECK ((order_count >= 0)),
    CONSTRAINT settle_batches_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT settle_batches_scheduled_check CHECK (((settle_mode = 'SCHEDULED'::text) OR (scheduled_at IS NULL))),
    CONSTRAINT settle_batches_settle_mode_check CHECK ((settle_mode = ANY (ARRAY['IMMEDIATE'::text, 'SCHEDULED'::text]))),
    CONSTRAINT settle_batches_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'CONFIRMED'::text, 'EXECUTING'::text, 'PARTIAL'::text, 'DONE'::text, 'CANCELLED'::text])))
);


--
-- Name: settle_bills; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_bills (
    app_id text NOT NULL,
    bill_id text NOT NULL,
    generation_started_at timestamp with time zone NOT NULL,
    generated_at timestamp with time zone,
    platform_order_counts jsonb,
    platform_settle_commission_totals jsonb,
    beneficiary_total_fen bigint,
    platform_retained_fen bigint,
    error_count integer,
    held_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_bills_bill_id_check CHECK ((bill_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT settle_bills_commission_totals_check CHECK ((jsonb_typeof(platform_settle_commission_totals) = 'object'::text)),
    CONSTRAINT settle_bills_counts_check CHECK (((error_count >= 0) AND (held_count >= 0))),
    CONSTRAINT settle_bills_order_counts_check CHECK ((jsonb_typeof(platform_order_counts) = 'object'::text))
);


--
-- Name: settle_jobs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_jobs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    job text NOT NULL,
    platform text NOT NULL,
    run_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    processed_count integer NOT NULL,
    skipped_count integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_jobs_counts_check CHECK (((processed_count >= 0) AND (skipped_count >= 0))),
    CONSTRAINT settle_jobs_finished_check CHECK (((status = 'running'::text) = (finished_at IS NULL))),
    CONSTRAINT settle_jobs_job_check CHECK ((job = ANY (ARRAY['bill'::text, 'settle_adjust'::text, 'recon_union'::text, 'recon_monthly'::text, 'supplement'::text]))),
    CONSTRAINT settle_jobs_platform_check CHECK ((platform <> ''::text)),
    CONSTRAINT settle_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: settle_runs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.settle_runs (
    settle_run_id uuid NOT NULL,
    app_id text NOT NULL,
    bill_id text NOT NULL,
    part integer DEFAULT 0 NOT NULL,
    last_outcome text,
    part_started_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settle_runs_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT settle_runs_last_outcome_check CHECK ((last_outcome = ANY (ARRAY['done'::text, 'partial'::text]))),
    CONSTRAINT settle_runs_part_check CHECK ((part >= 0)),
    CONSTRAINT settle_runs_row_version_check CHECK ((row_version >= 0))
);


--
-- Name: share_materials; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.share_materials (
    app_id text NOT NULL,
    link_id uuid NOT NULL,
    share_url text NOT NULL,
    tpwd text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT share_materials_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT share_materials_share_url_check CHECK ((share_url <> ''::text)),
    CONSTRAINT share_materials_tpwd_check CHECK ((tpwd <> ''::text))
);


--
-- Name: sms_send_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.sms_send_attempts (
    app_id text NOT NULL,
    attempt_id uuid NOT NULL,
    ip_hmac text NOT NULL,
    phone_hmac text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT sms_send_attempts_ip_hmac_check CHECK ((ip_hmac ~ '^[0-9a-f]{32,128}$'::text)),
    CONSTRAINT sms_send_attempts_phone_hmac_check CHECK ((phone_hmac ~ '^[0-9a-f]{32,128}$'::text)),
    CONSTRAINT sms_send_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT sms_send_attempts_updated_check CHECK ((updated_at >= created_at))
);


--
-- Name: sync_cursors; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.sync_cursors (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    query_kind text NOT NULL,
    scene text NOT NULL,
    cursor_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_cursors_query_kind_check CHECK ((query_kind <> ''::text)),
    CONSTRAINT sync_cursors_scene_check CHECK ((scene <> ''::text))
);


--
-- Name: sync_cursors_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.sync_cursors ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.sync_cursors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tax_ytd; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.tax_ytd (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    year integer NOT NULL,
    income_type text NOT NULL,
    identity_hmac text NOT NULL,
    cum_income_fen bigint DEFAULT 0 NOT NULL,
    cum_withheld_fen bigint DEFAULT 0 NOT NULL,
    continuous_months integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_ytd_app_id_check CHECK ((app_id <> ''::text)),
    CONSTRAINT tax_ytd_continuous_months_check CHECK ((continuous_months >= 0)),
    CONSTRAINT tax_ytd_cum_income_fen_check CHECK ((cum_income_fen >= 0)),
    CONSTRAINT tax_ytd_cum_withheld_fen_check CHECK ((cum_withheld_fen >= 0)),
    CONSTRAINT tax_ytd_identity_hmac_check CHECK ((identity_hmac ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tax_ytd_income_type_check CHECK ((income_type = 'SERVICE_FEE'::text)),
    CONSTRAINT tax_ytd_year_check CHECK (((year >= 2026) AND (year <= 2100)))
);


--
-- Name: union_accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_accounts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    account_name text NOT NULL,
    status text NOT NULL,
    sync_start_at timestamp with time zone,
    auth_expires_at timestamp with time zone,
    auth_status text NOT NULL,
    auth_renewed_at timestamp with time zone,
    auth_renewed_by uuid,
    alert_stage text DEFAULT 'none'::text NOT NULL,
    last_probe_at timestamp with time zone,
    last_probe_ok boolean,
    last_probe_error text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_expires_estimated boolean DEFAULT false NOT NULL,
    CONSTRAINT union_accounts_alert_stage_check CHECK (((alert_stage = ANY (ARRAY['none'::text, 'expired'::text])) OR (alert_stage ~ '^d[1-9][0-9]{0,2}$'::text))),
    CONSTRAINT union_accounts_auth_status_check CHECK ((auth_status = ANY (ARRAY['active'::text, 'expiring'::text, 'expired'::text])))
);


--
-- Name: union_auth_sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_auth_sessions (
    state text NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    platform text NOT NULL,
    mode text NOT NULL,
    link_id uuid,
    expire_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client text NOT NULL,
    auth_methods text[],
    auth_app_refs jsonb,
    CONSTRAINT union_auth_sessions_auth_app_refs_check CHECK (((auth_app_refs IS NULL) OR
CASE
    WHEN ((auth_methods IS NOT NULL) AND (jsonb_typeof(auth_app_refs) = 'object'::text)) THEN ((auth_app_refs ?& auth_methods) AND ((auth_app_refs - auth_methods) = '{}'::jsonb) AND ((NOT (auth_app_refs ? 'web_code'::text)) OR ((jsonb_typeof((auth_app_refs -> 'web_code'::text)) = 'string'::text) AND ((auth_app_refs ->> 'web_code'::text) <> ''::text))) AND ((NOT (auth_app_refs ? 'sdk_token'::text)) OR ((jsonb_typeof((auth_app_refs -> 'sdk_token'::text)) = 'string'::text) AND ((auth_app_refs ->> 'sdk_token'::text) <> ''::text))))
    ELSE false
END)),
    CONSTRAINT union_auth_sessions_auth_app_refs_presence_check CHECK (((auth_app_refs IS NULL) = (auth_methods IS NULL))),
    CONSTRAINT union_auth_sessions_auth_methods_check CHECK (((auth_methods IS NULL) OR
CASE
    WHEN ((array_ndims(auth_methods) = 1) AND (array_lower(auth_methods, 1) = 1) AND (array_position(auth_methods, NULL::text) IS NULL) AND (auth_methods <@ ARRAY['web_code'::text, 'sdk_token'::text])) THEN ((cardinality(auth_methods) = 1) OR ((cardinality(auth_methods) = 2) AND (auth_methods[1] <> auth_methods[2])))
    ELSE false
END)),
    CONSTRAINT union_auth_sessions_auth_methods_platform_check CHECK (((platform = 'taobao'::text) = (auth_methods IS NOT NULL))),
    CONSTRAINT union_auth_sessions_client_check CHECK ((client = ANY (ARRAY['ios'::text, 'android'::text, 'harmony'::text]))),
    CONSTRAINT union_auth_sessions_mode_check CHECK ((mode = 'bind'::text))
);


--
-- Name: union_binding_conflicts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_binding_conflicts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    kind text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    resolution text,
    CONSTRAINT union_binding_conflicts_kind_check CHECK ((kind = ANY (ARRAY['occupied'::text, 'cooling'::text, 'rebind'::text]))),
    CONSTRAINT union_binding_conflicts_platform_check CHECK ((platform = ANY (ARRAY['taobao'::text, 'jd'::text, 'pdd'::text, 'meituan'::text, 'vip'::text, 'douyin'::text, 'eleme'::text, 'kuaishou'::text, 'suning'::text]))),
    CONSTRAINT union_binding_conflicts_resolution_check CHECK ((resolution = ANY (ARRAY['bound_active'::text, 'already_active'::text]))),
    CONSTRAINT union_binding_conflicts_resolution_pair_check CHECK (((resolved_at IS NULL) = (resolution IS NULL))),
    CONSTRAINT union_binding_conflicts_resolved_order_check CHECK ((resolved_at >= occurred_at))
);


--
-- Name: union_bindings; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_bindings (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    relation_id text,
    special_id text,
    pdd_custom text,
    status text NOT NULL,
    bound_at timestamp with time zone,
    released_at timestamp with time zone,
    cooldown_until timestamp with time zone,
    blocked_reason text,
    reason text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_bindings_blocked_reason_check CHECK ((blocked_reason = ANY (ARRAY['ban'::text, 'admin_disable'::text, 'deletion'::text]))),
    CONSTRAINT union_bindings_cooldown_order_check CHECK ((cooldown_until >= released_at)),
    CONSTRAINT union_bindings_release_pair_check CHECK (((released_at IS NULL) = (cooldown_until IS NULL))),
    CONSTRAINT union_bindings_released_instants_check CHECK (((status <> 'released'::text) OR (released_at IS NOT NULL))),
    CONSTRAINT union_bindings_status_check CHECK ((status = ANY (ARRAY['unbound'::text, 'pending_auth'::text, 'active'::text, 'invalid'::text, 'released'::text, 'blocked'::text])))
);


--
-- Name: union_credentials; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_credentials (
    id uuid NOT NULL,
    app_id text NOT NULL,
    union_account_id uuid NOT NULL,
    access_token_cipher bytea NOT NULL,
    refresh_token_cipher bytea,
    expires_at timestamp with time zone,
    is_current boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: union_pids; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_pids (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    site_id text,
    pid text NOT NULL,
    pid_scene text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    hjy_ignore_confirmed_at timestamp with time zone,
    hjy_ignore_evidence_path text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_pids_hjy_evidence_check CHECK (((status = 'pending'::text) OR ((hjy_ignore_confirmed_at IS NOT NULL) AND (hjy_ignore_evidence_path IS NOT NULL)))),
    CONSTRAINT union_pids_pid_scene_check CHECK ((pid_scene = ANY (ARRAY['self_buy'::text, 'agent'::text, 'share'::text, 'taolijin'::text, 'fallback'::text, 'query'::text]))),
    CONSTRAINT union_pids_site_check CHECK (((platform = 'taobao'::text) = (site_id IS NOT NULL))),
    CONSTRAINT union_pids_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'retired'::text])))
);


--
-- Name: union_raw_payloads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_raw_payloads (
    id bigint NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    kind text NOT NULL,
    payload bytea NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    request_summary jsonb NOT NULL,
    latency_ms integer NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_raw_payloads_latency_check CHECK ((latency_ms >= 0)),
    CONSTRAINT union_raw_payloads_request_summary_check CHECK ((jsonb_typeof(request_summary) = 'object'::text))
)
PARTITION BY RANGE (fetched_at);


--
-- Name: union_raw_payloads_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_raw_payloads_default (
    id bigint CONSTRAINT union_raw_payloads_id_not_null NOT NULL,
    app_id text CONSTRAINT union_raw_payloads_app_id_not_null NOT NULL,
    platform text CONSTRAINT union_raw_payloads_platform_not_null NOT NULL,
    kind text CONSTRAINT union_raw_payloads_kind_not_null NOT NULL,
    payload bytea CONSTRAINT union_raw_payloads_payload_not_null NOT NULL,
    fetched_at timestamp with time zone CONSTRAINT union_raw_payloads_fetched_at_not_null NOT NULL,
    content_hash text CONSTRAINT union_raw_payloads_content_hash_not_null NOT NULL,
    request_summary jsonb CONSTRAINT union_raw_payloads_request_summary_not_null NOT NULL,
    latency_ms integer CONSTRAINT union_raw_payloads_latency_ms_not_null NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT union_raw_payloads_created_at_not_null NOT NULL,
    CONSTRAINT union_raw_payloads_latency_check CHECK ((latency_ms >= 0)),
    CONSTRAINT union_raw_payloads_request_summary_check CHECK ((jsonb_typeof(request_summary) = 'object'::text))
);


--
-- Name: union_raw_payloads_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.union_raw_payloads ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.union_raw_payloads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_oauth; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_oauth (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    union_id text NOT NULL,
    open_id text,
    merged_from_user_id uuid,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    apple_refresh_token_cipher bytea,
    revoked_at timestamp with time zone,
    CONSTRAINT user_oauth_apple_refresh_token_provider_check CHECK (((apple_refresh_token_cipher IS NULL) OR (provider = 'apple'::text))),
    CONSTRAINT user_oauth_provider_check CHECK ((provider = ANY (ARRAY['wechat'::text, 'apple'::text, 'huawei'::text])))
);


--
-- Name: user_risk_state; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_risk_state (
    user_id uuid NOT NULL,
    app_id text NOT NULL,
    state text NOT NULL,
    reason text,
    reason_category text,
    frozen_until timestamp with time zone,
    changed_by text NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    penalty_started_at timestamp with time zone,
    CONSTRAINT user_risk_state_frozen_until_check CHECK (((frozen_until IS NULL) OR (state = ANY (ARRAY['frozen'::text, 'appealing'::text])))),
    CONSTRAINT user_risk_state_reason_category_check CHECK ((reason_category = ANY (ARRAY['malicious_rights'::text, 'fraud_invite'::text, 'abnormal_trade'::text, 'account_security'::text, 'other'::text]))),
    CONSTRAINT user_risk_state_reason_category_required_check CHECK (((state = 'normal'::text) OR (reason_category IS NOT NULL))),
    CONSTRAINT user_risk_state_state_check CHECK ((state = ANY (ARRAY['normal'::text, 'frozen'::text, 'appealing'::text, 'banned'::text])))
);


--
-- Name: user_tip_reads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_tip_reads (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    tip_key text NOT NULL,
    platform text NOT NULL,
    read_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_tip_reads_tip_key_check CHECK ((tip_key = ANY (ARRAY['jump_tip'::text, 'inviter_before_buy'::text])))
);


--
-- Name: users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.users (
    id uuid NOT NULL,
    app_id text NOT NULL,
    phone_cipher bytea,
    phone_hmac text,
    nickname text NOT NULL,
    avatar text NOT NULL,
    nickname_change_month text,
    nickname_change_count integer DEFAULT 0 NOT NULL,
    invite_code text NOT NULL,
    attr_code text NOT NULL,
    parent_id uuid,
    parent_bind_source text,
    parent_bound_at timestamp with time zone,
    self_bind_used boolean DEFAULT false NOT NULL,
    level text NOT NULL,
    status text DEFAULT 'normal'::text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    deleted_reason text,
    personalization_off boolean DEFAULT false NOT NULL,
    register_method text NOT NULL,
    registered_channel text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone,
    last_login_device_hash text,
    reverify_flagged_at timestamp with time zone,
    reverify_trusted jsonb,
    reverify_fail_count integer DEFAULT 0 NOT NULL,
    reverify_fail_day date,
    CONSTRAINT users_last_login_device_hash_check CHECK ((last_login_device_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT users_nickname_change_month_check CHECK ((nickname_change_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT users_reverify_fail_count_check CHECK ((reverify_fail_count >= 0)),
    CONSTRAINT users_reverify_trusted_check CHECK (((jsonb_typeof(reverify_trusted) = 'object'::text) AND (jsonb_typeof((reverify_trusted -> 'realname'::text)) = 'boolean'::text) AND (jsonb_typeof((reverify_trusted -> 'providers'::text)) = 'array'::text)))
);


--
-- Name: withdraw_holds; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.withdraw_holds (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    reason text NOT NULL,
    source_ref text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hold_until timestamp with time zone,
    released_at timestamp with time zone,
    released_by text,
    CONSTRAINT withdraw_holds_created_by_check CHECK ((created_by <> ''::text)),
    CONSTRAINT withdraw_holds_reason_check CHECK ((reason = ANY (ARRAY['manual'::text, 'recon_diff'::text, 'ledger_mismatch'::text, 'manual_failed_watch'::text]))),
    CONSTRAINT withdraw_holds_released_check CHECK (((released_at IS NULL) = (released_by IS NULL)))
);


--
-- Name: withdrawals; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.withdrawals (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    amount_fen bigint NOT NULL,
    fee_fen bigint NOT NULL,
    tax_fen bigint NOT NULL,
    net_fen bigint NOT NULL,
    income_type text NOT NULL,
    fee_rule_id uuid,
    tax_rule_version text,
    payout_method text NOT NULL,
    payee_name text NOT NULL,
    payee_account_cipher bytea NOT NULL,
    payee_hmac text NOT NULL,
    bank_name text,
    wechat_app_id text,
    channel_state text,
    confirm_deadline timestamp with time zone,
    wechat_launch_cipher bytea,
    status text NOT NULL,
    out_biz_no text NOT NULL,
    review_mode text,
    auto_decision jsonb,
    review_deadline timestamp with time zone,
    reviewer_id uuid,
    reviewed_at timestamp with time zone,
    reject_reason_code text,
    reject_note text,
    fail_code text,
    executor_id uuid,
    executed_at timestamp with time zone,
    batch_id uuid,
    execute_seq integer DEFAULT 0 NOT NULL,
    needs_manual boolean DEFAULT false NOT NULL,
    manual_resolution text,
    resolver_ids jsonb,
    proof_file text,
    manual_entry_by uuid,
    manual_confirm_by uuid,
    hold_reason text,
    hold_at timestamp with time zone,
    blocked_reason text,
    risk_flags jsonb,
    risk_flags_at timestamp with time zone,
    payout_channel text NOT NULL,
    paid_at timestamp with time zone,
    channel_order_id text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_overdue_at timestamp with time zone,
    CONSTRAINT withdrawals_amount_check CHECK ((amount_fen > 0)),
    CONSTRAINT withdrawals_auto_decision_check CHECK (((auto_decision IS NULL) OR (jsonb_typeof(auto_decision) = 'object'::text))),
    CONSTRAINT withdrawals_bank_name_check CHECK (((payout_method = 'bank_card'::text) = (bank_name IS NOT NULL))),
    CONSTRAINT withdrawals_blocked_reason_check CHECK (((blocked_reason IS NULL) OR (blocked_reason = 'NEGATIVE_BALANCE'::text))),
    CONSTRAINT withdrawals_channel_order_id_check CHECK (((channel_order_id IS NULL) OR (channel_order_id <> ''::text))),
    CONSTRAINT withdrawals_channel_state_check CHECK (((channel_state IS NULL) OR (channel_state = ANY (ARRAY['processing'::text, 'wait_user_confirm'::text, 'canceling'::text])))),
    CONSTRAINT withdrawals_execute_seq_check CHECK ((execute_seq >= 0)),
    CONSTRAINT withdrawals_fee_check CHECK ((fee_fen >= 0)),
    CONSTRAINT withdrawals_hold_at_check CHECK (((hold_reason IS NULL) = (hold_at IS NULL))),
    CONSTRAINT withdrawals_hold_reason_check CHECK (((hold_reason IS NULL) OR (hold_reason = ANY (ARRAY['payout_disabled'::text, 'queue_paused'::text, 'channel_disabled'::text, 'member_blocked'::text, 'single_cap'::text, 'daily_cap'::text, 'payer_side_after_transfer'::text])))),
    CONSTRAINT withdrawals_income_type_check CHECK ((income_type = 'SERVICE_FEE'::text)),
    CONSTRAINT withdrawals_manual_resolution_check CHECK (((manual_resolution IS NULL) OR (manual_resolution = ANY (ARRAY['paid'::text, 'failed'::text])))),
    CONSTRAINT withdrawals_needs_manual_check CHECK (((NOT needs_manual) OR (status = ANY (ARRAY['PAYING'::text, 'REJECTED'::text, 'PAID_API'::text, 'PAID_MANUAL'::text, 'FAILED'::text])))),
    CONSTRAINT withdrawals_net_check CHECK (((net_fen >= 0) AND (net_fen = ((amount_fen - fee_fen) - tax_fen)))),
    CONSTRAINT withdrawals_out_biz_no_check CHECK ((out_biz_no ~ '^[A-Za-z0-9]{1,32}$'::text)),
    CONSTRAINT withdrawals_paid_check CHECK (((status <> ALL (ARRAY['PAID_API'::text, 'PAID_MANUAL'::text])) OR (paid_at IS NOT NULL))),
    CONSTRAINT withdrawals_paid_manual_check CHECK (((status <> 'PAID_MANUAL'::text) OR ((manual_entry_by IS NOT NULL) AND (manual_confirm_by IS NOT NULL)))),
    CONSTRAINT withdrawals_payee_hmac_check CHECK ((payee_hmac <> ''::text)),
    CONSTRAINT withdrawals_payee_name_check CHECK ((payee_name <> ''::text)),
    CONSTRAINT withdrawals_payout_channel_check CHECK ((payout_channel = ANY (ARRAY['alipay'::text, 'bank_card'::text, 'wechat'::text]))),
    CONSTRAINT withdrawals_payout_method_check CHECK ((payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text, 'wechat'::text]))),
    CONSTRAINT withdrawals_reject_reason_check CHECK (((reject_reason_code IS NULL) OR (reject_reason_code = ANY (ARRAY['RISK_SUSPECT'::text, 'ORDER_ABNORMAL'::text, 'PAYEE_INFO_INVALID'::text, 'USER_REQUEST'::text, 'OTHER'::text, 'NEGATIVE_BALANCE'::text])))),
    CONSTRAINT withdrawals_rejected_check CHECK (((status <> 'REJECTED'::text) OR (reject_reason_code IS NOT NULL))),
    CONSTRAINT withdrawals_resolver_ids_check CHECK (((resolver_ids IS NULL) OR (jsonb_typeof(resolver_ids) = 'array'::text))),
    CONSTRAINT withdrawals_review_mode_check CHECK (((review_mode IS NULL) OR (review_mode = ANY (ARRAY['auto'::text, 'manual'::text])))),
    CONSTRAINT withdrawals_risk_flags_check CHECK (((risk_flags IS NULL) OR (jsonb_typeof(risk_flags) = 'array'::text))),
    CONSTRAINT withdrawals_row_version_check CHECK ((row_version >= 0)),
    CONSTRAINT withdrawals_status_check CHECK ((status = ANY (ARRAY['PENDING_REVIEW'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAYING'::text, 'PAID_API'::text, 'PAID_MANUAL'::text, 'FAILED'::text]))),
    CONSTRAINT withdrawals_tax_check CHECK ((tax_fen >= 0)),
    CONSTRAINT withdrawals_wechat_app_id_check CHECK (((payout_method = 'wechat'::text) = (wechat_app_id IS NOT NULL))),
    CONSTRAINT withdrawals_wechat_only_check CHECK (((payout_method = 'wechat'::text) OR ((channel_state IS NULL) AND (confirm_deadline IS NULL) AND (wechat_launch_cipher IS NULL))))
);


--
-- Name: bam; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.bam (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    queue text,
    table_name text NOT NULL,
    command text NOT NULL,
    error text,
    created_on timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone
);


--
-- Name: job; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state NOT NULL,
    retry_limit integer DEFAULT 2 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    retry_delay integer DEFAULT 0 NOT NULL,
    retry_backoff boolean DEFAULT false NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 NOT NULL,
    deletion_seconds integer DEFAULT 604800 NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    pending_dependencies integer DEFAULT 0 NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer
)
PARTITION BY LIST (name);


--
-- Name: job_common; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_common (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT job_id_not_null NOT NULL,
    name text CONSTRAINT job_name_not_null NOT NULL,
    priority integer DEFAULT 0 CONSTRAINT job_priority_not_null NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state CONSTRAINT job_state_not_null NOT NULL,
    retry_limit integer DEFAULT 2 CONSTRAINT job_retry_limit_not_null NOT NULL,
    retry_count integer DEFAULT 0 CONSTRAINT job_retry_count_not_null NOT NULL,
    retry_delay integer DEFAULT 0 CONSTRAINT job_retry_delay_not_null NOT NULL,
    retry_backoff boolean DEFAULT false CONSTRAINT job_retry_backoff_not_null NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 CONSTRAINT job_expire_seconds_not_null NOT NULL,
    deletion_seconds integer DEFAULT 604800 CONSTRAINT job_deletion_seconds_not_null NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() CONSTRAINT job_start_after_not_null NOT NULL,
    created_on timestamp with time zone DEFAULT now() CONSTRAINT job_created_on_not_null NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) CONSTRAINT job_keep_until_not_null NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false CONSTRAINT job_blocked_not_null NOT NULL,
    blocking boolean DEFAULT false CONSTRAINT job_blocking_not_null NOT NULL,
    pending_dependencies integer DEFAULT 0 CONSTRAINT job_pending_dependencies_not_null NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer,
    CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))
);


--
-- Name: job_dependency; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_dependency (
    child_name text NOT NULL,
    child_id uuid NOT NULL,
    parent_name text NOT NULL,
    parent_id uuid NOT NULL
);


--
-- Name: queue; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue (
    name text NOT NULL,
    policy text NOT NULL,
    retry_limit integer NOT NULL,
    retry_delay integer NOT NULL,
    retry_backoff boolean NOT NULL,
    retry_delay_max integer,
    expire_seconds integer NOT NULL,
    retention_seconds integer NOT NULL,
    deletion_seconds integer NOT NULL,
    dead_letter text,
    partition boolean NOT NULL,
    table_name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    warning_queued integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    ready_history integer[] DEFAULT '{}'::integer[] NOT NULL,
    heartbeat_seconds integer,
    notify boolean DEFAULT false NOT NULL,
    singletons_active text[],
    monitor_claim_on timestamp with time zone,
    monitor_on timestamp with time zone,
    maintain_on timestamp with time zone,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_check CHECK ((dead_letter IS DISTINCT FROM name))
);


--
-- Name: queue_stats; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (captured_on);


--
-- Name: schedule; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.schedule (
    name text NOT NULL,
    key text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'cron'::text NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text,
    data jsonb,
    options jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    last_job_id uuid,
    CONSTRAINT schedule_kind_check CHECK ((kind = ANY (ARRAY['cron'::text, 'rrule'::text])))
);


--
-- Name: subscription; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.subscription (
    event text NOT NULL,
    name text NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: version; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.version (
    version integer NOT NULL,
    cron_on timestamp with time zone,
    bam_on timestamp with time zone,
    flow_on timestamp with time zone,
    reindex_on timestamp with time zone,
    monitor_backoff_on timestamp with time zone
);


--
-- Name: warning; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.warning (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: event_log_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log ATTACH PARTITION app.event_log_default DEFAULT;


--
-- Name: ledger_entries_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_entries ATTACH PARTITION app.ledger_entries_default DEFAULT;


--
-- Name: link_logs_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs ATTACH PARTITION app.link_logs_default DEFAULT;


--
-- Name: orders_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders ATTACH PARTITION app.orders_default DEFAULT;


--
-- Name: price_snapshot_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.price_snapshot ATTACH PARTITION app.price_snapshot_default DEFAULT;


--
-- Name: union_raw_payloads_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_raw_payloads ATTACH PARTITION app.union_raw_payloads_default DEFAULT;


--
-- Name: job_common; Type: TABLE ATTACH; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: account_balances account_balances_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.account_balances
    ADD CONSTRAINT account_balances_pkey PRIMARY KEY (account_id);


--
-- Name: admin_permissions admin_permissions_admin_permission_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_admin_permission_key UNIQUE (app_id, admin_id, permission_key);


--
-- Name: admin_permissions admin_permissions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_pkey PRIMARY KEY (id);


--
-- Name: admin_union_auth_sessions admin_union_auth_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_union_auth_sessions
    ADD CONSTRAINT admin_union_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: admin_union_auth_sessions admin_union_auth_sessions_state_hash_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_union_auth_sessions
    ADD CONSTRAINT admin_union_auth_sessions_state_hash_key UNIQUE (state_hash);


--
-- Name: admin_users admin_users_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_app_id_id_key UNIQUE (app_id, id);


--
-- Name: admin_users admin_users_login_name_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_login_name_key UNIQUE (login_name);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: agent_cards agent_cards_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_pkey PRIMARY KEY (id);


--
-- Name: agent_cards agent_cards_session_card_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_session_card_key UNIQUE (app_id, session_id, card_id);


--
-- Name: agent_clarify_asks agent_clarify_asks_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_clarify_asks
    ADD CONSTRAINT agent_clarify_asks_pkey PRIMARY KEY (app_id, session_id, chain_id, slot);


--
-- Name: agent_messages agent_messages_client_msg_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_client_msg_key UNIQUE (app_id, session_id, client_msg_id);


--
-- Name: agent_messages agent_messages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);


--
-- Name: agent_result_chains agent_result_chains_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_chains
    ADD CONSTRAINT agent_result_chains_pkey PRIMARY KEY (app_id, session_id, seq);


--
-- Name: agent_result_deliveries agent_result_deliveries_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_deliveries
    ADD CONSTRAINT agent_result_deliveries_pkey PRIMARY KEY (app_id, session_id, card_id);


--
-- Name: agent_result_sets agent_result_sets_app_id_run_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_sets
    ADD CONSTRAINT agent_result_sets_app_id_run_id_id_key UNIQUE (app_id, run_id, id);


--
-- Name: agent_result_sets agent_result_sets_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_sets
    ADD CONSTRAINT agent_result_sets_pkey PRIMARY KEY (id);


--
-- Name: agent_rule_chunks agent_rule_chunks_article_id_published_version_seq_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_rule_chunks
    ADD CONSTRAINT agent_rule_chunks_article_id_published_version_seq_key UNIQUE (article_id, published_version, seq);


--
-- Name: agent_rule_chunks agent_rule_chunks_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_rule_chunks
    ADD CONSTRAINT agent_rule_chunks_pkey PRIMARY KEY (chunk_id);


--
-- Name: agent_runs agent_runs_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_app_id_id_key UNIQUE (app_id, id);


--
-- Name: agent_runs agent_runs_app_id_session_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_app_id_session_id_id_key UNIQUE (app_id, session_id, id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_app_id_id_key UNIQUE (app_id, id);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_run_seq_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_run_seq_key UNIQUE (app_id, run_id, seq);


--
-- Name: agreements agreements_app_type_version_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agreements
    ADD CONSTRAINT agreements_app_type_version_key UNIQUE (app_id, type, version);


--
-- Name: agreements agreements_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agreements
    ADD CONSTRAINT agreements_pkey PRIMARY KEY (id);


--
-- Name: app_versions app_versions_app_platform_channel_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_versions
    ADD CONSTRAINT app_versions_app_platform_channel_key UNIQUE (app_id, platform, channel);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (id);


--
-- Name: appeal_claims appeal_claims_appeal_version_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeal_claims
    ADD CONSTRAINT appeal_claims_appeal_version_key UNIQUE (appeal_id, row_version);


--
-- Name: appeal_claims appeal_claims_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeal_claims
    ADD CONSTRAINT appeal_claims_pkey PRIMARY KEY (id);


--
-- Name: appeals appeals_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeals
    ADD CONSTRAINT appeals_pkey PRIMARY KEY (id);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id, version);


--
-- Name: asset_snapshot_receivables asset_snapshot_receivables_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.asset_snapshot_receivables
    ADD CONSTRAINT asset_snapshot_receivables_pkey PRIMARY KEY (asset_snapshot_id, platform);


--
-- Name: asset_snapshots asset_snapshots_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.asset_snapshots
    ADD CONSTRAINT asset_snapshots_app_id_id_key UNIQUE (app_id, id);


--
-- Name: asset_snapshots asset_snapshots_day_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.asset_snapshots
    ADD CONSTRAINT asset_snapshots_day_key UNIQUE (app_id, snapshot_date);


--
-- Name: asset_snapshots asset_snapshots_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.asset_snapshots
    ADD CONSTRAINT asset_snapshots_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: beneficiary_credits beneficiary_credits_item_ref_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.beneficiary_credits
    ADD CONSTRAINT beneficiary_credits_item_ref_key UNIQUE (app_id, beneficiary_credit_id, order_id, user_id, role);


--
-- Name: beneficiary_credits beneficiary_credits_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.beneficiary_credits
    ADD CONSTRAINT beneficiary_credits_pkey PRIMARY KEY (beneficiary_credit_id);


--
-- Name: blocklist blocklist_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.blocklist
    ADD CONSTRAINT blocklist_pkey PRIMARY KEY (id);


--
-- Name: category_blocklist category_blocklist_entry_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_entry_key UNIQUE NULLS NOT DISTINCT (app_id, platform, category_id, keyword);


--
-- Name: category_blocklist category_blocklist_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_pkey PRIMARY KEY (id);


--
-- Name: claim_items claim_items_applicant_order_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claim_items
    ADD CONSTRAINT claim_items_applicant_order_key UNIQUE (app_id, applicant_user_id, platform, sub_order_id);


--
-- Name: claim_items claim_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claim_items
    ADD CONSTRAINT claim_items_pkey PRIMARY KEY (id);


--
-- Name: claims claims_item_ref_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claims
    ADD CONSTRAINT claims_item_ref_key UNIQUE (app_id, id, user_id, platform);


--
-- Name: claims claims_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claims
    ADD CONSTRAINT claims_pkey PRIMARY KEY (id);


--
-- Name: commission_rule_reserves commission_rule_reserves_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_reserves
    ADD CONSTRAINT commission_rule_reserves_pkey PRIMARY KEY (rule_version_id, platform);


--
-- Name: commission_rule_trials commission_rule_trials_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_trials
    ADD CONSTRAINT commission_rule_trials_pkey PRIMARY KEY (trial_id);


--
-- Name: commission_rule_versions commission_rule_versions_app_id_rule_version_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_app_id_rule_version_id_key UNIQUE (app_id, rule_version_id);


--
-- Name: commission_rule_versions commission_rule_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_pkey PRIMARY KEY (rule_version_id);


--
-- Name: commission_rules commission_rules_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (rule_version_id, platform, level, order_type);


--
-- Name: commission_split_amounts commission_split_amounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_amounts
    ADD CONSTRAINT commission_split_amounts_pkey PRIMARY KEY (app_id, order_id, commission_version, user_id, role);


--
-- Name: commission_split_beneficiary_events commission_split_beneficiary_events_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_beneficiary_events
    ADD CONSTRAINT commission_split_beneficiary_events_pkey PRIMARY KEY (event_seq);


--
-- Name: commission_split_totals commission_split_totals_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_totals
    ADD CONSTRAINT commission_split_totals_pkey PRIMARY KEY (app_id, order_id, commission_version);


--
-- Name: commission_splits commission_splits_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_splits
    ADD CONSTRAINT commission_splits_pkey PRIMARY KEY (order_id);


--
-- Name: config_item_versions config_item_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.config_item_versions
    ADD CONSTRAINT config_item_versions_pkey PRIMARY KEY (app_id, key, version);


--
-- Name: config_items config_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.config_items
    ADD CONSTRAINT config_items_pkey PRIMARY KEY (app_id, key);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: daily_balances daily_balances_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.daily_balances
    ADD CONSTRAINT daily_balances_pkey PRIMARY KEY (app_id, account_id, sub_account, accounting_date);


--
-- Name: deleted_identities deleted_identities_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.deleted_identities
    ADD CONSTRAINT deleted_identities_pkey PRIMARY KEY (id);


--
-- Name: deletion_requests deletion_requests_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.deletion_requests
    ADD CONSTRAINT deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: device_registrations device_registrations_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_pkey PRIMARY KEY (app_id, user_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: dict_items dict_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.dict_items
    ADD CONSTRAINT dict_items_pkey PRIMARY KEY (app_id, dict, code, version);


--
-- Name: event_log event_log_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log
    ADD CONSTRAINT event_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: event_log_default event_log_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log_default
    ADD CONSTRAINT event_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: export_tasks export_tasks_app_id_public_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.export_tasks
    ADD CONSTRAINT export_tasks_app_id_public_id_key UNIQUE (app_id, public_id);


--
-- Name: export_tasks export_tasks_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.export_tasks
    ADD CONSTRAINT export_tasks_pkey PRIMARY KEY (id);


--
-- Name: favorites favorites_app_id_user_id_platform_product_key_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.favorites
    ADD CONSTRAINT favorites_app_id_user_id_platform_product_key_key UNIQUE (app_id, user_id, platform, product_key);


--
-- Name: favorites favorites_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.favorites
    ADD CONSTRAINT favorites_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_scope_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key);


--
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (message_id);


--
-- Name: invite_reward_budgets invite_reward_budgets_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_reward_budgets
    ADD CONSTRAINT invite_reward_budgets_pkey PRIMARY KEY (app_id, period);


--
-- Name: invite_rewards invite_rewards_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_pkey PRIMARY KEY (app_id, invitee_id);


--
-- Name: landing_registrations landing_registrations_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.landing_registrations
    ADD CONSTRAINT landing_registrations_pkey PRIMARY KEY (app_id, user_id);


--
-- Name: ledger_accounts ledger_accounts_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_accounts
    ADD CONSTRAINT ledger_accounts_app_id_id_key UNIQUE (app_id, id);


--
-- Name: ledger_accounts ledger_accounts_owner_subject_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_accounts
    ADD CONSTRAINT ledger_accounts_owner_subject_key UNIQUE (app_id, owner_type, owner_id, subject);


--
-- Name: ledger_accounts ledger_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_accounts
    ADD CONSTRAINT ledger_accounts_pkey PRIMARY KEY (id);


--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id, booked_at);


--
-- Name: ledger_entries_default ledger_entries_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_entries_default
    ADD CONSTRAINT ledger_entries_default_pkey PRIMARY KEY (id, booked_at);


--
-- Name: ledger_vouchers ledger_vouchers_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_vouchers
    ADD CONSTRAINT ledger_vouchers_app_id_id_key UNIQUE (app_id, id);


--
-- Name: ledger_vouchers ledger_vouchers_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_vouchers
    ADD CONSTRAINT ledger_vouchers_pkey PRIMARY KEY (id);


--
-- Name: ledger_vouchers ledger_vouchers_uniq_key_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.ledger_vouchers
    ADD CONSTRAINT ledger_vouchers_uniq_key_key UNIQUE (app_id, uniq_key);


--
-- Name: level_change_logs level_change_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.level_change_logs
    ADD CONSTRAINT level_change_logs_pkey PRIMARY KEY (id);


--
-- Name: link_logs link_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs
    ADD CONSTRAINT link_logs_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_logs_default link_logs_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs_default
    ADD CONSTRAINT link_logs_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_open_attempts link_open_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_pkey PRIMARY KEY (attempt_id);


--
-- Name: links links_app_id_link_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_app_id_link_id_key UNIQUE (app_id, link_id);


--
-- Name: links links_app_id_lk_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_app_id_lk_key UNIQUE (app_id, lk);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (link_id);


--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (app_id, user_id);


--
-- Name: notify_logs notify_logs_dedupe_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notify_logs
    ADD CONSTRAINT notify_logs_dedupe_key UNIQUE (app_id, dedupe_key);


--
-- Name: notify_logs notify_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notify_logs
    ADD CONSTRAINT notify_logs_pkey PRIMARY KEY (id);


--
-- Name: notify_templates notify_templates_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notify_templates
    ADD CONSTRAINT notify_templates_pkey PRIMARY KEY (app_id, code, variant);


--
-- Name: order_assignments order_assignments_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_assignments
    ADD CONSTRAINT order_assignments_pkey PRIMARY KEY (id);


--
-- Name: order_keys order_keys_app_order_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_app_order_key UNIQUE (app_id, order_id);


--
-- Name: order_keys order_keys_claim_ref_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_claim_ref_key UNIQUE (app_id, platform, sub_order_id, order_id);


--
-- Name: order_keys order_keys_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_identity_key UNIQUE (order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: order_keys order_keys_order_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_order_id_key UNIQUE (order_id);


--
-- Name: order_keys order_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_pkey PRIMARY KEY (platform, sub_order_id);


--
-- Name: order_rights order_rights_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_pkey PRIMARY KEY (id);


--
-- Name: order_settlements order_settlements_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_pkey PRIMARY KEY (order_id, seq);


--
-- Name: order_status_history order_status_history_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_status_history
    ADD CONSTRAINT order_status_history_pkey PRIMARY KEY (id);


--
-- Name: order_sync_counters order_sync_counters_day_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_counters
    ADD CONSTRAINT order_sync_counters_day_key UNIQUE (app_id, platform, date, counter);


--
-- Name: order_sync_counters order_sync_counters_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_counters
    ADD CONSTRAINT order_sync_counters_pkey PRIMARY KEY (id);


--
-- Name: order_sync_drop_keys order_sync_drop_keys_dedup_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_drop_keys
    ADD CONSTRAINT order_sync_drop_keys_dedup_key UNIQUE (app_id, platform, sub_order_id, reason);


--
-- Name: order_sync_drop_keys order_sync_drop_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_drop_keys
    ADD CONSTRAINT order_sync_drop_keys_pkey PRIMARY KEY (id);


--
-- Name: order_sync_drops order_sync_drops_day_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_drops
    ADD CONSTRAINT order_sync_drops_day_key UNIQUE (app_id, platform, date, reason);


--
-- Name: order_sync_drops order_sync_drops_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_drops
    ADD CONSTRAINT order_sync_drops_pkey PRIMARY KEY (id);


--
-- Name: order_sync_pending order_sync_pending_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_pending
    ADD CONSTRAINT order_sync_pending_pkey PRIMARY KEY (id);


--
-- Name: order_sync_request_windows order_sync_request_windows_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_request_windows
    ADD CONSTRAINT order_sync_request_windows_pkey PRIMARY KEY (sync_id, seq);


--
-- Name: order_sync_request_windows order_sync_request_windows_window_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_request_windows
    ADD CONSTRAINT order_sync_request_windows_window_key UNIQUE NULLS NOT DISTINCT (sync_id, union_account_id, window_start);


--
-- Name: order_sync_requests order_sync_requests_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_requests
    ADD CONSTRAINT order_sync_requests_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: orders_default orders_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders_default
    ADD CONSTRAINT orders_default_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: page_preview_tokens page_preview_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_preview_tokens
    ADD CONSTRAINT page_preview_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: page_versions page_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_versions
    ADD CONSTRAINT page_versions_pkey PRIMARY KEY (app_id, page_key, version);


--
-- Name: pages pages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (app_id, page_key);


--
-- Name: pay_anomalies pay_anomalies_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_anomalies
    ADD CONSTRAINT pay_anomalies_app_id_id_key UNIQUE (app_id, id);


--
-- Name: pay_anomalies pay_anomalies_channel_trade_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_anomalies
    ADD CONSTRAINT pay_anomalies_channel_trade_no_key UNIQUE (app_id, pay_channel, channel_trade_no);


--
-- Name: pay_anomalies pay_anomalies_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_anomalies
    ADD CONSTRAINT pay_anomalies_pkey PRIMARY KEY (id);


--
-- Name: pay_fulfillments pay_fulfillments_biz_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_fulfillments
    ADD CONSTRAINT pay_fulfillments_biz_key UNIQUE (app_id, biz_type, biz_ref);


--
-- Name: pay_fulfillments pay_fulfillments_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_fulfillments
    ADD CONSTRAINT pay_fulfillments_pkey PRIMARY KEY (id);


--
-- Name: pay_notifications pay_notifications_notify_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_notifications
    ADD CONSTRAINT pay_notifications_notify_id_key UNIQUE (app_id, pay_channel, notify_id);


--
-- Name: pay_notifications pay_notifications_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_notifications
    ADD CONSTRAINT pay_notifications_pkey PRIMARY KEY (id);


--
-- Name: pay_orders pay_orders_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_orders
    ADD CONSTRAINT pay_orders_app_id_id_key UNIQUE (app_id, id);


--
-- Name: pay_orders pay_orders_out_trade_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_orders
    ADD CONSTRAINT pay_orders_out_trade_no_key UNIQUE (app_id, out_trade_no);


--
-- Name: pay_orders pay_orders_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_orders
    ADD CONSTRAINT pay_orders_pkey PRIMARY KEY (id);


--
-- Name: pay_query_attempts pay_query_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_query_attempts
    ADD CONSTRAINT pay_query_attempts_pkey PRIMARY KEY (id);


--
-- Name: pay_recon_days pay_recon_days_day_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_recon_days
    ADD CONSTRAINT pay_recon_days_day_key UNIQUE (app_id, pay_channel, bill_date);


--
-- Name: pay_recon_days pay_recon_days_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_recon_days
    ADD CONSTRAINT pay_recon_days_pkey PRIMARY KEY (id);


--
-- Name: pay_refunds pay_refunds_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_refunds
    ADD CONSTRAINT pay_refunds_app_id_id_key UNIQUE (app_id, id);


--
-- Name: pay_refunds pay_refunds_idempotency_key_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_refunds
    ADD CONSTRAINT pay_refunds_idempotency_key_key UNIQUE (app_id, operator, idempotency_key);


--
-- Name: pay_refunds pay_refunds_out_refund_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_refunds
    ADD CONSTRAINT pay_refunds_out_refund_no_key UNIQUE (app_id, out_refund_no);


--
-- Name: pay_refunds pay_refunds_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_refunds
    ADD CONSTRAINT pay_refunds_pkey PRIMARY KEY (id);


--
-- Name: payout_account_changes payout_account_changes_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_changes
    ADD CONSTRAINT payout_account_changes_pkey PRIMARY KEY (id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_pkey PRIMARY KEY (id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_vendor_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_vendor_key UNIQUE (app_id, vendor_request_id);


--
-- Name: payout_accounts payout_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_accounts
    ADD CONSTRAINT payout_accounts_pkey PRIMARY KEY (id);


--
-- Name: payout_attempts payout_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_attempts
    ADD CONSTRAINT payout_attempts_pkey PRIMARY KEY (id);


--
-- Name: payout_batch_items payout_batch_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_batch_items
    ADD CONSTRAINT payout_batch_items_pkey PRIMARY KEY (id);


--
-- Name: payout_batches payout_batches_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_batches
    ADD CONSTRAINT payout_batches_pkey PRIMARY KEY (id);


--
-- Name: payout_recon_runs payout_recon_runs_day_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_recon_runs
    ADD CONSTRAINT payout_recon_runs_day_key UNIQUE (app_id, channel, bill_date);


--
-- Name: payout_recon_runs payout_recon_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_recon_runs
    ADD CONSTRAINT payout_recon_runs_pkey PRIMARY KEY (id);


--
-- Name: payout_watermarks payout_watermarks_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_watermarks
    ADD CONSTRAINT payout_watermarks_pkey PRIMARY KEY (id);


--
-- Name: personal_data_copies personal_data_copies_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.personal_data_copies
    ADD CONSTRAINT personal_data_copies_app_id_id_key UNIQUE (app_id, id);


--
-- Name: personal_data_copies personal_data_copies_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.personal_data_copies
    ADD CONSTRAINT personal_data_copies_pkey PRIMARY KEY (id);


--
-- Name: platform_icon_uploads platform_icon_uploads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_uploads
    ADD CONSTRAINT platform_icon_uploads_pkey PRIMARY KEY (id);


--
-- Name: platform_icon_versions platform_icon_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_versions
    ADD CONSTRAINT platform_icon_versions_pkey PRIMARY KEY (app_id, key, version);


--
-- Name: platform_icon_versions platform_icon_versions_upload_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_versions
    ADD CONSTRAINT platform_icon_versions_upload_id_key UNIQUE (upload_id);


--
-- Name: platform_icons platform_icons_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icons
    ADD CONSTRAINT platform_icons_pkey PRIMARY KEY (app_id, key);


--
-- Name: platforms platforms_key_prefix_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platforms
    ADD CONSTRAINT platforms_key_prefix_key UNIQUE (key_prefix);


--
-- Name: platforms platforms_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platforms
    ADD CONSTRAINT platforms_pkey PRIMARY KEY (code);


--
-- Name: pool_items pool_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pool_items
    ADD CONSTRAINT pool_items_pkey PRIMARY KEY (app_id, pool_id, product_key);


--
-- Name: price_snapshot price_snapshot_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.price_snapshot
    ADD CONSTRAINT price_snapshot_pkey PRIMARY KEY (id, first_observed_at);


--
-- Name: price_snapshot_default price_snapshot_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.price_snapshot_default
    ADD CONSTRAINT price_snapshot_default_pkey PRIMARY KEY (id, first_observed_at);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id);


--
-- Name: product_key_aliases product_key_aliases_new_key_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_key_aliases
    ADD CONSTRAINT product_key_aliases_new_key_key UNIQUE (new_key);


--
-- Name: product_key_aliases product_key_aliases_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_key_aliases
    ADD CONSTRAINT product_key_aliases_pkey PRIMARY KEY (old_key);


--
-- Name: product_pools product_pools_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_pools
    ADD CONSTRAINT product_pools_pkey PRIMARY KEY (app_id, pool_id);


--
-- Name: product_refs product_refs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_refs
    ADD CONSTRAINT product_refs_pkey PRIMARY KEY (app_id, product_key);


--
-- Name: push_tokens push_tokens_device_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_provider_key UNIQUE (app_id, device_id, provider);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


--
-- Name: realname realname_app_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.realname
    ADD CONSTRAINT realname_app_id_key UNIQUE (app_id, id);


--
-- Name: realname realname_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.realname
    ADD CONSTRAINT realname_pkey PRIMARY KEY (id);


--
-- Name: realname realname_user_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.realname
    ADD CONSTRAINT realname_user_key UNIQUE (app_id, user_id);


--
-- Name: recon_channel recon_channel_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.recon_channel
    ADD CONSTRAINT recon_channel_pkey PRIMARY KEY (id);


--
-- Name: recon_diffs recon_diffs_business_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.recon_diffs
    ADD CONSTRAINT recon_diffs_business_key UNIQUE (app_id, type, period, ref_id);


--
-- Name: recon_diffs recon_diffs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.recon_diffs
    ADD CONSTRAINT recon_diffs_pkey PRIMARY KEY (id);


--
-- Name: recon_union recon_union_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.recon_union
    ADD CONSTRAINT recon_union_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_parent_hash_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_parent_hash_key UNIQUE (app_id, parent_hash);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (app_id, token_hash);


--
-- Name: relation_change_logs relation_change_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.relation_change_logs
    ADD CONSTRAINT relation_change_logs_pkey PRIMARY KEY (id);


--
-- Name: reverified_devices reverified_devices_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.reverified_devices
    ADD CONSTRAINT reverified_devices_pkey PRIMARY KEY (id);


--
-- Name: reverified_devices reverified_devices_user_device_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.reverified_devices
    ADD CONSTRAINT reverified_devices_user_device_key UNIQUE (app_id, user_id, device_hash);


--
-- Name: rights_import_failures rights_import_failures_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_import_failures
    ADD CONSTRAINT rights_import_failures_pkey PRIMARY KEY (import_id, row_no);


--
-- Name: rights_imports rights_imports_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_imports
    ADD CONSTRAINT rights_imports_app_id_id_key UNIQUE (app_id, id);


--
-- Name: rights_imports rights_imports_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_imports
    ADD CONSTRAINT rights_imports_pkey PRIMARY KEY (id);


--
-- Name: risk_hits risk_hits_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_pkey PRIMARY KEY (id);


--
-- Name: risk_judgements risk_judgements_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_judgements
    ADD CONSTRAINT risk_judgements_pkey PRIMARY KEY (id);


--
-- Name: risk_judgements risk_judgements_ref_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_judgements
    ADD CONSTRAINT risk_judgements_ref_key UNIQUE (app_id, rule_id, ref_type, ref_id);


--
-- Name: risk_rules risk_rules_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_rules
    ADD CONSTRAINT risk_rules_pkey PRIMARY KEY (id);


--
-- Name: risk_rules risk_rules_rule_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_rules
    ADD CONSTRAINT risk_rules_rule_id_key UNIQUE (app_id, rule_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_sid_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_sid_key UNIQUE (app_id, sid);


--
-- Name: settle_adjust_batches settle_adjust_batches_app_id_batch_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjust_batches
    ADD CONSTRAINT settle_adjust_batches_app_id_batch_id_key UNIQUE (app_id, batch_id);


--
-- Name: settle_adjust_batches settle_adjust_batches_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjust_batches
    ADD CONSTRAINT settle_adjust_batches_pkey PRIMARY KEY (batch_id);


--
-- Name: settle_adjustments settle_adjustments_candidate_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_candidate_key UNIQUE NULLS NOT DISTINCT (app_id, order_id, settle_seq, commission_version, user_id, role);


--
-- Name: settle_adjustments settle_adjustments_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_pkey PRIMARY KEY (id);


--
-- Name: settle_batch_items settle_batch_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batch_items
    ADD CONSTRAINT settle_batch_items_pkey PRIMARY KEY (id);


--
-- Name: settle_batches settle_batches_app_id_batch_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batches
    ADD CONSTRAINT settle_batches_app_id_batch_id_key UNIQUE (app_id, batch_id);


--
-- Name: settle_batches settle_batches_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batches
    ADD CONSTRAINT settle_batches_pkey PRIMARY KEY (batch_id);


--
-- Name: settle_bills settle_bills_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_bills
    ADD CONSTRAINT settle_bills_pkey PRIMARY KEY (app_id, bill_id);


--
-- Name: settle_jobs settle_jobs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_jobs
    ADD CONSTRAINT settle_jobs_pkey PRIMARY KEY (id);


--
-- Name: settle_jobs settle_jobs_run_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_jobs
    ADD CONSTRAINT settle_jobs_run_key UNIQUE (app_id, job, platform, run_at);


--
-- Name: settle_runs settle_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_runs
    ADD CONSTRAINT settle_runs_pkey PRIMARY KEY (settle_run_id);


--
-- Name: share_materials share_materials_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.share_materials
    ADD CONSTRAINT share_materials_pkey PRIMARY KEY (link_id);


--
-- Name: sms_send_attempts sms_send_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sms_send_attempts
    ADD CONSTRAINT sms_send_attempts_pkey PRIMARY KEY (app_id, attempt_id);


--
-- Name: sync_cursors sync_cursors_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sync_cursors
    ADD CONSTRAINT sync_cursors_pkey PRIMARY KEY (id);


--
-- Name: sync_cursors sync_cursors_stream_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sync_cursors
    ADD CONSTRAINT sync_cursors_stream_key UNIQUE (app_id, platform, union_account_id, query_kind, scene);


--
-- Name: tax_ytd tax_ytd_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.tax_ytd
    ADD CONSTRAINT tax_ytd_identity_key UNIQUE (app_id, user_id, year, income_type, identity_hmac);


--
-- Name: tax_ytd tax_ytd_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.tax_ytd
    ADD CONSTRAINT tax_ytd_pkey PRIMARY KEY (id);


--
-- Name: union_accounts union_accounts_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_app_id_id_key UNIQUE (app_id, id);


--
-- Name: union_accounts union_accounts_app_id_platform_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_app_id_platform_id_key UNIQUE (app_id, platform, id);


--
-- Name: union_accounts union_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_pkey PRIMARY KEY (id);


--
-- Name: union_auth_sessions union_auth_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_pkey PRIMARY KEY (state);


--
-- Name: union_binding_conflicts union_binding_conflicts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_binding_conflicts
    ADD CONSTRAINT union_binding_conflicts_pkey PRIMARY KEY (id);


--
-- Name: union_bindings union_bindings_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_pkey PRIMARY KEY (id);


--
-- Name: union_credentials union_credentials_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_credentials
    ADD CONSTRAINT union_credentials_pkey PRIMARY KEY (id);


--
-- Name: union_pids union_pids_app_platform_pid_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_app_platform_pid_key UNIQUE (app_id, platform, pid);


--
-- Name: union_pids union_pids_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_pkey PRIMARY KEY (id);


--
-- Name: union_raw_payloads union_raw_payloads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_raw_payloads
    ADD CONSTRAINT union_raw_payloads_pkey PRIMARY KEY (id, fetched_at);


--
-- Name: union_raw_payloads_default union_raw_payloads_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_raw_payloads_default
    ADD CONSTRAINT union_raw_payloads_default_pkey PRIMARY KEY (id, fetched_at);


--
-- Name: user_oauth user_oauth_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_identity_key UNIQUE (app_id, provider, union_id);


--
-- Name: user_oauth user_oauth_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_pkey PRIMARY KEY (id);


--
-- Name: user_oauth user_oauth_user_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_provider_key UNIQUE (app_id, user_id, provider);


--
-- Name: user_risk_state user_risk_state_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_risk_state
    ADD CONSTRAINT user_risk_state_pkey PRIMARY KEY (user_id);


--
-- Name: user_tip_reads user_tip_reads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_pkey PRIMARY KEY (app_id, user_id, tip_key, platform);


--
-- Name: users users_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_app_id_id_key UNIQUE (app_id, id);


--
-- Name: users users_attr_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_attr_code_key UNIQUE (app_id, attr_code);


--
-- Name: users users_invite_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_invite_code_key UNIQUE (app_id, invite_code);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: withdraw_holds withdraw_holds_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdraw_holds
    ADD CONSTRAINT withdraw_holds_pkey PRIMARY KEY (id);


--
-- Name: withdrawals withdrawals_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdrawals
    ADD CONSTRAINT withdrawals_app_id_id_key UNIQUE (app_id, id);


--
-- Name: withdrawals withdrawals_out_biz_no_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdrawals
    ADD CONSTRAINT withdrawals_out_biz_no_key UNIQUE (app_id, out_biz_no);


--
-- Name: withdrawals withdrawals_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdrawals
    ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (id);


--
-- Name: bam bam_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.bam
    ADD CONSTRAINT bam_pkey PRIMARY KEY (id);


--
-- Name: job job_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job
    ADD CONSTRAINT job_pkey PRIMARY KEY (name, id);


--
-- Name: job_common job_common_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT job_common_pkey PRIMARY KEY (name, id);


--
-- Name: job_dependency job_dependency_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_dependency
    ADD CONSTRAINT job_dependency_pkey PRIMARY KEY (child_name, child_id, parent_name, parent_id);


--
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (name);


--
-- Name: queue_stats queue_stats_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue_stats
    ADD CONSTRAINT queue_stats_pkey PRIMARY KEY (id, captured_on);


--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (name, key);


--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (event, name);


--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (version);


--
-- Name: warning warning_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.warning
    ADD CONSTRAINT warning_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: admin_permissions_granted_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX admin_permissions_granted_by_idx ON app.admin_permissions USING btree (app_id, granted_by);


--
-- Name: admin_union_auth_sessions_account_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX admin_union_auth_sessions_account_idx ON app.admin_union_auth_sessions USING btree (app_id, union_account_id);


--
-- Name: admin_union_auth_sessions_created_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX admin_union_auth_sessions_created_by_idx ON app.admin_union_auth_sessions USING btree (app_id, created_by);


--
-- Name: admin_union_auth_sessions_pending_expiry_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX admin_union_auth_sessions_pending_expiry_idx ON app.admin_union_auth_sessions USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: agent_cards_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_cards_created_idx ON app.agent_cards USING btree (app_id, created_at);


--
-- Name: agent_cards_run_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_cards_run_idx ON app.agent_cards USING btree (app_id, run_id);


--
-- Name: agent_clarify_asks_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_clarify_asks_created_idx ON app.agent_clarify_asks USING btree (app_id, created_at);


--
-- Name: agent_messages_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_created_idx ON app.agent_messages USING btree (app_id, created_at);


--
-- Name: agent_messages_reported_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_reported_idx ON app.agent_messages USING btree (app_id, report_status, reported_at) WHERE reported;


--
-- Name: agent_messages_run_role_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX agent_messages_run_role_key ON app.agent_messages USING btree (app_id, run_id, role) WHERE (run_id IS NOT NULL);


--
-- Name: agent_messages_session_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_session_created_idx ON app.agent_messages USING btree (app_id, session_id, created_at);


--
-- Name: agent_result_chains_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_chains_created_idx ON app.agent_result_chains USING btree (app_id, created_at);


--
-- Name: agent_result_deliveries_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_deliveries_created_idx ON app.agent_result_deliveries USING btree (app_id, created_at);


--
-- Name: agent_result_deliveries_result_set_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_deliveries_result_set_idx ON app.agent_result_deliveries USING btree (app_id, run_id, result_set_id);


--
-- Name: agent_result_sets_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_sets_created_idx ON app.agent_result_sets USING btree (app_id, created_at);


--
-- Name: agent_result_sets_run_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_sets_run_idx ON app.agent_result_sets USING btree (app_id, run_id);


--
-- Name: agent_rule_chunks_app_id_status_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_rule_chunks_app_id_status_idx ON app.agent_rule_chunks USING btree (app_id, status);


--
-- Name: agent_runs_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_created_idx ON app.agent_runs USING btree (app_id, created_at);


--
-- Name: agent_runs_quota_first_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_quota_first_idx ON app.agent_runs USING btree (app_id, (quota_subjects[1]), accepted_at);


--
-- Name: agent_runs_quota_second_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_quota_second_idx ON app.agent_runs USING btree (app_id, (quota_subjects[2]), accepted_at) WHERE (cardinality(quota_subjects) = 2);


--
-- Name: agent_runs_session_accepted_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_session_accepted_idx ON app.agent_runs USING btree (app_id, session_id, accepted_at);


--
-- Name: agent_runs_session_unfinished_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_session_unfinished_idx ON app.agent_runs USING btree (app_id, session_id) WHERE (final_event IS NULL);


--
-- Name: agent_sessions_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_created_idx ON app.agent_sessions USING btree (app_id, created_at);


--
-- Name: agent_sessions_guest_recent_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_guest_recent_idx ON app.agent_sessions USING btree (app_id, device_id, last_active_at DESC) WHERE (user_id IS NULL);


--
-- Name: agent_sessions_run_lock_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_run_lock_idx ON app.agent_sessions USING btree (run_lock_expires_at, id) WHERE (run_lock_run_id IS NOT NULL);


--
-- Name: agent_sessions_user_recent_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_user_recent_idx ON app.agent_sessions USING btree (app_id, user_id, last_active_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: agent_tool_calls_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_tool_calls_created_idx ON app.agent_tool_calls USING btree (app_id, created_at);


--
-- Name: appeals_processing_deadline_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX appeals_processing_deadline_idx ON app.appeals USING btree (app_id, deadline_at) WHERE (status = 'processing'::text);


--
-- Name: appeals_processing_register_phone_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX appeals_processing_register_phone_key ON app.appeals USING btree (app_id, related_phone_hmac) WHERE ((status = 'processing'::text) AND (request_type = 'register'::text));


--
-- Name: appeals_processing_target_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX appeals_processing_target_key ON app.appeals USING btree (app_id, target_type, target_id) WHERE (status = 'processing'::text);


--
-- Name: appeals_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX appeals_user_idx ON app.appeals USING btree (app_id, user_id, created_at DESC);


--
-- Name: articles_app_category_published_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX articles_app_category_published_idx ON app.articles USING btree (app_id, category, status, published_at, id, version);


--
-- Name: audit_logs_admin_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_admin_at_idx ON app.audit_logs USING btree (app_id, admin_id, at);


--
-- Name: audit_logs_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_at_idx ON app.audit_logs USING btree (app_id, at);


--
-- Name: audit_logs_target_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_target_idx ON app.audit_logs USING btree (app_id, target, at);


--
-- Name: beneficiary_credits_open_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX beneficiary_credits_open_key ON app.beneficiary_credits USING btree (app_id, order_id, user_id, role) WHERE (status = 'open'::text);


--
-- Name: beneficiary_credits_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX beneficiary_credits_order_idx ON app.beneficiary_credits USING btree (app_id, order_id);


--
-- Name: blocklist_value_hmac_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX blocklist_value_hmac_idx ON app.blocklist USING btree (app_id, dimension, value_hmac) WHERE (value_hmac IS NOT NULL);


--
-- Name: blocklist_value_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX blocklist_value_idx ON app.blocklist USING btree (app_id, dimension, value) WHERE (value IS NOT NULL);


--
-- Name: claim_items_claim_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX claim_items_claim_idx ON app.claim_items USING btree (app_id, claim_id);


--
-- Name: claim_items_pending_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX claim_items_pending_idx ON app.claim_items USING btree (app_id, platform, sub_order_id) WHERE (decision IS NULL);


--
-- Name: claims_review_queue_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX claims_review_queue_idx ON app.claims USING btree (app_id, status, created_at) WHERE (status = ANY (ARRAY['auto_matched'::text, 'manual_review'::text]));


--
-- Name: claims_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX claims_user_created_idx ON app.claims USING btree (app_id, user_id, created_at DESC);


--
-- Name: commission_rule_trials_version_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX commission_rule_trials_version_created_idx ON app.commission_rule_trials USING btree (app_id, rule_version_id, created_at);


--
-- Name: commission_rule_versions_published_effective_from_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX commission_rule_versions_published_effective_from_key ON app.commission_rule_versions USING btree (app_id, effective_from) WHERE (status = 'published'::text);


--
-- Name: commission_split_beneficiary_events_current_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX commission_split_beneficiary_events_current_idx ON app.commission_split_beneficiary_events USING btree (app_id, order_id, user_id, role, event_seq);


--
-- Name: consent_records_device_type_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX consent_records_device_type_idx ON app.consent_records USING btree (app_id, subject_type, device_id, type, server_at DESC);


--
-- Name: consent_records_user_type_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX consent_records_user_type_idx ON app.consent_records USING btree (app_id, subject_type, user_id, type, server_at DESC);


--
-- Name: deleted_identities_device_hash_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX deleted_identities_device_hash_idx ON app.deleted_identities USING btree (app_id, device_hash) WHERE (device_hash IS NOT NULL);


--
-- Name: deleted_identities_expire_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX deleted_identities_expire_at_idx ON app.deleted_identities USING btree (expire_at);


--
-- Name: deleted_identities_phone_hmac_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX deleted_identities_phone_hmac_idx ON app.deleted_identities USING btree (app_id, phone_hmac) WHERE (phone_hmac IS NOT NULL);


--
-- Name: deletion_requests_open_user_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX deletion_requests_open_user_key ON app.deletion_requests USING btree (app_id, user_id) WHERE (status = ANY (ARRAY['cooling'::text, 'processing'::text]));


--
-- Name: deletion_requests_status_cooling_until_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX deletion_requests_status_cooling_until_idx ON app.deletion_requests USING btree (status, cooling_until);


--
-- Name: deletion_requests_user_apply_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX deletion_requests_user_apply_idx ON app.deletion_requests USING btree (app_id, user_id, apply_at DESC);


--
-- Name: device_registrations_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX device_registrations_created_at_idx ON app.device_registrations USING btree (created_at);


--
-- Name: device_registrations_device_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX device_registrations_device_created_idx ON app.device_registrations USING btree (app_id, device_hash, created_at);


--
-- Name: devices_app_id_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX devices_app_id_id_key ON app.devices USING btree (app_id, id);


--
-- Name: event_log_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_created_at_idx ON ONLY app.event_log USING btree (created_at);


--
-- Name: event_log_default_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_created_at_idx ON app.event_log_default USING btree (created_at);


--
-- Name: event_log_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_event_id_idx ON ONLY app.event_log USING btree (event_id);


--
-- Name: event_log_default_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_event_id_idx ON app.event_log_default USING btree (event_id);


--
-- Name: export_tasks_app_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX export_tasks_app_created_idx ON app.export_tasks USING btree (app_id, created_at);


--
-- Name: export_tasks_creator_active_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX export_tasks_creator_active_idx ON app.export_tasks USING btree (app_id, created_by, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: export_tasks_creator_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX export_tasks_creator_created_idx ON app.export_tasks USING btree (app_id, created_by, created_at);


--
-- Name: export_tasks_done_expires_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX export_tasks_done_expires_idx ON app.export_tasks USING btree (app_id, expires_at) WHERE (status = 'done'::text);


--
-- Name: favorites_app_id_user_id_created_at_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX favorites_app_id_user_id_created_at_id_idx ON app.favorites USING btree (app_id, user_id, created_at DESC, id);


--
-- Name: inbox_messages_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX inbox_messages_created_at_idx ON app.inbox_messages USING btree (created_at);


--
-- Name: inbox_messages_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX inbox_messages_user_created_idx ON app.inbox_messages USING btree (app_id, user_id, created_at, message_id);


--
-- Name: invite_rewards_inviter_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX invite_rewards_inviter_idx ON app.invite_rewards USING btree (app_id, inviter_id);


--
-- Name: invite_rewards_status_triggered_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX invite_rewards_status_triggered_idx ON app.invite_rewards USING btree (app_id, status, triggered_at);


--
-- Name: landing_registrations_ip_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX landing_registrations_ip_created_idx ON app.landing_registrations USING btree (app_id, ip_hmac, created_at);


--
-- Name: ledger_entries_account_booked_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_account_booked_idx ON ONLY app.ledger_entries USING btree (app_id, account_id, booked_at DESC);


--
-- Name: ledger_entries_account_version_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_account_version_idx ON ONLY app.ledger_entries USING btree (account_id, account_version) WHERE (account_version IS NOT NULL);


--
-- Name: ledger_entries_default_account_id_account_version_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_default_account_id_account_version_idx ON app.ledger_entries_default USING btree (account_id, account_version) WHERE (account_version IS NOT NULL);


--
-- Name: ledger_entries_default_app_id_account_id_booked_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_default_app_id_account_id_booked_at_idx ON app.ledger_entries_default USING btree (app_id, account_id, booked_at DESC);


--
-- Name: ledger_entries_voucher_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_voucher_idx ON ONLY app.ledger_entries USING btree (app_id, voucher_id);


--
-- Name: ledger_entries_default_app_id_voucher_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_entries_default_app_id_voucher_id_idx ON app.ledger_entries_default USING btree (app_id, voucher_id);


--
-- Name: ledger_vouchers_accounting_date_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_vouchers_accounting_date_idx ON app.ledger_vouchers USING btree (app_id, accounting_date);


--
-- Name: ledger_vouchers_order_key_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ledger_vouchers_order_key_idx ON app.ledger_vouchers USING btree (app_id, order_key) WHERE (order_key IS NOT NULL);


--
-- Name: level_change_logs_register_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX level_change_logs_register_key ON app.level_change_logs USING btree (app_id, user_id) WHERE (source = 'register'::text);


--
-- Name: level_change_logs_user_effective_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX level_change_logs_user_effective_idx ON app.level_change_logs USING btree (app_id, user_id, effective_at, id);


--
-- Name: link_logs_link_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_link_created_idx ON ONLY app.link_logs USING btree (app_id, link_id, created_at);


--
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_default_app_id_link_id_created_at_idx ON app.link_logs_default USING btree (app_id, link_id, created_at);


--
-- Name: link_open_attempts_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_link_idx ON app.link_open_attempts USING btree (app_id, link_id);


--
-- Name: link_open_attempts_opened_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_opened_idx ON app.link_open_attempts USING btree (opened_at);


--
-- Name: link_open_attempts_user_opened_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_user_opened_idx ON app.link_open_attempts USING btree (app_id, user_id, opened_at);


--
-- Name: login_logs_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX login_logs_created_at_idx ON app.login_logs USING btree (created_at);


--
-- Name: login_logs_device_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX login_logs_device_created_idx ON app.login_logs USING btree (app_id, device_hash, created_at) WHERE (device_hash IS NOT NULL);


--
-- Name: notify_logs_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX notify_logs_created_at_idx ON app.notify_logs USING btree (created_at);


--
-- Name: notify_logs_due_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX notify_logs_due_idx ON app.notify_logs USING btree (status, planned_at);


--
-- Name: notify_logs_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX notify_logs_user_created_idx ON app.notify_logs USING btree (app_id, user_id, created_at);


--
-- Name: order_assignments_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_assignments_order_idx ON app.order_assignments USING btree (app_id, order_id);


--
-- Name: order_assignments_to_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_assignments_to_user_idx ON app.order_assignments USING btree (app_id, to_user_id);


--
-- Name: order_rights_dedupe_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX order_rights_dedupe_key ON app.order_rights USING btree (app_id, order_id, type, platform_rights_no) NULLS NOT DISTINCT;


--
-- Name: order_rights_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_rights_order_idx ON app.order_rights USING btree (app_id, order_id);


--
-- Name: order_status_history_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_status_history_order_idx ON app.order_status_history USING btree (app_id, order_id, at);


--
-- Name: order_sync_pending_open_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX order_sync_pending_open_key ON app.order_sync_pending USING btree (app_id, platform, sub_order_id, reason) WHERE (status = 'open'::text);


--
-- Name: order_sync_request_windows_account_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_sync_request_windows_account_idx ON app.order_sync_request_windows USING btree (app_id, union_account_id);


--
-- Name: order_sync_requests_app_id_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX order_sync_requests_app_id_id_key ON app.order_sync_requests USING btree (app_id, id);


--
-- Name: order_sync_requests_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_sync_requests_created_idx ON app.order_sync_requests USING btree (app_id, created_at);


--
-- Name: order_sync_requests_live_digest_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX order_sync_requests_live_digest_key ON app.order_sync_requests USING btree (app_id, filter_digest) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: orders_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_link_idx ON ONLY app.orders USING btree (app_id, link_id);


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_link_id_idx ON app.orders_default USING btree (app_id, link_id);


--
-- Name: orders_user_paid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_user_paid_idx ON ONLY app.orders USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_user_id_paid_at_order_id_idx ON app.orders_default USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: pay_anomalies_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_anomalies_order_idx ON app.pay_anomalies USING btree (app_id, pay_order_id) WHERE (pay_order_id IS NOT NULL);


--
-- Name: pay_fulfillments_last_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_fulfillments_last_order_idx ON app.pay_fulfillments USING btree (app_id, last_pay_order_id) WHERE (last_pay_order_id IS NOT NULL);


--
-- Name: pay_orders_open_biz_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX pay_orders_open_biz_key ON app.pay_orders USING btree (app_id, biz_type, biz_ref) WHERE (status = ANY (ARRAY['PENDING'::text, 'PAID'::text]));


--
-- Name: pay_orders_status_expire_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_orders_status_expire_idx ON app.pay_orders USING btree (app_id, status, expire_at);


--
-- Name: pay_orders_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_orders_user_created_idx ON app.pay_orders USING btree (app_id, user_id, created_at);


--
-- Name: pay_query_attempts_order_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_query_attempts_order_at_idx ON app.pay_query_attempts USING btree (app_id, pay_order_id, at);


--
-- Name: pay_query_attempts_refund_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_query_attempts_refund_at_idx ON app.pay_query_attempts USING btree (app_id, pay_refund_id, at);


--
-- Name: pay_refunds_target_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pay_refunds_target_idx ON app.pay_refunds USING btree (app_id, target_type, target_id);


--
-- Name: payout_account_changes_user_changed_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_changes_user_changed_idx ON app.payout_account_changes USING btree (app_id, user_id, changed_at);


--
-- Name: payout_account_verify_attempts_fingerprint_reserved_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_verify_attempts_fingerprint_reserved_idx ON app.payout_account_verify_attempts USING btree (app_id, user_id, request_fingerprint, reserved_at);


--
-- Name: payout_account_verify_attempts_idempotency_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_account_verify_attempts_idempotency_key ON app.payout_account_verify_attempts USING btree (app_id, user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: payout_account_verify_attempts_inflight_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_account_verify_attempts_inflight_key ON app.payout_account_verify_attempts USING btree (app_id, user_id, request_fingerprint) WHERE (status = ANY (ARRAY['reserved'::text, 'unknown'::text]));


--
-- Name: payout_account_verify_attempts_user_date_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_verify_attempts_user_date_idx ON app.payout_account_verify_attempts USING btree (app_id, user_id, verify_date);


--
-- Name: payout_accounts_current_alipay_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_alipay_key ON app.payout_accounts USING btree (app_id, alipay_hmac) WHERE is_current;


--
-- Name: payout_accounts_current_bank_card_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_bank_card_key ON app.payout_accounts USING btree (app_id, bank_card_hmac) WHERE is_current;


--
-- Name: payout_accounts_current_user_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_user_key ON app.payout_accounts USING btree (app_id, user_id) WHERE is_current;


--
-- Name: payout_attempts_transfer_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_attempts_transfer_at_idx ON app.payout_attempts USING btree (app_id, at) WHERE (kind = 'transfer'::text);


--
-- Name: payout_attempts_transfer_once_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_attempts_transfer_once_key ON app.payout_attempts USING btree (withdrawal_id) WHERE (kind = 'transfer'::text);


--
-- Name: payout_attempts_withdrawal_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_attempts_withdrawal_at_idx ON app.payout_attempts USING btree (withdrawal_id, at);


--
-- Name: payout_batch_items_batch_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_batch_items_batch_at_idx ON app.payout_batch_items USING btree (batch_id, at);


--
-- Name: payout_batch_items_withdrawal_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_batch_items_withdrawal_at_idx ON app.payout_batch_items USING btree (withdrawal_id, at);


--
-- Name: payout_batches_app_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_batches_app_created_idx ON app.payout_batches USING btree (app_id, created_at);


--
-- Name: payout_watermarks_latest_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_watermarks_latest_idx ON app.payout_watermarks USING btree (app_id, channel, measured_at DESC);


--
-- Name: personal_data_copies_open_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX personal_data_copies_open_key ON app.personal_data_copies USING btree (app_id, user_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text]));


--
-- Name: personal_data_copies_requested_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX personal_data_copies_requested_by_idx ON app.personal_data_copies USING btree (app_id, requested_by);


--
-- Name: personal_data_copies_retry_of_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX personal_data_copies_retry_of_idx ON app.personal_data_copies USING btree (app_id, retry_of) WHERE (retry_of IS NOT NULL);


--
-- Name: personal_data_copies_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX personal_data_copies_user_idx ON app.personal_data_copies USING btree (app_id, user_id);


--
-- Name: pool_items_read_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX pool_items_read_idx ON app.pool_items USING btree (app_id, pool_id, sort, product_key);


--
-- Name: price_snapshot_latest_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX price_snapshot_latest_idx ON ONLY app.price_snapshot USING btree (app_id, product_key, source_kind, first_observed_at DESC);


--
-- Name: price_snapshot_default_app_id_product_key_source_kind_first_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX price_snapshot_default_app_id_product_key_source_kind_first_idx ON app.price_snapshot_default USING btree (app_id, product_key, source_kind, first_observed_at DESC);


--
-- Name: product_refs_platform_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX product_refs_platform_idx ON app.product_refs USING btree (platform);


--
-- Name: push_tokens_live_token_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX push_tokens_live_token_key ON app.push_tokens USING btree (app_id, provider, token) WHERE (revoked_at IS NULL);


--
-- Name: push_tokens_user_bound_sid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX push_tokens_user_bound_sid_idx ON app.push_tokens USING btree (app_id, user_id, bound_sid);


--
-- Name: realname_prior_identities_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX realname_prior_identities_user_idx ON app.realname_prior_identities USING btree (app_id, user_id);


--
-- Name: realname_verified_id_no_hmac_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX realname_verified_id_no_hmac_key ON app.realname USING btree (app_id, id_no_hmac) WHERE (status = 'verified'::text);


--
-- Name: recon_channel_channel_order_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX recon_channel_channel_order_id_key ON app.recon_channel USING btree (app_id, bill_date, channel_order_id) WHERE (channel_order_id IS NOT NULL);


--
-- Name: recon_channel_out_biz_no_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX recon_channel_out_biz_no_key ON app.recon_channel USING btree (app_id, bill_date, out_biz_no) WHERE (out_biz_no IS NOT NULL);


--
-- Name: recon_diffs_dedupe_key_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX recon_diffs_dedupe_key_key ON app.recon_diffs USING btree (app_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: recon_diffs_month_end_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX recon_diffs_month_end_key ON app.recon_diffs USING btree (app_id, period) WHERE (type = 'month_end_unbalanced'::text);


--
-- Name: recon_diffs_status_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX recon_diffs_status_idx ON app.recon_diffs USING btree (app_id, status, created_at);


--
-- Name: recon_union_period_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX recon_union_period_idx ON app.recon_union USING btree (app_id, period, platform);


--
-- Name: refresh_tokens_session_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX refresh_tokens_session_idx ON app.refresh_tokens USING btree (app_id, sid);


--
-- Name: relation_change_logs_user_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX relation_change_logs_user_at_idx ON app.relation_change_logs USING btree (app_id, user_id, at, id);


--
-- Name: rights_imports_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX rights_imports_created_idx ON app.rights_imports USING btree (app_id, created_at);


--
-- Name: risk_hits_blacklist_once_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX risk_hits_blacklist_once_key ON app.risk_hits USING btree (app_id, rule_id, ref_type, ref_id, value_hmac, risk_action) WHERE (rule_id = 'BLACKLIST_HIT'::text);


--
-- Name: risk_hits_ref_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_ref_idx ON app.risk_hits USING btree (app_id, ref_type, ref_id);


--
-- Name: risk_hits_related_phone_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_related_phone_idx ON app.risk_hits USING btree (app_id, related_phone_hmac) WHERE (related_phone_hmac IS NOT NULL);


--
-- Name: risk_hits_same_device_once_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX risk_hits_same_device_once_key ON app.risk_hits USING btree (app_id, rule_id, ref_type, ref_id, value_hmac) WHERE (rule_id = 'SAME_DEVICE_MULTI_ACCOUNT'::text);


--
-- Name: risk_hits_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_user_idx ON app.risk_hits USING btree (app_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: sessions_device_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sessions_device_idx ON app.sessions USING btree (app_id, device_id);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sessions_user_idx ON app.sessions USING btree (app_id, user_id);


--
-- Name: settle_adjustments_batch_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_adjustments_batch_idx ON app.settle_adjustments USING btree (app_id, batch_id);


--
-- Name: settle_adjustments_status_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_adjustments_status_idx ON app.settle_adjustments USING btree (app_id, status);


--
-- Name: settle_batch_items_beneficiary_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX settle_batch_items_beneficiary_key ON app.settle_batch_items USING btree (app_id, batch_id, beneficiary_credit_id) WHERE (item_type = 'beneficiary'::text);


--
-- Name: settle_batch_items_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_batch_items_order_idx ON app.settle_batch_items USING btree (app_id, order_id);


--
-- Name: settle_batch_items_order_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX settle_batch_items_order_key ON app.settle_batch_items USING btree (app_id, batch_id, order_id) WHERE (item_type = 'order'::text);


--
-- Name: settle_batches_bill_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_batches_bill_idx ON app.settle_batches USING btree (app_id, bill_id, platform);


--
-- Name: settle_batches_status_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_batches_status_idx ON app.settle_batches USING btree (app_id, status);


--
-- Name: settle_runs_bill_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX settle_runs_bill_idx ON app.settle_runs USING btree (app_id, bill_id);


--
-- Name: sms_send_attempts_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sms_send_attempts_created_at_idx ON app.sms_send_attempts USING btree (created_at);


--
-- Name: sms_send_attempts_ip_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sms_send_attempts_ip_created_idx ON app.sms_send_attempts USING btree (app_id, ip_hmac, created_at);


--
-- Name: tax_ytd_user_year_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX tax_ytd_user_year_idx ON app.tax_ytd USING btree (app_id, user_id, year);


--
-- Name: union_accounts_auth_renewed_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_accounts_auth_renewed_by_idx ON app.union_accounts USING btree (app_id, auth_renewed_by) WHERE (auth_renewed_by IS NOT NULL);


--
-- Name: union_auth_sessions_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_auth_sessions_user_idx ON app.union_auth_sessions USING btree (app_id, user_id, created_at);


--
-- Name: union_binding_conflicts_history_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_binding_conflicts_history_idx ON app.union_binding_conflicts USING btree (app_id, user_id, platform, occurred_at);


--
-- Name: union_binding_conflicts_unresolved_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_binding_conflicts_unresolved_idx ON app.union_binding_conflicts USING btree (app_id, user_id, platform) WHERE (resolved_at IS NULL);


--
-- Name: union_bindings_relation_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_bindings_relation_idx ON app.union_bindings USING btree (app_id, platform, relation_id);


--
-- Name: union_bindings_relation_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_bindings_relation_key ON app.union_bindings USING btree (app_id, union_account_id, platform, relation_id) WHERE (status = ANY (ARRAY['active'::text, 'invalid'::text, 'blocked'::text]));


--
-- Name: union_bindings_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_bindings_user_idx ON app.union_bindings USING btree (app_id, user_id);


--
-- Name: union_bindings_user_platform_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_bindings_user_platform_key ON app.union_bindings USING btree (app_id, user_id, platform) WHERE (status = ANY (ARRAY['pending_auth'::text, 'active'::text, 'invalid'::text, 'blocked'::text]));


--
-- Name: union_credentials_account_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_credentials_account_created_idx ON app.union_credentials USING btree (app_id, union_account_id, created_at);


--
-- Name: union_credentials_current_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_credentials_current_key ON app.union_credentials USING btree (app_id, union_account_id) WHERE is_current;


--
-- Name: union_pids_account_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_pids_account_idx ON app.union_pids USING btree (app_id, platform, union_account_id);


--
-- Name: union_pids_active_account_scene_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_pids_active_account_scene_key ON app.union_pids USING btree (app_id, platform, union_account_id, pid_scene) WHERE (status = 'active'::text);


--
-- Name: union_pids_scene_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_pids_scene_idx ON app.union_pids USING btree (app_id, platform, pid_scene, status);


--
-- Name: user_risk_state_state_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX user_risk_state_state_idx ON app.user_risk_state USING btree (app_id, state, frozen_until);


--
-- Name: users_phone_hmac_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX users_phone_hmac_key ON app.users USING btree (app_id, phone_hmac) WHERE (status <> 'deleted'::text);


--
-- Name: withdraw_holds_active_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX withdraw_holds_active_idx ON app.withdraw_holds USING btree (app_id, user_id) WHERE (released_at IS NULL);


--
-- Name: withdrawals_channel_order_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX withdrawals_channel_order_id_key ON app.withdrawals USING btree (app_id, channel_order_id) WHERE (channel_order_id IS NOT NULL);


--
-- Name: withdrawals_open_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX withdrawals_open_idx ON app.withdrawals USING btree (app_id, user_id) WHERE (status = ANY (ARRAY['PENDING_REVIEW'::text, 'APPROVED'::text, 'PAYING'::text]));


--
-- Name: withdrawals_payee_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX withdrawals_payee_created_idx ON app.withdrawals USING btree (app_id, payee_hmac, created_at);


--
-- Name: withdrawals_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX withdrawals_user_created_idx ON app.withdrawals USING btree (app_id, user_id, created_at);


--
-- Name: job_common_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i1 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'created'::pgboss.job_state) AND (policy = 'short'::text));


--
-- Name: job_common_i10; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i10 ON pgboss.job_common USING btree (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i11; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i11 ON pgboss.job_common USING btree (name, priority DESC, created_on, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));


--
-- Name: job_common_i2; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i2 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'active'::pgboss.job_state) AND (policy = 'singleton'::text));


--
-- Name: job_common_i3; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i3 ON pgboss.job_common USING btree (name, state, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'stately'::text));


--
-- Name: job_common_i4; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i4 ON pgboss.job_common USING btree (name, singleton_on, COALESCE(singleton_key, ''::text)) WHERE ((state <> 'cancelled'::pgboss.job_state) AND (singleton_on IS NOT NULL));


--
-- Name: job_common_i6; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i6 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'exclusive'::text));


--
-- Name: job_common_i7; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i7 ON pgboss.job_common USING btree (name, group_id) WHERE ((state = 'active'::pgboss.job_state) AND (group_id IS NOT NULL));


--
-- Name: job_common_i8; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i8 ON pgboss.job_common USING btree (name, singleton_key) WHERE ((state = ANY (ARRAY['active'::pgboss.job_state, 'retry'::pgboss.job_state, 'failed'::pgboss.job_state])) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i9; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state));


--
-- Name: job_dep_parent_idx; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency USING btree (parent_name, parent_id);


--
-- Name: queue_stats_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX queue_stats_i1 ON ONLY pgboss.queue_stats USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);


--
-- Name: warning_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX warning_i1 ON pgboss.warning USING btree (created_on DESC);


--
-- Name: event_log_default_created_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_created_at_idx ATTACH PARTITION app.event_log_default_created_at_idx;


--
-- Name: event_log_default_event_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_event_id_idx ATTACH PARTITION app.event_log_default_event_id_idx;


--
-- Name: event_log_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_pkey ATTACH PARTITION app.event_log_default_pkey;


--
-- Name: ledger_entries_default_account_id_account_version_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.ledger_entries_account_version_idx ATTACH PARTITION app.ledger_entries_default_account_id_account_version_idx;


--
-- Name: ledger_entries_default_app_id_account_id_booked_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.ledger_entries_account_booked_idx ATTACH PARTITION app.ledger_entries_default_app_id_account_id_booked_at_idx;


--
-- Name: ledger_entries_default_app_id_voucher_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.ledger_entries_voucher_idx ATTACH PARTITION app.ledger_entries_default_app_id_voucher_id_idx;


--
-- Name: ledger_entries_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.ledger_entries_pkey ATTACH PARTITION app.ledger_entries_default_pkey;


--
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_link_created_idx ATTACH PARTITION app.link_logs_default_app_id_link_id_created_at_idx;


--
-- Name: link_logs_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_pkey ATTACH PARTITION app.link_logs_default_pkey;


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_link_idx ATTACH PARTITION app.orders_default_app_id_link_id_idx;


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_user_paid_idx ATTACH PARTITION app.orders_default_app_id_user_id_paid_at_order_id_idx;


--
-- Name: orders_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_pkey ATTACH PARTITION app.orders_default_pkey;


--
-- Name: price_snapshot_default_app_id_product_key_source_kind_first_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.price_snapshot_latest_idx ATTACH PARTITION app.price_snapshot_default_app_id_product_key_source_kind_first_idx;


--
-- Name: price_snapshot_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.price_snapshot_pkey ATTACH PARTITION app.price_snapshot_default_pkey;


--
-- Name: union_raw_payloads_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.union_raw_payloads_pkey ATTACH PARTITION app.union_raw_payloads_default_pkey;


--
-- Name: job_common_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: -
--

ALTER INDEX pgboss.job_pkey ATTACH PARTITION pgboss.job_common_pkey;


--
-- Name: agent_cards agent_cards_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_cards_no_rewrite BEFORE UPDATE ON app.agent_cards FOR EACH ROW EXECUTE FUNCTION app.reject_agent_card_rewrite();


--
-- Name: agent_result_chains agent_result_chains_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_result_chains_no_rewrite BEFORE UPDATE ON app.agent_result_chains FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_chain_rewrite();


--
-- Name: agent_result_deliveries agent_result_deliveries_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_result_deliveries_no_rewrite BEFORE UPDATE ON app.agent_result_deliveries FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_delivery_rewrite();


--
-- Name: agent_result_sets agent_result_sets_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_result_sets_no_rewrite BEFORE UPDATE ON app.agent_result_sets FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_set_rewrite();


--
-- Name: agent_rule_chunks agent_rule_chunks_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_rule_chunks_no_rewrite BEFORE UPDATE ON app.agent_rule_chunks FOR EACH ROW EXECUTE FUNCTION app.reject_rule_chunk_rewrite();


--
-- Name: agent_runs agent_runs_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_runs_no_rewrite BEFORE UPDATE ON app.agent_runs FOR EACH ROW EXECUTE FUNCTION app.reject_agent_run_rewrite();


--
-- Name: agent_sessions agent_sessions_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_sessions_no_rewrite BEFORE UPDATE ON app.agent_sessions FOR EACH ROW EXECUTE FUNCTION app.reject_agent_session_rewrite();


--
-- Name: agent_tool_calls agent_tool_calls_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_tool_calls_no_rewrite BEFORE UPDATE ON app.agent_tool_calls FOR EACH ROW EXECUTE FUNCTION app.reject_agent_tool_call_rewrite();


--
-- Name: audit_logs audit_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER audit_logs_append_only BEFORE DELETE OR UPDATE ON app.audit_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: commission_rule_trials commission_rule_trials_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER commission_rule_trials_append_only BEFORE DELETE OR UPDATE ON app.commission_rule_trials FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: commission_split_amounts commission_split_amounts_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER commission_split_amounts_append_only BEFORE DELETE OR UPDATE ON app.commission_split_amounts FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: commission_split_beneficiary_events commission_split_beneficiary_events_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER commission_split_beneficiary_events_append_only BEFORE DELETE OR UPDATE ON app.commission_split_beneficiary_events FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: commission_split_totals commission_split_totals_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER commission_split_totals_append_only BEFORE DELETE OR UPDATE ON app.commission_split_totals FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: commission_splits commission_splits_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER commission_splits_append_only BEFORE DELETE OR UPDATE ON app.commission_splits FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: device_registrations device_registrations_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER device_registrations_no_rewrite BEFORE UPDATE ON app.device_registrations FOR EACH ROW EXECUTE FUNCTION app.reject_device_registration_rewrite();


--
-- Name: event_log event_log_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER event_log_append_only BEFORE DELETE OR UPDATE ON app.event_log FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: ledger_entries ledger_entries_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER ledger_entries_append_only BEFORE DELETE OR UPDATE ON app.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: ledger_vouchers ledger_vouchers_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER ledger_vouchers_append_only BEFORE DELETE OR UPDATE ON app.ledger_vouchers FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: level_change_logs level_change_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER level_change_logs_append_only BEFORE DELETE OR UPDATE ON app.level_change_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: link_logs link_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_logs_append_only BEFORE DELETE OR UPDATE ON app.link_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: link_open_attempts link_open_attempts_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_open_attempts_no_rewrite BEFORE UPDATE ON app.link_open_attempts FOR EACH ROW EXECUTE FUNCTION app.reject_link_open_attempt_rewrite();


--
-- Name: links links_no_promo_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER links_no_promo_rewrite BEFORE UPDATE ON app.links FOR EACH ROW EXECUTE FUNCTION app.reject_link_promo_rewrite();


--
-- Name: links links_no_quote_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER links_no_quote_rewrite BEFORE UPDATE ON app.links FOR EACH ROW EXECUTE FUNCTION app.reject_link_quote_rewrite();


--
-- Name: order_assignments order_assignments_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_assignments_append_only BEFORE DELETE OR UPDATE ON app.order_assignments FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_keys order_keys_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_settlements order_settlements_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_settlements_append_only BEFORE DELETE OR UPDATE ON app.order_settlements FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_status_history order_status_history_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_status_history_append_only BEFORE DELETE OR UPDATE ON app.order_status_history FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_sync_drop_keys order_sync_drop_keys_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_sync_drop_keys_append_only BEFORE DELETE OR UPDATE ON app.order_sync_drop_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: orders orders_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER orders_no_rewrite BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.reject_order_rewrite();


--
-- Name: pay_notifications pay_notifications_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER pay_notifications_append_only BEFORE DELETE OR UPDATE ON app.pay_notifications FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: pay_orders pay_orders_immutable_columns; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER pay_orders_immutable_columns BEFORE UPDATE ON app.pay_orders FOR EACH ROW EXECUTE FUNCTION app.pay_orders_reject_immutable_update();


--
-- Name: pay_query_attempts pay_query_attempts_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER pay_query_attempts_append_only BEFORE DELETE OR UPDATE ON app.pay_query_attempts FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: pay_recon_days pay_recon_days_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER pay_recon_days_append_only BEFORE DELETE OR UPDATE ON app.pay_recon_days FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: pay_refunds pay_refunds_immutable_columns; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER pay_refunds_immutable_columns BEFORE UPDATE ON app.pay_refunds FOR EACH ROW EXECUTE FUNCTION app.pay_refunds_reject_immutable_update();


--
-- Name: payout_account_changes payout_account_changes_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_account_changes_append_only BEFORE DELETE OR UPDATE ON app.payout_account_changes FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: payout_accounts payout_accounts_anonymize_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_accounts_anonymize_only BEFORE UPDATE ON app.payout_accounts FOR EACH ROW EXECUTE FUNCTION app.payout_accounts_reject_identifier_update();


--
-- Name: payout_attempts payout_attempts_complete_once; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_attempts_complete_once BEFORE DELETE OR UPDATE ON app.payout_attempts FOR EACH ROW EXECUTE FUNCTION app.payout_attempts_complete_once();


--
-- Name: payout_batch_items payout_batch_items_insert_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_batch_items_insert_only BEFORE DELETE OR UPDATE ON app.payout_batch_items FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: payout_watermarks payout_watermarks_insert_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_watermarks_insert_only BEFORE DELETE OR UPDATE ON app.payout_watermarks FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: product_key_aliases product_key_aliases_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER product_key_aliases_append_only BEFORE DELETE OR UPDATE ON app.product_key_aliases FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: product_refs product_refs_no_key_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER product_refs_no_key_rewrite BEFORE UPDATE ON app.product_refs FOR EACH ROW EXECUTE FUNCTION app.reject_product_ref_key_rewrite();


--
-- Name: relation_change_logs relation_change_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER relation_change_logs_append_only BEFORE DELETE OR UPDATE ON app.relation_change_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: rights_import_failures rights_import_failures_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER rights_import_failures_append_only BEFORE DELETE OR UPDATE ON app.rights_import_failures FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: share_materials share_materials_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER share_materials_append_only BEFORE DELETE OR UPDATE ON app.share_materials FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: union_auth_sessions union_auth_sessions_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_auth_sessions_no_rewrite BEFORE UPDATE ON app.union_auth_sessions FOR EACH ROW EXECUTE FUNCTION app.reject_union_auth_session_rewrite();


--
-- Name: union_binding_conflicts union_binding_conflicts_no_delete; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_binding_conflicts_no_delete BEFORE DELETE ON app.union_binding_conflicts FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: union_binding_conflicts union_binding_conflicts_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_binding_conflicts_no_rewrite BEFORE UPDATE ON app.union_binding_conflicts FOR EACH ROW EXECUTE FUNCTION app.reject_union_binding_conflict_rewrite();


--
-- Name: union_pids union_pids_no_delete; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_pids_no_delete BEFORE DELETE ON app.union_pids FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: union_raw_payloads union_raw_payloads_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_raw_payloads_append_only BEFORE DELETE OR UPDATE ON app.union_raw_payloads FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: withdrawals withdrawals_out_biz_no_fixed; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER withdrawals_out_biz_no_fixed BEFORE UPDATE OF out_biz_no ON app.withdrawals FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: account_balances account_balances_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.account_balances
    ADD CONSTRAINT account_balances_account_fkey FOREIGN KEY (app_id, account_id) REFERENCES app.ledger_accounts(app_id, id);


--
-- Name: admin_permissions admin_permissions_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_admin_fkey FOREIGN KEY (app_id, admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: admin_permissions admin_permissions_granted_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_granted_by_fkey FOREIGN KEY (app_id, granted_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: admin_union_auth_sessions admin_union_auth_sessions_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_union_auth_sessions
    ADD CONSTRAINT admin_union_auth_sessions_account_fkey FOREIGN KEY (app_id, union_account_id) REFERENCES app.union_accounts(app_id, id);


--
-- Name: admin_union_auth_sessions admin_union_auth_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_union_auth_sessions
    ADD CONSTRAINT admin_union_auth_sessions_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: agent_cards agent_cards_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: agent_cards agent_cards_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_run_fkey FOREIGN KEY (app_id, session_id, run_id) REFERENCES app.agent_runs(app_id, session_id, id);


--
-- Name: agent_clarify_asks agent_clarify_asks_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_clarify_asks
    ADD CONSTRAINT agent_clarify_asks_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_messages agent_messages_report_handler_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_report_handler_fkey FOREIGN KEY (app_id, report_handler_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: agent_messages agent_messages_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_run_fkey FOREIGN KEY (app_id, session_id, run_id) REFERENCES app.agent_runs(app_id, session_id, id);


--
-- Name: agent_messages agent_messages_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_result_chains agent_result_chains_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_chains
    ADD CONSTRAINT agent_result_chains_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_result_deliveries agent_result_deliveries_result_set_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_deliveries
    ADD CONSTRAINT agent_result_deliveries_result_set_fkey FOREIGN KEY (app_id, run_id, result_set_id) REFERENCES app.agent_result_sets(app_id, run_id, id);


--
-- Name: agent_result_deliveries agent_result_deliveries_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_deliveries
    ADD CONSTRAINT agent_result_deliveries_run_fkey FOREIGN KEY (app_id, session_id, run_id) REFERENCES app.agent_runs(app_id, session_id, id);


--
-- Name: agent_result_sets agent_result_sets_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_sets
    ADD CONSTRAINT agent_result_sets_run_fkey FOREIGN KEY (app_id, run_id) REFERENCES app.agent_runs(app_id, id);


--
-- Name: agent_rule_chunks agent_rule_chunks_article_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_rule_chunks
    ADD CONSTRAINT agent_rule_chunks_article_fkey FOREIGN KEY (article_id, published_version) REFERENCES app.articles(id, version);


--
-- Name: agent_runs agent_runs_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_sessions agent_sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: agent_sessions agent_sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: agent_tool_calls agent_tool_calls_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_run_fkey FOREIGN KEY (app_id, run_id) REFERENCES app.agent_runs(app_id, id);


--
-- Name: agreements agreements_article_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agreements
    ADD CONSTRAINT agreements_article_fkey FOREIGN KEY (article_id, article_version) REFERENCES app.articles(id, version);


--
-- Name: agreements agreements_published_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agreements
    ADD CONSTRAINT agreements_published_by_fkey FOREIGN KEY (published_by) REFERENCES app.admin_users(id);


--
-- Name: appeal_claims appeal_claims_appeal_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeal_claims
    ADD CONSTRAINT appeal_claims_appeal_fkey FOREIGN KEY (appeal_id) REFERENCES app.appeals(id);


--
-- Name: appeals appeals_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeals
    ADD CONSTRAINT appeals_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: asset_snapshot_receivables asset_snapshot_receivables_snapshot_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.asset_snapshot_receivables
    ADD CONSTRAINT asset_snapshot_receivables_snapshot_fkey FOREIGN KEY (app_id, asset_snapshot_id) REFERENCES app.asset_snapshots(app_id, id);


--
-- Name: audit_logs audit_logs_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.audit_logs
    ADD CONSTRAINT audit_logs_admin_fkey FOREIGN KEY (app_id, admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: beneficiary_credits beneficiary_credits_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.beneficiary_credits
    ADD CONSTRAINT beneficiary_credits_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: beneficiary_credits beneficiary_credits_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.beneficiary_credits
    ADD CONSTRAINT beneficiary_credits_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: beneficiary_credits beneficiary_credits_voucher_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.beneficiary_credits
    ADD CONSTRAINT beneficiary_credits_voucher_fkey FOREIGN KEY (app_id, voucher_id) REFERENCES app.ledger_vouchers(app_id, id);


--
-- Name: category_blocklist category_blocklist_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: claim_items claim_items_claim_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claim_items
    ADD CONSTRAINT claim_items_claim_fkey FOREIGN KEY (app_id, claim_id, applicant_user_id, platform) REFERENCES app.claims(app_id, id, user_id, platform);


--
-- Name: claim_items claim_items_decided_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claim_items
    ADD CONSTRAINT claim_items_decided_by_fkey FOREIGN KEY (app_id, decided_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: claim_items claim_items_order_key_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claim_items
    ADD CONSTRAINT claim_items_order_key_fkey FOREIGN KEY (app_id, platform, sub_order_id, order_id) REFERENCES app.order_keys(app_id, platform, sub_order_id, order_id);


--
-- Name: claims claims_handler_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claims
    ADD CONSTRAINT claims_handler_admin_fkey FOREIGN KEY (app_id, handler_admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: claims claims_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claims
    ADD CONSTRAINT claims_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: claims claims_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.claims
    ADD CONSTRAINT claims_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: commission_rule_reserves commission_rule_reserves_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_reserves
    ADD CONSTRAINT commission_rule_reserves_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: commission_rule_reserves commission_rule_reserves_rule_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_reserves
    ADD CONSTRAINT commission_rule_reserves_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: commission_rule_trials commission_rule_trials_base_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_trials
    ADD CONSTRAINT commission_rule_trials_base_version_id_fkey FOREIGN KEY (app_id, base_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: commission_rule_trials commission_rule_trials_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_trials
    ADD CONSTRAINT commission_rule_trials_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: commission_rule_trials commission_rule_trials_rule_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_trials
    ADD CONSTRAINT commission_rule_trials_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: commission_rule_versions commission_rule_versions_base_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_base_version_id_fkey FOREIGN KEY (app_id, base_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: commission_rule_versions commission_rule_versions_drafter_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_drafter_id_fkey FOREIGN KEY (app_id, drafter_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: commission_rule_versions commission_rule_versions_indirect_approver_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_indirect_approver_id_fkey FOREIGN KEY (app_id, indirect_approver_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: commission_rule_versions commission_rule_versions_publisher_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rule_versions
    ADD CONSTRAINT commission_rule_versions_publisher_id_fkey FOREIGN KEY (app_id, publisher_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: commission_rules commission_rules_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rules
    ADD CONSTRAINT commission_rules_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: commission_rules commission_rules_rule_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_rules
    ADD CONSTRAINT commission_rules_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: commission_split_amounts commission_split_amounts_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_amounts
    ADD CONSTRAINT commission_split_amounts_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: commission_split_beneficiary_events commission_split_beneficiary_events_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_beneficiary_events
    ADD CONSTRAINT commission_split_beneficiary_events_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: commission_split_totals commission_split_totals_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_split_totals
    ADD CONSTRAINT commission_split_totals_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: commission_splits commission_splits_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_splits
    ADD CONSTRAINT commission_splits_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: commission_splits commission_splits_rule_version_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.commission_splits
    ADD CONSTRAINT commission_splits_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id) REFERENCES app.commission_rule_versions(app_id, rule_version_id);


--
-- Name: consent_records consent_records_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: consent_records consent_records_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: daily_balances daily_balances_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.daily_balances
    ADD CONSTRAINT daily_balances_account_fkey FOREIGN KEY (app_id, account_id) REFERENCES app.ledger_accounts(app_id, id);


--
-- Name: deletion_requests deletion_requests_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.deletion_requests
    ADD CONSTRAINT deletion_requests_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: device_registrations device_registrations_merged_into_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_merged_into_fkey FOREIGN KEY (app_id, merged_into_user_id) REFERENCES app.users(app_id, id);


--
-- Name: device_registrations device_registrations_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: devices devices_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: dict_items dict_items_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.dict_items
    ADD CONSTRAINT dict_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.admin_users(id);


--
-- Name: export_tasks export_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.export_tasks
    ADD CONSTRAINT export_tasks_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: inbox_messages inbox_messages_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: invite_rewards invite_rewards_invitee_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_invitee_fkey FOREIGN KEY (app_id, invitee_id) REFERENCES app.users(app_id, id);


--
-- Name: invite_rewards invite_rewards_invitee_voucher_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_invitee_voucher_fkey FOREIGN KEY (app_id, invitee_voucher_id) REFERENCES app.ledger_vouchers(app_id, id);


--
-- Name: invite_rewards invite_rewards_inviter_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_inviter_fkey FOREIGN KEY (app_id, inviter_id) REFERENCES app.users(app_id, id);


--
-- Name: invite_rewards invite_rewards_inviter_voucher_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_inviter_voucher_fkey FOREIGN KEY (app_id, inviter_voucher_id) REFERENCES app.ledger_vouchers(app_id, id);


--
-- Name: invite_rewards invite_rewards_trigger_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invite_rewards
    ADD CONSTRAINT invite_rewards_trigger_order_fkey FOREIGN KEY (app_id, trigger_order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: landing_registrations landing_registrations_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.landing_registrations
    ADD CONSTRAINT landing_registrations_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: ledger_entries ledger_entries_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.ledger_entries
    ADD CONSTRAINT ledger_entries_account_fkey FOREIGN KEY (app_id, account_id) REFERENCES app.ledger_accounts(app_id, id);


--
-- Name: ledger_entries ledger_entries_voucher_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.ledger_entries
    ADD CONSTRAINT ledger_entries_voucher_fkey FOREIGN KEY (app_id, voucher_id) REFERENCES app.ledger_vouchers(app_id, id);


--
-- Name: level_change_logs level_change_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.level_change_logs
    ADD CONSTRAINT level_change_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_opener_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_opener_user_fkey FOREIGN KEY (app_id, opener_user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_open_attempts link_open_attempts_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: link_open_attempts link_open_attempts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: links links_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: links links_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: login_logs login_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: notification_settings notification_settings_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notification_settings
    ADD CONSTRAINT notification_settings_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: notify_logs notify_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.notify_logs
    ADD CONSTRAINT notify_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: order_assignments order_assignments_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_assignments
    ADD CONSTRAINT order_assignments_admin_fkey FOREIGN KEY (app_id, admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: order_assignments order_assignments_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_assignments
    ADD CONSTRAINT order_assignments_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_assignments order_assignments_to_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_assignments
    ADD CONSTRAINT order_assignments_to_user_fkey FOREIGN KEY (app_id, to_user_id) REFERENCES app.users(app_id, id);


--
-- Name: order_rights order_rights_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_settlements order_settlements_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_status_history order_status_history_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_status_history
    ADD CONSTRAINT order_status_history_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_sync_pending order_sync_pending_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_pending
    ADD CONSTRAINT order_sync_pending_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_sync_request_windows order_sync_request_windows_sync_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_request_windows
    ADD CONSTRAINT order_sync_request_windows_sync_fkey FOREIGN KEY (app_id, sync_id) REFERENCES app.order_sync_requests(app_id, id);


--
-- Name: order_sync_requests order_sync_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_sync_requests
    ADD CONSTRAINT order_sync_requests_requested_by_fkey FOREIGN KEY (app_id, requested_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: orders orders_identity_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_identity_fkey FOREIGN KEY (order_id, attr_at, app_id, platform, sub_order_id) REFERENCES app.order_keys(order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: orders orders_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: orders orders_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: page_preview_tokens page_preview_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_preview_tokens
    ADD CONSTRAINT page_preview_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.admin_users(id);


--
-- Name: page_preview_tokens page_preview_tokens_version_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_preview_tokens
    ADD CONSTRAINT page_preview_tokens_version_fkey FOREIGN KEY (app_id, page_key, version) REFERENCES app.page_versions(app_id, page_key, version);


--
-- Name: page_versions page_versions_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_versions
    ADD CONSTRAINT page_versions_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: page_versions page_versions_publisher_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.page_versions
    ADD CONSTRAINT page_versions_publisher_fkey FOREIGN KEY (publisher) REFERENCES app.admin_users(id);


--
-- Name: pages pages_current_version_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_current_version_fkey FOREIGN KEY (app_id, page_key, current_version) REFERENCES app.page_versions(app_id, page_key, version);


--
-- Name: pages pages_gray_version_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_gray_version_fkey FOREIGN KEY (app_id, page_key, gray_version) REFERENCES app.page_versions(app_id, page_key, version);


--
-- Name: pages pages_scheduled_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_scheduled_by_admin_id_fkey FOREIGN KEY (scheduled_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: pages pages_scheduled_version_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_scheduled_version_fkey FOREIGN KEY (app_id, page_key, scheduled_version) REFERENCES app.page_versions(app_id, page_key, version);


--
-- Name: pages pages_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pages
    ADD CONSTRAINT pages_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: pay_anomalies pay_anomalies_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_anomalies
    ADD CONSTRAINT pay_anomalies_order_fkey FOREIGN KEY (app_id, pay_order_id) REFERENCES app.pay_orders(app_id, id);


--
-- Name: pay_fulfillments pay_fulfillments_last_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_fulfillments
    ADD CONSTRAINT pay_fulfillments_last_order_fkey FOREIGN KEY (app_id, last_pay_order_id) REFERENCES app.pay_orders(app_id, id);


--
-- Name: pay_orders pay_orders_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_orders
    ADD CONSTRAINT pay_orders_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: pay_query_attempts pay_query_attempts_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_query_attempts
    ADD CONSTRAINT pay_query_attempts_order_fkey FOREIGN KEY (app_id, pay_order_id) REFERENCES app.pay_orders(app_id, id);


--
-- Name: pay_query_attempts pay_query_attempts_refund_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pay_query_attempts
    ADD CONSTRAINT pay_query_attempts_refund_fkey FOREIGN KEY (app_id, pay_refund_id) REFERENCES app.pay_refunds(app_id, id);


--
-- Name: payout_account_changes payout_account_changes_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_changes
    ADD CONSTRAINT payout_account_changes_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_accounts payout_accounts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_accounts
    ADD CONSTRAINT payout_accounts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_attempts payout_attempts_withdrawal_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_attempts
    ADD CONSTRAINT payout_attempts_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES app.withdrawals(id);


--
-- Name: payout_batch_items payout_batch_items_batch_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_batch_items
    ADD CONSTRAINT payout_batch_items_batch_fkey FOREIGN KEY (batch_id) REFERENCES app.payout_batches(id);


--
-- Name: payout_batch_items payout_batch_items_moved_to_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_batch_items
    ADD CONSTRAINT payout_batch_items_moved_to_fkey FOREIGN KEY (moved_to_batch_id) REFERENCES app.payout_batches(id);


--
-- Name: payout_batch_items payout_batch_items_withdrawal_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_batch_items
    ADD CONSTRAINT payout_batch_items_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES app.withdrawals(id);


--
-- Name: personal_data_copies personal_data_copies_requested_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.personal_data_copies
    ADD CONSTRAINT personal_data_copies_requested_by_fkey FOREIGN KEY (app_id, requested_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: personal_data_copies personal_data_copies_retry_of_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.personal_data_copies
    ADD CONSTRAINT personal_data_copies_retry_of_fkey FOREIGN KEY (app_id, retry_of) REFERENCES app.personal_data_copies(app_id, id);


--
-- Name: personal_data_copies personal_data_copies_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.personal_data_copies
    ADD CONSTRAINT personal_data_copies_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: platform_icon_uploads platform_icon_uploads_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_uploads
    ADD CONSTRAINT platform_icon_uploads_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: platform_icon_versions platform_icon_versions_created_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_versions
    ADD CONSTRAINT platform_icon_versions_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: platform_icon_versions platform_icon_versions_upload_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icon_versions
    ADD CONSTRAINT platform_icon_versions_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES app.platform_icon_uploads(id);


--
-- Name: platform_icons platform_icons_current_version_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icons
    ADD CONSTRAINT platform_icons_current_version_fkey FOREIGN KEY (app_id, key, current_version) REFERENCES app.platform_icon_versions(app_id, key, version);


--
-- Name: platform_icons platform_icons_updated_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platform_icons
    ADD CONSTRAINT platform_icons_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id) REFERENCES app.admin_users(id);


--
-- Name: pool_items pool_items_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pool_items
    ADD CONSTRAINT pool_items_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: pool_items pool_items_pool_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.pool_items
    ADD CONSTRAINT pool_items_pool_fkey FOREIGN KEY (app_id, pool_id) REFERENCES app.product_pools(app_id, pool_id);


--
-- Name: product_pools product_pools_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_pools
    ADD CONSTRAINT product_pools_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: product_refs product_refs_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_refs
    ADD CONSTRAINT product_refs_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: push_tokens push_tokens_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: push_tokens push_tokens_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: realname_prior_identities realname_prior_identities_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.realname_prior_identities
    ADD CONSTRAINT realname_prior_identities_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: realname realname_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.realname
    ADD CONSTRAINT realname_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: recon_diffs recon_diffs_handler_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.recon_diffs
    ADD CONSTRAINT recon_diffs_handler_fkey FOREIGN KEY (app_id, handler_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: refresh_tokens refresh_tokens_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_parent_fkey FOREIGN KEY (app_id, parent_hash) REFERENCES app.refresh_tokens(app_id, token_hash);


--
-- Name: refresh_tokens refresh_tokens_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_fkey FOREIGN KEY (app_id, sid) REFERENCES app.sessions(app_id, sid);


--
-- Name: relation_change_logs relation_change_logs_from_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.relation_change_logs
    ADD CONSTRAINT relation_change_logs_from_parent_fkey FOREIGN KEY (app_id, from_parent_id) REFERENCES app.users(app_id, id);


--
-- Name: relation_change_logs relation_change_logs_to_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.relation_change_logs
    ADD CONSTRAINT relation_change_logs_to_parent_fkey FOREIGN KEY (app_id, to_parent_id) REFERENCES app.users(app_id, id);


--
-- Name: relation_change_logs relation_change_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.relation_change_logs
    ADD CONSTRAINT relation_change_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: reverified_devices reverified_devices_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.reverified_devices
    ADD CONSTRAINT reverified_devices_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: rights_import_failures rights_import_failures_import_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_import_failures
    ADD CONSTRAINT rights_import_failures_import_fkey FOREIGN KEY (app_id, import_id) REFERENCES app.rights_imports(app_id, id);


--
-- Name: rights_imports rights_imports_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_imports
    ADD CONSTRAINT rights_imports_created_by_fkey FOREIGN KEY (app_id, created_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: rights_imports rights_imports_union_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.rights_imports
    ADD CONSTRAINT rights_imports_union_account_fkey FOREIGN KEY (app_id, union_account_id) REFERENCES app.union_accounts(app_id, id);


--
-- Name: risk_hits risk_hits_rule_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_rule_fkey FOREIGN KEY (app_id, rule_id) REFERENCES app.risk_rules(app_id, rule_id);


--
-- Name: risk_hits risk_hits_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: risk_judgements risk_judgements_rule_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_judgements
    ADD CONSTRAINT risk_judgements_rule_fkey FOREIGN KEY (app_id, rule_id) REFERENCES app.risk_rules(app_id, rule_id);


--
-- Name: risk_judgements risk_judgements_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_judgements
    ADD CONSTRAINT risk_judgements_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: sessions sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: sessions sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: settle_adjust_batches settle_adjust_batches_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjust_batches
    ADD CONSTRAINT settle_adjust_batches_confirmed_by_fkey FOREIGN KEY (app_id, confirmed_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: settle_adjustments settle_adjustments_approver_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_approver_fkey FOREIGN KEY (app_id, approver) REFERENCES app.admin_users(app_id, id);


--
-- Name: settle_adjustments settle_adjustments_batch_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_batch_fkey FOREIGN KEY (app_id, batch_id) REFERENCES app.settle_adjust_batches(app_id, batch_id);


--
-- Name: settle_adjustments settle_adjustments_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: settle_adjustments settle_adjustments_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_adjustments
    ADD CONSTRAINT settle_adjustments_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: settle_batch_items settle_batch_items_batch_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batch_items
    ADD CONSTRAINT settle_batch_items_batch_fkey FOREIGN KEY (app_id, batch_id) REFERENCES app.settle_batches(app_id, batch_id);


--
-- Name: settle_batch_items settle_batch_items_credit_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batch_items
    ADD CONSTRAINT settle_batch_items_credit_fkey FOREIGN KEY (app_id, beneficiary_credit_id, order_id, user_id, role) REFERENCES app.beneficiary_credits(app_id, beneficiary_credit_id, order_id, user_id, role);


--
-- Name: settle_batch_items settle_batch_items_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batch_items
    ADD CONSTRAINT settle_batch_items_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: settle_batches settle_batches_bill_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batches
    ADD CONSTRAINT settle_batches_bill_fkey FOREIGN KEY (app_id, bill_id) REFERENCES app.settle_bills(app_id, bill_id);


--
-- Name: settle_batches settle_batches_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_batches
    ADD CONSTRAINT settle_batches_confirmed_by_fkey FOREIGN KEY (app_id, confirmed_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: settle_runs settle_runs_bill_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.settle_runs
    ADD CONSTRAINT settle_runs_bill_fkey FOREIGN KEY (app_id, bill_id) REFERENCES app.settle_bills(app_id, bill_id);


--
-- Name: share_materials share_materials_link_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.share_materials
    ADD CONSTRAINT share_materials_link_id_fkey FOREIGN KEY (link_id) REFERENCES app.links(link_id);


--
-- Name: sync_cursors sync_cursors_union_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sync_cursors
    ADD CONSTRAINT sync_cursors_union_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: tax_ytd tax_ytd_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.tax_ytd
    ADD CONSTRAINT tax_ytd_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_accounts union_accounts_auth_renewed_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_auth_renewed_by_fkey FOREIGN KEY (app_id, auth_renewed_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: union_auth_sessions union_auth_sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: union_auth_sessions union_auth_sessions_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: union_auth_sessions union_auth_sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_binding_conflicts union_binding_conflicts_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_binding_conflicts
    ADD CONSTRAINT union_binding_conflicts_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: union_binding_conflicts union_binding_conflicts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_binding_conflicts
    ADD CONSTRAINT union_binding_conflicts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_bindings union_bindings_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: union_bindings union_bindings_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_credentials union_credentials_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_credentials
    ADD CONSTRAINT union_credentials_account_fkey FOREIGN KEY (app_id, union_account_id) REFERENCES app.union_accounts(app_id, id);


--
-- Name: union_pids union_pids_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: user_oauth user_oauth_merged_from_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_merged_from_fkey FOREIGN KEY (app_id, merged_from_user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_oauth user_oauth_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_risk_state user_risk_state_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_risk_state
    ADD CONSTRAINT user_risk_state_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_tip_reads user_tip_reads_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: users users_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_parent_fkey FOREIGN KEY (app_id, parent_id) REFERENCES app.users(app_id, id);


--
-- Name: withdraw_holds withdraw_holds_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdraw_holds
    ADD CONSTRAINT withdraw_holds_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: withdrawals withdrawals_batch_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdrawals
    ADD CONSTRAINT withdrawals_batch_fkey FOREIGN KEY (batch_id) REFERENCES app.payout_batches(id);


--
-- Name: withdrawals withdrawals_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.withdrawals
    ADD CONSTRAINT withdrawals_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: job_common dlq_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: job_common q_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: queue queue_dead_letter_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_dead_letter_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name);


--
-- Name: schedule schedule_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: subscription subscription_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA app TO couli_app;
GRANT USAGE ON SCHEMA app TO couli_payout;
GRANT USAGE ON SCHEMA app TO couli_readonly;
GRANT USAGE ON SCHEMA app TO couli_maint;


--
-- Name: SCHEMA pgboss; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA pgboss TO couli_app;
GRANT USAGE ON SCHEMA pgboss TO couli_payout;


--
-- Name: FUNCTION delete_expired_deleted_identities(p_now timestamp with time zone, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_deleted_identities(p_now timestamp with time zone, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_deleted_identities(p_now timestamp with time zone, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_device_registrations(p_now timestamp with time zone, p_days integer, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_device_registrations(p_now timestamp with time zone, p_days integer, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_device_registrations(p_now timestamp with time zone, p_days integer, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_inbox_messages(p_now timestamp with time zone, p_days integer, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_inbox_messages(p_now timestamp with time zone, p_days integer, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_inbox_messages(p_now timestamp with time zone, p_days integer, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_login_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_login_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_login_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_notify_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_notify_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_notify_logs(p_now timestamp with time zone, p_days integer, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION delete_expired_sms_send_attempts(p_now timestamp with time zone, p_days integer, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_sms_send_attempts(p_now timestamp with time zone, p_days integer, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_sms_send_attempts(p_now timestamp with time zone, p_days integer, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION drop_expired_day_partitions(p_table text, p_now timestamp with time zone); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) TO couli_maint;


--
-- Name: FUNCTION drop_expired_month_partitions(p_table text, p_now timestamp with time zone); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) TO couli_maint;


--
-- Name: FUNCTION drop_expired_union_raw_payload_partitions(p_now timestamp with time zone, p_days integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.drop_expired_union_raw_payload_partitions(p_now timestamp with time zone, p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.drop_expired_union_raw_payload_partitions(p_now timestamp with time zone, p_days integer) TO couli_maint;


--
-- Name: FUNCTION ensure_day_partition(p_table text, p_day date); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.ensure_day_partition(p_table text, p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION app.ensure_day_partition(p_table text, p_day date) TO couli_maint;


--
-- Name: FUNCTION ensure_month_partition(p_table text, p_month date); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) FROM PUBLIC;
GRANT ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) TO couli_maint;


--
-- Name: FUNCTION partition_default_rows(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.partition_default_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION app.partition_default_rows() TO couli_maint;


--
-- Name: FUNCTION pay_orders_reject_immutable_update(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.pay_orders_reject_immutable_update() FROM PUBLIC;


--
-- Name: FUNCTION pay_refunds_reject_immutable_update(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.pay_refunds_reject_immutable_update() FROM PUBLIC;


--
-- Name: FUNCTION payout_accounts_reject_identifier_update(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.payout_accounts_reject_identifier_update() FROM PUBLIC;


--
-- Name: FUNCTION read_retention_settings(p_app_id text); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.read_retention_settings(p_app_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.read_retention_settings(p_app_id text) TO couli_maint;


--
-- Name: FUNCTION reject_agent_card_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_card_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_result_chain_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_result_chain_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_result_delivery_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_result_delivery_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_result_set_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_result_set_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_run_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_run_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_session_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_session_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_tool_call_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_tool_call_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_device_registration_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_device_registration_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_open_attempt_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_open_attempt_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_promo_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_promo_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_quote_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_quote_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_order_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_order_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_product_ref_key_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_product_ref_key_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_rule_chunk_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_rule_chunk_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_union_auth_session_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_union_auth_session_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_union_binding_conflict_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_union_binding_conflict_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_update_delete(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_update_delete() FROM PUBLIC;


--
-- Name: TABLE account_balances; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.account_balances TO couli_app;
GRANT SELECT ON TABLE app.account_balances TO couli_readonly;


--
-- Name: COLUMN account_balances.available_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(available_fen) ON TABLE app.account_balances TO couli_app;


--
-- Name: COLUMN account_balances.frozen_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_fen) ON TABLE app.account_balances TO couli_app;


--
-- Name: COLUMN account_balances.negative_since; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(negative_since) ON TABLE app.account_balances TO couli_app;


--
-- Name: COLUMN account_balances.version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(version) ON TABLE app.account_balances TO couli_app;


--
-- Name: TABLE admin_permissions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.admin_permissions TO couli_app;
GRANT SELECT ON TABLE app.admin_permissions TO couli_readonly;


--
-- Name: TABLE admin_union_auth_sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.admin_union_auth_sessions TO couli_app;


--
-- Name: COLUMN admin_union_auth_sessions.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.union_account_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(union_account_id) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.created_by; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_by) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(expires_at) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.used_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(used_at) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.status; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(status) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.error; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(error) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(finished_at) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN admin_union_auth_sessions.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(updated_at) ON TABLE app.admin_union_auth_sessions TO couli_readonly;


--
-- Name: TABLE admin_users; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.login_name; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(login_name) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.password_hash; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(password_hash) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.totp_secret_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_secret_cipher) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.totp_bound_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_bound_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(totp_bound_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.totp_last_step; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_last_step) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(totp_last_step) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.is_super; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_super) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(is_super) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(status) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.verify_phone_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_cipher) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.verify_phone_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_hmac) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.verify_phone_set_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_set_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(verify_phone_set_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(row_version) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.password_must_change; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(password_must_change) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.failed_login_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(failed_login_count) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.locked_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(locked_until) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.display_name; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(display_name) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(display_name) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: TABLE agent_cards; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_cards TO couli_app;
GRANT SELECT ON TABLE app.agent_cards TO couli_readonly;


--
-- Name: COLUMN agent_cards.data; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(data) ON TABLE app.agent_cards TO couli_app;


--
-- Name: COLUMN agent_cards.fallback_text; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(fallback_text) ON TABLE app.agent_cards TO couli_app;


--
-- Name: TABLE agent_clarify_asks; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_clarify_asks TO couli_app;
GRANT SELECT ON TABLE app.agent_clarify_asks TO couli_readonly;


--
-- Name: TABLE agent_messages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.session_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(session_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.client_msg_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(client_msg_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.role; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(role) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.text; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(text) ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.card_ids; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_ids) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(card_ids) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.feedback; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(feedback) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(feedback) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.feedback_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(feedback_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(feedback_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.reported; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reported) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(reported) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_reason) ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.reported_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reported_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(reported_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_status) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_status) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_handler_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_handler_id) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_handler_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_handled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_handled_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_handled_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_note; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_note) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_note) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.badcase; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(badcase) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(badcase) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(row_version) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: TABLE agent_result_chains; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_result_chains TO couli_app;


--
-- Name: COLUMN agent_result_chains.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: COLUMN agent_result_chains.session_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(session_id) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: COLUMN agent_result_chains.seq; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(seq) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: COLUMN agent_result_chains.chain_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(chain_id) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: COLUMN agent_result_chains.status; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(status) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: COLUMN agent_result_chains.conditions; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(conditions) ON TABLE app.agent_result_chains TO couli_app;


--
-- Name: COLUMN agent_result_chains.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_result_chains TO couli_readonly;


--
-- Name: TABLE agent_result_deliveries; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_result_deliveries TO couli_app;
GRANT SELECT ON TABLE app.agent_result_deliveries TO couli_readonly;


--
-- Name: COLUMN agent_result_deliveries.card; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card) ON TABLE app.agent_result_deliveries TO couli_app;


--
-- Name: TABLE agent_result_sets; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_result_sets TO couli_app;


--
-- Name: COLUMN agent_result_sets.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.conditions; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(conditions) ON TABLE app.agent_result_sets TO couli_app;


--
-- Name: COLUMN agent_result_sets.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: TABLE agent_rule_chunks; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_rule_chunks TO couli_app;


--
-- Name: COLUMN agent_rule_chunks.chunk_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(chunk_id) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.article_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(article_id) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.published_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(published_version) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.seq; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(seq) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.agent_rule_chunks TO couli_app;
GRANT SELECT(status) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: COLUMN agent_rule_chunks.retired_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(retired_at) ON TABLE app.agent_rule_chunks TO couli_app;
GRANT SELECT(retired_at) ON TABLE app.agent_rule_chunks TO couli_readonly;


--
-- Name: TABLE agent_runs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_runs TO couli_app;


--
-- Name: COLUMN agent_runs.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.session_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(session_id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.user_text; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_text) ON TABLE app.agent_runs TO couli_app;


--
-- Name: COLUMN agent_runs.intent; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(intent) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(intent) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.model; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(model) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(model) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.model_snapshot; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(model_snapshot) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(model_snapshot) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.prompt_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(prompt_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.input_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(input_tokens) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(input_tokens) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_tokens) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_tokens) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.cost_mfen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cost_mfen) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(cost_mfen) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.ttft_ms; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(ttft_ms) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(ttft_ms) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.latency_ms; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(latency_ms) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(latency_ms) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finish_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finish_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finish_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.final_event; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(final_event) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(final_event) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.ended_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(ended_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(ended_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_filtered; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_filtered) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_filtered) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.filter_hits; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(filter_hits) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(filter_hits) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_truncated; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_truncated) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_truncated) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.price_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(price_version) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(price_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.result_check_provider; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(result_check_provider) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(result_check_provider) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.judge_model; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(judge_model) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(judge_model) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.page_guide_reject_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(page_guide_reject_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(page_guide_reject_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.accepted_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(accepted_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.quota_subjects; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(quota_subjects) ON TABLE app.agent_runs TO couli_readonly;
GRANT UPDATE(quota_subjects) ON TABLE app.agent_runs TO couli_app;


--
-- Name: COLUMN agent_runs.end_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(end_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.card_delivered; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_delivered) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(card_delivered) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.settle_result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settle_result) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(settle_result) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.settled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settled_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(settled_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(row_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.deadline_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(deadline_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.end_draft; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_draft) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(end_draft) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.cancel_requested_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cancel_requested_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(cancel_requested_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finalize_hold; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finalize_hold) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finalize_hold) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finalize_hold_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finalize_hold_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finalize_hold_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: TABLE agent_sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_sessions TO couli_app;
GRANT SELECT ON TABLE app.agent_sessions TO couli_readonly;


--
-- Name: COLUMN agent_sessions.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_id) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.last_active_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(last_active_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.expired_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expired_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.card_seq; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_seq) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.run_lock_run_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(run_lock_run_id) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.run_lock_expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(run_lock_expires_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.user_hash; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_hash) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: TABLE agent_tool_calls; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_tool_calls TO couli_app;


--
-- Name: COLUMN agent_tool_calls.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.seq; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(seq) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.name; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(name) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.args; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(args) ON TABLE app.agent_tool_calls TO couli_app;


--
-- Name: COLUMN agent_tool_calls.result_digest; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(result_digest) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.status; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(status) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.latency_ms; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(latency_ms) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: TABLE agreements; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agreements TO couli_app;
GRANT SELECT ON TABLE app.agreements TO couli_readonly;


--
-- Name: TABLE app_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.app_versions TO couli_app;
GRANT SELECT ON TABLE app.app_versions TO couli_readonly;


--
-- Name: TABLE appeal_claims; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.appeal_claims TO couli_app;
GRANT SELECT ON TABLE app.appeal_claims TO couli_readonly;


--
-- Name: TABLE appeals; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.appeals TO couli_app;
GRANT SELECT ON TABLE app.appeals TO couli_readonly;


--
-- Name: COLUMN appeals.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.handler_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(handler_id) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.closed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_at) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.appeals TO couli_app;


--
-- Name: TABLE articles; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.articles TO couli_app;
GRANT SELECT ON TABLE app.articles TO couli_readonly;


--
-- Name: COLUMN articles.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.articles TO couli_app;


--
-- Name: COLUMN articles.published_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(published_at) ON TABLE app.articles TO couli_app;


--
-- Name: COLUMN articles.notice_end_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(notice_end_at) ON TABLE app.articles TO couli_app;


--
-- Name: COLUMN articles.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.articles TO couli_app;


--
-- Name: COLUMN articles.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.articles TO couli_app;


--
-- Name: TABLE asset_snapshot_receivables; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.asset_snapshot_receivables TO couli_app;
GRANT SELECT ON TABLE app.asset_snapshot_receivables TO couli_readonly;


--
-- Name: TABLE asset_snapshots; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.asset_snapshots TO couli_app;
GRANT SELECT ON TABLE app.asset_snapshots TO couli_readonly;


--
-- Name: COLUMN asset_snapshots.waiting_comparable; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(waiting_comparable) ON TABLE app.asset_snapshots TO couli_app;


--
-- Name: COLUMN asset_snapshots.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.asset_snapshots TO couli_app;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.audit_logs TO couli_app;
GRANT SELECT ON TABLE app.audit_logs TO couli_readonly;


--
-- Name: TABLE beneficiary_credits; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.beneficiary_credits TO couli_app;
GRANT SELECT ON TABLE app.beneficiary_credits TO couli_readonly;


--
-- Name: COLUMN beneficiary_credits.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: COLUMN beneficiary_credits.closed_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_by) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: COLUMN beneficiary_credits.closed_ref; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_ref) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: COLUMN beneficiary_credits.voucher_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(voucher_id) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: COLUMN beneficiary_credits.closed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_at) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: COLUMN beneficiary_credits.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.beneficiary_credits TO couli_app;


--
-- Name: TABLE blocklist; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.blocklist TO couli_app;
GRANT SELECT ON TABLE app.blocklist TO couli_readonly;


--
-- Name: COLUMN blocklist.value_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(value_hmac) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.value; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(value) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.violation_type; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(violation_type) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.end_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.expire_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expire_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: TABLE category_blocklist; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.category_blocklist TO couli_app;
GRANT SELECT ON TABLE app.category_blocklist TO couli_readonly;


--
-- Name: COLUMN category_blocklist.category_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(category_id) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.keyword; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(keyword) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.updated_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_by) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: TABLE claim_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.claim_items TO couli_app;
GRANT SELECT ON TABLE app.claim_items TO couli_readonly;


--
-- Name: COLUMN claim_items.evidence; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(evidence) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.evidence_link_log_ids; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(evidence_link_log_ids) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.decision; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(decision) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.reject_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reject_reason) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.decided_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(decided_by) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.decided_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(decided_at) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.claim_items TO couli_app;


--
-- Name: COLUMN claim_items.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.claim_items TO couli_app;


--
-- Name: TABLE claims; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.claims TO couli_app;
GRANT SELECT ON TABLE app.claims TO couli_readonly;


--
-- Name: COLUMN claims.evidence_level; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(evidence_level) ON TABLE app.claims TO couli_app;


--
-- Name: COLUMN claims.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.claims TO couli_app;


--
-- Name: COLUMN claims.handler_admin_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(handler_admin_id) ON TABLE app.claims TO couli_app;


--
-- Name: COLUMN claims.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.claims TO couli_app;


--
-- Name: COLUMN claims.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.claims TO couli_app;


--
-- Name: COLUMN claims.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.claims TO couli_app;


--
-- Name: TABLE commission_rule_reserves; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_rule_reserves TO couli_app;
GRANT SELECT ON TABLE app.commission_rule_reserves TO couli_readonly;


--
-- Name: TABLE commission_rule_trials; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_rule_trials TO couli_app;
GRANT SELECT ON TABLE app.commission_rule_trials TO couli_readonly;


--
-- Name: TABLE commission_rule_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_rule_versions TO couli_app;
GRANT SELECT ON TABLE app.commission_rule_versions TO couli_readonly;


--
-- Name: COLUMN commission_rule_versions.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: COLUMN commission_rule_versions.publisher_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(publisher_id) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: COLUMN commission_rule_versions.published_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(published_at) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: COLUMN commission_rule_versions.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: COLUMN commission_rule_versions.indirect_approver_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(indirect_approver_id) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: COLUMN commission_rule_versions.indirect_approved_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(indirect_approved_at) ON TABLE app.commission_rule_versions TO couli_app;


--
-- Name: TABLE commission_rules; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_rules TO couli_app;
GRANT SELECT ON TABLE app.commission_rules TO couli_readonly;


--
-- Name: TABLE commission_split_amounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_split_amounts TO couli_app;
GRANT SELECT ON TABLE app.commission_split_amounts TO couli_readonly;


--
-- Name: TABLE commission_split_beneficiary_events; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_split_beneficiary_events TO couli_app;
GRANT SELECT ON TABLE app.commission_split_beneficiary_events TO couli_readonly;


--
-- Name: TABLE commission_split_totals; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_split_totals TO couli_app;
GRANT SELECT ON TABLE app.commission_split_totals TO couli_readonly;


--
-- Name: TABLE commission_splits; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.commission_splits TO couli_app;
GRANT SELECT ON TABLE app.commission_splits TO couli_readonly;


--
-- Name: TABLE config_item_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.config_item_versions TO couli_app;
GRANT SELECT ON TABLE app.config_item_versions TO couli_readonly;
GRANT SELECT ON TABLE app.config_item_versions TO couli_payout;


--
-- Name: TABLE config_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.config_items TO couli_app;
GRANT SELECT ON TABLE app.config_items TO couli_readonly;
GRANT SELECT ON TABLE app.config_items TO couli_payout;


--
-- Name: TABLE consent_records; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.consent_records TO couli_app;
GRANT SELECT ON TABLE app.consent_records TO couli_readonly;


--
-- Name: TABLE daily_balances; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.daily_balances TO couli_app;
GRANT SELECT ON TABLE app.daily_balances TO couli_readonly;


--
-- Name: TABLE deleted_identities; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.deleted_identities TO couli_app;
GRANT SELECT ON TABLE app.deleted_identities TO couli_readonly;


--
-- Name: TABLE deletion_requests; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.deletion_requests TO couli_app;
GRANT SELECT ON TABLE app.deletion_requests TO couli_readonly;


--
-- Name: COLUMN deletion_requests.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.cancelled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cancelled_at) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.cancel_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cancel_reason) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.processed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(processed_at) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.cleaned_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cleaned_at) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.apple_revoke_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(apple_revoke_attempts) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: COLUMN deletion_requests.apple_revoke_result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(apple_revoke_result) ON TABLE app.deletion_requests TO couli_app;


--
-- Name: TABLE device_registrations; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.device_registrations TO couli_app;
GRANT SELECT ON TABLE app.device_registrations TO couli_readonly;


--
-- Name: COLUMN device_registrations.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.device_hash; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(device_hash) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.register_method; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(register_method) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(created_at) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.merged_into_user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(merged_into_user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: TABLE devices; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.devices TO couli_app;


--
-- Name: COLUMN devices.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.device_hash; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(device_hash) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.id_source; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id_source) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.platform; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(platform) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.app_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_version) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.last_login_sid; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(last_login_sid) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(revoked_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.last_seen_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(last_seen_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(row_version) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(updated_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: TABLE dict_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.dict_items TO couli_app;
GRANT SELECT ON TABLE app.dict_items TO couli_readonly;


--
-- Name: TABLE event_log; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.event_log TO couli_app;
GRANT SELECT,INSERT ON TABLE app.event_log TO couli_payout;
GRANT SELECT ON TABLE app.event_log TO couli_readonly;


--
-- Name: TABLE export_tasks; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.export_tasks TO couli_app;
GRANT SELECT ON TABLE app.export_tasks TO couli_readonly;


--
-- Name: COLUMN export_tasks.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.progress; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(progress) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.failure_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(failure_reason) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.file_name; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(file_name) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.object_key; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(object_key) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.row_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_count) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.generated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(generated_at) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expires_at) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.export_tasks TO couli_app;


--
-- Name: COLUMN export_tasks.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.export_tasks TO couli_app;


--
-- Name: TABLE favorites; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.favorites TO couli_app;
GRANT SELECT ON TABLE app.favorites TO couli_readonly;


--
-- Name: TABLE idempotency_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.idempotency_keys TO couli_app;
GRANT SELECT ON TABLE app.idempotency_keys TO couli_readonly;


--
-- Name: TABLE inbox_messages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.inbox_messages TO couli_app;
GRANT SELECT ON TABLE app.inbox_messages TO couli_readonly;


--
-- Name: COLUMN inbox_messages.read_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(read_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: TABLE invite_reward_budgets; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.invite_reward_budgets TO couli_app;
GRANT SELECT ON TABLE app.invite_reward_budgets TO couli_readonly;


--
-- Name: COLUMN invite_reward_budgets.reserved_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reserved_fen) ON TABLE app.invite_reward_budgets TO couli_app;


--
-- Name: COLUMN invite_reward_budgets.granted_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(granted_fen) ON TABLE app.invite_reward_budgets TO couli_app;


--
-- Name: COLUMN invite_reward_budgets.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.invite_reward_budgets TO couli_app;


--
-- Name: COLUMN invite_reward_budgets.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.invite_reward_budgets TO couli_app;


--
-- Name: TABLE invite_rewards; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.invite_rewards TO couli_app;
GRANT SELECT ON TABLE app.invite_rewards TO couli_readonly;


--
-- Name: COLUMN invite_rewards.trigger_order_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(trigger_order_id) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.triggered_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(triggered_at) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.inviter_result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(inviter_result) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.invitee_result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(invitee_result) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.inviter_skip_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(inviter_skip_reason) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.invitee_skip_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(invitee_skip_reason) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.void_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(void_reason) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.inviter_voucher_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(inviter_voucher_id) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.invitee_voucher_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(invitee_voucher_id) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.granted_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(granted_at) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: COLUMN invite_rewards.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.invite_rewards TO couli_app;


--
-- Name: TABLE landing_registrations; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.landing_registrations TO couli_app;
GRANT SELECT ON TABLE app.landing_registrations TO couli_readonly;


--
-- Name: TABLE ledger_accounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.ledger_accounts TO couli_app;
GRANT SELECT ON TABLE app.ledger_accounts TO couli_readonly;


--
-- Name: TABLE ledger_entries; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.ledger_entries TO couli_app;
GRANT SELECT ON TABLE app.ledger_entries TO couli_readonly;


--
-- Name: TABLE ledger_vouchers; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.ledger_vouchers TO couli_app;
GRANT SELECT ON TABLE app.ledger_vouchers TO couli_readonly;


--
-- Name: TABLE level_change_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.level_change_logs TO couli_app;
GRANT SELECT ON TABLE app.level_change_logs TO couli_readonly;


--
-- Name: TABLE link_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_logs TO couli_app;
GRANT SELECT ON TABLE app.link_logs TO couli_readonly;


--
-- Name: TABLE link_logs_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.link_logs_default TO couli_readonly;


--
-- Name: TABLE link_open_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_open_attempts TO couli_app;
GRANT SELECT ON TABLE app.link_open_attempts TO couli_readonly;


--
-- Name: COLUMN link_open_attempts.jump_reported_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(jump_reported_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.dismissed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(dismissed_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: TABLE links; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.links TO couli_app;
GRANT SELECT ON TABLE app.links TO couli_readonly;


--
-- Name: TABLE login_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.login_logs TO couli_app;
GRANT SELECT ON TABLE app.login_logs TO couli_readonly;


--
-- Name: COLUMN login_logs.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_id) ON TABLE app.login_logs TO couli_app;


--
-- Name: TABLE notification_settings; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.notification_settings TO couli_app;
GRANT SELECT ON TABLE app.notification_settings TO couli_readonly;


--
-- Name: COLUMN notification_settings.service_push; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(service_push) ON TABLE app.notification_settings TO couli_app;


--
-- Name: COLUMN notification_settings.subscription_push; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(subscription_push) ON TABLE app.notification_settings TO couli_app;


--
-- Name: COLUMN notification_settings.marketing_push; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(marketing_push) ON TABLE app.notification_settings TO couli_app;


--
-- Name: COLUMN notification_settings.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.notification_settings TO couli_app;


--
-- Name: COLUMN notification_settings.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.notification_settings TO couli_app;


--
-- Name: TABLE notify_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.notify_logs TO couli_app;
GRANT SELECT ON TABLE app.notify_logs TO couli_readonly;


--
-- Name: TABLE notify_templates; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.notify_templates TO couli_app;
GRANT SELECT ON TABLE app.notify_templates TO couli_readonly;


--
-- Name: TABLE order_assignments; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_assignments TO couli_app;
GRANT SELECT ON TABLE app.order_assignments TO couli_readonly;


--
-- Name: TABLE order_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_keys TO couli_app;
GRANT SELECT ON TABLE app.order_keys TO couli_readonly;


--
-- Name: TABLE order_rights; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_rights TO couli_app;
GRANT SELECT ON TABLE app.order_rights TO couli_readonly;


--
-- Name: COLUMN order_rights.answered_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(answered_at) ON TABLE app.order_rights TO couli_app;


--
-- Name: TABLE order_settlements; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_settlements TO couli_app;
GRANT SELECT ON TABLE app.order_settlements TO couli_readonly;


--
-- Name: TABLE order_status_history; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_status_history TO couli_app;
GRANT SELECT ON TABLE app.order_status_history TO couli_readonly;


--
-- Name: TABLE order_sync_counters; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_sync_counters TO couli_app;
GRANT SELECT ON TABLE app.order_sync_counters TO couli_readonly;


--
-- Name: TABLE order_sync_drop_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_sync_drop_keys TO couli_app;
GRANT SELECT ON TABLE app.order_sync_drop_keys TO couli_readonly;


--
-- Name: TABLE order_sync_drops; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_sync_drops TO couli_app;
GRANT SELECT ON TABLE app.order_sync_drops TO couli_readonly;


--
-- Name: TABLE order_sync_pending; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_sync_pending TO couli_app;
GRANT SELECT ON TABLE app.order_sync_pending TO couli_readonly;


--
-- Name: TABLE order_sync_request_windows; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_sync_request_windows TO couli_app;
GRANT SELECT ON TABLE app.order_sync_request_windows TO couli_readonly;


--
-- Name: COLUMN order_sync_request_windows.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: COLUMN order_sync_request_windows.fetched_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(fetched_count) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: COLUMN order_sync_request_windows.stored_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(stored_count) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: COLUMN order_sync_request_windows.error; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(error) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: COLUMN order_sync_request_windows.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: COLUMN order_sync_request_windows.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.order_sync_request_windows TO couli_app;


--
-- Name: TABLE order_sync_requests; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_sync_requests TO couli_app;
GRANT SELECT ON TABLE app.order_sync_requests TO couli_readonly;


--
-- Name: COLUMN order_sync_requests.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.order_sync_requests TO couli_app;


--
-- Name: COLUMN order_sync_requests.fetched_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(fetched_count) ON TABLE app.order_sync_requests TO couli_app;


--
-- Name: COLUMN order_sync_requests.stored_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(stored_count) ON TABLE app.order_sync_requests TO couli_app;


--
-- Name: COLUMN order_sync_requests.error; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(error) ON TABLE app.order_sync_requests TO couli_app;


--
-- Name: COLUMN order_sync_requests.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.order_sync_requests TO couli_app;


--
-- Name: TABLE orders; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.orders TO couli_app;
GRANT SELECT ON TABLE app.orders TO couli_readonly;


--
-- Name: TABLE orders_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.orders_default TO couli_readonly;


--
-- Name: TABLE page_preview_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.page_preview_tokens TO couli_app;
GRANT SELECT ON TABLE app.page_preview_tokens TO couli_readonly;


--
-- Name: COLUMN page_preview_tokens.used_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(used_count) ON TABLE app.page_preview_tokens TO couli_app;


--
-- Name: TABLE page_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.page_versions TO couli_app;
GRANT SELECT ON TABLE app.page_versions TO couli_readonly;


--
-- Name: COLUMN page_versions.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.page_versions TO couli_app;


--
-- Name: COLUMN page_versions.render_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(render_count) ON TABLE app.page_versions TO couli_app;


--
-- Name: COLUMN page_versions.error_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(error_count) ON TABLE app.page_versions TO couli_app;


--
-- Name: COLUMN page_versions.publish_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(publish_at) ON TABLE app.page_versions TO couli_app;


--
-- Name: COLUMN page_versions.publisher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(publisher) ON TABLE app.page_versions TO couli_app;


--
-- Name: TABLE pages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pages TO couli_app;
GRANT SELECT ON TABLE app.pages TO couli_readonly;


--
-- Name: COLUMN pages.current_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(current_version) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.gray_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(gray_version) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.gray_percent; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(gray_percent) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.revision; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revision) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.updated_by_admin_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_by_admin_id) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.scheduled_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scheduled_version) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.scheduled_gray_percent; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scheduled_gray_percent) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.scheduled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scheduled_at) ON TABLE app.pages TO couli_app;


--
-- Name: COLUMN pages.scheduled_by_admin_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scheduled_by_admin_id) ON TABLE app.pages TO couli_app;


--
-- Name: TABLE pay_anomalies; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_anomalies TO couli_app;
GRANT SELECT ON TABLE app.pay_anomalies TO couli_readonly;


--
-- Name: COLUMN pay_anomalies.refunded_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(refunded_fen) ON TABLE app.pay_anomalies TO couli_app;


--
-- Name: COLUMN pay_anomalies.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.pay_anomalies TO couli_app;


--
-- Name: TABLE pay_fulfillments; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_fulfillments TO couli_app;
GRANT SELECT ON TABLE app.pay_fulfillments TO couli_readonly;


--
-- Name: COLUMN pay_fulfillments.state; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(state) ON TABLE app.pay_fulfillments TO couli_app;


--
-- Name: COLUMN pay_fulfillments.last_pay_order_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(last_pay_order_id) ON TABLE app.pay_fulfillments TO couli_app;


--
-- Name: COLUMN pay_fulfillments.refunded_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(refunded_fen) ON TABLE app.pay_fulfillments TO couli_app;


--
-- Name: COLUMN pay_fulfillments.version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(version) ON TABLE app.pay_fulfillments TO couli_app;


--
-- Name: COLUMN pay_fulfillments.applied_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(applied_at) ON TABLE app.pay_fulfillments TO couli_app;


--
-- Name: TABLE pay_notifications; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_notifications TO couli_app;
GRANT SELECT ON TABLE app.pay_notifications TO couli_readonly;


--
-- Name: TABLE pay_orders; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_orders TO couli_app;
GRANT SELECT ON TABLE app.pay_orders TO couli_readonly;


--
-- Name: COLUMN pay_orders.refunded_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(refunded_fen) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.channel_trade_no; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_trade_no) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.launch_issued_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(launch_issued_at) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.closing; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closing) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.needs_manual; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(needs_manual) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.paid_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(paid_at) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.closed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_at) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.close_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(close_reason) ON TABLE app.pay_orders TO couli_app;


--
-- Name: COLUMN pay_orders.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.pay_orders TO couli_app;


--
-- Name: TABLE pay_query_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_query_attempts TO couli_app;
GRANT SELECT ON TABLE app.pay_query_attempts TO couli_readonly;


--
-- Name: TABLE pay_recon_days; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_recon_days TO couli_app;
GRANT SELECT ON TABLE app.pay_recon_days TO couli_readonly;


--
-- Name: TABLE pay_refunds; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.pay_refunds TO couli_app;
GRANT SELECT ON TABLE app.pay_refunds TO couli_readonly;


--
-- Name: COLUMN pay_refunds.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.pay_refunds TO couli_app;


--
-- Name: COLUMN pay_refunds.channel_refund_no; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_refund_no) ON TABLE app.pay_refunds TO couli_app;


--
-- Name: COLUMN pay_refunds.succeeded_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(succeeded_at) ON TABLE app.pay_refunds TO couli_app;


--
-- Name: COLUMN pay_refunds.failed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(failed_at) ON TABLE app.pay_refunds TO couli_app;


--
-- Name: TABLE payout_account_changes; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_account_changes TO couli_app;
GRANT SELECT ON TABLE app.payout_account_changes TO couli_readonly;


--
-- Name: TABLE payout_account_verify_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_account_verify_attempts TO couli_app;
GRANT SELECT ON TABLE app.payout_account_verify_attempts TO couli_readonly;


--
-- Name: COLUMN payout_account_verify_attempts.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.unknown_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(unknown_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.resolved_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolved_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: TABLE payout_accounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_accounts TO couli_app;
GRANT SELECT ON TABLE app.payout_accounts TO couli_readonly;


--
-- Name: COLUMN payout_accounts.alipay_logon_id_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(alipay_logon_id_cipher) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.alipay_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(alipay_hmac) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.bank_card_no_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bank_card_no_cipher) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.bank_card_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bank_card_hmac) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.bank_name; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bank_name) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.card_bin; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_bin) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.payee_name; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(payee_name) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.is_current; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_current) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.anonymized_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(anonymized_at) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: TABLE payout_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.payout_attempts TO couli_app;
GRANT SELECT,INSERT ON TABLE app.payout_attempts TO couli_payout;
GRANT SELECT ON TABLE app.payout_attempts TO couli_readonly;


--
-- Name: COLUMN payout_attempts.response; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(response) ON TABLE app.payout_attempts TO couli_payout;


--
-- Name: COLUMN payout_attempts.resp_code; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resp_code) ON TABLE app.payout_attempts TO couli_payout;


--
-- Name: COLUMN payout_attempts.resp_sub_code; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resp_sub_code) ON TABLE app.payout_attempts TO couli_payout;


--
-- Name: COLUMN payout_attempts.result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(result) ON TABLE app.payout_attempts TO couli_payout;


--
-- Name: COLUMN payout_attempts.latency_ms; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(latency_ms) ON TABLE app.payout_attempts TO couli_payout;


--
-- Name: TABLE payout_batch_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_batch_items TO couli_app;
GRANT SELECT ON TABLE app.payout_batch_items TO couli_payout;
GRANT SELECT ON TABLE app.payout_batch_items TO couli_readonly;


--
-- Name: TABLE payout_batches; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_batches TO couli_app;
GRANT SELECT ON TABLE app.payout_batches TO couli_payout;
GRANT SELECT ON TABLE app.payout_batches TO couli_readonly;


--
-- Name: TABLE payout_recon_runs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_recon_runs TO couli_app;
GRANT SELECT ON TABLE app.payout_recon_runs TO couli_payout;
GRANT SELECT ON TABLE app.payout_recon_runs TO couli_readonly;


--
-- Name: COLUMN payout_recon_runs.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.started_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(started_at) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.bill_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bill_rows) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.matched; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(matched) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.diffs; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(diffs) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: COLUMN payout_recon_runs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.payout_recon_runs TO couli_app;


--
-- Name: TABLE payout_watermarks; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_watermarks TO couli_app;
GRANT SELECT ON TABLE app.payout_watermarks TO couli_payout;
GRANT SELECT ON TABLE app.payout_watermarks TO couli_readonly;


--
-- Name: TABLE personal_data_copies; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.personal_data_copies TO couli_app;


--
-- Name: COLUMN personal_data_copies.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.requested_by; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(requested_by) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.delivery; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(delivery) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(status) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.retry_of; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(retry_of) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.object_key; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(object_key) ON TABLE app.personal_data_copies TO couli_app;


--
-- Name: COLUMN personal_data_copies.due_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(due_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.generated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(generated_at) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(generated_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.delivered_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(delivered_at) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(delivered_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expires_at) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(expires_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.failure_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(failure_reason) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(failure_reason) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(row_version) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: COLUMN personal_data_copies.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.personal_data_copies TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.personal_data_copies TO couli_readonly;


--
-- Name: TABLE platform_icon_uploads; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.platform_icon_uploads TO couli_app;
GRANT SELECT ON TABLE app.platform_icon_uploads TO couli_readonly;


--
-- Name: TABLE platform_icon_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.platform_icon_versions TO couli_app;
GRANT SELECT ON TABLE app.platform_icon_versions TO couli_readonly;


--
-- Name: COLUMN platform_icon_versions.source_url; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(source_url) ON TABLE app.platform_icon_versions TO couli_app;


--
-- Name: COLUMN platform_icon_versions.downloaded_on; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(downloaded_on) ON TABLE app.platform_icon_versions TO couli_app;


--
-- Name: COLUMN platform_icon_versions.ever_published; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(ever_published) ON TABLE app.platform_icon_versions TO couli_app;


--
-- Name: COLUMN platform_icon_versions.revision; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revision) ON TABLE app.platform_icon_versions TO couli_app;


--
-- Name: TABLE platform_icons; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.platform_icons TO couli_app;
GRANT SELECT ON TABLE app.platform_icons TO couli_readonly;


--
-- Name: TABLE platforms; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.platforms TO couli_app;
GRANT SELECT ON TABLE app.platforms TO couli_readonly;


--
-- Name: COLUMN platforms.key_stability; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(key_stability) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.search_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(search_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.convert_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(convert_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.order_sync_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(order_sync_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.stage; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(stage) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.platforms TO couli_app;


--
-- Name: TABLE pool_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.pool_items TO couli_app;
GRANT SELECT ON TABLE app.pool_items TO couli_readonly;


--
-- Name: TABLE price_snapshot; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.price_snapshot TO couli_app;
GRANT SELECT ON TABLE app.price_snapshot TO couli_readonly;


--
-- Name: COLUMN price_snapshot.last_observed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(last_observed_at) ON TABLE app.price_snapshot TO couli_app;


--
-- Name: COLUMN price_snapshot.observation_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(observation_count) ON TABLE app.price_snapshot TO couli_app;


--
-- Name: TABLE processed_events; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_app;
GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_payout;
GRANT SELECT ON TABLE app.processed_events TO couli_readonly;


--
-- Name: TABLE product_key_aliases; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.product_key_aliases TO couli_app;
GRANT SELECT ON TABLE app.product_key_aliases TO couli_readonly;


--
-- Name: TABLE product_pools; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.product_pools TO couli_app;
GRANT SELECT ON TABLE app.product_pools TO couli_readonly;


--
-- Name: TABLE product_refs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.product_refs TO couli_app;
GRANT SELECT ON TABLE app.product_refs TO couli_readonly;


--
-- Name: COLUMN product_refs.raw_item_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(raw_item_id) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.raw_fetched_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(raw_fetched_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.canonical_url; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(canonical_url) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.title; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(title) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.shop_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(shop_id) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.shop_type; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(shop_type) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.source; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(source) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.refreshed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(refreshed_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: TABLE push_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.push_tokens TO couli_app;
GRANT SELECT ON TABLE app.push_tokens TO couli_readonly;


--
-- Name: COLUMN push_tokens.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_id) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.bound_sid; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bound_sid) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token_set_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token_set_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.acquired_by_move_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(acquired_by_move_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.frozen_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_until) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: TABLE realname; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.realname TO couli_app;


--
-- Name: COLUMN realname.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.name_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(name_cipher) ON TABLE app.realname TO couli_app;


--
-- Name: COLUMN realname.id_no_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(id_no_cipher) ON TABLE app.realname TO couli_app;


--
-- Name: COLUMN realname.id_no_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(id_no_hmac) ON TABLE app.realname TO couli_app;


--
-- Name: COLUMN realname.birth_date_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(birth_date_cipher) ON TABLE app.realname TO couli_app;


--
-- Name: COLUMN realname.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.realname TO couli_app;
GRANT SELECT(status) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.provider; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(provider) ON TABLE app.realname TO couli_app;
GRANT SELECT(provider) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.verified_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verified_at) ON TABLE app.realname TO couli_app;
GRANT SELECT(verified_at) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.realname TO couli_app;
GRANT SELECT(row_version) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.realname TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.realname TO couli_readonly;


--
-- Name: COLUMN realname.tax_retained; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(tax_retained) ON TABLE app.realname TO couli_app;


--
-- Name: TABLE realname_prior_identities; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT ON TABLE app.realname_prior_identities TO couli_app;


--
-- Name: TABLE recon_channel; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.recon_channel TO couli_app;
GRANT SELECT ON TABLE app.recon_channel TO couli_payout;
GRANT SELECT ON TABLE app.recon_channel TO couli_readonly;


--
-- Name: COLUMN recon_channel.out_biz_no; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(out_biz_no) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.channel_order_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_order_id) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.our_status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(our_status) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.channel_status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_status) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.our_amount_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(our_amount_fen) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.channel_amount_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_amount_fen) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(result) ON TABLE app.recon_channel TO couli_app;


--
-- Name: COLUMN recon_channel.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.recon_channel TO couli_app;


--
-- Name: TABLE recon_diffs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.recon_diffs TO couli_app;
GRANT SELECT ON TABLE app.recon_diffs TO couli_readonly;


--
-- Name: COLUMN recon_diffs.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: COLUMN recon_diffs.handler_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(handler_id) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: COLUMN recon_diffs.closed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_at) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: COLUMN recon_diffs.dedupe_key; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(dedupe_key) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: COLUMN recon_diffs.resolution; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolution) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: COLUMN recon_diffs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.recon_diffs TO couli_app;


--
-- Name: TABLE recon_union; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.recon_union TO couli_app;
GRANT SELECT ON TABLE app.recon_union TO couli_readonly;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.refresh_tokens TO couli_app;
GRANT SELECT ON TABLE app.refresh_tokens TO couli_readonly;


--
-- Name: COLUMN refresh_tokens.rotated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(rotated_at) ON TABLE app.refresh_tokens TO couli_app;


--
-- Name: COLUMN refresh_tokens.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.refresh_tokens TO couli_app;


--
-- Name: TABLE relation_change_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.relation_change_logs TO couli_app;
GRANT SELECT ON TABLE app.relation_change_logs TO couli_readonly;


--
-- Name: TABLE reverified_devices; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.reverified_devices TO couli_app;
GRANT SELECT ON TABLE app.reverified_devices TO couli_readonly;


--
-- Name: TABLE rights_import_failures; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.rights_import_failures TO couli_app;
GRANT SELECT ON TABLE app.rights_import_failures TO couli_readonly;


--
-- Name: TABLE rights_imports; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.rights_imports TO couli_app;
GRANT SELECT ON TABLE app.rights_imports TO couli_readonly;


--
-- Name: COLUMN rights_imports.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.total_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(total_rows) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.succeeded_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(succeeded_rows) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.failed_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(failed_rows) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.skipped_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(skipped_rows) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.duplicate_rows; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(duplicate_rows) ON TABLE app.rights_imports TO couli_app;


--
-- Name: COLUMN rights_imports.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.rights_imports TO couli_app;


--
-- Name: TABLE risk_hits; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.risk_hits TO couli_app;
GRANT SELECT ON TABLE app.risk_hits TO couli_readonly;


--
-- Name: COLUMN risk_hits.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.rule_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(rule_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.risk_action; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(risk_action) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.dimension; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(dimension) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.value_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(value_hmac) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.ref_type; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_type) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.ref_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.request_type; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(request_type) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.related_phone_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(related_phone_hmac) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.related_phone_masked; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(related_phone_masked) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.amount_fen; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(amount_fen) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(created_at) ON TABLE app.risk_hits TO couli_app;


--
-- Name: TABLE risk_judgements; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.risk_judgements TO couli_app;
GRANT SELECT ON TABLE app.risk_judgements TO couli_readonly;


--
-- Name: COLUMN risk_judgements.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.rule_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(rule_id) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.ref_type; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_type) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.ref_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_id) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.marked; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(marked) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.result; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(result) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.judged_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(judged_at) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: COLUMN risk_judgements.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(created_at) ON TABLE app.risk_judgements TO couli_app;


--
-- Name: TABLE risk_rules; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.risk_rules TO couli_app;
GRANT SELECT ON TABLE app.risk_rules TO couli_readonly;


--
-- Name: COLUMN risk_rules.scene; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scene) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.conditions; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(conditions) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.risk_action; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(risk_action) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(version) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.risk_rules TO couli_app;


--
-- Name: TABLE sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.sessions TO couli_app;
GRANT SELECT ON TABLE app.sessions TO couli_readonly;


--
-- Name: COLUMN sessions.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.sessions TO couli_app;


--
-- Name: COLUMN sessions.revoke_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoke_reason) ON TABLE app.sessions TO couli_app;


--
-- Name: COLUMN sessions.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.sessions TO couli_app;


--
-- Name: TABLE settle_adjust_batches; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_adjust_batches TO couli_app;
GRANT SELECT ON TABLE app.settle_adjust_batches TO couli_readonly;


--
-- Name: COLUMN settle_adjust_batches.confirmed_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(confirmed_by) ON TABLE app.settle_adjust_batches TO couli_app;


--
-- Name: COLUMN settle_adjust_batches.confirmed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(confirmed_at) ON TABLE app.settle_adjust_batches TO couli_app;


--
-- Name: TABLE settle_adjustments; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_adjustments TO couli_app;
GRANT SELECT ON TABLE app.settle_adjustments TO couli_readonly;


--
-- Name: COLUMN settle_adjustments.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.settle_adjustments TO couli_app;


--
-- Name: COLUMN settle_adjustments.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.settle_adjustments TO couli_app;


--
-- Name: COLUMN settle_adjustments.approver; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(approver) ON TABLE app.settle_adjustments TO couli_app;


--
-- Name: COLUMN settle_adjustments.decided_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(decided_at) ON TABLE app.settle_adjustments TO couli_app;


--
-- Name: COLUMN settle_adjustments.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.settle_adjustments TO couli_app;


--
-- Name: TABLE settle_batch_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_batch_items TO couli_app;
GRANT SELECT ON TABLE app.settle_batch_items TO couli_readonly;


--
-- Name: COLUMN settle_batch_items.amount_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(amount_fen) ON TABLE app.settle_batch_items TO couli_app;


--
-- Name: COLUMN settle_batch_items.result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(result) ON TABLE app.settle_batch_items TO couli_app;


--
-- Name: COLUMN settle_batch_items.skip_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(skip_reason) ON TABLE app.settle_batch_items TO couli_app;


--
-- Name: TABLE settle_batches; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_batches TO couli_app;
GRANT SELECT ON TABLE app.settle_batches TO couli_readonly;


--
-- Name: COLUMN settle_batches.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.settle_mode; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settle_mode) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.scheduled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scheduled_at) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.confirmed_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(confirmed_by) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.confirmed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(confirmed_at) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.cancelled_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cancelled_reason) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.settle_run_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settle_run_id) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.started_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(started_at) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.paused_by_switch_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(paused_by_switch_at) ON TABLE app.settle_batches TO couli_app;


--
-- Name: COLUMN settle_batches.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.settle_batches TO couli_app;


--
-- Name: TABLE settle_bills; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_bills TO couli_app;
GRANT SELECT ON TABLE app.settle_bills TO couli_readonly;


--
-- Name: COLUMN settle_bills.generated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(generated_at) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.platform_order_counts; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(platform_order_counts) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.platform_settle_commission_totals; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(platform_settle_commission_totals) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.beneficiary_total_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(beneficiary_total_fen) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.platform_retained_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(platform_retained_fen) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.error_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(error_count) ON TABLE app.settle_bills TO couli_app;


--
-- Name: COLUMN settle_bills.held_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(held_count) ON TABLE app.settle_bills TO couli_app;


--
-- Name: TABLE settle_jobs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_jobs TO couli_app;
GRANT SELECT ON TABLE app.settle_jobs TO couli_readonly;


--
-- Name: COLUMN settle_jobs.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.settle_jobs TO couli_app;


--
-- Name: COLUMN settle_jobs.processed_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(processed_count) ON TABLE app.settle_jobs TO couli_app;


--
-- Name: COLUMN settle_jobs.skipped_count; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(skipped_count) ON TABLE app.settle_jobs TO couli_app;


--
-- Name: COLUMN settle_jobs.finished_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finished_at) ON TABLE app.settle_jobs TO couli_app;


--
-- Name: COLUMN settle_jobs.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.settle_jobs TO couli_app;


--
-- Name: TABLE settle_runs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.settle_runs TO couli_app;


--
-- Name: COLUMN settle_runs.part; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(part) ON TABLE app.settle_runs TO couli_app;


--
-- Name: COLUMN settle_runs.last_outcome; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(last_outcome) ON TABLE app.settle_runs TO couli_app;


--
-- Name: COLUMN settle_runs.part_started_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(part_started_at) ON TABLE app.settle_runs TO couli_app;


--
-- Name: COLUMN settle_runs.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.settle_runs TO couli_app;


--
-- Name: COLUMN settle_runs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.settle_runs TO couli_app;


--
-- Name: TABLE share_materials; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.share_materials TO couli_app;
GRANT SELECT ON TABLE app.share_materials TO couli_readonly;


--
-- Name: TABLE sms_send_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.sms_send_attempts TO couli_app;
GRANT SELECT ON TABLE app.sms_send_attempts TO couli_readonly;


--
-- Name: COLUMN sms_send_attempts.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.sms_send_attempts TO couli_app;


--
-- Name: COLUMN sms_send_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.sms_send_attempts TO couli_app;


--
-- Name: TABLE sync_cursors; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.sync_cursors TO couli_app;
GRANT SELECT ON TABLE app.sync_cursors TO couli_readonly;


--
-- Name: TABLE tax_ytd; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.tax_ytd TO couli_app;
GRANT SELECT ON TABLE app.tax_ytd TO couli_payout;
GRANT SELECT ON TABLE app.tax_ytd TO couli_readonly;


--
-- Name: COLUMN tax_ytd.cum_income_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cum_income_fen) ON TABLE app.tax_ytd TO couli_app;


--
-- Name: COLUMN tax_ytd.cum_withheld_fen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cum_withheld_fen) ON TABLE app.tax_ytd TO couli_app;


--
-- Name: COLUMN tax_ytd.continuous_months; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(continuous_months) ON TABLE app.tax_ytd TO couli_app;


--
-- Name: COLUMN tax_ytd.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.tax_ytd TO couli_app;


--
-- Name: TABLE union_accounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_accounts TO couli_app;
GRANT SELECT ON TABLE app.union_accounts TO couli_readonly;


--
-- Name: TABLE union_auth_sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_auth_sessions TO couli_app;
GRANT SELECT ON TABLE app.union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN union_auth_sessions.used_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(used_at) ON TABLE app.union_auth_sessions TO couli_app;


--
-- Name: TABLE union_binding_conflicts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_binding_conflicts TO couli_app;
GRANT SELECT ON TABLE app.union_binding_conflicts TO couli_readonly;


--
-- Name: COLUMN union_binding_conflicts.resolved_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolved_at) ON TABLE app.union_binding_conflicts TO couli_app;


--
-- Name: COLUMN union_binding_conflicts.resolution; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolution) ON TABLE app.union_binding_conflicts TO couli_app;


--
-- Name: TABLE union_bindings; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_bindings TO couli_app;
GRANT SELECT ON TABLE app.union_bindings TO couli_readonly;


--
-- Name: TABLE union_credentials; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_credentials TO couli_app;


--
-- Name: COLUMN union_credentials.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.union_account_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(union_account_id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(expires_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.is_current; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_current) ON TABLE app.union_credentials TO couli_app;
GRANT SELECT(is_current) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.union_credentials TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: TABLE union_pids; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_pids TO couli_app;
GRANT SELECT ON TABLE app.union_pids TO couli_readonly;


--
-- Name: TABLE union_raw_payloads; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_raw_payloads TO couli_app;
GRANT SELECT ON TABLE app.union_raw_payloads TO couli_readonly;


--
-- Name: TABLE user_oauth; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.user_oauth TO couli_app;
GRANT SELECT ON TABLE app.user_oauth TO couli_readonly;


--
-- Name: TABLE user_risk_state; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.user_risk_state TO couli_app;
GRANT SELECT ON TABLE app.user_risk_state TO couli_readonly;


--
-- Name: COLUMN user_risk_state.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.state; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(state) ON TABLE app.user_risk_state TO couli_app;
GRANT SELECT(state) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.reason_category; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason_category) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.frozen_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_until) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.changed_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(changed_by) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.changed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(changed_at) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.penalty_started_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(penalty_started_at) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: TABLE user_tip_reads; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.user_tip_reads TO couli_app;
GRANT SELECT ON TABLE app.user_tip_reads TO couli_readonly;


--
-- Name: TABLE users; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.users TO couli_app;
GRANT SELECT ON TABLE app.users TO couli_readonly;


--
-- Name: TABLE withdraw_holds; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.withdraw_holds TO couli_app;
GRANT SELECT ON TABLE app.withdraw_holds TO couli_payout;
GRANT SELECT ON TABLE app.withdraw_holds TO couli_readonly;


--
-- Name: COLUMN withdraw_holds.released_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(released_at) ON TABLE app.withdraw_holds TO couli_app;


--
-- Name: COLUMN withdraw_holds.released_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(released_by) ON TABLE app.withdraw_holds TO couli_app;


--
-- Name: TABLE withdrawals; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.withdrawals TO couli_app;
GRANT SELECT ON TABLE app.withdrawals TO couli_payout;
GRANT SELECT ON TABLE app.withdrawals TO couli_readonly;


--
-- Name: COLUMN withdrawals.channel_state; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_state) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.confirm_deadline; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(confirm_deadline) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.wechat_launch_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(wechat_launch_cipher) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(status) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.review_mode; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(review_mode) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.auto_decision; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(auto_decision) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.review_deadline; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(review_deadline) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.reviewer_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reviewer_id) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.reviewed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reviewed_at) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.reject_reason_code; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reject_reason_code) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.reject_note; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reject_note) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.fail_code; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(fail_code) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(fail_code) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.executor_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(executor_id) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(executor_id) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.executed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(executed_at) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(executed_at) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.batch_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(batch_id) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(batch_id) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.execute_seq; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(execute_seq) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(execute_seq) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.needs_manual; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(needs_manual) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.manual_resolution; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(manual_resolution) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(manual_resolution) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.resolver_ids; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolver_ids) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(resolver_ids) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.proof_file; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(proof_file) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(proof_file) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.manual_entry_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(manual_entry_by) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(manual_entry_by) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.manual_confirm_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(manual_confirm_by) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(manual_confirm_by) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.hold_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(hold_reason) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(hold_reason) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.hold_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(hold_at) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(hold_at) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.blocked_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(blocked_reason) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.risk_flags; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(risk_flags) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.risk_flags_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(risk_flags_at) ON TABLE app.withdrawals TO couli_app;


--
-- Name: COLUMN withdrawals.paid_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(paid_at) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(paid_at) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.channel_order_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(channel_order_id) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(channel_order_id) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(row_version) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.withdrawals TO couli_app;
GRANT UPDATE(updated_at) ON TABLE app.withdrawals TO couli_payout;


--
-- Name: COLUMN withdrawals.review_overdue_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(review_overdue_at) ON TABLE app.withdrawals TO couli_app;


--
-- Name: TABLE bam; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_payout;


--
-- Name: TABLE job; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_payout;


--
-- Name: TABLE job_common; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_payout;


--
-- Name: TABLE job_dependency; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_payout;


--
-- Name: TABLE queue; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_payout;


--
-- Name: TABLE queue_stats; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_payout;


--
-- Name: TABLE schedule; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_payout;


--
-- Name: TABLE subscription; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_payout;


--
-- Name: TABLE version; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_payout;


--
-- Name: TABLE warning; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_payout;


--
-- PostgreSQL database dump complete
--

\unrestrict couli
