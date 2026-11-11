// B1-18e（BR-CALC-03，D10-1250 ②）：淘宝订单报文没有服务费金额时的回退。顺序：
//   ① alimm_share_info_dto 的服务费金额（预估 alimm_tech_service_pre_fee / 结算 alimm_tech_service_fee），缺值取
//      alimama_share_fee——现状（B1-04zz）；
//   ② 都没有金额：同一 dto 的 alimm_tech_service_rate（百分数，同本适配器其他比例字段的 pctStrToBp → bp；单位未实测）；
//   ③ 再没有：配置 union.taobao.service_fee_bp（经适配器的 serviceFeeBp 读取注入；键取报文 order_type 原文，
//      找不到用 "*"）；
//   ④ 都没有：est / settle 为 null（下游进待处理），绝不按 0 扣。
// 服务费 = ceil(gross × bp / 10000)（向上取整，N 取保守值），N = gross − 服务费；service_fee_fen 写实际扣的数。
// gross：est 用 pub_share_pre_fee_for_commission，settle（只 tk_status 3）用 pub_share_fee_for_commission。
// 真实适配器 + 假传输，两种开关（不开 / CallCtx.rowErrors collect）都跑。报文全部合成：字段名照官方
// publisher_order_dto（order_type 是官方字段「订单类型」，如 天猫 / 淘宝 / 聚划算；值自拟），金额不是录制原值。
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  ServiceFeeBpReader,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  mapTaobaoOrder,
  parseTaobaoOrderBody,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { rejectedOf, resolved, TAOBAO } from '../row-quarantine/wires.ts';
import { netRow, paidRow } from '../taobao-net-n/net-row.ts';
import { forms, inBothModes, MODES, orderOf } from '../taobao-negative/negative-wire.ts';
import { instant, num, onePage, pageData, reply, setup, visible } from '../taobao-orders/kit.ts';

const UNVERIFIED = 'taobao_order_service_fee_unverified';
const CONFIG_INVALID = 'taobao_order_service_fee_config_invalid';

const SOURCE = '合成来源：规则测试夹具';

/** 一个订单类型的配置取值（形状由本单定：bp 整数 0..10000、source 非空、verified 布尔）。 */
function entry(bp: unknown, verified: unknown = true, source: unknown = SOURCE) {
  return { bp, source, verified };
}

/**
 * 报文里没有服务费金额：alimama_share_fee 为「--」（无值、不告警），alimm_share_info_dto 只带费率；
 * rate 为 undefined 时整个 dto 不出现。
 */
function noFee(rate?: unknown): Record<string, unknown> {
  return {
    alimama_share_fee: '--',
    alimm_share_info_dto: rate === undefined ? undefined : { alimm_tech_service_rate: rate },
  };
}

/** 未结算行（tk_status 12），预估毛额 `gross`（元），没有服务费金额。 */
function paidNoFee(index: number, gross: string, extra: Record<string, unknown> = {}) {
  return paidRow(index, { pub_share_pre_fee_for_commission: num(gross), ...noFee(), ...extra });
}

/** 已结算行（tk_status 3），预估毛额 `pre`、结算毛额 `settle`（元），没有服务费金额。 */
function settledNoFee(
  index: number,
  pre: string,
  settle: string,
  extra: Record<string, unknown> = {},
) {
  return netRow(index, {
    pub_share_pre_fee_for_commission: num(pre),
    pub_share_fee_for_commission: num(settle),
    ...noFee(),
    ...extra,
  });
}

/** 一页报文经真实适配器；serviceFeeBp 读取恒给 `config`（null = 没有配置）。 */
async function listed(rows: readonly unknown[], call: CallCtx, config: unknown = null) {
  const read = vi.fn<ServiceFeeBpReader>(async () => config);
  const s = setup(onePage(rows), { overrides: { serviceFeeBp: read } });
  const page = await resolved(() => s.adapter.listOrders(TAOBAO.win, {}, call));
  return {
    items: page.items,
    rejected: rejectedOf(page),
    warned: s.orderWarn.mock.calls.map(([warning]) => warning),
  };
}

function eventsOf(warned: readonly { readonly event: string }[], event: string): number {
  return warned.filter((warning) => warning.event === event).length;
}

it.each(MODES)(
  '[AC-B1-18e#1][BR-CALC-03] $mode：未结算行没有服务费金额 → 按 dto 的 alimm_tech_service_rate 扣：毛额 10.01 元、费率 6.00% → 服务费 ceil(60.06)=61，est 940；16.00 元、10% → 160，est 1440；配置在也先用报文费率',
  async ({ call }) => {
    const config = { '*': entry(1000) };
    for (const rate of forms('6.00')) {
      const carry = paidNoFee(1, '10.01', noFee(rate));
      const exact = paidNoFee(2, '16.00', noFee(num('10')));
      const page = await listed([carry, exact], call, config);
      expect(page.rejected).toEqual([]);

      expect(orderOf(page.items, carry)).toMatchObject({
        est_commission_fen: 940n,
        service_fee_fen: 61n,
        commission_fen: 940n,
        settle_commission_fen: null,
      });
      expect(orderOf(page.items, exact)).toMatchObject({
        est_commission_fen: 1440n,
        service_fee_fen: 160n,
        commission_fen: 1440n,
        settle_commission_fen: null,
      });
    }

    // 附带：报文有金额时现状不变（dto 预估服务费 1.00 → est 900），费率与配置都不看。
    const withAmount = paidRow(3, {
      alimm_share_info_dto: {
        alimm_tech_service_pre_fee: num('1.00'),
        alimm_tech_service_fee: num('0.80'),
        alimm_tech_service_rate: '50.00',
      },
    });
    const page = await listed([withAmount], call, config);
    expect(orderOf(page.items, withAmount)).toMatchObject({
      est_commission_fen: 900n,
      service_fee_fen: 100n,
    });
  },
);

it.each(MODES)(
  '[AC-B1-18e#2][BR-CALC-03] $mode：已结算行（tk_status 3）没有服务费金额 → 预估与结算各按报文费率扣：10% 下 16.00 → est 1440，16.05 → 服务费 ceil(160.5)=161、settle 1444；service_fee_fen 是结算服务费 161；collect 下不进 rejected',
  async ({ call }) => {
    const row = settledNoFee(1, '16.00', '16.05', noFee('10.00'));
    const page = await listed([row], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, row)).toMatchObject({
      raw_status: '3',
      est_commission_fen: 1440n,
      settle_commission_fen: 1444n,
      service_fee_fen: 161n,
    });
  },
);

it.each(MODES)(
  '[AC-B1-18e#3][BR-CALC-03] $mode：没有金额、没有费率 → 取配置 union.taobao.service_fee_bp：键取报文 order_type 原文，找不到用 "*"',
  async ({ call }) => {
    const config = { 天猫: entry(600), '*': entry(1000) };
    const tmall = paidNoFee(1, '10.01', { order_type: '天猫' });
    const other = paidNoFee(2, '10.01', { order_type: '聚划算' });
    const untyped = paidNoFee(3, '10.01');
    // 费率字段没有值（「--」）同没有费率。
    const dashRate = paidNoFee(4, '10.00', { order_type: '天猫', ...noFee('--') });
    const settled = settledNoFee(5, '16.00', '16.05', { order_type: '淘宝' });
    const page = await listed([tmall, other, untyped, dashRate, settled], call, config);
    expect(page.rejected).toEqual([]);

    // 天猫：600 bp，ceil(1001 × 600 / 10000) = ceil(60.06) = 61。
    expect(orderOf(page.items, tmall)).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
      commission_fen: 940n,
    });
    // 聚划算、无 order_type：落到 "*" 1000 bp，ceil(100.1) = 101。
    for (const row of [other, untyped]) {
      expect(orderOf(page.items, row)).toMatchObject({
        est_commission_fen: 900n,
        service_fee_fen: 101n,
      });
    }
    // 整除：1000 × 600 / 10000 = 60。
    expect(orderOf(page.items, dashRate)).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 60n,
    });
    // 已结算「淘宝」：落到 "*"；预估 1600 − 160，结算 1605 − ceil(160.5)。
    expect(orderOf(page.items, settled)).toMatchObject({
      est_commission_fen: 1440n,
      settle_commission_fen: 1444n,
      service_fee_fen: 161n,
    });
    // 已核实的取值不发待核实告警，合法配置也不报形状不合法。
    expect(eventsOf(page.warned, UNVERIFIED)).toBe(0);
    expect(eventsOf(page.warned, CONFIG_INVALID)).toBe(0);
  },
);

it.each(MODES)(
  '[AC-B1-18e#4][BR-CALC-03] $mode：配置里既没有该 order_type 也没有 "*" → 当作没有配置，est 为 null（不按 0 扣）；没有配置同样为 null',
  async ({ call }) => {
    const config = { 天猫: entry(600) };
    const tmall = paidNoFee(1, '10.01', { order_type: '天猫' });
    const taobao = paidNoFee(2, '10.01', { order_type: '淘宝' });
    const page = await listed([tmall, taobao], call, config);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, tmall).est_commission_fen).toBe(940n);
    const missing = orderOf(page.items, taobao);
    expect(missing.est_commission_fen).toBeNull();
    expect(missing.service_fee_fen).toBeNull();

    // 附带：没有配置（读取给 null）也是 null，不是毛额。
    const bare = await listed([taobao], call, null);
    expect(orderOf(bare.items, taobao).est_commission_fen).toBeNull();
    expect(orderOf(bare.items, taobao).service_fee_fen).toBeNull();
  },
);

it.each(MODES)(
  '[AC-B1-18e#5][BR-CALC-03] $mode：verified: false（待核实）的取值照常使用、金额同已核实，另发一次 taobao_order_service_fee_unverified 告警；告警不带单号、金额',
  async ({ call }) => {
    const row = paidNoFee(1, '10.01', { order_type: '天猫' });
    const page = await listed([row], call, { 天猫: entry(600, false) });
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, row)).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
    });
    expect(eventsOf(page.warned, UNVERIFIED)).toBe(1);
    const text = visible(page.warned);
    expect(text).not.toContain(String(row.trade_id));
    expect(text).not.toContain('10.01');
  },
);

const INVALID_CONFIG: readonly { readonly label: string; readonly config: unknown }[] = [
  { label: 'bp 非整数 600.5', config: { '*': entry(600.5) } },
  { label: 'bp 为负 -1', config: { '*': entry(-1) } },
  { label: 'bp 越界 10001', config: { '*': entry(10001) } },
  { label: 'bp 是字符串 "600"', config: { '*': entry('600') } },
  { label: 'bp 缺失', config: { '*': { source: '合成来源', verified: true } } },
  { label: '缺 source', config: { '*': { bp: 600, verified: true } } },
  { label: 'source 空串', config: { '*': entry(600, true, '') } },
  { label: '整个值是数字', config: 600 },
  { label: '整个值是数组', config: [entry(600)] },
  { label: '取值不是对象', config: { '*': 600 } },
];

it.each(inBothModes(INVALID_CONFIG))(
  '[AC-B1-18e#6][BR-CALC-03] $mode：配置形状不合法（$label）→ 当作没有配置：est 为 null（不按 0、不按毛额），发 taobao_order_service_fee_config_invalid 告警',
  async ({ call, config }) => {
    const row = paidNoFee(1, '10.01', { order_type: '天猫' });
    const page = await listed([row], call, config);
    expect(page.rejected).toEqual([]);
    const order = orderOf(page.items, row);
    expect(order.est_commission_fen).toBeNull();
    expect(order.service_fee_fen).toBeNull();
    expect(eventsOf(page.warned, CONFIG_INVALID)).toBe(1);
    expect(visible(page.warned)).not.toContain(String(row.trade_id));
  },
);

it.each(MODES)(
  '[AC-B1-18e#7][BR-CALC-03] $mode：bp 边界合法：0 → 服务费 0、est 等于毛额；10000 → 服务费等于毛额、est 0',
  async ({ call }) => {
    const zero = paidNoFee(1, '10.01', { order_type: '天猫' });
    const full = paidNoFee(2, '10.01', { order_type: '淘宝' });
    const page = await listed([zero, full], call, { 天猫: entry(0), 淘宝: entry(10000) });
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, zero)).toMatchObject({
      est_commission_fen: 1001n,
      service_fee_fen: 0n,
    });
    expect(orderOf(page.items, full)).toMatchObject({
      est_commission_fen: 0n,
      service_fee_fen: 1001n,
    });
    expect(eventsOf(page.warned, CONFIG_INVALID)).toBe(0);
  },
);

/** fen → 元文本（两位小数），只用 bigint。 */
function yuanText(fen: bigint): string {
  return `${fen / 100n}.${(fen % 100n).toString().padStart(2, '0')}`;
}

/** bp → 百分数文本（两位小数）。 */
function pctText(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

/** ceil(gross × bp / 10000)，手算于 bigint。 */
function ceilFee(gross: bigint, bp: bigint): bigint {
  return (gross * bp + 9999n) / 10000n;
}

/** listOrders 读到的一行：真实报文解析保留 JSON 数字原文。 */
function parsedRow(input: Record<string, unknown>): unknown {
  return parseTaobaoOrderBody(reply(pageData([input])).body).rows[0];
}

it('[AC-B1-18e#8][BR-CALC-03][BR-CALC-26] 任意毛额与报文费率：服务费 = ceil(gross × bp / 10000)，N = gross − 服务费；预估与结算各算各的，service_fee_fen 取结算那个', () => {
  const meta = { rawPayloadId: null, like: new FixedClock(instant).now() };
  const fen = fc.bigInt({ min: 0n, max: 10n ** 12n });
  fc.assert(
    fc.property(fen, fen, fc.integer({ min: 0, max: 10000 }), (pre, settle, bp) => {
      const rate = pctText(bp);
      const paid = mapTaobaoOrder(
        parsedRow(paidNoFee(1, yuanText(pre), noFee(rate))),
        meta,
        undefined,
      );
      const settled = mapTaobaoOrder(
        parsedRow(settledNoFee(2, yuanText(pre), yuanText(settle), noFee(rate))),
        meta,
        undefined,
      );
      const preFee = ceilFee(pre, BigInt(bp));
      const settleFee = ceilFee(settle, BigInt(bp));
      expect(paid?.est_commission_fen).toBe(pre - preFee);
      expect(paid?.service_fee_fen).toBe(preFee);
      expect(settled?.est_commission_fen).toBe(pre - preFee);
      expect(settled?.settle_commission_fen).toBe(settle - settleFee);
      expect(settled?.service_fee_fen).toBe(settleFee);
      return true;
    }),
    { numRuns: propRuns(), seed: propSeed() },
  );
}, 900_000);

/** 非法的报文费率：不是数字、带符号（同本适配器其他比例字段：符号不放行）。 */
const INVALID_RATES: readonly { readonly label: string; readonly rate: unknown }[] = [
  { label: '「abc」', rate: 'abc' },
  { label: '「1.2.3」', rate: '1.2.3' },
  { label: '「-6.00」', rate: '-6.00' },
  { label: 'JSON number -6.00', rate: num('-6.00') },
];

it.each(inBothModes(INVALID_RATES))(
  '[AC-B1-18e#16][BR-CALC-03] $mode：报文没有服务费金额、alimm_tech_service_rate 非法（$label）→ 不回退配置、也不当作 0：est 为 null；已结算行 settle 也为 null（collect 下进 rejected）；同页费率缺值（「--」）的行照常按配置 "*" 600 bp 扣',
  async ({ call, rate }) => {
    const config = { '*': entry(600) };
    const bad = paidNoFee(1, '10.01', noFee(rate));
    const badSettled = settledNoFee(2, '10.01', '10.01', noFee(rate));
    // 对照：缺值才往下回退（与上面的非法值同页）。
    const dash = paidNoFee(3, '10.01', noFee('--'));
    const page = await listed([bad, badSettled, dash], call, config);

    expect(orderOf(page.items, dash)).toMatchObject({
      est_commission_fen: 940n,
      service_fee_fen: 61n,
    });

    const unsettled = orderOf(page.items, bad);
    expect(unsettled.est_commission_fen).toBeNull();
    expect(unsettled.service_fee_fen).toBeNull();

    if (call.rowErrors === 'collect') {
      // 已结算行没有结算净额：collect 下整行拒收（B1-04zz 现有口径），不以任何金额出现。
      expect(page.items.some((item) => item.sub_order_id === badSettled.trade_id)).toBe(false);
      expect(page.rejected.map((row) => row.sub_order_id)).toEqual([badSettled.trade_id]);
    } else {
      expect(page.rejected).toEqual([]);
      const settled = orderOf(page.items, badSettled);
      expect(settled.est_commission_fen).toBeNull();
      expect(settled.settle_commission_fen).toBeNull();
      expect(settled.service_fee_fen).toBeNull();
    }
  },
);

it.each(MODES)(
  '[AC-B1-18e#17][BR-CALC-03] $mode：报文费率为 0（"0"、"0.00"，字符串或 JSON 数字）是合法的 0 bp，不是缺失：服务费 0、N 等于毛额，不取配置 "*" 600 bp',
  async ({ call }) => {
    const config = { '*': entry(600) };
    for (const rate of [...forms('0'), ...forms('0.00')]) {
      const paid = paidNoFee(1, '10.01', noFee(rate));
      const settled = settledNoFee(2, '16.00', '16.05', noFee(rate));
      const page = await listed([paid, settled], call, config);
      expect(page.rejected).toEqual([]);
      expect(orderOf(page.items, paid)).toMatchObject({
        est_commission_fen: 1001n,
        service_fee_fen: 0n,
        commission_fen: 1001n,
      });
      expect(orderOf(page.items, settled)).toMatchObject({
        est_commission_fen: 1600n,
        settle_commission_fen: 1605n,
        service_fee_fen: 0n,
      });
    }
  },
);
