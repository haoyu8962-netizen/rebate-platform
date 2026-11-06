-- Up Migration
-- The risk marks of the accounts linked to a written-off member (08 BR-FUND-12「核销时给同实名、
-- 同设备、同收款账号的关联账户打风控标记」; 写者 risk). Shape fixed by the orchestrator rulings
-- D10-727 ③, D10-590 ⑤ and D10-758 (couli-runs/B2-12g plan.md and brief §10). Task B2-12g.
-- Compatibility: additive. One new ordinary (non-partitioned) table in schema app; no existing
-- object changes. Recovery: restore from backup; no down migration.
--
-- risk_linked_marks: one row per (approved write-off candidate, linked member, dimension).
-- - Trace only: nothing reads it to change a withdrawal decision, no notice, no console endpoint
--   yet (FU-BAD-DEBT-LINKED-VIEW); no expiry and no appeal (BR not decided).
-- - id is a bigint identity (GENERATED ALWAYS: the identity sequence needs no grant).
-- - user_id is the marked linked member, source_user_id the written-off member, source_ref the
--   write-off candidate's id (app.bad_debt_writeoffs.id as text), dimension the link that matched:
--   id_no (same verified real name; reserved, not written yet: FU-BAD-DEBT-LINKED-REALNAME), device (a session on a device row whose device_hash is that of
--   a device of the written-off member's sessions; a reinstall registers a new row with the same
--   hash) or payout_account (an alipay_hmac or bank_card_hmac shared by any payout_accounts rows of
--   the two members, is_current=false history rows too). Only the dimension is kept: no plaintext,
--   no cipher and no HMAC.
-- - Unique (app_id, source_ref, user_id, dimension): a replayed approval or a second call of the
--   writer inserts nothing new (ON CONFLICT DO NOTHING).
-- - Both members are rows of app.users of the same app (foreign keys, no cascade); a member is
--   never marked by its own write-off.
-- - Deletion: kept like app.risk_hits (BR-ID-30, retained pending legal review; D10-758): the
--   account deletion leaves these rows as they are.
-- - created_at is written from the injected Clock; now() is only the fallback default.
-- - risk_linked_marks_app_id_user_id_idx serves the reads of one member's marks; the unique index
--   serves the reads of one candidate's marks; source_user_id's foreign key is served by
--   risk_linked_marks_app_id_source_user_id_idx.
-- Lookup indexes for the writer's reads (brief §11): app.devices had no (app_id, device_hash)
-- index, and app.payout_accounts only partial ones WHERE is_current, which do not serve the
-- history rows. devices_app_id_device_hash_idx serves the device_hash join;
-- payout_accounts_app_id_user_id_idx, payout_accounts_app_id_alipay_hmac_idx and
-- payout_accounts_app_id_bank_card_hmac_idx serve one member's rows and the rows sharing an HMAC
-- (all rows, current or not; NULL HMACs are left out). New named indexes only; no existing
-- index, constraint or trigger changes.
-- Locking: these four indexes are built without CONCURRENTLY, so writes to app.devices and
-- app.payout_accounts are blocked while they are built. Once live, any later index of this kind
-- must be built with CREATE INDEX CONCURRENTLY in its own migration.
-- No trigger is added (db/AGENTS.md rule 8).
--
-- Grants: couli_app gets SELECT and INSERT only (append only: no UPDATE, DELETE or TRUNCATE).
-- couli_readonly gets SELECT. No other role (couli_payout, couli_maint) gets any privilege.
--
-- Timeouts: a new, empty table with its constraints and indexes is created; the foreign keys take a
-- SHARE ROW EXCLUSIVE lock on app.users for an instant (no rows to validate). The four lookup
-- indexes are built in the migration's transaction (CONCURRENTLY is not possible there) and hold a
-- SHARE lock on app.devices / app.payout_accounts while they build (writes wait; small before
-- launch). 5s lock wait so a blocked deploy fails fast, 120s per statement as a ceiling for the
-- index builds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE app.risk_linked_marks (
  id bigint GENERATED ALWAYS AS IDENTITY,
  app_id text NOT NULL,
  user_id uuid NOT NULL,
  source_user_id uuid NOT NULL,
  source_ref text NOT NULL,
  dimension text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_linked_marks_pkey PRIMARY KEY (id),
  CONSTRAINT risk_linked_marks_mark_key UNIQUE (app_id, source_ref, user_id, dimension),
  CONSTRAINT risk_linked_marks_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT risk_linked_marks_source_user_fkey FOREIGN KEY (app_id, source_user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT risk_linked_marks_not_self_check CHECK (user_id <> source_user_id),
  CONSTRAINT risk_linked_marks_dimension_check
    CHECK (dimension IN ('id_no', 'device', 'payout_account')),
  CONSTRAINT risk_linked_marks_source_ref_check CHECK (char_length(source_ref) BETWEEN 1 AND 128)
);

CREATE INDEX risk_linked_marks_app_id_user_id_idx ON app.risk_linked_marks (app_id, user_id);

CREATE INDEX risk_linked_marks_app_id_source_user_id_idx
  ON app.risk_linked_marks (app_id, source_user_id);

GRANT SELECT, INSERT ON app.risk_linked_marks TO couli_app;
GRANT SELECT ON app.risk_linked_marks TO couli_readonly;

CREATE INDEX devices_app_id_device_hash_idx ON app.devices (app_id, device_hash);

CREATE INDEX payout_accounts_app_id_user_id_idx ON app.payout_accounts (app_id, user_id);

CREATE INDEX payout_accounts_app_id_alipay_hmac_idx
  ON app.payout_accounts (app_id, alipay_hmac)
  WHERE alipay_hmac IS NOT NULL;

CREATE INDEX payout_accounts_app_id_bank_card_hmac_idx
  ON app.payout_accounts (app_id, bank_card_hmac)
  WHERE bank_card_hmac IS NOT NULL;
