import { afterEach, expect, it, vi } from 'vitest';
import {
  collect,
  ITEM_ID,
  num,
  one,
  OUR_ADZONE,
  onePage,
  row,
  setup,
  TRADE_ID,
  TRADE_PARENT_ID,
  visible,
} from './kit.ts';

// 映射（任务书「目标口径 · 映射到 UnionOrder」）：官方 publisher_order_dto 同名字段 → UnionOrder 平台无关
// 字段 + TaobaoOrderFields；大淘客自算字段（income、income_by_one、price_by_one、day、
// pub_share_pre_fee_for_commission、*_for_sdy）不映射。时间是北京时间文本，「--」为 null。

afterEach(() => {
  vi.unstubAllEnvs();
});

const at = (text: string): Date => new Date(text);

it('[AC-B1-04f#18] 已结算订单的平台无关字段按同名官方字段映射', async () => {
  const order = await one(row({ pub_share_fee_for_commission: '7.66' }));
  expect(order).toMatchObject({
    platform: 'taobao',
    order_id: TRADE_ID,
    sub_order_id: TRADE_ID,
    parent_order_id: TRADE_PARENT_ID,
    item_id: ITEM_ID,
    promotion_slot: OUR_ADZONE,
    attr_params: { relation_id: null, custom_parameters: null, sub_union_id: null },
    raw_status: '3',
    paid_fen: 8880n,
    commission_fen: 724n,
    est_commission_fen: 724n,
    settle_commission_fen: 666n,
    paid_at: at('2026-10-30T02:00:05Z'),
    settled_at: at('2026-10-30T02:40:00Z'),
    modified_at: at('2026-10-30T02:45:30Z'),
    received_at: null,
    deposit_paid_at: null,
    raw_payload_id: null,
  });
});

it('[AC-B1-04f#19] TaobaoOrderFields 原样给出官方字段（金额为分、比例为 bp、整数 ID 为十进制串）', async () => {
  const order = await one(row());
  expect(order).toMatchObject({
    tk_status: 3,
    refund_tag: 0,
    tk_order_role: 0,
    item_num: 1,
    site_id: '3000000001',
    special_id: null,
    item_price_fen: 9900n,
    alimama_share_fen: 45n,
    subsidy_fen: 120n,
    total_commission_fen: 888n,
    tech_service_fee_fen: 100n,
    tech_service_pre_fee_fen: 50n,
    income_rate_bp: 900n,
    pub_share_rate_bp: 10000n,
    total_commission_rate_bp: 900n,
  });
});

it('[AC-B1-04f#20] 不用大淘客自算字段：income / income_by_one / price_by_one / day / *_for_commission / *_for_sdy 的值不出现在 DTO 里', async () => {
  const order = await one(row());
  const values = Object.values(order);
  for (const fen of [777n, 776n, 775n, 774n, 773n]) expect(values).not.toContain(fen);
  const printed = visible(order);
  for (const text of ['7.77', '7.76', '7.75', '7.74', '7.73', '2026-10-29']) {
    expect(printed).not.toContain(text);
  }
  for (const key of ['income', 'income_by_one', 'price_by_one', 'day']) {
    expect(Object.hasOwn(order, key)).toBe(false);
  }
  // 淘宝订单不带店铺键（UnionOrder.shop_id 的约定）。
  expect(Object.hasOwn(order, 'shop_id')).toBe(false);
});

it('[AC-B1-04f#21] 未结算（tk_status 12、tk_earning_time 与 pub_share_fee 为「--」）→ 结算佣金与结算时间为 null', async () => {
  const order = await one(
    row({ tk_status: num('12'), tk_earning_time: '--', pub_share_fee: '--' }),
  );
  expect(order).toMatchObject({
    raw_status: '12',
    tk_status: 12,
    settle_commission_fen: null,
    settled_at: null,
    est_commission_fen: 724n,
    paid_at: at('2026-10-30T02:00:05Z'),
  });
});

it('[AC-B1-04f#22] pub_share_fee 与 tk_earning_time 缺失 → null', async () => {
  const order = await one(row({ pub_share_fee: undefined, tk_earning_time: undefined }));
  expect(order.settle_commission_fen).toBeNull();
  expect(order.settled_at).toBeNull();
});

it('[AC-B1-04f#23] 渠道单：relation_id / special_id（整数）→ 十进制字符串；relation_id 进 attr_params', async () => {
  const order = await one(row({ relation_id: num('2700000001'), special_id: num('3800000001') }));
  expect(order.attr_params).toEqual({
    relation_id: '2700000001',
    custom_parameters: null,
    sub_union_id: null,
  });
  expect(order.special_id).toBe('3800000001');
});

it('[AC-B1-04f#24] 预售定金时间有值则填 deposit_paid_at，「--」为 null', async () => {
  const deposit = await one(
    row({ tb_deposit_time: '2026-10-29 20:00:00', tk_deposit_time: '2026-10-29 20:00:00' }),
  );
  expect(deposit.deposit_paid_at).toEqual(at('2026-10-29T12:00:00Z'));
  const plain = await one(row());
  expect(plain.deposit_paid_at).toBeNull();
});

it('[AC-B1-04f#25] 订单号、父单号、商品号原样字符串：19 位 trade_id 不经数字，item_id 后段不换算', async () => {
  const tradeId = '0900719925474099301';
  const order = await one(row({ trade_id: tradeId, trade_parent_id: tradeId }));
  expect(order.order_id).toBe(tradeId);
  expect(order.sub_order_id).toBe(tradeId);
  expect(order.parent_order_id).toBe(tradeId);
  expect(order.item_id).toBe(ITEM_ID);
});

it.each(['UTC', 'America/New_York', 'Asia/Tokyo'])(
  '[AC-B1-04f#26] 进程时区 %s 下，北京时间文本解析成同一时刻',
  async (zone) => {
    vi.stubEnv('TZ', zone);
    const order = await one(row());
    expect(order.paid_at).toEqual(at('2026-10-30T02:00:05Z'));
    expect(order.modified_at).toEqual(at('2026-10-30T02:45:30Z'));
  },
);

it('[AC-B1-04f#27] 一页多条按上游顺序映射，每条的订单号各自来自本条', async () => {
  const rows = [
    row({ trade_id: '2900000000000000201', tk_status: num('12') }),
    row({ trade_id: '2900000000000000202', tk_status: num('14') }),
    row({ trade_id: '2900000000000000203', tk_status: num('13') }),
  ];
  const { adapter } = setup(onePage(rows));
  const { orders } = await collect(adapter);
  expect(orders.map((order) => [order.order_id, order.raw_status])).toEqual([
    ['2900000000000000201', '12'],
    ['2900000000000000202', '14'],
    ['2900000000000000203', '13'],
  ]);
});
