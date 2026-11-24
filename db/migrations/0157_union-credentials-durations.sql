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
--   index, trigger or grant changes; app.union_accounts (alert_stage and its CHECK included) is not
--   touched (D10-2771: hour alert nodes only enter the alert dedupe key).
-- Grants: couli_app's table-level SELECT / INSERT (0015) covers the new columns; no UPDATE (the
--   numbers are written once with the row). couli_readonly reads app.union_credentials by column
--   list (0015), so SELECT on the five non-secret numbers is added for it.
-- Recovery: no down migration. To stop using them the application stops writing them (NULL stays
--   readable); a later migration may drop them once nothing reads them.
--
-- Timeouts: ADD COLUMN without a default is catalog only, but takes ACCESS EXCLUSIVE on
-- app.union_credentials held to commit (the runner uses one transaction), and the inline CHECKs scan
-- the table (one row per authorization, a few rows). 5s lock wait so a blocked deploy fails fast
-- instead of queueing re-authorizations behind it; 30s overall as a ceiling.
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
