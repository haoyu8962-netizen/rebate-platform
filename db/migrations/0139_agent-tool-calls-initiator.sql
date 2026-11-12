-- Up Migration
-- Who started each agent tool call (08 BR-AI-01 细则「意图兜底与不空回复」: a server-initiated call is
-- traced 「照常留痕（标明由服务端发起）」; BR-AI-19: tool calls are stored in app.agent_tool_calls).
-- Task B3-05p; orchestrator rulings D10-1378, D10-1380.
-- app.agent_tool_calls gains initiator text NOT NULL DEFAULT 'model':
--   'model'  — the model asked for the call (every row written before this migration, and every
--              insert that leaves the column out);
--   'server' — the server made the call on its own initiative: the intent fallback's calls and the
--              deterministic link path's get_rebate_quote (no model involved).
-- agent_tool_calls_initiator_check: initiator IN ('model', 'server').
-- Compatibility: additive. Existing inserts that omit the column keep working and read 'model';
--   existing rows read 'model' (a constant default is stored as the missing value: no rewrite, no
--   backfill). The update trigger agent_tool_calls_no_rewrite (0073) compares whole rows except args,
--   so the new column cannot be changed either.
-- The CHECK is added NOT VALID: new rows are checked at once; every existing row reads the default
--   'model', so none can violate it. A later migration may VALIDATE it (precedent 0136 / 0137).
-- Writer: agent (agent/store/results createPgAgentTraceWriter, couli_app). No personal data.
-- Grants: couli_app's table-level SELECT / INSERT (0021) covers the new column; no UPDATE on it.
--   couli_readonly reads app.agent_tool_calls by column list (0021: every column except args), so
--   SELECT (initiator) is added for it, as 0023 did for the new agent_runs columns; initiator is a
--   fixed code, not user text.
-- Recovery: no down migration. To undo, a later migration drops agent_tool_calls_initiator_check
--   and then the column once nothing reads or writes it.
--
-- Timeouts: ADD COLUMN with a constant default and ADD CONSTRAINT … NOT VALID are catalog-only (no
-- scan, no rewrite) but take ACCESS EXCLUSIVE on app.agent_tool_calls, held to commit since the
-- runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of queueing the
-- asynchronous trace writes behind it; 30s overall as a ceiling for the catalog change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.agent_tool_calls ADD COLUMN initiator text NOT NULL DEFAULT 'model';

ALTER TABLE app.agent_tool_calls ADD CONSTRAINT agent_tool_calls_initiator_check
  CHECK (initiator IN ('model', 'server')) NOT VALID;

GRANT SELECT (initiator) ON app.agent_tool_calls TO couli_readonly;

COMMENT ON COLUMN app.agent_tool_calls.initiator IS
  'BR-AI-01: model = the model asked for the call; server = the server made it on its own initiative';
