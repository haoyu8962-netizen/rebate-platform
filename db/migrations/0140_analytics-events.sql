-- Up Migration
-- CT-13e: analytics event storage (规划/04 §3.2 events row: name, props JSON, user_id / device_id,
-- client_at, server_at; day-partitioned; writer analytics. §6.4: every event carries a client-made
-- event_id, deduplicated by (event_type, event_id)). Orchestrator rulings D10-1487, D10-1488 (1),
-- D10-1489; ADR-0001 §4.2 #4, #5, #8; BR-ID-30 ③ (events kept 90 days).
--
-- app.events: RANGE (server_at), one partition per +08:00 calendar day, plus app.events_default.
--   Only DEFAULT is created here (db/AGENTS.md rule 5); dated partitions are made at run time by
--   app.ensure_events_day_partition. No unique key on (event_type, event_id): a unique constraint
--   on a partitioned table must contain the partition key, so global deduplication lives in the
--   separate, unpartitioned app.event_dedup (D10-1488 (1)). Writing the dedup row first and the
--   event only when that row is new, in one transaction, is CT-13g; this migration only stores.
--   server_at has no SQL default (db/AGENTS.md rule 6): the writer supplies its injected Clock.
--   user_id references app.users (app_id, id) like link_logs; device_id has no foreign key because
--   app.devices has no (app_id, id) key and anonymous / H5 events need not have a registered device.
--   events_user_idx (partial, user_id not null) serves the account-deletion detachment lookup and the
--   foreign key check when a user row is deleted.
-- app.event_dedup: unpartitioned, PRIMARY KEY (event_type, event_id) — the event_id is a client UUID,
--   unique across apps, so app_id is stored (NOT NULL, repository rule 7) but not part of the key.
--   created_at (DEFAULT now()) drives the retention cleanup (CT-13f); event_dedup_created_idx serves it.
--
-- Detachment (D10-1489): couli_app may UPDATE events.user_id only (column grant), and the trigger
-- events_detach_only lets an update through only when user_id goes from non-null to null and no other
-- column changes. A null-to-value, value-to-other-value or same-value update is refused with
-- restrict_violation (23001), as link_open_attempts_no_rewrite (0006) does.
--
-- Partition maintenance: the shared app.ensure_day_partition / app.drop_expired_day_partitions are NOT
-- changed (their frozen tests pin that they refuse 'events'). Two dedicated functions are written like
-- them (0012): SECURITY DEFINER, owner couli_migrator, fixed search_path / lock_timeout / DateStyle /
-- TimeZone, +08:00 day bounds, and one creation lock per partition shared by create and drop:
-- hashtextextended('app.ensure_events_day_partition:' || <partition name>, 0). Drop calls are serialised
-- by hashtextextended('app.drop_expired_events_day_partitions', 0). Cutoff: 00:00 (+08:00) of
-- (the +08:00 calendar day of p_now − 90 days), BR-ID-30 ③; a partition goes when the upper bound of
-- its actual range (catalogue, not name) is at or before the cutoff. DEFAULT is never dropped.
-- Rows that fell into app.events_default (their day partition was not created in time) are removed by
-- a third function, app.purge_expired_events_default: same cutoff, row DELETE on app.events_default
-- only (never a day partition, never app.event_dedup), server_at strictly before the cutoff; it
-- returns the number of deleted rows. events_detach_only is BEFORE UPDATE only, so DELETE is not
-- blocked by it.
--
-- Grants (written here, ADR-0001 §4.2 #8):
--   couli_app   — SELECT, INSERT on app.events and app.event_dedup; UPDATE (user_id) on app.events.
--                 No DELETE, TRUNCATE or other column UPDATE.
--   couli_maint — SELECT, DELETE on app.event_dedup (retention cleanup by created_at, CT-13f);
--                 EXECUTE on the two partition functions and on app.purge_expired_events_default.
--                 No DDL right on app.events and no direct DELETE on app.events / app.events_default.
--
-- Compatibility: additive (two new tables, four new functions, one trigger); nothing reads them yet.
-- Recovery: no down migration. Stop calling the partition functions, the DEFAULT purge and the dedup
--   cleanup, then apply a corrective migration; partitions, DEFAULT rows and dedup rows removed by
--   later maintenance calls can only be recovered from a backup.
--
-- Timeouts: new tables only; the foreign key to app.users takes a brief SHARE ROW EXCLUSIVE lock on
-- app.users, so 5s lock wait to fail fast instead of queueing user writes; 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.events (
  app_id     text NOT NULL,
  event_id   uuid NOT NULL,
  event_type text NOT NULL,
  name       text NOT NULL,
  props      jsonb NOT NULL,
  user_id    uuid,
  device_id  uuid,
  client_at  timestamptz NOT NULL,
  server_at  timestamptz NOT NULL,
  CONSTRAINT events_props_object_check CHECK (jsonb_typeof(props) = 'object'),
  CONSTRAINT events_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
) PARTITION BY RANGE (server_at);

CREATE TABLE app.events_default PARTITION OF app.events DEFAULT;

CREATE INDEX events_user_idx ON app.events (app_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE app.event_dedup (
  app_id     text NOT NULL,
  event_type text NOT NULL,
  event_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_dedup_pkey PRIMARY KEY (event_type, event_id)
);

CREATE INDEX event_dedup_created_idx ON app.event_dedup (created_at);

CREATE FUNCTION app.reject_event_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Only detachment passes: user_id non-null -> null, every other column unchanged (whole row
  -- compared, so a column added later is covered too).
  IF OLD.user_id IS NULL OR NEW.user_id IS NOT NULL
    OR (to_jsonb(NEW) - 'user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id')
  THEN
    RAISE EXCEPTION 'events rows are immutable except clearing user_id once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_event_rewrite() FROM PUBLIC;

CREATE TRIGGER events_detach_only
  BEFORE UPDATE ON app.events
  FOR EACH ROW EXECUTE FUNCTION app.reject_event_rewrite();

CREATE FUNCTION app.ensure_events_day_partition(p_day date)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET DateStyle = 'ISO, YMD'
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_name   text;
  v_parent oid;
  v_child  oid;
  v_start  timestamptz;
  v_end    timestamptz;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'ensure_events_day_partition: p_day is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_day) OR p_day < DATE '2000-01-01' OR p_day > DATE '9999-12-31' THEN
    RAISE EXCEPTION 'ensure_events_day_partition: p_day must be between 2000-01-01 and 9999-12-31'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_name := 'events_p' || to_char(p_day::timestamp, 'YYYYMMDD');

  -- Share this transaction lock with deletion. Catalogue queries after the wait
  -- see a preceding caller's committed DDL under READ COMMITTED.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.ensure_events_day_partition:' || v_name, 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'events' AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_events_day_partition: app.events is not a partitioned table'
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
    RAISE EXCEPTION 'ensure_events_day_partition: app.% exists but is not a partition of app.events',
      v_name
      USING ERRCODE = 'duplicate_table';
  END IF;

  -- Add a calendar day before converting to an instant, including 9999-12-31's
  -- upper boundary. Fixed offsets avoid session time zones and historical DST.
  v_start := p_day::timestamp AT TIME ZONE INTERVAL '8 hours';
  v_end := (p_day + 1)::timestamp AT TIME ZONE INTERVAL '8 hours';

  -- PostgreSQL checks DEFAULT rows and clones constraints/indexes/triggers.
  -- Propagate 23514 unchanged if DEFAULT contains rows of this day. All waits
  -- (advisory, parent, DEFAULT and app.users) are bounded by 5s; 55P03 aborts
  -- the statement and releases its locks without a partial creation.
  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.events FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );

  RETURN v_name;
END
$$;

ALTER FUNCTION app.ensure_events_day_partition(date) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.ensure_events_day_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_events_day_partition(date) TO couli_maint;

CREATE FUNCTION app.drop_expired_events_day_partitions(p_now timestamptz)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET DateStyle = 'ISO, YMD'
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'drop_expired_events_day_partitions: p_now is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_events_day_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion calls before listing so each drop is reported once.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_events_day_partitions', 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'events' AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_events_day_partitions: app.events is not a partitioned table'
      USING ERRCODE = 'undefined_table';
  END IF;

  -- BR-ID-30 ③: midnight of the supplied +08:00 calendar day minus 90 days.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ '^events_p[0-9]{8}$'
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

  -- Empty runs do not request a lock on app.events or any of its partitions.
  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Take ALL candidate creation locks before the parent lock. Otherwise an
  -- ensure caller could hold a later candidate lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('app.ensure_events_day_partition:' || v_name, 0)
    );
  END LOOP;

  -- Parent before children follows writer lock order; ONLY avoids unrelated and
  -- DEFAULT partitions. Every wait, including advisory locks, has a 5s bound.
  -- Do not catch 55P03: the whole statement must roll back, including earlier drops.
  LOCK TABLE ONLY app.events IN ACCESS EXCLUSIVE MODE;

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

    -- server_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$$;

ALTER FUNCTION app.drop_expired_events_day_partitions(timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.drop_expired_events_day_partitions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.drop_expired_events_day_partitions(timestamptz) TO couli_maint;

CREATE FUNCTION app.purge_expired_events_default(p_now timestamptz)
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
    RAISE EXCEPTION 'purge_expired_events_default: p_now is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'purge_expired_events_default: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30 ③: the same cutoff as drop_expired_events_day_partitions — midnight of the supplied
  -- +08:00 calendar day minus 90 days. Rows strictly before it are expired.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- DEFAULT partition only: day partitions are removed whole by the drop function, and
  -- app.event_dedup has its own cleanup. Waits (ensure's DEFAULT scan) are bounded by 5s.
  DELETE FROM ONLY app.events_default WHERE server_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.purge_expired_events_default(timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.purge_expired_events_default(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_events_default(timestamptz) TO couli_maint;

GRANT SELECT, INSERT ON app.events, app.event_dedup TO couli_app;
GRANT UPDATE (user_id) ON app.events TO couli_app;
GRANT SELECT, DELETE ON app.event_dedup TO couli_maint;
