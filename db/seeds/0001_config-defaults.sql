-- Configuration defaults from 规划/08_业务规则 at SPEC_REF 826f86ef3bb76738e3c99998d7d31516838d1539.
-- Synthetic app_id/actor only. Re-running preserves every existing value and revision,
-- including values changed by an operator; this is initialization, not a config update.
-- Scope: c-03, b2-40, b3-39, b4-32, fa-24. Excluded by the task: sms.* / device.*
-- thresholds and share.tpwd_rate_per_min (D-7; orchestrator 2026-10-04: rate limits are risk parameters), help_links.* (D-8), derived claim.window_days / features.*,
-- link_patterns (specs), and search.enabled.<platform> (kill_switches, 04 §10.2).

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  -- 第 1 批：c-03
  ('couli', 'union.taobao.auth_methods.ios', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'union.taobao.auth_methods.android', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'union.taobao.auth_methods.harmony', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'external_page.union_host_block', 'true'::jsonb, 'seed'), -- BR-ATTR-29
  ('couli', 'external_page.nav_host_sample_bp', '1000'::jsonb, 'seed'), -- BR-ATTR-29 细则
  ('couli', 'share.open_in_app.enabled', 'true'::jsonb, 'seed'), -- BR-ATTR-05 细则
  ('couli', 'invite.bind_phone_guide', 'true'::jsonb, 'seed'), -- BR-INV-21、BR-INV-03 细则
  ('couli', 'invite.before_buy_tip', 'true'::jsonb, 'seed'), -- BR-INV-21、BR-INV-03 细则
  ('couli', 'auth.oauth_attempt_ttl_sec', '600'::jsonb, 'seed'), -- BR-ID-04 细则
  -- 第 2 批：b2-40
  ('couli', 'rebate.pdd.compare_precheck.enabled', 'false'::jsonb, 'seed'), -- BR-PRICE-07 细则
  ('couli', 'earnings.dashboard.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-25
  ('couli', 'earnings.dashboard.referral_visible', 'true'::jsonb, 'seed'), -- BR-FUND-25
  ('couli', 'withdraw.payout_account_verify_per_day', '3'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_inflight_timeout_sec', '60'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_recheck_minutes', '30'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_reuse_hours', '24'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'order.user_query_months', '0'::jsonb, 'seed'), -- BR-ID-30 细则
  ('couli', 'push.token_conflict_window_hours', '24'::jsonb, 'seed'), -- BR-ID-07 细则
  -- 第 3 批：b3-39
  ('couli', 'external_hosts', '[]'::jsonb, 'seed'), -- BR-ID-10 细则
  ('couli', 'app_update.recheck_interval_sec', '1800'::jsonb, 'seed'), -- BR-ID-01 细则
  -- 第 4 批：b4-32
  ('couli', 'risk.merge_tombstone_dedupe', 'true'::jsonb, 'seed'), -- BR-ID-05、BR-ID-37 引用 08 §13.2 第 4 批行
  ('couli', 'attr.track_complete_tolerance_sec', '120'::jsonb, 'seed'), -- BR-ATTR-21 细则
  -- 资金规则对齐：fa-24
  ('couli', 'settle.estimate_change_diff.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-01 R9b
  ('couli', 'settle.adjust.void_on_clawback.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-09
  ('couli', 'order_sync.regression_hold.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-01 P10
  ('couli', 'order_sync.unmapped_status_hold.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-02
  ('couli', 'ledger.bad_debt_require_no_frozen.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-12
  ('couli', 'payout.proven_success_writeoff.enabled', 'true'::jsonb, 'seed'), -- BR-WDR-08、BR-WDR-17
  -- 第 5 批：BR-FUND-04 细则默认值表（SPEC_REF 5ecafb3）
  ('couli', 'settle.bill_day', '24'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_basis.taobao', '"received_at"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_basis.jd', '"received_at"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_basis.pdd', '"received_at"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_basis.meituan', '"received_at"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.statement_source.taobao', '"api"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.statement_source.jd', '"api"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.statement_source.pdd', '"api"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.statement_source.meituan', '"api"'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.batch.match_tolerance_fen', '0'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.batch.max_orders', '5000'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_offset_months.taobao', '1'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_offset_months.jd', '1'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_offset_months.pdd', '1'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.period_offset_months.meituan', '1'::jsonb, 'seed'), -- BR-FUND-04 细则
  ('couli', 'settle.statement.grace_days', '10'::jsonb, 'seed'), -- BR-FUND-04 细则
  -- 第 6 批：BR-INV-24 细则默认值（SPEC_REF 5ecafb3）；两个开关不进种子（缺行即默认 off）
  ('couli', 'growth.invite_reward.amount_fen', '1000'::jsonb, 'seed'), -- BR-INV-24
  ('couli', 'growth.invite_reward.daily_budget_fen', '0'::jsonb, 'seed'), -- BR-INV-24
  ('couli', 'growth.invite_reward.total_budget_fen', '0'::jsonb, 'seed'), -- BR-INV-24
  ('couli', 'growth.invite_reward.min_paid_fen', '0'::jsonb, 'seed'), -- BR-INV-24
  ('couli', 'growth.invite_reward.ip_window_hours', '24'::jsonb, 'seed'), -- BR-INV-24
  -- 第 7 批：BR-INV-24 细则资格有效期默认值（SPEC_REF ac4d993）
  ('couli', 'growth.invite_reward.eligibility_days', '30'::jsonb, 'seed'), -- BR-INV-24
  -- 第 8 批：BR-WDR-18 / 22 / 28 / 32 的 payout 进程参数默认值（B2-06b，D10-223 / D10-244 / D10-296；代理补全的默认，biz_scene 空串即未配置、fail-close）
  ('couli', 'payout.single_cap_fen', '500000'::jsonb, 'seed'), -- BR-WDR-18
  ('couli', 'payout.daily_cap_fen', '5000000'::jsonb, 'seed'), -- BR-WDR-18
  ('couli', 'payout.watermark_usable_bp', '9000'::jsonb, 'seed'), -- BR-WDR-18
  ('couli', 'payout.biz_scene', '""'::jsonb, 'seed'), -- BR-WDR-22
  ('couli', 'payout.query_schedule', '{"points_min": [1, 5, 30, 120], "interval_min": 120, "manual_after_min": 1440}'::jsonb, 'seed'), -- BR-WDR-28
  ('couli', 'payout.definite_fail_codes', '[]'::jsonb, 'seed'), -- BR-WDR-28
  ('couli', 'payout.payer_side_codes', '[]'::jsonb, 'seed'), -- BR-WDR-28
  ('couli', 'payout.query_status_map', '{"SUCCESS": "success"}'::jsonb, 'seed'), -- BR-WDR-28
  -- 第 9 批：BR-WDR-29 审核风险标签阈值默认值（B2-11a / B2-11z，D10-368）
  ('couli', 'risk.withdraw.invalid_ratio_bp', '3000'::jsonb, 'seed'), -- BR-WDR-29
  ('couli', 'risk.withdraw.invalid_min_count', '3'::jsonb, 'seed'), -- BR-WDR-29
  ('couli', 'risk.withdraw.high_commission_rate_bp', '5000'::jsonb, 'seed'), -- BR-WDR-29
  ('couli', 'risk.withdraw.high_commission_ratio_bp', '5000'::jsonb, 'seed'), -- BR-WDR-29
  ('couli', 'risk.withdraw.min_orders', '5'::jsonb, 'seed'), -- BR-WDR-29
  ('couli', 'risk.withdraw.withdraw_received_ratio_bp', '10000'::jsonb, 'seed'), -- BR-WDR-29
  -- 第 10 批：BR-WDR-30 细则自动到账规则组默认值（B2-11y，D10-373）；总开关 withdraw.auto_payout.enabled 是紧急开关，不在此
  ('couli', 'withdraw.auto_payout.max_amount_fen', '30000'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.window_start', '"09:00:00"'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.window_end', '"22:59:59"'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.window_limit_enabled', 'false'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.first_withdrawal_limit_enabled', 'false'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.frozen_balance_policy', '"no_auto"'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.same_day_policy', '"no_auto"'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.payee_daily_max_count', '1'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.payee_monthly_max_count', '2'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.user_daily_max_count', '1'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.user_monthly_max_count', '1'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.warn.high_commission_rate_bp', '10000'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.warn.high_commission_order_ratio_bp', '10000'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.warn.invalid_ratio_bp', '10000'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.warn.withdraw_received_ratio_bp', '0'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.platform_daily_max_fen', '200000'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'withdraw.auto_payout.risk_block_flags', '["same_device_multi_account", "had_negative", "recon_diff", "payee_prev_other_user", "risk_calc_failed"]'::jsonb, 'seed'), -- BR-WDR-30
  -- 第 11 批：BR-WDR-30 细则开启前置检查（B2-11dz，D10-392 / D10-394）；payout.auto_enable_check.recon_required_days 缺省不设（无种子行，即不满足）
  ('couli', 'payout.auto_enable_check.limits_supported', 'false'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'payout.auto_enable_check.status_codes_supported', 'false'::jsonb, 'seed'), -- BR-WDR-30
  ('couli', 'payout.auto_enable_check.bill_out_biz_no_supported', 'false'::jsonb, 'seed'), -- BR-WDR-30
  -- 第 12 批：热销榜服务端缓存时长（B1-28g，D10-419；规划/04 §10.1 服务端业务配置键，代理补全的默认、负责人 2026-10-05 确认）
  ('couli', 'rank.cache_ttl_seconds', '600'::jsonb, 'seed'), -- 规划/04 §10.1、规划/01 F-PROD-13
  -- 第 13 批：搜索热词与关键词直达（B1-05l，D10-419 (a)）；默认空列表 = 不展示热词、无直达，不编造热词
  ('couli', 'search.hot_words', '[]'::jsonb, 'seed'), -- D10-419 (a)
  ('couli', 'search.keyword_routes', '[]'::jsonb, 'seed'), -- D10-419 (a)
  -- 第 14 批：个人数据留存清理总开关与各表保留天数（B1-15zd，D10-454）；缺省取 08 现值
  ('couli', 'retention.purge.enabled', 'true'::jsonb, 'seed'), -- D10-454
  ('couli', 'retention.login_logs_days', '180'::jsonb, 'seed'), -- BR-ID-30 ⑥
  ('couli', 'retention.device_registrations_days', '180'::jsonb, 'seed'), -- BR-ID-30 ⑱
  ('couli', 'retention.sms_send_attempts_days', '190'::jsonb, 'seed'), -- BR-ID-30 ⑥
  ('couli', 'retention.inbox_messages_days', '180'::jsonb, 'seed'), -- BR-ID-30 ⑮
  ('couli', 'retention.notify_logs_days', '190'::jsonb, 'seed'), -- BR-ID-30 ⑯
  ('couli', 'retention.union_raw_payloads_days', '180'::jsonb, 'seed'), -- BR-ID-30 ⑦
  -- 第 15 批：BR-WDR-20 税配置（B2-08cz，D10-456 ④）；税率表到位前 method=none、tax_fen 记 0（拍板第二批 FUND-04），rate_bp 为 0、rate_table 为空档位
  ('couli', 'tax.SERVICE_FEE.method', '"none"'::jsonb, 'seed'), -- BR-WDR-20
  ('couli', 'tax.SERVICE_FEE.rate_bp', '0'::jsonb, 'seed'), -- BR-WDR-20
  ('couli', 'tax.SERVICE_FEE.rate_table', '[]'::jsonb, 'seed'), -- BR-WDR-20
  -- 第 16 批：商品池价格有效期与刷新间隔（B1-05s，D10-480）；feed.fallback_pool_id 缺省不设（无种子行，未配置时信息流联盟故障答空列表）
  ('couli', 'pool.max_age_sec', '7200'::jsonb, 'seed'), -- BR-PRICE-11
  ('couli', 'pool.refresh_interval_sec', '3600'::jsonb, 'seed'), -- BR-PRICE-11
  -- 第 17 批：旧号提现加验天数（B1-02zs，B1-02zp 前置）；0 = 关闭旧号加验，三端加验页上线后由负责人在后台改为 08 细则的 180
  ('couli', 'withdraw.dormant_reverify_days', '0'::jsonb, 'seed'), -- BR-WDR-01
  -- 第 18 批：商品反馈开关与每设备每日条数上限（B1-28q，D10-698）；默认开、每台设备每个 +08:00 自然日 20 条
  ('couli', 'feedback.enabled', 'true'::jsonb, 'seed'), -- 规划/01 F-PROD-15、04 §10.1 / §10.2
  ('couli', 'feedback.daily_limit_per_device', '20'::jsonb, 'seed'), -- BR-ID-02 细则「商品反馈与进店」
  -- 第 19 批：负余额坏账核销候选单的天数与金额阈值（B2-12e，D10-590）；90 天、0 分为占位值，上线前由超管在后台填写（拍板第二批 §8 ADD-03）
  ('couli', 'ledger.bad_debt_days', '90'::jsonb, 'seed'), -- BR-FUND-12
  ('couli', 'ledger.bad_debt_min_fen', '0'::jsonb, 'seed'), -- BR-FUND-12
  -- 第 20 批：进店来源（B1-05zi，D10-736）；只给淘宝 dataoke（大淘客店铺转链），京东、拼多多无种子（按未配置）
  ('couli', 'shop.entry.source.taobao', '"dataoke"'::jsonb, 'seed') -- BR-PRICE-21 细则「进店」、04 §10.1 / §11.2
ON CONFLICT (app_id, key) DO NOTHING;
