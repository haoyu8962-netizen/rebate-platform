-- Up Migration
-- Tags on pool items (CT-07e; 规划/01 F-ADM-10, 04 §3.2 pool_items.tags; orchestrator rulings
-- D10-1758, D10-1761, D10-1764, D10-1765): the console labels pool items, filters its item list by
-- one tag, and a home-page product_pool data source may name tags so that only the items sharing at
-- least one of them are delivered. catalog stays the single writer: the pool admin writes the
-- normalized value (NFKC, trimmed, inner whitespace one space, duplicates dropped, at most 10 tags of
-- 1–16 code points, no control characters); the database keeps it as given, in its order.
-- Compatibility: additive. app.pool_items gains tags text[] NOT NULL DEFAULT '{}': every existing row
-- reads [] and inserts that omit the column keep working. The default is a constant, so PostgreSQL
-- records it in the catalog and rewrites no row. No CHECK: the rules live in one place, the
-- application's normalization (a CHECK would need NOT VALID + VALIDATE and repeat them). No index:
-- every read that filters by tags (the console list, the home section read) is already scoped by
-- (app_id, pool_id) through pool_items_read_idx (app_id, pool_id, sort, product_key), and a pool
-- holds at most a few hundred rows, so a GIN index over all pools would cost every write and save
-- nothing.
-- Other columns, constraints, indexes and the primary key are unchanged. Grants are unchanged: the
-- table-level privileges of couli_app and couli_readonly from 0107 cover the new column.
-- Recovery: no down migration. To roll back, a new migration drops the column tags (after the
-- application stops reading and writing it).
--
-- Timeouts: ADD COLUMN with a constant default only changes the catalog, but takes ACCESS EXCLUSIVE
-- on app.pool_items, held to commit since the runner uses one transaction. 5s lock wait so a blocked
-- deploy fails fast instead of queueing pool reads behind it; 30s overall as a ceiling, as in 0124.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.pool_items ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
