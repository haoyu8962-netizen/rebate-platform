// 'rights.window' / 'punish.window' 处理器（任务书第 9 节第 2、4、5、8 条；08 BR-FUND-06 / 08）。写入只经
// 写入方（application/rights-sync.ts 的 createRightsSyncWriter：找单 → 锁 → 重读 → settlement 的
// rights.record，见 writer.int.test.ts）；这里钉交给它的参数：
// - 维权：type RIGHTS，platform_rights_no = 维权单号，应扣佣金 deduction_commission_fen = refund_fen，
//   amount_fen 不取（null），occurred_at = 维权创建时间（缺失取注入时钟）；状态 PROCESSING / SUCCEEDED /
//   FAILED 原样，CLOSED_NO_CHARGE（14 / 15，结束且不扣我方）记 FAILED 并计数进日志；未知状态不写、计数进
//   warn 级日志，不当成功。
// - 违规：type PUNISH，status SUCCEEDED，platform_rights_no = 违规单号，occurred_at = 同步时刻（D10-645 ③）。
// - 对不上订单（别家推广位）只计数：不抛错、不进死信，日志不带单号；重放由去重键兜底，duplicate 不是失败。
// - 维权窗做完全部页才推一次水位（窗口自己的流）；违规不推水位。门控：可查账号、站点授权。
import { expect, it } from 'vitest';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import {
  handlePunishWindow,
  handleRightsWindow,
} from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionRefund } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  APP,
  NOW,
  NOW_MS,
  HOUR_MS,
  OTHER_ACCOUNT,
  PUNISH_JOB,
  RIGHTS_JOB,
  fixture,
  iso,
  job,
  loggedValues,
  printed,
  punishWindow,
  punishment,
  refund,
  rightsWindow,
  type Fixture,
} from './kit.ts';

const START = iso(NOW_MS - 10 * HOUR_MS);
const WINDOW = rightsWindow(START);

function targetOf(r: { readonly order_id: string }) {
  return { app_id: APP, platform: 'taobao', sub_order_id: r.order_id };
}

/** Values of a counter field in the info / warn lines (which level is the implementation's). */
function counted(f: Fixture, field: string): unknown[] {
  return [...loggedValues(f.logger.info, field), ...loggedValues(f.logger.warn, field)];
}

/** A refund without the rights_status member at all. */
function withoutStatus(index: number): UnionRefund {
  const kept = Object.entries(refund(index)).filter(([key]) => key !== 'rights_status');
  return Object.fromEntries(kept) as unknown as UnionRefund;
}

it('[AC-B1-04zza#21] rights.window 取完全部页（按更新时间、配额 order_sync），每条维权按 rights.record 的参数交给写入方', async () => {
  const first = refund(1);
  const second = refund(2, { rights_status: 'SUCCEEDED', refund_status: '12', refund_fen: 150n });
  const third = refund(3, { rights_status: 'PROCESSING', refund_status: '11', refund_fen: 0n });
  const f = fixture({ refundPages: [[first, second], [third]] });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);

  expect(f.listRefunds).toHaveBeenCalledTimes(2);
  const [win, ctx, opt] = f.listRefunds.mock.calls[0]!;
  expect(win).toEqual({ from: WINDOW.window_start, to: WINDOW.window_end });
  expect(ctx).toMatchObject({ appId: APP, purpose: 'order_sync' });
  expect(opt?.timeBasis ?? 'update').toBe('update');
  expect(opt?.cursor).toBeUndefined();
  expect(f.listRefunds.mock.calls[1]![2]).toMatchObject({ cursor: 'page-1' });
  expect(f.listRefunds.mock.calls[1]![0]).toEqual(win);

  expect(f.writes()).toEqual([
    {
      target: targetOf(first),
      item: {
        type: 'RIGHTS',
        status: 'PROCESSING',
        amount_fen: null,
        deduction_commission_fen: 71n,
        occurred_at: first.refund_created_at,
        platform_rights_no: first.refund_id,
      },
    },
    {
      target: targetOf(second),
      item: {
        type: 'RIGHTS',
        status: 'SUCCEEDED',
        amount_fen: null,
        deduction_commission_fen: 150n,
        occurred_at: second.refund_created_at,
        platform_rights_no: second.refund_id,
      },
    },
    {
      target: targetOf(third),
      item: {
        type: 'RIGHTS',
        status: 'PROCESSING',
        amount_fen: null,
        deduction_commission_fen: 0n,
        occurred_at: third.refund_created_at,
        platform_rights_no: third.refund_id,
      },
    },
  ]);
  expect(f.advance).toHaveBeenCalledTimes(1);
  expect(f.advance).toHaveBeenCalledWith(WINDOW);
});

it.each([
  ['PROCESSING', 'PROCESSING'],
  ['SUCCEEDED', 'SUCCEEDED'],
  ['FAILED', 'FAILED'],
  ['CLOSED_NO_CHARGE', 'FAILED'],
] as const)('[AC-B1-04zza#22] 维权状态 %s 交给 rights.record 记 %s', async (state, status) => {
  const r = refund(1, { rights_status: state });
  const f = fixture({ refundPages: [[r]] });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]).toMatchObject({
    target: targetOf(r),
    item: { type: 'RIGHTS', status, platform_rights_no: r.refund_id },
  });
});

it('[AC-B1-04zza#23] 14 / 15 结束且不扣我方：记 FAILED（解除维权中、不扣回），个数进日志；同一维权之后变 12 / 13 照 SUCCEEDED', async () => {
  const closed = refund(1, { rights_status: 'CLOSED_NO_CHARGE', refund_status: '14' });
  const alsoClosed = refund(2, { rights_status: 'CLOSED_NO_CHARGE', refund_status: '15' });
  const f = fixture({ refundPages: [[closed, alsoClosed]] });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);
  expect(f.writes().map((w) => w.item.status)).toEqual(['FAILED', 'FAILED']);
  expect(counted(f, 'closed_no_charge')).toContain(2);

  const later = refund(1, { rights_status: 'SUCCEEDED', refund_status: '13' });
  const g = fixture({ refundPages: [[later]] });
  await handleRightsWindow(job(RIGHTS_JOB, rightsWindow(WINDOW.window_end)), g.handler);
  expect(g.writes()).toEqual([
    {
      target: targetOf(later),
      item: expect.objectContaining({
        type: 'RIGHTS',
        status: 'SUCCEEDED',
        platform_rights_no: closed.refund_id,
      }),
    },
  ]);
});

it('[AC-B1-04zza#24] 状态缺失或未知的维权不当成功：不写，个数进日志，其余照写，窗口照常推进', async () => {
  const known = refund(3, { rights_status: 'SUCCEEDED', refund_status: '2' });
  const f = fixture({
    refundPages: [
      [refund(1, { rights_status: null, refund_status: '99' }), withoutStatus(2), known],
    ],
  });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]?.item).toMatchObject({
    status: 'SUCCEEDED',
    platform_rights_no: known.refund_id,
  });
  expect(
    f
      .writes()
      .some((w) => w.item.status === 'SUCCEEDED' && w.target.sub_order_id !== known.order_id),
  ).toBe(false);
  // 未知状态是要人看的异常：计数只认 warn 级（评审 r1 S2，不接受 info）。
  expect(loggedValues(f.logger.warn, 'unknown_status')).toContain(2);
  expect(f.advance).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zza#25] 没有维权创建时间的维权：发生时间取注入时钟', async () => {
  const r = refund(1, { refund_created_at: null });
  const f = fixture({ refundPages: [[r]] });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);
  expect(f.writes()[0]?.item.occurred_at).toEqual(new Date(NOW));
});

it('[AC-B1-04zza#26] 对不上订单（别家推广位）：只计数，不抛错，不当失败；日志不带订单号与维权单号；窗口照常推进', async () => {
  const foreign = refund(1);
  const ours = refund(2, { rights_status: 'SUCCEEDED' });
  const f = fixture({ refundPages: [[foreign, ours]] });
  f.write.mockImplementation(async (target) =>
    target.sub_order_id === foreign.order_id ? { kind: 'not_found' } : { kind: 'applied' },
  );
  await expect(handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler)).resolves.toBeUndefined();
  expect(f.write).toHaveBeenCalledTimes(2);
  expect(f.advance).toHaveBeenCalledTimes(1);
  expect(counted(f, 'not_found')).toContain(1);
  const logs = printed(f.logger.info, f.logger.warn, f.logger.error);
  for (const marker of [foreign.order_id, foreign.refund_id, ours.order_id, ours.refund_id]) {
    expect(logs).not.toContain(marker);
  }
});

it('[AC-B1-04zza#27] 同一条维权重放：照样交给写入方，duplicate 不算失败、不抛错（去重由 order_rights 去重键）', async () => {
  const r = refund(1, { rights_status: 'SUCCEEDED' });
  const f = fixture({ refundPages: [[r]] });
  f.write.mockResolvedValueOnce({ kind: 'applied' }).mockResolvedValueOnce({ kind: 'duplicate' });
  await handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler);
  await expect(handleRightsWindow(job(RIGHTS_JOB, WINDOW, 2), f.handler)).resolves.toBeUndefined();
  expect(f.write).toHaveBeenCalledTimes(2);
  expect(f.write.mock.calls[1]).toEqual(f.write.mock.calls[0]);
});

it('[AC-B1-04zza#28] 取页失败或写入失败：错误外抛（队列重试），水位不推', async () => {
  const outage = new Error('synthetic upstream outage');
  const f = fixture({ refundPages: [[refund(1)], [refund(2)]] });
  f.listRefunds.mockImplementation(async (_win, _ctx, opt) => {
    if (opt?.cursor !== undefined) throw outage;
    return { items: [refund(1)], nextCursor: 'page-1' };
  });
  await expect(handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler)).rejects.toBe(outage);
  expect(f.advance).not.toHaveBeenCalled();

  const broken = new Error('synthetic rights.record failure');
  const g = fixture({ refundPages: [[refund(1)]] });
  g.write.mockRejectedValue(broken);
  await expect(handleRightsWindow(job(RIGHTS_JOB, WINDOW), g.handler)).rejects.toBe(broken);
  expect(g.advance).not.toHaveBeenCalled();
});

it.each([
  ['不是可查账号', 'queryable'],
  ['站点授权失效', 'site'],
] as const)('[AC-B1-04zza#29] %s：不取数、不写、不推水位，不抛错', async (_name, gate) => {
  const f = fixture({ refundPages: [[refund(1)]], punishPages: [[punishment(1)]] });
  if (gate === 'queryable') f.queryableAccount.mockResolvedValue(OTHER_ACCOUNT);
  else f.siteAuthAvailable.mockResolvedValue(false);
  await expect(handleRightsWindow(job(RIGHTS_JOB, WINDOW), f.handler)).resolves.toBeUndefined();
  await expect(
    handlePunishWindow(job(PUNISH_JOB, punishWindow()), f.handler),
  ).resolves.toBeUndefined();
  expect(f.listRefunds).not.toHaveBeenCalled();
  expect(f.listPunishments).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});

it.each([
  ['query_kind 不是 rights', { ...WINDOW, query_kind: 'increment' }],
  ['scene 不认识', { ...WINDOW, scene: 'synthetic' }],
  ['窗口为空', { ...WINDOW, window_end: WINDOW.window_start }],
  ['窗口时间不是时间', { ...WINDOW, window_start: 'not-a-time' }],
  ['缺 app_id', { ...WINDOW, app_id: '' }],
])(
  '[AC-B1-04zza#30] rights.window 的 payload %s → OrderSyncPayloadError，不取数',
  async (_name, payload) => {
    const f = fixture({ refundPages: [[refund(1)]] });
    await expect(handleRightsWindow(job(RIGHTS_JOB, payload), f.handler)).rejects.toBeInstanceOf(
      OrderSyncPayloadError,
    );
    expect(f.listRefunds).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zza#31] 回扫窗口（scene rescan）照样写入，推进的是回扫流自己的水位', async () => {
  const rescan = rightsWindow(iso(NOW_MS - 50 * 24 * HOUR_MS), { scene: 'rescan' });
  const r = refund(1, { rights_status: 'SUCCEEDED' });
  const f = fixture({ refundPages: [[r]] });
  await handleRightsWindow(job(RIGHTS_JOB, rescan), f.handler);
  expect(f.writes()).toHaveLength(1);
  expect(f.advance).toHaveBeenCalledTimes(1);
  expect(f.advance).toHaveBeenCalledWith(rescan);
});

it('[AC-B1-04zza#32] punish.window 取完全部页：每条记 PUNISH / SUCCEEDED，违规单号作去重号，发生时间取同步时刻，不推水位', async () => {
  const first = punishment(1);
  const second = punishment(2, { punish_status: '1' });
  const third = punishment(3);
  const f = fixture({ punishPages: [[first, second], [third]] });
  const payload = punishWindow();
  await handlePunishWindow(job(PUNISH_JOB, payload), f.handler);

  expect(f.listPunishments).toHaveBeenCalledTimes(2);
  const [win, ctx, opt] = f.listPunishments.mock.calls[0]!;
  expect(win).toEqual({ from: payload.window_start, to: payload.window_end });
  expect(ctx).toMatchObject({ appId: APP, purpose: 'order_sync' });
  expect(opt?.cursor).toBeUndefined();
  expect(f.listPunishments.mock.calls[1]![2]).toMatchObject({ cursor: 'page-1' });

  const item = (p: typeof first) => ({
    target: targetOf(p),
    item: {
      type: 'PUNISH',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: new Date(NOW),
      platform_rights_no: p.punishment_id,
    },
  });
  expect(f.writes()).toEqual([item(first), item(second), item(third)]);
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.listRefunds).not.toHaveBeenCalled();
});

it('[AC-B1-04zza#33] punish 对不上订单只计数、重放 duplicate 不算失败：不抛错，日志不带单号', async () => {
  const foreign = punishment(1);
  const replayed = punishment(2);
  const f = fixture({ punishPages: [[foreign, replayed]] });
  f.write.mockImplementation(async (target) =>
    target.sub_order_id === foreign.order_id ? { kind: 'not_found' } : { kind: 'duplicate' },
  );
  await expect(
    handlePunishWindow(job(PUNISH_JOB, punishWindow()), f.handler),
  ).resolves.toBeUndefined();
  expect(f.write).toHaveBeenCalledTimes(2);
  expect(counted(f, 'not_found')).toContain(1);
  const logs = printed(f.logger.info, f.logger.warn, f.logger.error);
  for (const marker of [foreign.order_id, foreign.punishment_id, replayed.order_id]) {
    expect(logs).not.toContain(marker);
  }
});

it.each([
  ['query_kind 不是 punish', { ...punishWindow(), query_kind: 'rights' }],
  ['窗口为空', { ...punishWindow(), window_start: NOW }],
  ['缺 union_account_id', { ...punishWindow(), union_account_id: '' }],
])(
  '[AC-B1-04zza#34] punish.window 的 payload %s → OrderSyncPayloadError，不取数',
  async (_name, payload) => {
    const f = fixture({ punishPages: [[punishment(1)]] });
    await expect(handlePunishWindow(job(PUNISH_JOB, payload), f.handler)).rejects.toBeInstanceOf(
      OrderSyncPayloadError,
    );
    expect(f.listPunishments).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  },
);
