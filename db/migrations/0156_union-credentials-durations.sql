-- Up Migration
-- The validity periods Taobao returns with a station-owner authorization (08 BR-ID-24 ③ and 细则
-- 「授权时长与续期」「记录与显示」, 2026-11-22; task B1-22zd; orchestrator rulings D10-2584,
-- D10-2587, D10-2758, D10-2771; 04 §3.2 union_credentials).
--
-- app.union_credentials gains five nullable integer columns, the seconds of the token answer:
--   re_expires_in_s (re_expires_in: how long the refresh_token may renew; > 0 means renewable),
--   r1_expires_in_s, r2_expires_in_s, w1_expires_in_s, w2_expires_in_s (the r1 / r2 / w1 / w2
--   read / write grade periods). Only the numbers are kept, never a token. Writer: union (the
--   re-authorization callback, auth-expiry/reauth.ts) on the INSERT of a new credential row; an
--   absent, non-integer or negative value is stored as NULL, a manually entered credential has
--   NULL in all five. The admin account list derives auth_refreshable from re_expires_in_s of the
--   current credential (> 0 true, = 0 false, NULL unknown).
-- Compatibility: additive. No default, no backfill: credential rows written before this migration
--   read NULL (unknown). Each column has a named CHECK (>= 0). No existing column, constraint,
--   index, trigger or grant changes; alert_stage and its CHECK on app.union_accounts are not touched
--   (D10-2771: hour alert nodes only enter the alert dedupe key).
-- app.union_accounts gains one nullable text column hour_alert_key (task patch 4, review money r1):
--   the hour alert node last handled for the account, '<auth_expires_at epoch ms>:h<N>'. Writer:
--   union's hour_alert job only (auth-expiry/service.ts), on the account row locked FOR UPDATE, and
--   only when the value differs; the alert line and the expiring status are written in the same
--   transaction, so a repeat or a late job of the same node finds its key and does nothing. The daily
--   check never writes it. No default, no backfill (NULL: no hour node handled yet), no constraint;
--   the table-level grants of 0015 (couli_app SELECT / INSERT / UPDATE, couli_readonly SELECT)
--   already cover it.
-- Grants: couli_app's table-level SELECT / INSERT (0015) covers the new columns; no UPDATE (the
--   numbers are written once with the row). couli_readonly reads app.union_credentials by column
--   list (0015), so SELECT on the five non-secret numbers is added for it.
-- Recovery: no down migration. To stop using them the application stops writing them (NULL stays
--   readable); a later migration may drop them once nothing reads them.
--
-- Timeouts: ADD COLUMN without a default is catalog only, but takes ACCESS EXCLUSIVE on
-- app.union_credentials and app.union_accounts held to commit (the runner uses one transaction),
-- and the inline CHECKs scan union_credentials (one row per authorization, a few rows). 5s lock
-- wait so a blocked deploy fails fast instead of queueing union traffic behind it; 30s overall as
-- a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.union_credentials
  ADD COLUMN re_expires_in_s integer
    CONSTRAINT union_credentials_re_expires_in_s_check CHECK (re_expires_in_s >= 0),
  ADD COLUMN r1_expires_in_s integer
    CONSTRAINT union_credentials_r1_expires_in_s_check CHECK (r1_expires_in_s >= 0),
  ADD COLUMN r2_expires_in_s integer
    CONSTRAINT union_credentials_r2_expires_in_s_check CHECK (r2_expires_in_s >= 0),
  ADD COLUMN w1_expires_in_s integer
    CONSTRAINT union_credentials_w1_expires_in_s_check CHECK (w1_expires_in_s >= 0),
  ADD COLUMN w2_expires_in_s integer
    CONSTRAINT union_credentials_w2_expires_in_s_check CHECK (w2_expires_in_s >= 0);

GRANT SELECT (re_expires_in_s, r1_expires_in_s, r2_expires_in_s, w1_expires_in_s, w2_expires_in_s)
  ON app.union_credentials TO couli_readonly;

COMMENT ON COLUMN app.union_credentials.re_expires_in_s IS
  'BR-ID-24: Taobao re_expires_in seconds of this authorization (> 0 renewable); NULL unknown';

ALTER TABLE app.union_accounts
  ADD COLUMN hour_alert_key text;

COMMENT ON COLUMN app.union_accounts.hour_alert_key IS
  'BR-ID-24: last hour alert node handled, <auth_expires_at epoch ms>:h<N>; written by the hour job only';

-- app.union_auth_alerts (task B1-22ze, owner 2026-11-25 D10-2970 ③; BR-ID-24 细则「后台告警的
--   持久记录」, 04 §3.2 union_auth_alerts; D10-3063 / D10-3064 (i), D10-3074): the backend alert of
--   the site authorization as a fact, one row per account, node and authorization. Writer: union
--   (auth-expiry/service.ts alert()), INSERT … ON CONFLICT DO NOTHING in the same transaction as the
--   account's alert_stage / hour_alert_key / status and the notify_logs rows; a new row also queues
--   the alert_log job (the pino line) in that transaction. No handler, no state, nothing to close.
--   stage: d<N> / h<N> / expired (the notify_logs dedupe key's stage). alert_key: the rest of that
--   dedupe key without the account and the phone — '<auth_expires_at ISO | none>:<stage>', and for
--   expired ':<entered ISO>' appended (a later re-entry is a new row, a rerun of one entry is not).
--   entered_at: the instant expired was entered (expired only). cause: time / probe / call (expired
--   only). phones_configured: whether alert phones were configured when it was recorded.
-- Append-only: app.reject_update_delete() (as audit_logs / event_log); couli_app SELECT / INSERT,
--   couli_readonly SELECT. New table only: no existing constraint, index, trigger, grant or
--   alert_stage CHECK changes (D10-2771).
-- Recovery: no down migration; the application stops writing it, a later migration may drop it.
CREATE TABLE app.union_auth_alerts (
  id                uuid NOT NULL,
  app_id            text NOT NULL,
  union_account_id  uuid NOT NULL,
  platform          text NOT NULL,
  stage             text NOT NULL,
  alert_key         text NOT NULL,
  auth_expires_at   timestamptz,
  entered_at        timestamptz,
  phones_configured boolean NOT NULL,
  cause             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_auth_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT union_auth_alerts_account_fkey FOREIGN KEY (app_id, platform, union_account_id)
    REFERENCES app.union_accounts (app_id, platform, id),
  CONSTRAINT union_auth_alerts_alert_key UNIQUE (app_id, union_account_id, stage, alert_key),
  CONSTRAINT union_auth_alerts_stage_check CHECK (stage ~ '^(d[0-9]+|h[0-9]+|expired)$'),
  CONSTRAINT union_auth_alerts_cause_check CHECK (cause IN ('time', 'probe', 'call')),
  CONSTRAINT union_auth_alerts_expired_check CHECK (
    (stage = 'expired') = (cause IS NOT NULL) AND (stage = 'expired') = (entered_at IS NOT NULL)
  )
);

CREATE TRIGGER union_auth_alerts_append_only
  BEFORE UPDATE OR DELETE ON app.union_auth_alerts
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.union_auth_alerts TO couli_app;
GRANT SELECT ON app.union_auth_alerts TO couli_readonly;

COMMENT ON TABLE app.union_auth_alerts IS
  'BR-ID-24: backend alert of the site authorization, one row per account, node and authorization; append-only';
