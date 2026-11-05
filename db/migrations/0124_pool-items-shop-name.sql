-- Up Migration
-- Shop name on pool items (FU-POOL-SHOP-NAME, D10-653): a home-page pool card carries the shop name
-- the union gave for the item, as a search card does. Task B1-05zd: the pool admin writes it from the
-- candidate's union detail when an item is added or re-checked, the pool refresh rewrites it from the
-- latest union item, and the pool reader hands it to the card. Absent in the union answer means NULL;
-- nothing fills it from the title, the seller nick or any other field.
-- Compatibility: additive. app.pool_items gains shop_name text; nullable, no default, no backfill:
-- every existing row reads NULL until the next refresh or re-add writes it, and inserts that omit
-- the column keep working. No check: the union adapter already drops empty and blank names. Other
-- columns, constraints, indexes and the primary key are unchanged. Grants are unchanged: the
-- table-level privileges of couli_app and couli_readonly from 0107 cover the new column.
-- Recovery: no down migration. To roll back, a new migration drops the column shop_name (after the
-- application stops reading and writing it).
--
-- Timeouts: ADD COLUMN without a default only changes the catalog, but takes ACCESS EXCLUSIVE on
-- app.pool_items, held to commit since the runner uses one transaction. 5s lock wait so a blocked
-- deploy fails fast instead of queueing pool reads behind it; 30s overall as a ceiling, as in 0110.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.pool_items ADD COLUMN shop_name text;
