-- Up Migration
-- B3-08s (FU-AGENT-TRACE-PURGE; BR-ID-30 ①, BR-AI-19, BR-AI-22; orchestrator rulings D10-454,
-- D10-971, D10-999). The daily 03:00 (+08:00) Agent trace cleanup, written like the retention
-- functions of 0102 (maintenance section K) and driven by maintenance section M.
--
--   app.delete_expired_agent_traces(p_now timestamptz, p_days integer, p_batch_size integer)
--     RETURNS TABLE (table_name text, deleted bigint)
--
-- One SECURITY DEFINER function (owner couli_migrator, EXECUTE for couli_maint only) for the nine
-- agent_* tables that hold personal data (agent_rule_chunks is article content, not touched). Each
-- call deletes one batch of at most p_batch_size rows per table, children before parents, in this
-- fixed order, and returns one row per table in the same order (0 when nothing was deleted):
--   agent_tool_calls, agent_cards, agent_result_deliveries, agent_messages, agent_result_sets,
--   agent_runs, agent_clarify_asks, agent_result_chains, agent_sessions
-- One function instead of nine so that the database, not the caller, owns the foreign-key order.
--
-- A row goes when created_at < 00:00 (+08:00) of (the +08:00 calendar day of p_now − p_days calendar
-- days); a row exactly at the cutoff is kept. The rows are hard-deleted (BR-ID-30 ①), unlike the
-- account-deletion path of BR-AI-22 that only blanks free text: blanked rows, reported and badcase
-- messages have no exception and go at the same cutoff. p_days comes from agent.trace.retention_days;
-- 184 is written here as the second gate behind the configuration (08: "后台不得设为小于 184 天"),
-- 36500 is a technical ceiling against overflow.
--
-- Batches: oldest first, over every app_id, FOR UPDATE SKIP LOCKED: a row another transaction holds
-- (also the KEY SHARE a writer takes on the parent while it inserts a child) is left for a later call
-- instead of waiting. A parent row (agent_result_sets, agent_runs, agent_sessions) is deleted only
-- when no row of the nine tables references it any more: while a child is younger than the cutoff or
-- locked, the parent stays (only ever kept longer, never shorter). Rows deleted earlier in the same
-- call are visible to the later tables, so a fully expired tree goes in one call when the batch is
-- large enough. The one remaining race — a child committed after this statement's snapshot but before
-- the parent lock was granted — makes the parent delete fail with 23503; that batch of that parent
-- table is rolled back to its savepoint and reported as 0, the next call tries again.
--
-- No foreign key is cascading and the only triggers on these tables are BEFORE UPDATE (no rewrite),
-- which DELETE does not fire. No role gets DELETE on any agent_* table: the frozen privilege tests
-- (test/spec/db/agent*) pin that couli_maint has no table privilege there.
--
-- Configuration: app.read_retention_settings (0102) is redefined with the same signature, owner and
-- grants so that it also returns agent.trace.retention_days: maintenance reads its configuration once
-- per run, and a second read would double the failure of a locked config_items.
--
-- Single-column created_at indexes keep every batch bounded across all app_id values (the existing
-- (app_id, created_at) indexes do not serve an ORDER BY created_at over every app); the parent checks
-- use the existing child indexes on the foreign-key columns.
--
-- Compatibility: additive (one function, nine indexes, one function body widened).
-- Recovery: set retention.purge.enabled to false (stops sections K, L and M), then apply a
-- corrective migration; rows deleted by maintenance can only be recovered from a backup.
--
-- Timeouts: as in 0102, the runner's single transaction rules out CONCURRENTLY, and each CREATE INDEX
-- holds a SHARE lock that blocks writers of that table (the Agent trace writer) for the build. The
-- tables are small before launch, so the builds are short; 5s lock wait so a blocked deploy fails
-- fast instead of queueing writers behind it, 120s overall as a ceiling for the nine builds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX agent_tool_calls_created_at_idx ON app.agent_tool_calls (created_at);
CREATE INDEX agent_cards_created_at_idx ON app.agent_cards (created_at);
CREATE INDEX agent_result_deliveries_created_at_idx ON app.agent_result_deliveries (created_at);
CREATE INDEX agent_messages_created_at_idx ON app.agent_messages (created_at);
CREATE INDEX agent_result_sets_created_at_idx ON app.agent_result_sets (created_at);
CREATE INDEX agent_runs_created_at_idx ON app.agent_runs (created_at);
CREATE INDEX agent_clarify_asks_created_at_idx ON app.agent_clarify_asks (created_at);
CREATE INDEX agent_result_chains_created_at_idx ON app.agent_result_chains (created_at);
CREATE INDEX agent_sessions_created_at_idx ON app.agent_sessions (created_at);

-- configuration -------------------------------------------------------------------------------

-- Same signature, owner and ACL as 0102; only the key filter is widened by exactly one key.
CREATE OR REPLACE FUNCTION app.read_retention_settings(p_app_id text)
RETURNS TABLE (key text, value jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.key, c.value
  FROM app.config_items c
  WHERE c.app_id = p_app_id
    AND (starts_with(c.key, 'retention.') OR c.key = 'agent.trace.retention_days')
$$;

-- agent traces --------------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_agent_traces(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff        timestamptz;
  v_tool_calls    bigint;
  v_cards         bigint;
  v_deliveries    bigint;
  v_messages      bigint;
  v_result_sets   bigint;
  v_runs          bigint;
  v_clarify_asks  bigint;
  v_result_chains bigint;
  v_sessions      bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_agent_traces: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_agent_traces: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_agent_traces: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ① itself ("不得设为小于 184 天"): the second gate behind the configuration.
  IF p_days < 184 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_agent_traces: p_days must be between 184 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting local
  -- midnight back to an instant (BR-ID-30 正文; as app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- Leaves first: nothing references these rows.
  WITH victims AS (
    SELECT t.id
    FROM app.agent_tool_calls t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_tool_calls d
  USING victims v
  WHERE d.id = v.id;
  GET DIAGNOSTICS v_tool_calls = ROW_COUNT;

  WITH victims AS (
    SELECT t.id
    FROM app.agent_cards t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_cards d
  USING victims v
  WHERE d.id = v.id;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  WITH victims AS (
    SELECT t.app_id, t.session_id, t.card_id
    FROM app.agent_result_deliveries t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_result_deliveries d
  USING victims v
  WHERE d.app_id = v.app_id AND d.session_id = v.session_id AND d.card_id = v.card_id;
  GET DIAGNOSTICS v_deliveries = ROW_COUNT;

  WITH victims AS (
    SELECT t.id
    FROM app.agent_messages t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_messages d
  USING victims v
  WHERE d.id = v.id;
  GET DIAGNOSTICS v_messages = ROW_COUNT;

  -- Parent of agent_result_deliveries. FOR UPDATE (not NO KEY UPDATE) so that a writer's KEY SHARE
  -- on this row makes it skipped rather than deleted under the writer.
  BEGIN
    WITH victims AS (
      SELECT t.id
      FROM app.agent_result_sets t
      WHERE t.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_result_deliveries c
          WHERE c.app_id = t.app_id AND c.run_id = t.run_id AND c.result_set_id = t.id
        )
      ORDER BY t.created_at
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM app.agent_result_sets d
    USING victims v
    WHERE d.id = v.id;
    GET DIAGNOSTICS v_result_sets = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    v_result_sets := 0;
  END;

  -- Parent of agent_tool_calls, agent_cards, agent_result_deliveries, agent_messages and
  -- agent_result_sets.
  BEGIN
    WITH victims AS (
      SELECT t.id
      FROM app.agent_runs t
      WHERE t.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_tool_calls c WHERE c.app_id = t.app_id AND c.run_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_cards c WHERE c.app_id = t.app_id AND c.run_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_result_deliveries c WHERE c.app_id = t.app_id AND c.run_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_messages c WHERE c.app_id = t.app_id AND c.run_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_result_sets c WHERE c.app_id = t.app_id AND c.run_id = t.id
        )
      ORDER BY t.created_at
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM app.agent_runs d
    USING victims v
    WHERE d.id = v.id;
    GET DIAGNOSTICS v_runs = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    v_runs := 0;
  END;

  WITH victims AS (
    SELECT t.app_id, t.session_id, t.chain_id, t.slot
    FROM app.agent_clarify_asks t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_clarify_asks d
  USING victims v
  WHERE d.app_id = v.app_id AND d.session_id = v.session_id AND d.chain_id = v.chain_id
    AND d.slot = v.slot;
  GET DIAGNOSTICS v_clarify_asks = ROW_COUNT;

  WITH victims AS (
    SELECT t.app_id, t.session_id, t.seq
    FROM app.agent_result_chains t
    WHERE t.created_at < v_cutoff
    ORDER BY t.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.agent_result_chains d
  USING victims v
  WHERE d.app_id = v.app_id AND d.session_id = v.session_id AND d.seq = v.seq;
  GET DIAGNOSTICS v_result_chains = ROW_COUNT;

  -- Parent of agent_runs, agent_messages, agent_clarify_asks and agent_result_chains.
  BEGIN
    WITH victims AS (
      SELECT t.id
      FROM app.agent_sessions t
      WHERE t.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_runs c WHERE c.app_id = t.app_id AND c.session_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_messages c WHERE c.app_id = t.app_id AND c.session_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_clarify_asks c WHERE c.app_id = t.app_id AND c.session_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.agent_result_chains c WHERE c.app_id = t.app_id AND c.session_id = t.id
        )
      ORDER BY t.created_at
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM app.agent_sessions d
    USING victims v
    WHERE d.id = v.id;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    v_sessions := 0;
  END;

  RETURN QUERY
  SELECT r.name, r.n
  FROM (VALUES
    (1, 'agent_tool_calls'::text, v_tool_calls),
    (2, 'agent_cards'::text, v_cards),
    (3, 'agent_result_deliveries'::text, v_deliveries),
    (4, 'agent_messages'::text, v_messages),
    (5, 'agent_result_sets'::text, v_result_sets),
    (6, 'agent_runs'::text, v_runs),
    (7, 'agent_clarify_asks'::text, v_clarify_asks),
    (8, 'agent_result_chains'::text, v_result_chains),
    (9, 'agent_sessions'::text, v_sessions)
  ) AS r(pos, name, n)
  ORDER BY r.pos;
END
$$;

ALTER FUNCTION app.delete_expired_agent_traces(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_agent_traces(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_agent_traces(timestamptz, integer, integer) TO couli_maint;
