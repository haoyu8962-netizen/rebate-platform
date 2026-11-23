import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type UnionEndpoint } from '../../domain/types.ts';
import type { UnionTransport } from '../replay.ts';
import { PddUnionAdapter } from './pdd-adapter.ts';
import {
  incrementWindow,
  mapPddOrder,
  parseIncrementCursor,
  parsePddOrderEnvelope,
  rangeWindow,
} from './orders.ts';

const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://pdd-gateway.invalid/api/router',
  quotaKey: 'unit',
};
const ctx = { appId: 'unit-app', requestId: 'unit-req', purpose: 'order_sync' } as const;
const base = { order_sn: 'unit-sn', order_amount: 100, promotion_amount: 10 };
const meta = { rawPayloadId: null, like: new FixedClock('2026-10-14T00:00:00Z').now() };

function setup(reply: (body: Record<string, unknown>) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    bodies.push(body);
    return { status: 200, headers: {}, body: JSON.stringify(reply(body)) };
  });
  const adapter = new PddUnionAdapter({
    clock: new FixedClock('2026-10-15T00:00:00Z'),
    credentials: async () => ({ clientId: 'unit-client', clientSecret: 'unitValue' }),
    transport,
    endpoint,
  });
  return { adapter, bodies };
}

it('[AC-B1-04i-UNIT#2] 北京时间换算跨年、闰日正确；亚秒边界向外取整', () => {
  expect(rangeWindow({ from: '2027-12-31T16:00:00Z', to: '2028-02-29T15:59:59Z' })).toEqual({
    start_time: '2028-01-01 00:00:00',
    end_time: '2028-02-29 23:59:59',
  });
  expect(
    incrementWindow(
      { from: '2026-10-14T00:00:00.400Z', to: '2026-10-14T01:00:00.400Z' },
      Date.parse('2026-10-15T00:00:00Z'),
    ),
  ).toEqual({
    start_update_time: Date.parse('2026-10-14T00:00:00Z') / 1000,
    end_update_time: Date.parse('2026-10-14T01:00:01Z') / 1000,
  });
});

it('[AC-B1-04i-UNIT#3] 游标格式不对或与查询方式不符报 invalid_dto，且不发请求', async () => {
  expect(parseIncrementCursor('inc:7')).toBe(7);
  const { adapter, bodies } = setup(() => ({}));
  const win = { from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' };
  for (const [cursor, queryMode] of [
    ['inc:0', 'increment'],
    ['inc:10001', 'increment'],
    ['range:abc', 'increment'],
    ['inc:3', 'pay_time'],
    ['range:', 'pay_time'],
  ] as const) {
    await expect(adapter.listOrders(win, { cursor, queryMode }, ctx)).rejects.toMatchObject({
      code: 'invalid_dto',
    });
  }
  expect(bodies).toHaveLength(0);
});

it('[AC-B1-04i-UNIT#4] subsidy_list 成员不进 DTO，只保留长度', () => {
  const dto = mapPddOrder(
    { ...base, subsidy_list: [{ subsidy_amount: 5 }, {}] },
    'increment',
    meta,
  );
  expect(dto.subsidy_list).toEqual([null, null]);
  expect(JSON.stringify(dto.subsidy_list)).not.toContain('subsidy_amount');
  expect(() => mapPddOrder({ ...base, subsidy_list: {} }, 'increment', meta)).toThrow(UnionError);
});

it('[AC-B1-04i-UNIT#5] 按接口取字段：range 不读 order_id，详情不读列表专有字段', () => {
  const range = mapPddOrder({ ...base, order_id: 'unit-id', p_id: 'unit-pid' }, 'range', meta);
  expect(range.platform_order_id).toBeNull();
  expect(range.pid).toBe('unit-pid');
  const detail = mapPddOrder(
    { ...base, order_id: 'unit-id', p_id: 'list-pid', fail_reason: 'x', return_status: 1 },
    'detail',
    meta,
  );
  expect(detail).toMatchObject({
    platform_order_id: null,
    pid: null,
    fail_reason: null,
    return_status: 1,
  });
});

it('[AC-B1-04i-UNIT#6] range 迭代器原样不变但仍有数据时也结束，避免死循环', async () => {
  const { adapter } = setup(() => ({
    order_list_get_response: { order_list: [base], last_order_id: 'same' },
  }));
  const page = await adapter.listOrders(
    { from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' },
    { queryMode: 'pay_time', cursor: 'range:same' },
    ctx,
  );
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
});

it('[AC-B1-04w-UNIT#3] 整个窗口落在 90 天界所在那一秒时，收回后的起点不追上终点', () => {
  const nowMs = Date.parse('2026-10-15T00:00:00.500Z');
  const oldestMs = nowMs - 90 * 86_400_000;
  const window = incrementWindow(
    { from: new Date(oldestMs).toISOString(), to: new Date(oldestMs + 1).toISOString() },
    nowMs,
  );
  expect(window.start_update_time).toBe(Math.ceil(oldestMs / 1000));
  expect(window.end_update_time).toBe(window.start_update_time + 1);
});

it('[AC-B1-04w-UNIT#4] 直接映射时普通数值商品号只接受非负安全整数', () => {
  expect(mapPddOrder({ ...base, goods_id: 42 }, 'increment', meta).goods_id).toBe('42');
  for (const goods_id of [2 ** 53, -1, 1.5]) {
    expect(() => mapPddOrder({ ...base, goods_id }, 'increment', meta)).toThrow(UnionError);
  }
});

it('[AC-B1-08e-UNIT#3] 平台无关字段：子单号、推广位、原样归因串、原状态、时刻与佣金', () => {
  const dto = mapPddOrder(
    {
      ...base,
      p_id: 'unit-slot',
      custom_parameters: 'raw-attr',
      order_status: 2,
      order_pay_time: 1,
      order_receive_time: 0,
      order_modify_at: 1791936007,
      duo_id_service_fee: 3,
    },
    'increment',
    { rawPayloadId: '42', like: meta.like },
  );
  expect(dto).toMatchObject({
    sub_order_id: 'unit-sn',
    parent_order_id: null,
    promotion_slot: 'unit-slot',
    attr_params: { relation_id: null, custom_parameters: 'raw-attr', sub_union_id: null },
    raw_status: '2',
    deposit_paid_at: null,
    paid_at: new Date('1970-01-01T00:00:01.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: new Date('2026-10-14T00:00:07.000Z'),
    est_commission_fen: 7n,
    settle_commission_fen: null,
    raw_payload_id: '42',
  });
  expect(meta.like.toISOString()).toBe('2026-10-14T00:00:00.000Z');
});

it('[AC-B1-08p#U1] 店铺 ID：mall_id 原始文本与数值按十进制正整数取，缺失或不合格为 null 且照常映射', () => {
  const raw = (text: string) =>
    mapPddOrder(
      parsePddOrderEnvelope(
        `{"r":{"order_sn":"unit-sn","order_amount":100,"promotion_amount":10,"mall_id":${text}}}`,
        'r',
      ),
      'increment',
      meta,
    ).shop_id;
  expect(raw('73129')).toBe('73129');
  expect(raw('9007199254740991')).toBe('9007199254740991');
  // 超出安全整数、小数字面量（JSON.parse 会舍成整数）、指数写法都不当作店铺。
  for (const text of ['9007199254740992', '9007199254740993', '73129.0', '7.3129e4', '0', '-5']) {
    expect(raw(text)).toBeNull();
  }
  for (const mall_id of ['73129', 73129]) {
    expect(mapPddOrder({ ...base, mall_id }, 'detail', meta).shop_id).toBe('73129');
  }
  for (const mall_id of ['', ' 73129', '073129', 'abc', 2 ** 53, Number.NaN, true, {}, undefined]) {
    const dto = mapPddOrder({ ...base, mall_id }, 'range', meta);
    expect(dto.shop_id).toBeNull();
    expect(dto.order_id).toBe('unit-sn');
  }
});

const feeBp = (bp: number) => ({
  rawPayloadId: null,
  like: meta.like,
  serviceFeeBp: { '*': { bp, source: 'unit', verified: true } },
});

it('[AC-B2-19-UNIT#1] 状态 5 结算额与预估同值；2、3 等其余状态只写预估；预估算不出时结算也为 null', () => {
  const row = { ...base, order_amount: 5000, promotion_amount: 1600, duo_id_service_fee: 160 };
  for (const source of ['increment', 'range', 'detail'] as const) {
    const settled = mapPddOrder({ ...row, order_status: 5 }, source, meta);
    expect(settled.est_commission_fen).toBe(1440n);
    expect(settled.settle_commission_fen).toBe(1440n);
    for (const order_status of [0, 1, 2, 3, 4, 10, undefined]) {
      const dto = mapPddOrder({ ...row, order_status }, source, meta);
      expect(dto.est_commission_fen).toBe(1440n);
      expect(dto.settle_commission_fen).toBeNull();
    }
    // 无服务费字段、无配置：预估与结算都为 null，绝不按 0。
    for (const page of [meta, { ...meta, serviceFeeBp: null }]) {
      const noFee = { ...row, duo_id_service_fee: undefined, order_status: 5 };
      const missing = mapPddOrder(noFee, source, page);
      expect(missing.est_commission_fen).toBeNull();
      expect(missing.settle_commission_fen).toBeNull();
    }
    // 净额为负时结算额照样取同一个负值（不截成 0）。
    const negative = mapPddOrder(
      { ...row, promotion_amount: 10, duo_id_service_fee: 30, order_status: 5 },
      source,
      meta,
    );
    expect(negative.settle_commission_fen).toBe(-20n);
  }
});

it('[AC-B2-19-UNIT#2] 状态 5：毛额 1001 分、报文显式服务费 0、配置 600 bp → 结算额 1001 分（显式 0 不走费率兜底）', () => {
  const dto = mapPddOrder(
    { ...base, promotion_amount: 1001, duo_id_service_fee: 0, order_status: 5 },
    'increment',
    feeBp(600),
  );
  expect(dto.service_fee_fen).toBe(0n);
  expect(dto.est_commission_fen).toBe(1001n);
  expect(dto.settle_commission_fen).toBe(1001n);
});

it('[AC-B2-19-UNIT#3] 状态 5：毛额 1600 分、报文缺服务费、配置 1000 bp → 结算额 1440 分（恰好整除不加 1）', () => {
  for (const duo_id_service_fee of [undefined, null]) {
    const dto = mapPddOrder(
      { ...base, promotion_amount: 1600, duo_id_service_fee, order_status: 5 },
      'range',
      feeBp(1000),
    );
    expect(dto.service_fee_fen).toBe(160n);
    expect(dto.est_commission_fen).toBe(1440n);
    expect(dto.settle_commission_fen).toBe(1440n);
  }
  // 对照：不整除时向上取整（1605 × 10% = 160.5 → 161）。
  const ceil = mapPddOrder(
    { ...base, promotion_amount: 1605, order_status: 5 },
    'range',
    feeBp(1000),
  );
  expect(ceil.settle_commission_fen).toBe(1444n);
});

it('[AC-B2-19-UNIT#4] 列表 rowErrors=collect 分支返回的状态 5 行仍带结算额', async () => {
  const row = { ...base, promotion_amount: 1600, duo_id_service_fee: 160, order_status: 5 };
  const { adapter } = setup(() => ({
    order_list_get_response: { order_list: [row, { order_sn: '' }], last_order_id: '' },
  }));
  const page = await adapter.listOrders(
    { from: '2026-10-14T00:00:00Z', to: '2026-10-14T12:00:00Z' },
    { queryMode: 'pay_time' },
    { ...ctx, rowErrors: 'collect' },
  );
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ settle_commission_fen: 1440n, est_commission_fen: 1440n });
  expect(page.rejected).toHaveLength(1);
});

/**
 * B2-19（D10-2677 ②）：照 pdd.ddk.order.detail.get 文档形状的详情回包（order_detail_response，带
 * order_receive_time、order_verify_time、order_settle_time 与 pid），与同一笔的列表报文（increment、range，
 * 带 p_id）比较。字段值为合成。
 */
const SAME_ORDER = {
  order_sn: 'unit-b219-sn',
  goods_id: 8123456789013,
  order_amount: 52_800,
  promotion_amount: 1_000,
  duo_id_service_fee: 100,
  order_status: 5,
  order_create_time: 1_792_000_000,
  order_pay_time: 1_792_000_010,
  order_group_success_time: 1_792_000_020,
  order_receive_time: 1_792_300_000,
  order_verify_time: 1_792_400_000,
  order_settle_time: 1_792_500_000,
  order_modify_at: 1_792_500_060,
};
const SAME_ORDER_DETAIL = {
  ...SAME_ORDER,
  pid: 'unit-slot',
  url_last_generate_time: 1_791_999_000,
};
const SAME_ORDER_LIST = { ...SAME_ORDER, p_id: 'unit-slot' };

/** 映射结果里与结算记录去重相关的部分：时刻、结算额、预估、原秒字段。 */
function settleView(dto: ReturnType<typeof mapPddOrder>) {
  return {
    paid_at: dto.paid_at,
    received_at: dto.received_at,
    settled_at: dto.settled_at,
    modified_at: dto.modified_at,
    est_commission_fen: dto.est_commission_fen,
    settle_commission_fen: dto.settle_commission_fen,
    order_receive_time: dto.order_receive_time,
    order_verify_time: dto.order_verify_time,
    order_settle_time: dto.order_settle_time,
    raw_status: dto.raw_status,
  };
}

// 错实现下怎么红：FIELDS.detail 不登记 order_settle_time / order_receive_time（r1 的状态）时，详情的
// settled_at、received_at、order_settle_time、order_receive_time 都是 null，与列表的时刻不等；只登记其一时另一项不等。
it('[AC-B2-19-UNIT#5] 详情回包（文档形状）与同一笔列表报文映射出的 settled_at、received_at 一致', async () => {
  const { adapter, bodies } = setup((body) =>
    body.type === 'pdd.ddk.order.detail.get'
      ? { order_detail_response: SAME_ORDER_DETAIL }
      : { order_list_get_response: { order_list: [SAME_ORDER_LIST], last_order_id: '' } },
  );
  const detail = await adapter.getPddOrderDetail(SAME_ORDER.order_sn, ctx);
  expect(bodies[0]?.type).toBe('pdd.ddk.order.detail.get');
  expect(detail.settled_at).toEqual(new Date('2026-10-20T12:40:00.000Z'));
  expect(detail.received_at).toEqual(new Date('2026-10-18T05:06:40.000Z'));
  expect(detail).toMatchObject({
    order_receive_time: 1_792_300_000,
    order_verify_time: 1_792_400_000,
    order_settle_time: 1_792_500_000,
  });
  const increment = mapPddOrder(SAME_ORDER_LIST, 'increment', meta);
  expect(detail.settled_at).toEqual(increment.settled_at);
  expect(detail.received_at).toEqual(increment.received_at);
  // range 的字段表不登记 order_receive_time（不在本单范围），只比 settled_at。
  expect(detail.settled_at).toEqual(mapPddOrder(SAME_ORDER_LIST, 'range', meta).settled_at);
});

// 错实现下怎么红：详情漏读 order_settle_time 时详情的 settled_at 为 null（列表是 2026-10-20T12:40:00Z），
// 下游按结算时间算的去重 hash 不同、会追加 seq；结算额若在详情另算（不与 est 同值）或按入口区分，结算额不等。
it('[AC-B2-19-UNIT#6] 状态 5 同额同结算时间：详情与列表映射出的结算额与 settled_at 完全相同', () => {
  const detail = mapPddOrder(SAME_ORDER_DETAIL, 'detail', meta);
  expect(detail.settle_commission_fen).toBe(900n);
  expect(detail.settled_at).not.toBeNull();
  const increment = mapPddOrder(SAME_ORDER_LIST, 'increment', meta);
  expect(settleView(detail)).toEqual(settleView(increment));
  // range 的字段表不登记 order_receive_time / order_verify_time（不在本单范围）：只比结算额与 settled_at。
  const range = mapPddOrder(SAME_ORDER_LIST, 'range', meta);
  expect(detail.settle_commission_fen).toBe(range.settle_commission_fen);
  expect(detail.settled_at).toEqual(range.settled_at);
});
