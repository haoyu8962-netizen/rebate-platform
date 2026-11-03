import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type CallCtx, type TimeWindow } from '../../domain/types.ts';
import { DataokeClient } from '../dataoke/dataoke-client.ts';
import type { UnionTransport, UnionTransportRequest } from '../replay.ts';
import {
  beijingMs,
  beijingText,
  mapTaobaoOrder,
  nextTaobaoOrderCursor,
  parseTaobaoOrderBody,
  planTaobaoOrders,
  slotAdzones,
  taobaoOrderCursor,
  type TaobaoOrderWarning,
} from './orders.ts';
import { TaobaoUnionAdapter } from './taobao-adapter.ts';

// 单元测试（实现者）：游标与窗口一致性、has_next 无位点、时间文本与推广位解析。报文全部合成。

const win: TimeWindow = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T09:00:00Z' };
const start = Date.parse(win.from) / 1000;
const end = Date.parse(win.to) / 1000;
const ctx: CallCtx = { appId: 'unit-app', requestId: 'unit-request', purpose: 'order_sync' };

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

function syncFailure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

function body(data: unknown): string {
  return JSON.stringify({ time: 1, code: 0, msg: 'ok', data });
}

function setup(answer: (request: UnionTransportRequest) => string) {
  const clock = new FixedClock('2026-10-31T08:00:00.000Z');
  const transport = vi.fn<UnionTransport>(async (request) => ({
    status: 200,
    headers: {},
    body: answer(request),
  }));
  const orderSource = new DataokeClient({
    baseUrl: 'https://dataoke-unit.invalid',
    clock,
    credentials: async () => ({ appKey: 'unit-key', appSecret: 'unit-secret-unit' }),
    random: () => 7,
    transport,
  });
  const adapter = new TaobaoUnionAdapter({
    clock,
    credentials: async () => ({ appKey: 'k', appSecret: 's' }),
    transport: vi.fn<UnionTransport>(),
    endpoint: { platform: 'taobao', mode: 'live', baseUrl: 'https://tb.invalid', quotaKey: 'q' },
    orderSource,
    orderSlots: async () => ['mm_1_2_123456789012'],
  });
  return { adapter, transport };
}

it('[AC-B1-04f-UNIT#1] 游标里的窗口或口径与本次调用不符 → invalid_dto，不发请求（不按游标的窗口去查）', async () => {
  const { adapter, transport } = setup(() => body({ has_next: false, results: {} }));
  const own = taobaoOrderCursor({ queryType: 4, start, end, subStart: start, position: 'p|q' });
  const shifted: TimeWindow = { from: '2026-10-30T03:00:00Z', to: win.to };
  const longer: TimeWindow = { from: win.from, to: '2026-10-30T10:00:00Z' };
  expect(await failure(() => adapter.listOrders(shifted, { cursor: own }, ctx))).toBe(
    'invalid_dto',
  );
  expect(await failure(() => adapter.listOrders(longer, { cursor: own }, ctx))).toBe('invalid_dto');
  expect(await failure(() => adapter.listOrders(win, { cursor: own, timeBasis: 'pay' }, ctx))).toBe(
    'invalid_dto',
  );
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04f-UNIT#2] 游标的窗起点不在 3 小时网格上、越界或位点非规范编码 → invalid_dto', () => {
  const cursors = [
    `tbo1.4.${start}.${end}.${start + 60}.`,
    `tbo1.4.${start}.${end}.${end}.`,
    `tbo1.4.${start}.${end}.${start - 10800}.`,
    `tbo1.4.${start}.${end}.${start}.cA=`,
    `tbo1.4.${start}.${end}.${start}.cA`.replace('cA', 'c'),
  ];
  for (const cursor of cursors) {
    expect(
      syncFailure(() => planTaobaoOrders(win, { cursor })),
      cursor,
    ).toBe('invalid_dto');
  }
  const plan = planTaobaoOrders(win, {
    cursor: taobaoOrderCursor({ queryType: 4, start, end, subStart: start + 10800, position: 'x' }),
  });
  expect(plan).toMatchObject({ subStart: start + 10800, subEnd: start + 21600, position: 'x' });
});

it.each([
  ['空串', ''],
  ['缺失', undefined],
])(
  '[AC-B1-04f-UNIT#3] has_next=true 但 position_index %s → upstream_unavailable，不重拉首页',
  async (_name, position) => {
    const { adapter, transport } = setup(() =>
      body({ has_next: true, position_index: position, results: { publisher_order_dto: [] } }),
    );
    expect(await failure(() => adapter.listOrders(win, {}, ctx))).toBe('upstream_unavailable');
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04f-UNIT#4] has_next=true 且 position_index 与本次所带相同 → upstream_unavailable（不原地打转）', () => {
  const plan = planTaobaoOrders(win, {
    cursor: taobaoOrderCursor({ queryType: 4, start, end, subStart: start, position: 'same' }),
  });
  expect(syncFailure(() => nextTaobaoOrderCursor(plan, { hasNext: true, position: 'same' }))).toBe(
    'upstream_unavailable',
  );
  expect(nextTaobaoOrderCursor(plan, { hasNext: false, position: 'same' })).toBe(
    taobaoOrderCursor({ queryType: 4, start, end, subStart: start + 10800, position: null }),
  );
});

it('[AC-B1-04f-UNIT#5] 报文结构：results / 列表缺失为空页，列表不是数组 → upstream_unavailable；数字保留原文', () => {
  expect(parseTaobaoOrderBody(body({ has_next: false })).rows).toEqual([]);
  expect(parseTaobaoOrderBody(body({ results: null })).rows).toEqual([]);
  expect(
    syncFailure(() => parseTaobaoOrderBody(body({ results: { publisher_order_dto: {} } }))),
  ).toBe('upstream_unavailable');
  const page = parseTaobaoOrderBody(
    '{"data":{"has_next":false,"results":{"publisher_order_dto":[{"x":0.29999999999999999}]}}}',
  );
  expect(page.rows).toEqual([{ x: expect.objectContaining({ text: '0.29999999999999999' }) }]);
});

it('[AC-B1-04f-UNIT#6] 北京时间文本：往返一致，非法日期为 null', () => {
  const seconds = Date.parse('2026-02-28T16:30:59Z') / 1000;
  expect(beijingText(seconds)).toBe('2026-03-01 00:30:59');
  expect(beijingMs('2026-03-01 00:30:59')).toBe(seconds * 1000);
  for (const text of ['2026-02-29 00:00:00', '2026-13-01 00:00:00', '2026-01-01 24:00:00', '--']) {
    expect(beijingMs(text), text).toBeNull();
  }
  expect(beijingMs('2028-02-29 08:00:00')).toBe(Date.parse('2028-02-29T00:00:00Z'));
});

it('[AC-B1-04f-UNIT#7] 推广位：只取 PID 最后一段的十进制 adzone，其余忽略', () => {
  expect([
    ...slotAdzones(['mm_1_2_345', 'mm_1_2_x', 'plain', 'mm_1_2_', 'mm_1_2_0345', 7]),
  ]).toEqual(['345']);
  expect(slotAdzones(null).size).toBe(0);
});

function fullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    trade_id: '2900000000000000501',
    trade_parent_id: '2900000000000000500',
    item_id: 'UnitItem-0001',
    item_num: 1,
    adzone_id: 123456789012,
    site_id: 3000000001,
    tk_status: 3,
    refund_tag: 0,
    tk_order_role: 0,
    alipay_total_price: '10.00',
    item_price: '10.00',
    pub_share_pre_fee: '1.00',
    pub_share_pre_fee_for_commission: '1.00',
    pub_share_fee_for_commission: '0.90',
    total_commission_fee: '1.10',
    alimama_share_fee: '0.05',
    subsidy_fee: '0.00',
    income_rate: '10.00',
    pub_share_rate: '100.00',
    total_commission_rate: '10.00',
    tk_paid_time: '2026-10-30 10:00:05',
    tk_earning_time: '2026-10-30 10:40:00',
    modified_time: '2026-10-30 10:45:30',
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key];
  return base;
}

function mapOne(input: Record<string, unknown>) {
  const warnings: TaobaoOrderWarning[] = [];
  const page = parseTaobaoOrderBody(
    body({ has_next: false, results: { publisher_order_dto: [input] } }),
  );
  const order = mapTaobaoOrder(
    page.rows[0],
    { rawPayloadId: null, like: new FixedClock('2026-10-31T08:00:00.000Z').now() },
    (event) => warnings.push(event),
  );
  return { order, warnings };
}

it('[AC-B1-04f-UNIT#8] 未结算（tk_status 12、tk_earning_time 缺失）时 pub_share_fee_for_commission "0.00" 也不当结算佣金：settle_commission_fen = null，且不告警', () => {
  const { order, warnings } = mapOne(
    fullRow({
      tk_status: 12,
      pub_share_fee_for_commission: '0.00',
      tk_earning_time: undefined,
    }),
  );
  expect(order).toMatchObject({ raw_status: '12', settled_at: null, settle_commission_fen: null });
  expect(warnings).toEqual([]);
  const dashed = mapOne(
    fullRow({ tk_status: 12, pub_share_fee_for_commission: '--', tk_earning_time: '--' }),
  );
  expect(dashed.order?.settle_commission_fen).toBeNull();
});

it('[AC-B1-04f-UNIT#9] 已结算（tk_status 3）→ 佣金减服务费；结算时间非法只让 settled_at 为 null，结算额照读', () => {
  expect(mapOne(fullRow()).order).toMatchObject({
    settle_commission_fen: 85n,
    settled_at: new Date('2026-10-30T02:40:00Z'),
  });
  const bad = mapOne(fullRow({ tk_earning_time: '2026-02-30 00:00:00' }));
  expect(bad.order).toMatchObject({ settled_at: null, settle_commission_fen: 85n });
  expect(bad.warnings).toEqual([{ event: 'taobao_order_field_invalid', field: 'tk_earning_time' }]);
});

it('[AC-B1-04f-UNIT#10] 每条都应有的官方字段键缺失 → null 并告警一次；「--」与按条件出现的字段缺失静默', () => {
  const missing = mapOne(fullRow({ modified_time: undefined }));
  expect(missing.order?.modified_at).toBeNull();
  expect(missing.warnings).toEqual([
    { event: 'taobao_order_field_invalid', field: 'modified_time' },
  ]);

  const total = mapOne(fullRow({ total_commission_fee: undefined }));
  expect(total.order?.total_commission_fen).toBeNull();
  expect(total.warnings).toEqual([
    { event: 'taobao_order_field_invalid', field: 'total_commission_fee' },
  ]);

  const quiet = mapOne(fullRow({ modified_time: '--', relation_id: undefined }));
  expect(quiet.order).toMatchObject({ modified_at: null, special_id: null });
  expect(quiet.warnings).toEqual([]);
});
