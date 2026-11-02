import { expect, it } from 'vitest';
import { one, sourceRow, sources, value } from './kit.ts';

it.each(sources)(
  '[AC-B1-08e-SHAPE#1] %s 归一订单标识、推广位、原始归因串与原状态，保留拼多多字段',
  async (source) => {
    const input = sourceRow(source, {
      // 两个推广位故意不同，避免列表误用详情字段，或反过来。
      p_id: 'synthetic-list-slot',
      pid: 'synthetic-detail-slot',
    });
    const dto = await one(source, input);
    const slot = source === 'detail' ? 'synthetic-detail-slot' : 'synthetic-list-slot';
    expect(dto).toMatchObject({
      platform: 'pdd',
      sub_order_id: '000000000000000000000000012345-SYN',
      parent_order_id: null,
      promotion_slot: slot,
      attr_params: {
        relation_id: null,
        custom_parameters: ' { "app": "synthetic-orders-app", "uid": "fake-attr", "sc": 9 } ',
        sub_union_id: null,
      },
      raw_status: '4',
      raw_payload_id: null,
      // 佣金 76543 − 服务费 4321（BR-CALC-03）。
      est_commission_fen: 72222n,
      settle_commission_fen: null,
    });
    // 保留全部 PddOrderFields 的原有单位、接口字段白名单及空值语义。
    expect(dto).toMatchObject({
      order_id: '000000000000000000000000012345-SYN',
      platform_order_id: source === 'increment' ? '000000000000000000000000099999-SYN' : null,
      pid: slot,
      custom_parameters: input.custom_parameters,
      order_status: 4,
      order_status_desc: '合成审核失败说明',
      fail_reason: source === 'detail' ? null : '合成失败原因',
      return_status: null,
      goods_id: '8123456789012345',
      goods_sign: 'synthetic-goods-sign',
      paid_fen: 8765432n,
      commission_fen: 76543n,
      service_fee_fen: 4321n,
      goods_price_fen: 9876543n,
      platform_discount_fen: 6543n,
      sep_market_fee_fen: 2345n,
      promotion_rate: 127n,
      sep_rate: 19n,
      order_create_time: 1791936001,
      order_pay_time: 1791936002,
      order_group_success_time: 1791936003,
      order_receive_time: source === 'increment' ? 1791936004 : null,
      order_verify_time: source === 'increment' ? 1791936005 : null,
      order_settle_time: source === 'detail' ? null : 1791936006,
      order_modify_at: 1791936007,
      url_last_generate_time: source === 'detail' ? 1791936008 : null,
      subsidy_duo_amount_level: 54321n,
      subsidy_duo_amount_ten_million: null,
      subsidy_type: 3,
      subsidy_list: [],
    });
  },
);

it.each(sources)(
  '[AC-B1-08e-SHAPE#2] %s 不解析归因串，零状态与零佣金不是缺失，净额可为负，不推导结算佣金',
  async (source) => {
    const dto = await one(
      source,
      sourceRow(source, {
        custom_parameters: '  not JSON; uid=synthetic-only  ',
        order_status: 0,
        promotion_amount: 0,
        duo_id_service_fee: 500,
        subsidy_duo_amount_level: 999999,
      }),
    );
    expect(dto).toMatchObject({
      attr_params: {
        relation_id: null,
        custom_parameters: '  not JSON; uid=synthetic-only  ',
        sub_union_id: null,
      },
      raw_status: '0',
      // 佣金 0 − 服务费 500：负值保留，不夹成 0。
      est_commission_fen: -500n,
      settle_commission_fen: null,
      commission_fen: 0n,
      order_status: 0,
    });
    expect(value(dto, 'attr_params')).not.toHaveProperty('uid');
  },
);

it.each(sources)('[AC-B1-08e-SHAPE#3] %s 缺失推广位、归因、状态统一为显式 null', async (source) => {
  const input = sourceRow(source);
  for (const key of ['p_id', 'pid', 'custom_parameters', 'order_status']) delete input[key];
  const dto = await one(source, input);
  expect(dto).toMatchObject({
    promotion_slot: null,
    attr_params: { relation_id: null, custom_parameters: null, sub_union_id: null },
    raw_status: null,
    parent_order_id: null,
    pid: null,
    custom_parameters: null,
    order_status: null,
  });
});

it.each(sources)(
  '[AC-B1-08e-SHAPE#4] %s 预估佣金保留整数分上界，扣服务费、不并补贴；服务费缺失 est 为 null',
  async (source) => {
    const dto = await one(source, sourceRow(source, { promotion_amount: 9007199254740991 }));
    // 9007199254740991 − 4321，逐分准确。
    expect(value(dto, 'est_commission_fen')).toBe(9007199254736670n);
    expect(value(dto, 'settle_commission_fen')).toBeNull();
    expect(dto.commission_fen).toBe(9007199254740991n);

    const missing = await one(source, sourceRow(source, { duo_id_service_fee: null }));
    expect(value(missing, 'est_commission_fen')).toBeNull();
    expect(value(missing, 'service_fee_fen')).toBeNull();
    expect(missing.commission_fen).toBe(76543n);
  },
);
