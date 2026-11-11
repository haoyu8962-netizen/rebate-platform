// B1-18e（BR-CALC-03，D10-1250 ②）：拼多多订单报文没有 duo_id_service_fee 时的回退。顺序：
//   ① duo_id_service_fee 金额——现状（B1-08zh）：est = promotion_amount − 服务费；
//   ② 缺值：配置 union.pdd.service_fee_bp（只用键 "*"；拼多多报文没有服务费率字段）；
//   ③ 都没有：est 为 null（现状，下游进待处理），绝不按 0 扣。
// 服务费 = ceil(promotion_amount × bp / 10000)（向上取整，N 取保守值），est = promotion_amount − 服务费；
// service_fee_fen 写实际扣的数；commission_fen 仍是毛额 promotion_amount。
// 映射入口 mapPddOrder 的页元数据带配置原值（serviceFeeBp），适配器经构造参数 serviceFeeBp 读取注入。
// 行形状照 pdd-orders/kit.ts（increment 文档字段），值全部合成；order_status 取 0，避开 4 / 10 的失效告警。
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ServiceFeeBpReader,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  mapPddOrder,
  type PddOrderLogger,
  type PddOrderSource,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { mapped as jdOrder } from '../jd-orders/kit.ts';
import { envelope, reply, type Source } from '../orders-shape/kit.ts';
import { ctx, detailRow, endpoint, row, win } from '../pdd-orders/kit.ts';

const UNVERIFIED = 'pdd_service_fee_unverified';
const CONFIG_INVALID = 'pdd_service_fee_config_invalid';
const SOURCES: readonly PddOrderSource[] = ['increment', 'range', 'detail'];
const LIKE = new FixedClock(win.to).now();
const SOURCE_TEXT = '合成来源：规则测试夹具';

/** 一个取值（形状由本单定：bp 整数 0..10000、source 非空、verified 布尔）。 */
function entry(bp: unknown, verified: unknown = true, source: unknown = SOURCE_TEXT) {
  return { bp, source, verified };
}

/** 没有服务费金额、状态为已支付（0）的一行；`promotion` 是佣金毛额（分）。 */
function noFeeRow(
  source: PddOrderSource | Source,
  promotion: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const overrides = {
    order_status: 0,
    fail_reason: undefined,
    duo_id_service_fee: undefined,
    promotion_amount: promotion,
    ...extra,
  };
  return source === 'detail' ? detailRow(overrides) : row(overrides);
}

/** 映射一行，页元数据带配置原值；返回订单与映射发出的告警字段。 */
function mapped(source: PddOrderSource, input: Record<string, unknown>, config: unknown = null) {
  const warn = vi.fn<PddOrderLogger['warn']>();
  const order = mapPddOrder(input, source, {
    rawPayloadId: null,
    like: LIKE,
    logger: { warn },
    serviceFeeBp: config,
  });
  return { order, alerts: warn.mock.calls.map(([fields]) => fields) };
}

function alertsOf(alerts: readonly Readonly<Record<string, unknown>>[], alert: string): number {
  return alerts.filter((fields) => fields.alert === alert).length;
}

it('[AC-B1-18e#9][BR-CALC-03] 没有 duo_id_service_fee → 按配置 "*" 扣：1001 分、600 bp → 服务费 ceil(60.06)=61，est 940；1600、1000 bp → 160，est 1440；1605 → 161，est 1444；commission_fen 仍是毛额', () => {
  for (const source of SOURCES) {
    const carry = mapped(source, noFeeRow(source, 1001), { '*': entry(600) }).order;
    expect(carry, source).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
      commission_fen: 1001n,
      settle_commission_fen: null,
    });
    // JSON null 同没有值。
    const nulled = mapped(source, noFeeRow(source, 1001, { duo_id_service_fee: null }), {
      '*': entry(600),
    }).order;
    expect(nulled.est_commission_fen, source).toBe(940n);

    const config = { '*': entry(1000) };
    expect(mapped(source, noFeeRow(source, 1600), config).order, source).toMatchObject({
      est_commission_fen: 1440n,
      service_fee_fen: 160n,
      commission_fen: 1600n,
    });
    expect(mapped(source, noFeeRow(source, 1605), config).order, source).toMatchObject({
      est_commission_fen: 1444n,
      service_fee_fen: 161n,
      commission_fen: 1605n,
    });

    // 附带：报文有服务费金额时现状不变（按金额扣，不按配置重算）。
    const withAmount = mapped(source, noFeeRow(source, 1001, { duo_id_service_fee: 100 }), config);
    expect(withAmount.order, source).toMatchObject({
      est_commission_fen: 901n,
      service_fee_fen: 100n,
    });
  }
});

it('[AC-B1-18e#10][BR-CALC-03] 拼多多只用键 "*"：别的键不用；没有 "*" 当作没有配置，est 为 null（不按 0 扣）', () => {
  for (const source of SOURCES) {
    const both = mapped(source, noFeeRow(source, 1001), {
      '*': entry(600),
      多多进宝: entry(1000),
    }).order;
    expect(both.est_commission_fen, source).toBe(940n);

    const starless = mapped(source, noFeeRow(source, 1001), { 多多进宝: entry(1000) }).order;
    expect(starless.est_commission_fen, source).toBeNull();
    expect(starless.service_fee_fen, source).toBeNull();
    // 附带：没有配置也是 null。
    expect(mapped(source, noFeeRow(source, 1001), null).order.est_commission_fen).toBeNull();
  }
});

it('[AC-B1-18e#11][BR-CALC-03] verified: false（待核实）照常使用、金额同已核实，另发一次 pdd_service_fee_unverified（platform pdd，不带单号、金额）；已核实不发', () => {
  for (const source of SOURCES) {
    const input = noFeeRow(source, 1001);
    const unverified = mapped(source, input, { '*': entry(600, false) });
    expect(unverified.order, source).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
    });
    expect(alertsOf(unverified.alerts, UNVERIFIED), source).toBe(1);
    expect(unverified.alerts).toContainEqual(
      expect.objectContaining({ alert: UNVERIFIED, platform: 'pdd' }),
    );
    const text = JSON.stringify(unverified.alerts);
    expect(text).not.toContain(String(input.order_sn));
    expect(text).not.toContain('1001');

    const verified = mapped(source, input, { '*': entry(600, true) });
    expect(verified.order.est_commission_fen).toBe(940n);
    expect(alertsOf(verified.alerts, UNVERIFIED), source).toBe(0);
  }
});

const INVALID_CONFIG: readonly { readonly label: string; readonly config: unknown }[] = [
  { label: 'bp 非整数 600.5', config: { '*': entry(600.5) } },
  { label: 'bp 为负 -1', config: { '*': entry(-1) } },
  { label: 'bp 越界 10001', config: { '*': entry(10001) } },
  { label: 'bp 是字符串 "600"', config: { '*': entry('600') } },
  { label: 'bp 缺失', config: { '*': { source: SOURCE_TEXT, verified: true } } },
  { label: '缺 source', config: { '*': { bp: 600, verified: true } } },
  { label: 'source 空串', config: { '*': entry(600, true, '') } },
  { label: '整个值是数字', config: 600 },
  { label: '整个值是数组', config: [entry(600)] },
  { label: '取值不是对象', config: { '*': 600 } },
];

it.each(INVALID_CONFIG)(
  '[AC-B1-18e#12][BR-CALC-03] 配置形状不合法（$label）→ 当作没有配置：est 为 null（不按 0、不按毛额），发一次 pdd_service_fee_config_invalid',
  ({ config }) => {
    for (const source of SOURCES) {
      const input = noFeeRow(source, 1001);
      const { order, alerts } = mapped(source, input, config);
      expect(order.est_commission_fen, source).toBeNull();
      expect(order.service_fee_fen, source).toBeNull();
      expect(order.commission_fen, source).toBe(1001n);
      expect(alertsOf(alerts, CONFIG_INVALID), source).toBe(1);
      expect(alerts).toContainEqual(expect.objectContaining({ platform: 'pdd' }));
      expect(JSON.stringify(alerts)).not.toContain(String(input.order_sn));
    }
  },
);

it('[AC-B1-18e#13][BR-CALC-03] bp 边界合法：0 → 服务费 0、est 等于毛额；10000 → 服务费等于毛额、est 0', () => {
  for (const source of SOURCES) {
    const zero = mapped(source, noFeeRow(source, 1001), { '*': entry(0) });
    expect(zero.order, source).toMatchObject({ est_commission_fen: 1001n, service_fee_fen: 0n });
    expect(alertsOf(zero.alerts, CONFIG_INVALID), source).toBe(0);
    const full = mapped(source, noFeeRow(source, 1001), { '*': entry(10000) });
    expect(full.order, source).toMatchObject({ est_commission_fen: 0n, service_fee_fen: 1001n });
    expect(alertsOf(full.alerts, CONFIG_INVALID), source).toBe(0);
  }
});

/** 真实拼多多适配器，假传输恒答一行 `input`；serviceFeeBp 读取恒给 `config`。 */
function adapterWith(source: Source, input: Record<string, unknown>, config: unknown) {
  const read = vi.fn<ServiceFeeBpReader>(async () => config);
  return new PddUnionAdapter({
    clock: new FixedClock(win.to),
    credentials: async () => ({ clientId: 'synthetic-client', clientSecret: 'fake-secret' }),
    transport: async () => reply(envelope(source, input)),
    endpoint,
    serviceFeeBp: read,
  });
}

async function throughAdapter(source: Source, config: unknown): Promise<UnionOrder> {
  const input = noFeeRow(source, 1001);
  const adapter = adapterWith(source, input, config);
  if (source === 'detail') return adapter.getPddOrderDetail(String(input.order_sn), ctx);
  const page = await adapter.listOrders(win, { queryMode: source }, ctx);
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

it('[AC-B1-18e#14][BR-CALC-03] 适配器经构造参数 serviceFeeBp 读配置：increment、pay_time、详情三条路都按 "*" 600 bp 扣出 est 940；京东订单不受影响', async () => {
  for (const source of ['increment', 'pay_time', 'detail'] as const) {
    const order = await throughAdapter(source, { '*': entry(600) });
    expect(order, source).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
      commission_fen: 1001n,
    });
    // 附带：读取给 null（没有配置）→ est 为 null。
    expect((await throughAdapter(source, null)).est_commission_fen, source).toBeNull();
  }
  // 附带：京东报文是净额，不适用回退（B1-08zh 的同一断言）。
  const jd = jdOrder({});
  expect(jd.est_commission_fen).toBe(123n);
  expect(jd.settle_commission_fen).toBeNull();
});

it('[AC-B1-18e#15][BR-CALC-03] 任意毛额与配置 bp：服务费 = ceil(gross × bp / 10000)，est = gross − 服务费，service_fee_fen 是服务费，commission_fen 是毛额', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 13n }),
      fc.integer({ min: 0, max: 10000 }),
      (gross, bp) => {
        const fee = (gross * BigInt(bp) + 9999n) / 10000n;
        const { order } = mapped('increment', noFeeRow('increment', Number(gross)), {
          '*': entry(bp),
        });
        expect(order.est_commission_fen).toBe(gross - fee);
        expect(order.service_fee_fen).toBe(fee);
        expect(order.commission_fen).toBe(gross);
        return true;
      },
    ),
    { numRuns: propRuns(), seed: propSeed() },
  );
}, 900_000);
