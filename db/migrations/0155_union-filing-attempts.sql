-- Up Migration
-- Taobao channel filing attempts. Task B1-04zzzzn (supersedes B1-04zzzzm); 08 BR-ID-17 / BR-ATTR-05;
-- orchestrator rulings D10-2850 (record the attempt before publisher.info.save) and D10-2851 (a new
-- table, outcome written once; only an earlier attempt whose outcome is unknown is evidence).
--
--   app.union_filing_attempts: one row = "the bindings use case was about to call
--   taobao.tbk.sc.publisher.info.save for this user under union_account_id, with the state it
--   consumed, at started_at". The row is inserted and committed on its own transaction before the
--   save is sent; the save's answer is then written once: saved (an id came back; written on the
--   binding's transaction), rejected (an explicit refusal), duplicate (answered as already filed).
--   A process that dies during the save, or a transport timeout, leaves outcome and finished_at
--   NULL: the outcome is unknown, and such an earlier attempt is what lets a later duplicate answer's
--   read-back id be accepted for the same (app, user, platform, union account).
--   id, started_at and finished_at are supplied by the application (UUIDv7, injected Clock); no
--   SQL default and no SQL clock.
--
-- Keys: PK (id); UNIQUE (state) (a state is consumed once, so it starts at most one filing; it also
-- indexes the state foreign key); FK (app_id, user_id) → users (app_id, id); FK (app_id, platform,
-- union_account_id) → union_accounts (app_id, platform, id); FK (state) → union_auth_sessions
-- (state) (its primary key). No cascading (db/AGENTS.md rule 7). The lookup index serves the
-- evidence query (app, user, platform, account, earlier started_at, outcome unknown) and the user
-- foreign key.
-- CHECKs: outcome ∈ {saved, rejected, duplicate} or NULL; outcome and finished_at are both NULL or
-- both set; finished_at not before started_at.
-- Write-once: couli_app gets SELECT, INSERT and column UPDATE of (outcome, finished_at) only, no
-- DELETE / TRUNCATE; the new trigger function app.reject_union_filing_attempt_rewrite (a new
-- function, no existing guard is touched) refuses any UPDATE once outcome is set and any change of
-- the other columns, and refuses DELETE (db/AGENTS.md rule 8: reject-only trigger).
-- couli_readonly gets SELECT.
-- Session ownership: the state's authorization session belongs to the attempt's own app_id, user_id
-- and platform; the application guarantees it (the bindings use case takes those values from the
-- authorization session row it has verified). No INSERT-time trigger checks it (db/AGENTS.md rule 8
-- allows only reject-UPDATE / DELETE triggers); the columns cannot change afterwards
-- (reject_union_filing_attempt_rewrite).
--
-- User-data paths: rows hold no credential, token, nick or account name (none is ever stored);
-- on account deletion or merge they stay under the tombstoned user_id like union_bindings.
-- Cleanup of finished attempts and the patrol of long-unknown ones are not in this task
-- (FU-FILING-ATTEMPT-PATROL).
--
-- Compatibility: additive (one new table, one new function; nothing existing changes).
-- Recovery: no down migration. Rollback is DROP TABLE app.union_filing_attempts and DROP FUNCTION
-- app.reject_union_filing_attempt_rewrite(), only while no row has been written; union_* is an
-- attribution table, so the migration gate refuses that DROP and it needs a gate change approved by
-- the owner (db/AGENTS.md rule 11). Once rows exist they are attribution evidence and are kept; the
-- application simply stops reading and writing them.
--
-- Timeouts: CREATE TABLE with three foreign keys takes SHARE ROW EXCLUSIVE on app.users,
-- app.union_accounts and app.union_auth_sessions for the short catalog change; the new table is
-- empty, so the indexes scan nothing. 5s lock wait so a blocked deploy fails fast instead of
-- queueing binding submissions; 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.union_filing_attempts (
  id uuid NOT NULL,
  app_id text NOT NULL,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  union_account_id uuid NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL,
  outcome text,
  finished_at timestamptz,
  CONSTRAINT union_filing_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT union_filing_attempts_state_key UNIQUE (state),
  CONSTRAINT union_filing_attempts_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('saved', 'rejected', 'duplicate')),
  CONSTRAINT union_filing_attempts_finished_check
    CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CONSTRAINT union_filing_attempts_finished_order_check
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT union_filing_attempts_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT union_filing_attempts_account_fkey FOREIGN KEY (app_id, platform, union_account_id)
    REFERENCES app.union_accounts (app_id, platform, id),
  CONSTRAINT union_filing_attempts_state_fkey FOREIGN KEY (state)
    REFERENCES app.union_auth_sessions (state)
);

CREATE INDEX union_filing_attempts_lookup_idx
  ON app.union_filing_attempts (app_id, user_id, platform, union_account_id, started_at);

CREATE FUNCTION app.reject_union_filing_attempt_rewrite() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'union_filing_attempts rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.id, NEW.app_id, NEW.user_id, NEW.platform, NEW.union_account_id, NEW.state,
         NEW.started_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.user_id, OLD.platform, OLD.union_account_id, OLD.state,
          OLD.started_at)
    OR OLD.outcome IS NOT NULL
    OR OLD.finished_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'union_filing_attempts are immutable and the outcome is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_union_filing_attempt_rewrite() FROM PUBLIC;

CREATE TRIGGER union_filing_attempts_no_rewrite
  BEFORE UPDATE OR DELETE ON app.union_filing_attempts
  FOR EACH ROW EXECUTE FUNCTION app.reject_union_filing_attempt_rewrite();

GRANT SELECT, INSERT ON app.union_filing_attempts TO couli_app;
GRANT UPDATE (outcome, finished_at) ON app.union_filing_attempts TO couli_app;
GRANT SELECT ON app.union_filing_attempts TO couli_readonly;
