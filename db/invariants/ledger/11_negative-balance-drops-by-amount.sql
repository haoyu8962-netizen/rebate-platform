-- BR-FUND-19 ⑦ 账户级（替换 07，输出编号仍为 07）：用户账户里一张凭证使某子户余额下降且结果为负时，
-- 该凭证在这个子户的第一条分录，其 ledger_type 属于 {CLAWBACK, SETTLE_ADJUST, ADMIN_ADJUST}，或属于改派
-- 红冲凭证（uniq_key 含 :REASSIGN_REV:，迁移 R14：红冲沿用原流水类型，按凭证键识别）。
-- 任务 B2-02zb。只读，一条 SELECT，检查全量历史。
--
-- 为什么换版（07 → 11）
-- - 07 用 LAG 把本条 balance_after_fen 与前一条比。balance_after_fen 取自过账时的余额缓存；缓存按分录
--   重算（下调）后，下一笔正常入账以新缓存为底，会低于以旧缓存为底的前一条，07 误判为「下降」；
--   重算上调后真正的扣款反而可能高于前一条而漏报。07 查全量历史，误报此后每天再现。
-- - 11 的「下降」只看本凭证自己的分录：同一 (app_id, 账户, 子户, 凭证) 的 amount_fen 合计 > 0
--   （用户账户是负债户，余额随 −amount_fen 变动，合计 > 0 即余额下降）。不再与缓存派生的值比。
--
-- 口径（与 07 逐行等价：无重算历史时，同凭证同子户各条的 balance_after_fen 相同，且等于前一凭证的值
-- 减本凭证净额，所以 07 恰报每组按 (account_version, id) 排第一的那条）
-- - 只看用户账户（owner_type = user）上写了 balance_after_fen 的分录，平台账户不参与。
-- - 分组 = 同一 (app_id, 账户, 子户, 凭证)；只报组内按 (account_version, id) 排第一的那条。
-- - 下降 = 组内 amount_fen 合计 > 0；净额为 0、余额回升都不算。结果为负 = 该条 balance_after_fen < 0
--   （降到 0 不算）。首笔即为负同样要查。
-- - 白名单类型与改派红冲豁免都作用在报出的那一条上；改派红冲只认 uniq_key 里的 :REASSIGN_REV: 片段
--   （strpos 精确匹配，不用 LIKE），sub_type 或 voucher_kind 写成 REASSIGN_REV 都不算。
-- - detail 形状、字段与 07 相同（previous_balance_after_fen 仍是同子户前一条的值，仅作参考，不参与判断）；
--   金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 参与核对的用户分录条数（同 07）。
WITH user_entries AS (
  SELECT
    e.app_id,
    e.account_id,
    e.id AS entry_id,
    e.voucher_id,
    e.sub_account,
    e.ledger_type,
    e.sub_type,
    e.account_version,
    e.amount_fen,
    e.balance_after_fen,
    LAG(e.balance_after_fen) OVER (
      PARTITION BY e.app_id, e.account_id, e.sub_account
      ORDER BY e.account_version, e.id
    ) AS previous_balance_after_fen,
    row_number() OVER (
      PARTITION BY e.app_id, e.account_id, e.sub_account, e.voucher_id
      ORDER BY e.account_version, e.id
    ) AS position_in_voucher,
    sum(e.amount_fen) OVER (
      PARTITION BY e.app_id, e.account_id, e.sub_account, e.voucher_id
    ) AS voucher_amount_fen
  FROM app.ledger_entries e
  JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  WHERE a.owner_type = 'user'
    AND e.balance_after_fen IS NOT NULL
),
differences AS (
  SELECT
    ue.app_id,
    ue.account_id,
    jsonb_build_object(
      'entry_id', ue.entry_id::text,
      'voucher_id', ue.voucher_id::text,
      'uniq_key', v.uniq_key,
      'ledger_type', ue.ledger_type,
      'sub_type', ue.sub_type,
      'sub_account', ue.sub_account,
      'account_version', ue.account_version::text,
      'has_previous', ue.previous_balance_after_fen IS NOT NULL,
      'previous_balance_after_fen', COALESCE(ue.previous_balance_after_fen, 0)::text,
      'balance_after_fen', ue.balance_after_fen::text,
      'allowed_ledger_types', jsonb_build_array('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    ) AS detail
  FROM user_entries ue
  JOIN app.ledger_vouchers v ON v.app_id = ue.app_id AND v.id = ue.voucher_id
  WHERE ue.position_in_voucher = 1
    AND ue.voucher_amount_fen > 0
    AND ue.balance_after_fen < 0
    AND ue.ledger_type NOT IN ('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    AND strpos(v.uniq_key, ':REASSIGN_REV:') = 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM user_entries
)
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'account'::text AS scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
