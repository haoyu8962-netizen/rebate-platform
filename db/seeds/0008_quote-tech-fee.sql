-- B2-03za: the quote technical service fee rate tech_fee_bp (08 BR-CALC-20: 不单独维护报价技术服务费率,
-- 配置 tech_fee_bp 各平台统一为 0; 负责人 2026-11-22 拍板, D10-2592 ②, D10-2595;
-- FU-QUOTE-TECH-FEE-DEFAULT-ZERO, D10-3358 ①, D10-3676). The quote read side refuses a missing
-- tech_fee_bp, so without this row a fresh database cannot quote taobao, jd or pdd.
-- The order-sync fallback keys union.*.service_fee_bp are not set to 0 by BR-CALC-20 (BR-CALC-03) and
-- are not written here.
-- Synthetic app_id only.
-- Re-runnable: ON CONFLICT DO NOTHING keeps an existing value and its revision, including one an
-- operator saved in the admin. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'tech_fee_bp', '{"taobao":0,"jd":0,"pdd":0}'::jsonb, 'seed') -- BR-CALC-20
ON CONFLICT (app_id, key) DO NOTHING;
