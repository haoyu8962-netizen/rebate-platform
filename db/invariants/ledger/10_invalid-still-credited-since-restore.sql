-- BR-FUND-19 ⑧ 账户级（恢复截断版，替代 08_invalid-still-credited.sql，输出编号仍为 08）：
-- platform_status = INVALID，或存在最后一次平台恢复之后才成功的 INVALID_AFTER_SETTLE 维权、
-- 但 rebate_status 仍为 CREDITED 的子订单数 = 0。
-- 任务 B2-04zzr（编排 D10-1126 ②、D10-1134 (3)）。只读，一条 SELECT。由 ledger 日终运行器按目录执行
-- （superseded.json 登记旧 08 由本文件替代）；读 orders、order_rights、order_status_history、
-- commission_splits 等跨模块表是 BR-FUND-19 日终复核本意（编排 S13 唯一例外，只读）。
--
-- 口径（除恢复截断外与旧 08 相同）
-- - 候选：app.orders 中 rebate_status = CREDITED 的子订单（CLAWED_BACK、VOID 等不是本条对象）；
--   checked_rows = 候选子订单数（不被维权、受益人、账户、历史连接倍增）。
-- - 最后一次恢复：该单 app.order_status_history 中 field = 'rebate'、event = 'ADMIN_RESTORE'、
--   from_status IN ('VOID', 'CLAWED_BACK')（R12 / R13）的 max(at)；没有这样的行即从未恢复。
--   不按 RESTORE 凭证、审计或差错单取恢复（账户申诉恢复也写这类凭证，但不写历史行）。
-- - 成功维权：同 app_id、同 order_id、type = INVALID_AFTER_SETTLE 且 status = SUCCEEDED 的
--   order_rights；其「变为成功的时刻」取 updated_at（直接以 SUCCEEDED 写入的行 updated_at =
--   created_at），不按 occurred_at。有过恢复的单只计 updated_at >= 最后一次恢复（同一时刻也计）的
--   成功维权；从未恢复的单全部计入。处理中、待佣金、失败，以及 RIGHTS、PUNISH、REFUND_AFTER_SETTLE
--   等其他类型都不算；不用 orders.rights_pending 代替。多条成功维权只算一个差异子订单。
-- - 差异子订单：候选中 platform_status = INVALID（这一支不受恢复截断），或计入的成功维权 > 0。
-- - 状态是当前值，不按会计日截断，核对日 couli.check_date 不参与本条。
-- - 定位（细则 ⑧ 例：冻结该单全部受益人提现）：该单受益人 = commission_splits.beneficiaries 快照里
--   的全部 user_id ∪ 该单 (app_id, order_key = platform || ':' || sub_order_id) 凭证上的
--   beneficiary_user_id ∪ orders.user_id，去重；按同 app_id 的用户账户（owner_type = user，
--   subject = USER_BALANCE，owner_id = user_id）定位。每个 (差异子订单, 用户账户) 一行 account
--   差异；同一用户多个角色只出一行。
-- - 一个受益人都定位不到用户账户的差异子订单：按 global 差异报出（detail.reasons 含
--   no_beneficiary_account）；能定位部分账户时，未定位的用户列在 detail.unlocated_user_ids。
-- - detail 写子订单、平台状态、原因、计入的成功维权条数与受益人列表；计数写成文本。
WITH credited AS (
  SELECT
    o.app_id,
    o.order_id,
    o.platform || ':' || o.sub_order_id AS order_key,
    o.platform_status,
    o.rebate_status,
    o.user_id
  FROM app.orders o
  WHERE o.rebate_status = 'CREDITED'
),
last_restores AS (
  SELECT
    h.app_id,
    h.order_id,
    max(h.at) AS restored_at
  FROM app.order_status_history h
  WHERE h.field = 'rebate'
    AND h.event = 'ADMIN_RESTORE'
    AND h.from_status IN ('VOID', 'CLAWED_BACK')
  GROUP BY h.app_id, h.order_id
),
succeeded_rights AS (
  SELECT
    r.app_id,
    r.order_id,
    count(*) AS rights
  FROM app.order_rights r
  LEFT JOIN last_restores lr
    ON lr.app_id = r.app_id
    AND lr.order_id = r.order_id
  WHERE r.type = 'INVALID_AFTER_SETTLE'
    AND r.status = 'SUCCEEDED'
    AND (lr.restored_at IS NULL OR r.updated_at >= lr.restored_at)
  GROUP BY r.app_id, r.order_id
),
bad_orders AS (
  SELECT
    c.app_id,
    c.order_id,
    c.order_key,
    c.platform_status,
    c.rebate_status,
    c.user_id,
    COALESCE(sr.rights, 0) AS succeeded_rights,
    (c.platform_status = 'INVALID') AS platform_invalid
  FROM credited c
  LEFT JOIN succeeded_rights sr
    ON sr.app_id = c.app_id
    AND sr.order_id = c.order_id
  WHERE c.platform_status = 'INVALID'
    OR sr.rights > 0
),
bad_users AS (
  SELECT DISTINCT
    b.app_id,
    b.order_id,
    u.user_id
  FROM bad_orders b
  CROSS JOIN LATERAL (
    SELECT b.user_id::text AS user_id
    WHERE b.user_id IS NOT NULL
    UNION
    SELECT lower(item ->> 'user_id') AS user_id
    FROM app.commission_splits s
    CROSS JOIN LATERAL jsonb_array_elements(s.beneficiaries) AS i (item)
    WHERE s.app_id = b.app_id
      AND s.order_id = b.order_id
      AND item ->> 'user_id' IS NOT NULL
    UNION
    SELECT v.beneficiary_user_id::text AS user_id
    FROM app.ledger_vouchers v
    WHERE v.app_id = b.app_id
      AND v.order_key = b.order_key
      AND v.beneficiary_user_id IS NOT NULL
  ) u
),
located AS (
  SELECT
    bu.app_id,
    bu.order_id,
    bu.user_id,
    a.id AS account_id
  FROM bad_users bu
  LEFT JOIN app.ledger_accounts a
    ON a.app_id = bu.app_id
    AND a.owner_type = 'user'
    AND a.subject = 'USER_BALANCE'
    AND a.owner_id = bu.user_id
),
order_people AS (
  SELECT
    b.app_id,
    b.order_id,
    COALESCE(
      jsonb_agg(l.user_id ORDER BY l.user_id) FILTER (WHERE l.user_id IS NOT NULL),
      '[]'::jsonb
    ) AS beneficiary_user_ids,
    COALESCE(
      jsonb_agg(l.user_id ORDER BY l.user_id)
        FILTER (WHERE l.user_id IS NOT NULL AND l.account_id IS NULL),
      '[]'::jsonb
    ) AS unlocated_user_ids,
    count(l.account_id) AS located_accounts
  FROM bad_orders b
  LEFT JOIN located l
    ON l.app_id = b.app_id
    AND l.order_id = b.order_id
  GROUP BY b.app_id, b.order_id
),
order_details AS (
  SELECT
    b.app_id,
    b.order_id,
    op.located_accounts,
    jsonb_build_object(
      'order_id', b.order_id::text,
      'order_key', b.order_key,
      'platform_status', b.platform_status,
      'rebate_status', b.rebate_status,
      'reasons', (
        SELECT COALESCE(jsonb_agg(reason.label ORDER BY reason.ord), '[]'::jsonb)
        FROM (
          VALUES
            (1, 'platform_invalid', b.platform_invalid),
            (2, 'invalid_after_settle_succeeded', b.succeeded_rights > 0),
            (3, 'no_beneficiary_account', op.located_accounts = 0)
        ) AS reason (ord, label, hit)
        WHERE reason.hit
      ),
      'succeeded_invalid_after_settle_rights', b.succeeded_rights::text,
      'beneficiary_user_ids', op.beneficiary_user_ids,
      'unlocated_user_ids', op.unlocated_user_ids
    ) AS detail
  FROM bad_orders b
  JOIN order_people op
    ON op.app_id = b.app_id
    AND op.order_id = b.order_id
),
differences AS (
  SELECT DISTINCT
    'account'::text AS scope,
    od.app_id,
    l.account_id,
    od.detail || jsonb_build_object('user_id', l.user_id) AS detail
  FROM order_details od
  JOIN located l
    ON l.app_id = od.app_id
    AND l.order_id = od.order_id
  WHERE l.account_id IS NOT NULL
  UNION ALL
  SELECT
    'global'::text AS scope,
    od.app_id,
    NULL::uuid AS account_id,
    od.detail
  FROM order_details od
  WHERE od.located_accounts = 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM credited
)
SELECT
  '08'::text AS invariant,
  st.checked_rows,
  df.scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '08'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
