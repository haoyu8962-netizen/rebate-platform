// B1-12zc CLAWBACK render rules (BR-TEXT-09 表 l.600–602 与 l.611, BR-TEXT-05 原因标题, BR-TEXT-10 金额,
// 上级隐私 l.613; D10-773 ③⑤). Unit tests: no database. Expected texts are written out from the
// brief and 08, never from the code. Top-level it() only.
import { expect, it } from 'vitest';
import {
  renderClawbackMessage,
  type ClawbackFacts,
} from '../../../../apps/api/src/modules/notification/application/clawback-message.ts';
import { isLedger, orderDetail } from './routes.ts';

const ORDER_ID = '0190a6a0-0000-7000-8000-0000000000c1';

/** The R8 reasons of clawback-order.ts and their BR-TEXT-05 titles. */
const REASONS = {
  REFUND: '订单已退款或取消',
  RIGHTS: '发起售后维权，返利取消',
  PUNISH: '订单被联盟判定违规',
  COMMISSION_ZERO: '返利已取消',
} as const;

/** 320 fen clawed back: {amount} = -¥3.2. */
function facts(patch: Partial<ClawbackFacts>): ClawbackFacts {
  return { order_id: ORDER_ID, role: 'self', clawback_fen: 320n, reason: 'REFUND', ...patch };
}

it.each(Object.entries(REASONS))(
  '[AC-B1-12zc#1] 自购 / 原因 %s → CLAWBACK self「订单返利已扣回 {amount}：{reason.title}」，标题「返利扣回」，服务类，跳订单详情',
  (reason, title) => {
    expect(renderClawbackMessage(facts({ role: 'self', reason }), null)).toStrictEqual({
      code: 'CLAWBACK',
      variant: 'self',
      category: 'service',
      title: '返利扣回',
      body: `订单返利已扣回 -¥3.2：${title}`,
      route: orderDetail(ORDER_ID),
    });
  },
);

it.each(Object.entries(REASONS))(
  '[AC-B1-12zc#2] 分享 / 原因 %s → CLAWBACK share「一笔分享订单的推广收益已扣回 {amount}：{reason.title}」，标题「推广收益扣回」，跳订单详情',
  (reason, title) => {
    expect(renderClawbackMessage(facts({ role: 'share', reason }), null)).toStrictEqual({
      code: 'CLAWBACK',
      variant: 'share',
      category: 'service',
      title: '推广收益扣回',
      body: `一笔分享订单的推广收益已扣回 -¥3.2：${title}`,
      route: orderDetail(ORDER_ID),
    });
  },
);

it.each([
  ['direct', 'REFUND'],
  ['indirect', 'RIGHTS'],
  ['direct', null],
  ['indirect', 'PUNISH'],
] as const)(
  '[AC-B1-12zc#3] 上级 %s（原因 %s）→ CLAWBACK invite「一笔邀请订单的推广收益已扣回 {amount}」：不带原因（J7），标题「推广收益扣回」，跳余额流水不跳订单',
  (role, reason) => {
    const message = renderClawbackMessage(facts({ role, reason }), null);
    expect(message).toMatchObject({
      code: 'CLAWBACK',
      variant: 'invite',
      category: 'service',
      title: '推广收益扣回',
      body: '一笔邀请订单的推广收益已扣回 -¥3.2',
    });
    expect(isLedger(message?.route)).toBe(true);
    expect(JSON.stringify(message)).not.toContain(ORDER_ID);
    for (const title of Object.values(REASONS)) expect(message?.body).not.toContain(title);
  },
);

it.each([
  [1n, '-¥0.01'],
  [10n, '-¥0.1'],
  [320n, '-¥3.2'],
  [990n, '-¥9.9'],
  [1000n, '-¥10'],
  [123456n, '-¥1234.56'],
  [9007199254740993n, '-¥90071992547409.93'],
] as const)(
  '[AC-B1-12zc#4] 扣回 %s 分的 {amount} 按 BR-TEXT-10 负值格式为 %s（自购、分享、邀请同一格式）',
  (clawback_fen, yuan) => {
    const bodies = (['self', 'share', 'direct'] as const).map(
      (role) => renderClawbackMessage(facts({ role, clawback_fen }), null)?.body,
    );
    expect(bodies).toEqual([
      `订单返利已扣回 ${yuan}：订单已退款或取消`,
      `一笔分享订单的推广收益已扣回 ${yuan}：订单已退款或取消`,
      `一笔邀请订单的推广收益已扣回 ${yuan}`,
    ]);
  },
);

it.each([
  {
    label: 'self 只覆盖标题',
    input: facts({ role: 'self', reason: 'RIGHTS' }),
    override: { title_override: '扣回提醒', body_override: null },
    title: '扣回提醒',
    body: '订单返利已扣回 -¥3.2：发起售后维权，返利取消',
  },
  {
    label: 'invite 覆盖正文并替换 {amount}',
    input: facts({ role: 'indirect', reason: 'REFUND' }),
    override: { title_override: null, body_override: '收益调整 {amount}，再说一次 {amount}' },
    title: '推广收益扣回',
    body: '收益调整 -¥3.2，再说一次 -¥3.2',
  },
  {
    label: 'share 两项都覆盖',
    input: facts({ role: 'share', reason: 'PUNISH' }),
    override: { title_override: '分享收益变动', body_override: '扣回 {amount}' },
    title: '分享收益变动',
    body: '扣回 -¥3.2',
  },
  {
    label: '两项覆盖都为空回退包内默认',
    input: facts({ role: 'direct', reason: 'REFUND' }),
    override: { title_override: null, body_override: null },
    title: '推广收益扣回',
    body: '一笔邀请订单的推广收益已扣回 -¥3.2',
  },
])('[AC-B1-12zc#5] 标题与正文分别覆盖、分别回退：$label', ({ input, override, title, body }) => {
  expect(renderClawbackMessage(input, override)).toMatchObject({
    code: 'CLAWBACK',
    category: 'service',
    title,
    body,
  });
});

it('[AC-B1-12zc#6] 跳转按角色：自购与分享到本订单详情，直推与间推到余额流水；覆盖模板不改跳转', () => {
  const override = { title_override: '标题', body_override: '正文 {amount}' };
  const routes = (['self', 'share', 'direct', 'indirect'] as const).map(
    (role) => renderClawbackMessage(facts({ role }), override)?.route,
  );
  expect(routes.slice(0, 2)).toStrictEqual([orderDetail(ORDER_ID), orderDetail(ORDER_ID)]);
  expect(routes.slice(2).map(isLedger)).toEqual([true, true]);
});
