// B1-12zc SETTLE_ADJUSTED render rules (D10-773 ②④⑤⑥; BR-TEXT-05 原因标题, BR-TEXT-10 金额,
// BR-TEXT-09 上级隐私, BR-FUND-09 细则「补差负向时发站内信并附原因」). Unit tests: no database.
// Expected texts are written out from the brief and 08, never from the code. Top-level it() only.
import { expect, it } from 'vitest';
import { definitionOf } from '../../../../apps/api/src/modules/notification/admin-channels/catalog.ts';
import {
  renderSettleAdjustedMessage,
  type SettleAdjustedFacts,
} from '../../../../apps/api/src/modules/notification/application/clawback-message.ts';
import { isLedger, orderDetail } from '../clawback-message/routes.ts';

const ORDER_ID = '0190a6a0-0000-7000-8000-0000000000d2';

/** sub_type → BR-TEXT-05 order_reason.<CODE>.title (08 l.447–449). */
const SUB_TYPES = {
  SETTLE_DIFF: '结算金额调整',
  PRICE_PROTECT: '商家价保退差',
  PRICE_COMPARE: '比价订单',
} as const;

/** A decrease of 320 fen booked to the available balance: {amount} = ¥3.2. */
function facts(patch: Partial<SettleAdjustedFacts>): SettleAdjustedFacts {
  return {
    order_id: ORDER_ID,
    role: 'self',
    adjust_fen: -320n,
    bucket: 'user_available',
    sub_type: 'SETTLE_DIFF',
    ...patch,
  };
}

it.each(Object.entries(SUB_TYPES))(
  '[AC-B1-12zc#30] 自购 / %s 负差 → SETTLE_ADJUSTED self「订单返利已按结算金额调整，减少 {amount}：{reason.title}」，标题「返利已调整」，服务类，跳订单详情',
  (sub_type, title) => {
    expect(renderSettleAdjustedMessage(facts({ role: 'self', sub_type }), null)).toStrictEqual({
      code: 'SETTLE_ADJUSTED',
      variant: 'self',
      category: 'service',
      title: '返利已调整',
      body: `订单返利已按结算金额调整，减少 ¥3.2：${title}`,
      route: orderDetail(ORDER_ID),
    });
  },
);

it.each(Object.entries(SUB_TYPES))(
  '[AC-B1-12zc#31] 分享 / %s 负差 → SETTLE_ADJUSTED share「一笔分享订单的推广收益已按结算金额调整，减少 {amount}：{reason.title}」，标题「推广收益已调整」，跳订单详情',
  (sub_type, title) => {
    expect(renderSettleAdjustedMessage(facts({ role: 'share', sub_type }), null)).toStrictEqual({
      code: 'SETTLE_ADJUSTED',
      variant: 'share',
      category: 'service',
      title: '推广收益已调整',
      body: `一笔分享订单的推广收益已按结算金额调整，减少 ¥3.2：${title}`,
      route: orderDetail(ORDER_ID),
    });
  },
);

it.each([
  ['direct', 'SETTLE_DIFF'],
  ['indirect', 'PRICE_PROTECT'],
  ['direct', 'PRICE_COMPARE'],
] as const)(
  '[AC-B1-12zc#32] 上级 %s（%s）→ SETTLE_ADJUSTED invite「一笔邀请奖励已按结算金额调整，减少 {amount}」：不带原因（J7），标题「邀请奖励已调整」，跳余额流水不跳订单',
  (role, sub_type) => {
    const message = renderSettleAdjustedMessage(facts({ role, sub_type }), null);
    expect(message).toMatchObject({
      code: 'SETTLE_ADJUSTED',
      variant: 'invite',
      category: 'service',
      title: '邀请奖励已调整',
      body: '一笔邀请奖励已按结算金额调整，减少 ¥3.2',
    });
    expect(isLedger(message?.route)).toBe(true);
    expect(JSON.stringify(message)).not.toContain(ORDER_ID);
    for (const title of Object.values(SUB_TYPES)) expect(message?.body).not.toContain(`：${title}`);
  },
);

it.each([
  [-1n, '¥0.01'],
  [-10n, '¥0.1'],
  [-320n, '¥3.2'],
  [-990n, '¥9.9'],
  [-1000n, '¥10'],
  [-123456n, '¥1234.56'],
  [-9007199254740993n, '¥90071992547409.93'],
] as const)(
  '[AC-B1-12zc#33] 调减 %s 分的 {amount} 取绝对值按 BR-TEXT-10 格式为 %s（写「减少 ¥x」，不写「减少 -¥x」）',
  (adjust_fen, yuan) => {
    const bodies = (['self', 'share', 'indirect'] as const).map(
      (role) => renderSettleAdjustedMessage(facts({ role, adjust_fen }), null)?.body,
    );
    expect(bodies).toEqual([
      `订单返利已按结算金额调整，减少 ${yuan}：结算金额调整`,
      `一笔分享订单的推广收益已按结算金额调整，减少 ${yuan}：结算金额调整`,
      `一笔邀请奖励已按结算金额调整，减少 ${yuan}`,
    ]);
    for (const body of bodies) expect(body).not.toContain('-¥');
  },
);

it.each([0n, 1n, 320n, 9007199254740993n])(
  '[AC-B1-12zc#34] 正向补差与零（adjust_fen = %s）不发：四种角色都无消息，即使给了覆盖模板',
  (adjust_fen) => {
    const override = { title_override: '覆盖标题', body_override: '覆盖正文 {amount}' };
    const seen = (['self', 'share', 'direct', 'indirect'] as const).map((role) => [
      renderSettleAdjustedMessage(facts({ role, adjust_fen }), null),
      renderSettleAdjustedMessage(facts({ role, adjust_fen }), override),
    ]);
    expect(seen).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
  },
);

it.each(['bad_debt', 'platform', 'USER_AVAILABLE', ''])(
  '[AC-B1-12zc#35] 负差但 bucket = %s（不是 user_available：坏账、平台侧等）不发',
  (bucket) => {
    const seen = (['self', 'share', 'direct', 'indirect'] as const).map((role) =>
      renderSettleAdjustedMessage(facts({ role, bucket }), null),
    );
    expect(seen).toEqual([null, null, null, null]);
  },
);

it.each([
  {
    label: 'self 只覆盖标题',
    input: facts({ role: 'self', sub_type: 'PRICE_PROTECT' }),
    override: { title_override: '返利变动', body_override: null },
    title: '返利变动',
    body: '订单返利已按结算金额调整，减少 ¥3.2：商家价保退差',
  },
  {
    label: 'invite 覆盖正文并替换 {amount}（绝对值）',
    input: facts({ role: 'direct' }),
    override: { title_override: null, body_override: '奖励减少 {amount}，再说一次 {amount}' },
    title: '邀请奖励已调整',
    body: '奖励减少 ¥3.2，再说一次 ¥3.2',
  },
  {
    label: 'share 两项都覆盖',
    input: facts({ role: 'share', sub_type: 'PRICE_COMPARE' }),
    override: { title_override: '分享收益变动', body_override: '减少 {amount}' },
    title: '分享收益变动',
    body: '减少 ¥3.2',
  },
  {
    label: '两项覆盖都为空回退包内默认',
    input: facts({ role: 'indirect' }),
    override: { title_override: null, body_override: null },
    title: '邀请奖励已调整',
    body: '一笔邀请奖励已按结算金额调整，减少 ¥3.2',
  },
])('[AC-B1-12zc#36] 标题与正文分别覆盖、分别回退：$label', ({ input, override, title, body }) => {
  expect(renderSettleAdjustedMessage(input, override)).toMatchObject({
    code: 'SETTLE_ADJUSTED',
    category: 'service',
    title,
    body,
  });
});

it('[AC-B1-12zc#37] 后台渠道目录加 SETTLE_ADJUSTED：默认推送 + 站内、可开关（不是只发站内）、无固定短信，变体 self / share / invite 的变量与 CLAWBACK 同形；CLAWBACK 原样不变', () => {
  const clawback = {
    defaultChannels: ['push', 'inbox'],
    variables: { self: ['amount', 'reason'], share: ['amount', 'reason'], invite: ['amount'] },
  };
  expect({
    SETTLE_ADJUSTED: definitionOf('SETTLE_ADJUSTED'),
    CLAWBACK: definitionOf('CLAWBACK'),
  }).toStrictEqual({ SETTLE_ADJUSTED: clawback, CLAWBACK: clawback });
});
