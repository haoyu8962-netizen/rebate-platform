-- Up Migration
-- Product feedback from the detail page (S-15; contract CT-26q submitProductFeedback; 08 BR-ID-02
-- 细则「商品反馈与进店」, BR-ID-30 细则「商品反馈记录」, BR-ID-28 删除清单; 写者 feedback). Table
-- shape follows the orchestrator ruling in couli-runs/B1-28p brief §9.2 ②. Task B1-28p.
-- Compatibility: additive. One new ordinary (non-partitioned) table in schema app; no existing
-- object changes. Recovery: restore from backup; no down migration.
--
-- product_feedbacks: one row per accepted feedback.
-- - Only what BR-ID-30 细则「商品反馈记录」 lists: platform, product_key, the detail's link_id, the
--   shown final price and rebate, the quote time, the reason, the optional note, the device and,
--   when logged in, user_id; plus id, app_id and created_at. No contact column.
-- - id is a UUIDv7 supplied by the application; no default (db/AGENTS.md rule 6).
-- - device_id, user_id and link_id carry the ids of app.devices, app.users and app.links but no
--   foreign key: the account deletion cleanup physically deletes the user's rows (never by
--   cascade), guest rows outlive the device, and the link check is the application's (30144).
-- - shown_final_price_fen / shown_rebate_fen are what the page displayed, in fen, never negative;
--   shown_rebate_fen is NULL when the page showed none.
-- - note is at most 100 characters (BR-TEXT-14 表 C feedback.note.*); reason is one of the four
--   contract values.
-- - created_at is written from the injected Clock; now() is only the fallback default. The
--   per-device daily limit (feedback.daily_limit_per_device, +08:00 natural day) is an application
--   rule under a per-device advisory lock, served by product_feedbacks_app_id_device_id_created_at_idx.
-- - product_feedbacks_app_id_user_id_idx serves the deletion cleanup (rows of one user).
-- - No retention job: the keeping period waits for legal review (BR-ID-30 细则).
-- No trigger is added (db/AGENTS.md rule 8).
--
-- Grants: couli_app gets SELECT, INSERT and DELETE (no UPDATE: a feedback is never edited; DELETE
-- for the account deletion cleanup; no TRUNCATE). couli_readonly gets SELECT. No other role
-- (couli_payout, couli_maint) gets any privilege.
--
-- Timeouts: only a new, empty table with its constraints and two indexes is created, and no
-- existing table is locked; 5s lock wait so a blocked deploy fails fast, 30s overall as a
-- ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.product_feedbacks (
  id uuid NOT NULL,
  app_id text NOT NULL,
  device_id uuid NOT NULL,
  user_id uuid,
  platform text NOT NULL,
  product_key text NOT NULL,
  item_ref text,
  link_id uuid NOT NULL,
  shown_final_price_fen bigint NOT NULL,
  shown_rebate_fen bigint,
  quoted_at timestamptz NOT NULL,
  reason text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_feedbacks_pkey PRIMARY KEY (id),
  CONSTRAINT product_feedbacks_shown_final_price_fen_check CHECK (shown_final_price_fen >= 0),
  CONSTRAINT product_feedbacks_shown_rebate_fen_check
    CHECK (shown_rebate_fen IS NULL OR shown_rebate_fen >= 0),
  CONSTRAINT product_feedbacks_reason_check CHECK (reason IN ('price', 'rebate', 'info', 'other')),
  CONSTRAINT product_feedbacks_note_check CHECK (note IS NULL OR char_length(note) <= 100),
  CONSTRAINT product_feedbacks_item_ref_check
    CHECK (item_ref IS NULL OR char_length(item_ref) BETWEEN 1 AND 1024),
  CONSTRAINT product_feedbacks_product_key_check CHECK (char_length(product_key) BETWEEN 3 AND 128)
);

CREATE INDEX product_feedbacks_app_id_device_id_created_at_idx
  ON app.product_feedbacks (app_id, device_id, created_at);

CREATE INDEX product_feedbacks_app_id_user_id_idx
  ON app.product_feedbacks (app_id, user_id)
  WHERE user_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON app.product_feedbacks TO couli_app;
GRANT SELECT ON app.product_feedbacks TO couli_readonly;
