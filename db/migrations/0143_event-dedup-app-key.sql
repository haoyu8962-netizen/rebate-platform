-- Up Migration
-- CT-13i (FU-EVENT-DEDUP-APP-KEY; orchestrator rulings D10-1519, D10-1520): the primary key of
-- app.event_dedup becomes (app_id, event_type, event_id). 规划/02 multi-App isolation: a business
-- unique key starts with app_id, so two apps that happen to send the same event_type / event_id are
-- each accepted once and deduplicated only within their own app. 0140's key was (event_type, event_id).
--
-- The constraint keeps its name event_dedup_pkey; only its columns change. event_dedup_created_idx
-- (retention cleanup, 0142's app.purge_expired_event_dedup) is untouched. Columns, defaults and grants
-- are unchanged. The writer (apps/api analytics recordEvents) switches its ON CONFLICT target to the
-- new key in the same change.
--
-- app.event_dedup is not a funds or attribution table (not in the funds list of
-- tools/ci/lint-migrations.ts). No foreign key references event_dedup_pkey.
-- Why this is safe with data, not only on an empty table: app_id is NOT NULL since 0140 (and no later
-- migration changes it), and the old key (event_type, event_id) was stricter than the new one — every
-- row that is unique under the old key is necessarily unique under (app_id, event_type, event_id). So
-- the ADD cannot fail on existing rows, whatever their number. The only cost is the ACCESS EXCLUSIVE
-- lock held while the new key index is built (a scan of the table); before go-live this lock is to be
-- removed by the CONCURRENTLY pattern under FU-MIGRATION-INDEX-CONCURRENTLY.
--
-- Compatibility: the old key was stricter; any writer still using ON CONFLICT (event_type, event_id)
--   would fail with 42P10 after this migration, which is why the writer change ships with it.
-- Recovery: no down migration. To go back, a corrective migration drops event_dedup_pkey and adds
--   PRIMARY KEY (event_type, event_id) again — that fails if two apps by then hold the same
--   (event_type, event_id); such duplicates must be resolved first (keep one row per key) — and the
--   writer's conflict target is reverted with it.
--
-- Timeouts: DROP / ADD CONSTRAINT take ACCESS EXCLUSIVE on app.event_dedup; 5s lock wait so a blocked
-- deploy fails fast instead of queueing event writes behind it; 30s overall as a ceiling for the index
-- build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.event_dedup DROP CONSTRAINT event_dedup_pkey;

-- squawk exemption: the runner applies migrations in one transaction, so CREATE INDEX CONCURRENTLY +
-- ADD CONSTRAINT … USING INDEX (or NOT VALID + VALIDATE, which a primary key does not support) is not
-- possible here. Existing rows always satisfy the new key (see above), so the ADD cannot fail; the
-- price is the exclusive lock during the index build, which FU-MIGRATION-INDEX-CONCURRENTLY removes
-- before go-live. No serial column is added: the key is over existing NOT NULL columns (text, text, uuid).
-- squawk-ignore constraint-missing-not-valid, adding-serial-primary-key-field
ALTER TABLE app.event_dedup ADD CONSTRAINT event_dedup_pkey
  PRIMARY KEY (app_id, event_type, event_id);
