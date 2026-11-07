-- Up Migration
-- Manual order sub-reason columns (08 12_TEXT BR-TEXT-05「子原因 reason_sub」: 15 codes; 人工选择覆盖
-- 自动映射, 人工选过的不被自动覆盖). Task B1-09u; orchestrator rulings D10-819 ①, D10-821 ③.
-- - app.rights_imports.reason_sub text NULL: the manual choice of one rights import; one of the 15
--   codes or 'none' (「无」chosen explicitly); NULL = not chosen (automatic mapping).
-- - app.order_rights.reason_sub text NULL + reason_sub_manual boolean NOT NULL DEFAULT false: the
--   manual choice carried by one rights record; reason_sub must be NULL while reason_sub_manual is
--   false. With reason_sub_manual true, reason_sub is one of the 15 codes, 'none' or NULL.
-- - app.orders.reason_sub_manual boolean NOT NULL DEFAULT false: the order's sub-reason was chosen
--   by hand, so automatic mapping must not overwrite it. app.orders.reason_sub already exists and
--   gets no CHECK here (no full validation scan of the large partitioned table).
-- Compatibility: additive. No backfill: the nullable reason_sub columns read NULL on existing rows;
--   the boolean columns are added with DEFAULT false directly (a non-volatile default, stored as
--   the missing value: no rewrite), so existing rows read false. ALTER TABLE on the partitioned
--   parent app.orders (not ONLY) adds the column to orders_default and every partition created
--   later. Existing inserts and updates that omit the new columns keep working.
--   rights_imports_reason_sub_check: added validated (not a funds table, small, every existing row
--     NULL); precedent 0104 / 0110.
--   order_rights_reason_sub_check, order_rights_reason_sub_manual_check: app.order_rights is a funds
--     / attribution table (no squawk-ignore), so both are added NOT VALID (new and updated rows are
--     checked at once). Every existing row has reason_sub NULL and reason_sub_manual false, so none
--     can violate them; a later migration may VALIDATE them (precedent 0129 / 0130).
-- Grants: app.orders and app.order_rights grant couli_app table-level SELECT / INSERT / UPDATE and
--   couli_readonly SELECT, which cover the new columns. app.rights_imports grants couli_app
--   table-level SELECT / INSERT but UPDATE per column, so UPDATE (reason_sub) is added for
--   couli_app; couli_readonly keeps table-level SELECT only.
-- Recovery: no down migration. app.orders and app.order_rights are funds / attribution tables, so
--   their columns are never dropped by a migration; to stop using them the application stops
--   reading and writing them. For app.rights_imports a later migration may drop the CHECK by name
--   and then the column.
--
-- Timeouts: ADD COLUMN (nullable, or with a constant default) and ADD CONSTRAINT … NOT VALID are
-- catalog-only; the validated CHECK on app.rights_imports scans that small table. All take ACCESS
-- EXCLUSIVE on their table (app.orders: on the parent and its partitions), held to commit since the
-- runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of queueing order
-- sync and rights import traffic behind it; 30s overall as a ceiling (as in 0063).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.rights_imports ADD COLUMN reason_sub text;

-- app.rights_imports is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD COLUMN and gain nothing; the table is small (one row per import) and the new column is NULL on
-- every existing row, so a plain validated ADD is used, as in 0104 and 0110.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.rights_imports ADD CONSTRAINT rights_imports_reason_sub_check
  CHECK (reason_sub IS NULL OR reason_sub IN (
    'VIOLATION_PROMO', 'SHOP_TK', 'INSITE_PROMO', 'PROXY_BUY', 'FAKE_TRADE', 'INSITE_RESALE',
    'OVER_LIMIT', 'MARKET_DISRUPT', 'MULTI_TRADE_ABNORMAL', 'SINGLE_TRADE_ABNORMAL', 'RISK_ORDER',
    'PUNISH_ORDER', 'IN_SALE', 'AFTER_SETTLE', 'AFTER_SALE', 'none'
  ));

GRANT UPDATE (reason_sub) ON app.rights_imports TO couli_app;

ALTER TABLE app.order_rights
  ADD COLUMN reason_sub text,
  ADD COLUMN reason_sub_manual boolean NOT NULL DEFAULT false;

ALTER TABLE app.order_rights ADD CONSTRAINT order_rights_reason_sub_check
  CHECK (reason_sub IS NULL OR reason_sub IN (
    'VIOLATION_PROMO', 'SHOP_TK', 'INSITE_PROMO', 'PROXY_BUY', 'FAKE_TRADE', 'INSITE_RESALE',
    'OVER_LIMIT', 'MARKET_DISRUPT', 'MULTI_TRADE_ABNORMAL', 'SINGLE_TRADE_ABNORMAL', 'RISK_ORDER',
    'PUNISH_ORDER', 'IN_SALE', 'AFTER_SETTLE', 'AFTER_SALE', 'none'
  )) NOT VALID;

ALTER TABLE app.order_rights ADD CONSTRAINT order_rights_reason_sub_manual_check
  CHECK (reason_sub_manual OR reason_sub IS NULL) NOT VALID;

ALTER TABLE app.orders ADD COLUMN reason_sub_manual boolean NOT NULL DEFAULT false;
