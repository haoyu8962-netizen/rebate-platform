-- Up Migration
-- Adjustments linked to external recon diffs, plan B (08 BR-FUND-24 ⑨ and 细则「对外差错单的调账」;
-- task B2-17; orchestrator rulings D10-3185, D10-3191, D10-3237, D10-3239). Storage plus one backfill
-- of the link rows of forms executed before this migration; the writer (apps/api ledger, admin
-- adjustment submit and reversal) comes in the second part of the task.
--
-- app.adjustment_recon_diffs: one row per recon diff that an executed adjustment form links to.
--   - Written by ledger in the transaction that executes the form (INSERT, reversed_by_adjust_id
--     NULL, user_id = the form's member, created_at from the application clock, no SQL default).
--     When the form is reversed, the same transaction sets reversed_by_adjust_id to the reversal's
--     adjust_id on each of its rows; no other column is ever updated and rows are never deleted.
--   - Primary key (adjust_id, recon_diff_id): a form links a diff at most once.
--   - adjustment_recon_diffs_active_key: at most one executed, not reversed form per (diff, member)
--     — BR-FUND-24 ⑨「同一差错单对同一受益用户至多一张已执行、未被红冲的调账单」 as a database
--     backstop (the service answers 20902 recon_diff before writing anything).
--   - Four foreign keys, none cascading: the form, the reversal, the member and the diff, each
--     scoped by app_id. The diff key references the unique index recon_diffs_app_id_id_key below.
--   - Named CHECKs: app_id is not empty; a form does not reverse itself.
--
-- app.recon_diffs:
--   - involved_user_ids uuid[], nullable, no default, no constraint: the members a diff involves,
--     written once when the diff is registered (daily ledger check; other registrars leave it NULL).
--     NULL or an empty array means "only the member being adjusted". No CHECK on purpose: every
--     table constraint of app.recon_diffs is pinned to migration 0060 (test/spec/db/settlement/
--     ledger-owned, AC-B2-04b#4), and merged migrations never change.
--   - recon_diffs_app_id_id_key: unique index (app_id, id), an index and not a table constraint for
--     the same reason; the composite foreign key of the link table references it.
--
-- Compatibility: additive, plus one backfill of the new link table (编排 D10-3237 (一), D10-3239).
-- One new table, one nullable column with no default (catalog only, no rewrite), one unique index.
-- (app_id, id) is unique already because id is the primary key, so that index build cannot fail on
-- existing rows. Forms executed before this migration named their diffs only in admin_adjustments.refs
-- (back then an adjustment never changed a diff's status); the INSERT … SELECT after the partial
-- unique index gives them their link rows, so that the same member cannot record a second
-- adjustment on the same diff after the upgrade. It backfills one row (reversed_by_adjust_id NULL,
-- user_id = the form's member, created_at = the form's reviewed_at) per form and per ref when the
-- form is APPROVED, is not a reversal and has not been reversed (no form's reverses_adjust_id names
-- it), and the ref is an object { ref_type: 'recon_diff', ref_id } whose ref_id (any letter case)
-- is the id of an existing diff of the same app with type 'ledger_mismatch', whatever that diff's
-- status. It does not backfill: PENDING / REJECTED / CANCELLED forms, reversed originals,
-- reversals, refs of another ref_type, diffs of another app, ids naming no diff, diffs of any other
-- type (platform_restore, appeal_restore, union_mismatch, ...); refs that are not objects or whose
-- ref_id is not a UUID are skipped without an error. It changes no diff — no status or other column
-- of app.recon_diffs is written, a backfilled diff keeps the status it has — and does not touch
-- admin_adjustments or involved_user_ids (diffs registered before this migration keep NULL, i.e.
-- "only the member being adjusted"). The statement uses only couli_app's privileges on the three
-- tables (SELECT on admin_adjustments / recon_diffs, INSERT on the link table).
-- Grants: couli_app SELECT, INSERT on the link table and UPDATE of reversed_by_adjust_id only (no
-- DELETE / TRUNCATE, identity columns not updatable); couli_readonly SELECT. On app.recon_diffs the
-- table-level SELECT / INSERT of couli_app and SELECT of couli_readonly (0060) cover the new column;
-- couli_app gets no UPDATE of involved_user_ids (the list is not changed after registration).
-- Recovery: restore from backup; no down migration. Both tables are funds tables: nothing here is
-- ever dropped by a migration; to stop using them the application stops writing them.
--
-- Before deploying (变更记录 20261121-对外差错单方案B §3): if an app has two or more forms that
-- meet the backfill conditions above for the same ledger_mismatch diff and the same member, the
-- backfill fails with 23505 on adjustment_recon_diffs_active_key and the whole migration rolls back;
-- that is intended (fail closed: BR-FUND-24 ⑨ allows one executed, not reversed adjustment per diff
-- and member). Find such groups with
--   SELECT a.app_id, d.id AS recon_diff_id, a.user_id,
--          array_agg(DISTINCT a.adjust_id) AS adjust_ids
--     FROM app.admin_adjustments a
--     CROSS JOIN LATERAL jsonb_array_elements(a.refs) AS r(ref)
--     JOIN app.recon_diffs d
--       ON d.app_id = a.app_id AND d.id::text = lower(r.ref ->> 'ref_id')
--    WHERE a.status = 'APPROVED' AND a.reverses_adjust_id IS NULL
--      AND NOT EXISTS (SELECT 1 FROM app.admin_adjustments v
--                       WHERE v.app_id = a.app_id AND v.reverses_adjust_id = a.adjust_id)
--      AND jsonb_typeof(r.ref) = 'object' AND r.ref ->> 'ref_type' = 'recon_diff'
--      AND d.type = 'ledger_mismatch'
--    GROUP BY a.app_id, d.id, a.user_id
--   HAVING count(DISTINCT a.adjust_id) > 1;
-- and settle them by hand first (reverse the surplus forms through the console), then deploy.
--
-- squawk: require-concurrent-index-creation is excluded globally in .squawk.toml (the runner applies
-- migrations in one transaction, precedent 0152).
-- Timeouts: ADD COLUMN takes ACCESS EXCLUSIVE on app.recon_diffs (catalog only) held to commit;
-- CREATE UNIQUE INDEX scans app.recon_diffs under a SHARE lock; the foreign keys take SHARE ROW
-- EXCLUSIVE on admin_adjustments, users and recon_diffs. Registrations, closes and adjustments wait
-- for the deploy. The backfill reads admin_adjustments and recon_diffs once (no locks beyond the
-- above). 5s lock wait so a blocked deploy fails fast; 5min overall as a ceiling for the index build
-- and the backfill (precedent 0152).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE app.recon_diffs ADD COLUMN involved_user_ids uuid[];

CREATE UNIQUE INDEX recon_diffs_app_id_id_key ON app.recon_diffs (app_id, id);

CREATE TABLE app.adjustment_recon_diffs (
  app_id                text NOT NULL,
  adjust_id             uuid NOT NULL,
  recon_diff_id         uuid NOT NULL,
  user_id               uuid NOT NULL,
  reversed_by_adjust_id uuid,
  created_at            timestamptz NOT NULL,
  CONSTRAINT adjustment_recon_diffs_pkey PRIMARY KEY (adjust_id, recon_diff_id),
  CONSTRAINT adjustment_recon_diffs_adjust_fkey FOREIGN KEY (app_id, adjust_id)
    REFERENCES app.admin_adjustments (app_id, adjust_id),
  CONSTRAINT adjustment_recon_diffs_reversed_by_fkey FOREIGN KEY (app_id, reversed_by_adjust_id)
    REFERENCES app.admin_adjustments (app_id, adjust_id),
  CONSTRAINT adjustment_recon_diffs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT adjustment_recon_diffs_diff_fkey FOREIGN KEY (app_id, recon_diff_id)
    REFERENCES app.recon_diffs (app_id, id),
  CONSTRAINT adjustment_recon_diffs_app_id_check CHECK (app_id <> ''),
  CONSTRAINT adjustment_recon_diffs_reversed_by_check CHECK (reversed_by_adjust_id <> adjust_id)
);

-- BR-FUND-24 ⑨: one executed, not reversed form per (recon diff, member).
CREATE UNIQUE INDEX adjustment_recon_diffs_active_key
  ON app.adjustment_recon_diffs (app_id, recon_diff_id, user_id)
  WHERE reversed_by_adjust_id IS NULL;

-- Backfill (see Compatibility above): the forms executed before this migration. DISTINCT folds a
-- diff named twice in one form's refs into one row. ref_id is compared as text with the diff's
-- canonical id, so a ref_id that is not a UUID matches nothing instead of failing a cast. A second
-- qualifying form of the same member on the same diff fails here on adjustment_recon_diffs_active_key.
INSERT INTO app.adjustment_recon_diffs
  (app_id, adjust_id, recon_diff_id, user_id, reversed_by_adjust_id, created_at)
SELECT DISTINCT a.app_id, a.adjust_id, d.id, a.user_id, NULL::uuid, a.reviewed_at
  FROM app.admin_adjustments a
  CROSS JOIN LATERAL jsonb_array_elements(a.refs) AS r(ref)
  JOIN app.recon_diffs d
    ON d.app_id = a.app_id
   AND d.id::text = lower(r.ref ->> 'ref_id')
 WHERE a.status = 'APPROVED'
   AND a.reverses_adjust_id IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM app.admin_adjustments v
      WHERE v.app_id = a.app_id
        AND v.reverses_adjust_id = a.adjust_id
   )
   AND jsonb_typeof(r.ref) = 'object'
   AND r.ref ->> 'ref_type' = 'recon_diff'
   AND d.type = 'ledger_mismatch';

GRANT SELECT, INSERT ON app.adjustment_recon_diffs TO couli_app;
GRANT UPDATE (reversed_by_adjust_id) ON app.adjustment_recon_diffs TO couli_app;
GRANT SELECT ON app.adjustment_recon_diffs TO couli_readonly;
