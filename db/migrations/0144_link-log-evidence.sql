-- Up Migration
-- CT-13m: app.link_log_evidence (BR-ATTR-14 默认值「被工单引用的记录在分区删除前复制到 link_log_evidence」;
-- BR-ID-30 ②「link_log_evidence 工单关闭后 180 天」; 规划/04 第 438 行: the same set of columns as
-- link_logs; orchestrator rulings D10-1624, D10-1625). The only ticket that references link_logs is
-- the claim: app.claim_items.evidence_link_log_ids (bigint[], by id, no foreign key).
--
-- app.link_log_evidence: every column of app.link_logs (0005 and later, as in db/schema.sql) with
--   the same name, type and nullability, in the same order, plus copied_at (NOT NULL, no SQL clock
--   default, db/AGENTS.md rule 6: the copy writes the p_now of the maintenance run). Not partitioned;
--   primary key (id) — one evidence row per link_logs record. No defaults, CHECK or foreign keys of
--   link_logs: rows only ever come from link_logs, so they already passed those, and a row must stay
--   copyable however link_logs' checks evolve (a stricter CHECK here would make a drop fail). No
--   foreign key to app.users: evidence must not block account deletion; the deletion cleanup removes
--   the claims, after which the purge below removes the unreferenced evidence (D10-1625 补一).
--   Personal data: only linking (claim review reader) and maintenance read it (D10-1625 补二).
--
-- app.copy_referenced_link_logs(p_partition text, p_before timestamptz, p_copied_at timestamptz)
--   RETURNS bigint: inserts into the evidence table every row of app.<p_partition> (a child of
--   app.link_logs: a day partition or link_logs_default, the latter for CT-13l) with created_at <
--   p_before whose id appears in some claim_items.evidence_link_log_ids (whatever the item's
--   decision), ON CONFLICT (id) DO NOTHING; returns the number of rows inserted. A conflicting
--   evidence row being deleted by an uncommitted purge is waited for (bounded by lock_timeout 5s),
--   never skipped. Runs in the caller's transaction, so a failure rolls back with it.
--
-- app.drop_expired_day_partitions (0012) is replaced with CREATE OR REPLACE: same signature, result,
--   owner, SECURITY DEFINER, function-level settings (same order) and ACL. The only change: under the
--   ACCESS EXCLUSIVE lock on app.link_logs (so references committed while the call waited for that
--   lock are seen: each statement of a VOLATILE plpgsql function takes a fresh snapshot), each
--   partition is copied (copy_referenced_link_logs with its upper bound and p_now) right before its
--   DROP. A failing copy raises out of the function: nothing is dropped or copied in that call.
--
-- app.purge_expired_link_log_evidence(p_now timestamptz) RETURNS bigint: deletes an evidence row
--   exactly when no claim_items row references its id, or every referencing item has decided_at and
--   the latest one is before the cutoff = 00:00 (+08:00) of p_now's +08:00 calendar day − 180 days
--   (the 180 days live only here). Returns the number of deleted rows. NULL p_now → 22004, non-finite
--   → 22023, nothing deleted.
--
-- Functions: plpgsql, SECURITY DEFINER, owner couli_migrator, settings as 0012 / 0142 (search_path,
--   lock_timeout 5s, DateStyle, TimeZone UTC). REVOKE ALL FROM PUBLIC; EXECUTE to couli_maint only.
-- Grants on the table: couli_app (claim review reader) and couli_readonly SELECT; couli_maint SELECT
--   (it writes only through the two functions above, which run as the owner). No role has a direct
--   INSERT, UPDATE, DELETE or TRUNCATE.
--
-- Compatibility: additive (one table, two functions) plus a replaced function whose behaviour is
--   unchanged when no claim item references a dropped partition's rows.
-- Recovery: no down migration. A corrective migration restores 0012's definition of
--   app.drop_expired_day_partitions; evidence rows removed by later purges, and link_logs partitions
--   dropped, can only be recovered from a backup.
--
-- Timeouts: a new table and function definitions only, no lock on an existing table's rows; 5s lock
-- wait and 30s overall as ceilings.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.link_log_evidence (
  id               bigint NOT NULL,
  app_id           text NOT NULL,
  link_id          uuid,
  event            text NOT NULL,
  user_id          uuid,
  opener_user_id   uuid,
  platform         text,
  product_key      text,
  raw_item_id      text,
  shop_id          text,
  scene            text,
  pid_scene        text,
  spm              text,
  pid              text,
  relation_id      text,
  client           text,
  cache_hit        boolean NOT NULL,
  expired          boolean NOT NULL,
  quoted_price_fen bigint,
  no_rebate        boolean NOT NULL,
  no_rebate_reason text,
  agent_session_id uuid,
  agent_message_id uuid,
  prompt_version   text,
  model            text,
  result_code      integer NOT NULL,
  latency_ms       integer,
  created_at       timestamptz NOT NULL,
  copied_at        timestamptz NOT NULL,
  CONSTRAINT link_log_evidence_pkey PRIMARY KEY (id)
);

GRANT SELECT ON app.link_log_evidence TO couli_app;
GRANT SELECT ON app.link_log_evidence TO couli_readonly;
GRANT SELECT ON app.link_log_evidence TO couli_maint;

CREATE FUNCTION app.copy_referenced_link_logs(
  p_partition text,
  p_before timestamptz,
  p_copied_at timestamptz
)
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
  v_copied bigint;
BEGIN
  IF p_partition IS NULL OR p_before IS NULL OR p_copied_at IS NULL THEN
    RAISE EXCEPTION 'copy_referenced_link_logs: p_partition, p_before and p_copied_at are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_copied_at) THEN
    RAISE EXCEPTION 'copy_referenced_link_logs: p_copied_at must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only a direct child of app.link_logs, never another table.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class pc ON pc.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE pn.nspname = 'app' AND pc.relname = 'link_logs'
      AND n.nspname = 'app' AND c.relname = p_partition AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'copy_referenced_link_logs: app.% is not a partition of app.link_logs', p_partition
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A plain INSERT … ON CONFLICT: an evidence row of the same id that an uncommitted purge is
  -- deleting is waited for (lock_timeout), not skipped, so the record cannot be lost.
  EXECUTE format(
    $sql$
      INSERT INTO app.link_log_evidence (
        id, app_id, link_id, event, user_id, opener_user_id, platform, product_key, raw_item_id,
        shop_id, scene, pid_scene, spm, pid, relation_id, client, cache_hit, expired,
        quoted_price_fen, no_rebate, no_rebate_reason, agent_session_id, agent_message_id,
        prompt_version, model, result_code, latency_ms, created_at, copied_at)
      SELECT l.id, l.app_id, l.link_id, l.event, l.user_id, l.opener_user_id, l.platform,
             l.product_key, l.raw_item_id, l.shop_id, l.scene, l.pid_scene, l.spm, l.pid,
             l.relation_id, l.client, l.cache_hit, l.expired, l.quoted_price_fen, l.no_rebate,
             l.no_rebate_reason, l.agent_session_id, l.agent_message_id, l.prompt_version, l.model,
             l.result_code, l.latency_ms, l.created_at, $2
      FROM app.%I l
      WHERE l.created_at < $1
        AND l.id IN (
          SELECT r.id
          FROM app.claim_items ci
          CROSS JOIN LATERAL unnest(ci.evidence_link_log_ids) AS r(id)
        )
      ON CONFLICT (id) DO NOTHING
    $sql$,
    p_partition
  ) USING p_before, p_copied_at;
  GET DIAGNOSTICS v_copied = ROW_COUNT;

  RETURN v_copied;
END
$$;

ALTER FUNCTION app.copy_referenced_link_logs(text, timestamptz, timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.copy_referenced_link_logs(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.copy_referenced_link_logs(text, timestamptz, timestamptz) TO couli_maint;

-- 0012's definition with the copy before each DROP (marked "CT-13m" below); nothing else changes.
CREATE OR REPLACE FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamptz)
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

    -- CT-13m (BR-ATTR-14): copy the rows referenced by claim items into app.link_log_evidence in
    -- this transaction, under the parent lock taken above (references committed while this call
    -- waited for it are seen). A failing copy raises: nothing is dropped and nothing is copied.
    PERFORM app.copy_referenced_link_logs(v_partition.name, v_bounds[2]::timestamptz, p_now);

    -- created_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$$;

ALTER FUNCTION app.drop_expired_day_partitions(text, timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.drop_expired_day_partitions(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.drop_expired_day_partitions(text, timestamptz) TO couli_maint;

CREATE FUNCTION app.purge_expired_link_log_evidence(p_now timestamptz)
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
    RAISE EXCEPTION 'purge_expired_link_log_evidence: p_now is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'purge_expired_link_log_evidence: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30 ②: 180 days after the ticket closed, counted from midnight of the supplied +08:00
  -- calendar day (BR-ID-30 正文). Fixed UTC+08:00, never the session TimeZone.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 180)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- An evidence row stays while some claim item that references it is undecided or was decided at
  -- or after the cutoff; every other row goes, including rows no claim item references any more
  -- (D10-1625 补一). One pass over claim_items, then an anti-join on the evidence key.
  DELETE FROM app.link_log_evidence e
  WHERE NOT EXISTS (
    SELECT 1
    FROM (
      SELECT r.id
      FROM app.claim_items ci
      CROSS JOIN LATERAL unnest(ci.evidence_link_log_ids) AS r(id)
      WHERE ci.decided_at IS NULL OR ci.decided_at >= v_cutoff
    ) AS kept
    WHERE kept.id = e.id
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.purge_expired_link_log_evidence(timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.purge_expired_link_log_evidence(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_link_log_evidence(timestamptz) TO couli_maint;
