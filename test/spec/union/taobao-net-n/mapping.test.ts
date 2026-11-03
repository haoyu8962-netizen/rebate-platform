// B1-04zz（BR-CALC-03、BR-CALC-18、D10-105、D10-588）：淘宝 N 是净额。est = pub_share_pre_fee_for_commission
// − 预估服务费，settle = pub_share_fee_for_commission − 结算服务费，补贴（*_for_sdy）不进 N；settle 只在
// tk_status=3 读（BR-FUND-02）。服务费先取 alimm_share_info_dto，缺了取 alimama_share_fee，都缺不按 0。
// 真实适配器 + 假传输，两种开关（不开 / CallCtx.rowErrors collect）都跑。报文全部合成。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  mapTaobaoOrder,
  parseTaobaoOrderBody,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { BAD_AMOUNT, fieldNamed } from '../row-quarantine/wires.ts';
import {
  COLLECT,
  forms,
  ILLEGAL,
  inBothModes,
  MODES,
  orderOf,
  PLAIN,
  throughAdapter,
} from '../taobao-negative/negative-wire.ts';
import { instant, num, pageData, reply } from '../taobao-orders/kit.ts';
import { netRow, paidRow } from './net-row.ts';

const EST_FIELD = 'pub_share_pre_fee_for_commission';
const SETTLE_FIELD = 'pub_share_fee_for_commission';

function fees(preFee: unknown, fee: unknown): Record<string, unknown> {
  return {
    alimm_share_info_dto: { alimm_tech_service_pre_fee: preFee, alimm_tech_service_fee: fee },
  };
}

it.each(MODES)(
  '[AC-B1-04zz#1][BR-CALC-03][BR-CALC-18] $mode：佣金 10.00、预估服务费 1.00、补贴 2.00 → est 900，补贴不进 N',
  async ({ call }) => {
    const input = paidRow(1);
    const page = await throughAdapter([input], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, input)).toMatchObject({
      est_commission_fen: 900n,
      commission_fen: 900n,
      service_fee_fen: 100n,
      settle_commission_fen: null,
    });

    const moreSubsidy = paidRow(2, {
      pub_share_pre_fee: '99.00',
      pub_share_pre_fee_for_sdy: num('89.00'),
    });
    const next = await throughAdapter([moreSubsidy], call);
    expect(orderOf(next.items, moreSubsidy).est_commission_fen).toBe(900n);
  },
);

it.each(MODES)(
  '[AC-B1-04zz#2][BR-CALC-03][BR-CALC-18] $mode：已结算（tk_status 3）佣金 9.00、结算服务费 0.80 → settle 820，service_fee_fen 是结算服务费，补贴不进 N',
  async ({ call }) => {
    const input = netRow(1);
    const page = await throughAdapter([input], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, input)).toMatchObject({
      est_commission_fen: 900n,
      commission_fen: 900n,
      settle_commission_fen: 820n,
      service_fee_fen: 80n,
    });
  },
);

it.each(inBothModes([{ status: '12' }, { status: '13' }, { status: '14' }]))(
  '[AC-B1-04zz#3][BR-FUND-02] $mode：tk_status $status 带 tk_earning_time → settle 为 null，结算字段不读：是坏值也不告警、不进 rejected',
  async ({ call, status }) => {
    const input = netRow(1, { tk_status: num(status) });
    const page = await throughAdapter([input], call);
    expect(orderOf(page.items, input)).toMatchObject({
      raw_status: status,
      settle_commission_fen: null,
      est_commission_fen: 900n,
    });

    const broken = netRow(2, { tk_status: num(status), [SETTLE_FIELD]: BAD_AMOUNT });
    const next = await throughAdapter([broken], call);
    expect(next.rejected).toEqual([]);
    expect(orderOf(next.items, broken).settle_commission_fen).toBeNull();
    expect(next.warned.map((warning) => warning.field)).not.toContain(SETTLE_FIELD);
  },
);

const NO_EARNING_TIME: readonly { readonly earning: unknown }[] = [
  { earning: '--' },
  { earning: undefined },
  { earning: null },
];

it.each(NO_EARNING_TIME)(
  '[AC-B1-04zz#4][BR-FUND-02] 不开 collect：结算按状态判：tk_status 3 而 tk_earning_time 为 $earning，settle 照读',
  async ({ earning }) => {
    const input = netRow(1, { tk_earning_time: earning });
    const page = await throughAdapter([input], PLAIN);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, input).settle_commission_fen).toBe(820n);
  },
);

// BR-CALC-03：tk_earning_time 是已结算行的必需字段，缺了不生成快照，不按预估顶替（编排第 5 次）。
it.each(NO_EARNING_TIME)(
  '[AC-B1-04zz#4][BR-CALC-03] collect：tk_status 3 而 tk_earning_time 为 $earning，缺已结算行的必需字段：进 rejected，不留在 items',
  async ({ earning }) => {
    const good = netRow(1);
    const bad = netRow(2, { tk_earning_time: earning });

    const collected = await throughAdapter([good, bad], COLLECT);
    expect(orderOf(collected.items, good).settle_commission_fen).toBe(820n);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([good.trade_id]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed('tk_earning_time')),
      }),
    ]);
  },
);

const FEE_SOURCES: readonly {
  readonly label: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly est: bigint;
  readonly settle: bigint;
  readonly fee: bigint;
}[] = [
  {
    label: 'dto 整个没有',
    row: { alimm_share_info_dto: undefined },
    est: 970n,
    settle: 870n,
    fee: 30n,
  },
  { label: 'dto 是 null', row: { alimm_share_info_dto: null }, est: 970n, settle: 870n, fee: 30n },
  {
    label: 'dto 没有服务费字段',
    row: { alimm_share_info_dto: { alimm_tech_service_rate: num('10') } },
    est: 970n,
    settle: 870n,
    fee: 30n,
  },
  { label: 'dto 字段是「--」', row: fees('--', '--'), est: 970n, settle: 870n, fee: 30n },
  {
    label: 'dto 只有预估服务费',
    row: fees(num('1.00'), undefined),
    est: 900n,
    settle: 870n,
    fee: 30n,
  },
  {
    label: 'dto 只有结算服务费',
    row: fees(undefined, num('0.80')),
    est: 970n,
    settle: 820n,
    fee: 80n,
  },
  { label: 'dto 的 0 是真实值', row: fees(num('0'), num('0')), est: 1000n, settle: 900n, fee: 0n },
];

it.each(inBothModes(FEE_SOURCES))(
  '[AC-B1-04zz#5][BR-CALC-03] $mode：服务费取值，$label → est $est，settle $settle，service_fee_fen $fee',
  async ({ call, row, est, settle, fee }) => {
    const input = netRow(1, row);
    const page = await throughAdapter([input], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, input)).toMatchObject({
      est_commission_fen: est,
      settle_commission_fen: settle,
      service_fee_fen: fee,
    });
  },
);

it.each(MODES)(
  '[AC-B1-04zz#6][BR-CALC-03] $mode：未结算行的 service_fee_fen 是预估服务费，dto 缺了是 alimama_share_fee',
  async ({ call }) => {
    const input = paidRow(1, { alimm_share_info_dto: undefined });
    const page = await throughAdapter([input], call);
    expect(orderOf(page.items, input)).toMatchObject({
      est_commission_fen: 970n,
      service_fee_fen: 30n,
    });
  },
);

const NO_FEE = [undefined, null, '--'].map((alimama) => ({
  label: alimama === undefined ? '缺失' : String(alimama),
  alimama,
}));

// est 为 null 时 commission_fen 同拼多多（AC-B1-08zh#2）：毛额照常，也就是佣金字段收到非负。
// 已结算行拿不到结算服务费：不开 collect 仍是 null，collect 下进 rejected（编排第 4 次 ①）。
it.each(NO_FEE)(
  '[AC-B1-04zz#7][BR-CALC-03] dto 与 alimama_share_fee（$label）都没有 → est、settle、service_fee_fen 都是 null，不按 0，commission_fen 是毛额；未结算行留在 items，已结算行 collect 下进 rejected',
  async ({ alimama }) => {
    const noFee = { alimm_share_info_dto: undefined, alimama_share_fee: alimama };
    const settled = netRow(1, noFee);
    const paid = paidRow(2, noFee);
    const negative = paidRow(3, { ...noFee, [EST_FIELD]: num('-1.00') });
    const rows = [settled, paid, negative];

    const plain = await throughAdapter(rows, PLAIN);
    expect(plain.rejected).toEqual([]);
    for (const input of [settled, paid]) {
      const order = orderOf(plain.items, input);
      expect(order.est_commission_fen).toBeNull();
      expect(order.settle_commission_fen).toBeNull();
      expect(order.service_fee_fen).toBeNull();
      expect(order.commission_fen).toBe(1000n);
    }
    expect(orderOf(plain.items, negative)).toMatchObject({
      est_commission_fen: null,
      commission_fen: 0n,
    });

    const collected = await throughAdapter(rows, COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([
      paid.trade_id,
      negative.trade_id,
    ]);
    expect(collected.rejected.map((row) => row.sub_order_id)).toEqual([settled.trade_id]);
    expect(orderOf(collected.items, paid)).toMatchObject({
      est_commission_fen: null,
      settle_commission_fen: null,
      service_fee_fen: null,
      commission_fen: 1000n,
    });
    expect(orderOf(collected.items, negative)).toMatchObject({
      est_commission_fen: null,
      commission_fen: 0n,
    });
  },
);

const ILLEGAL_FEES: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '「-1.00」', value: '-1.00' },
  { label: 'JSON number -1.00', value: num('-1.00') },
  { label: '非数字', value: BAD_AMOUNT },
  ...ILLEGAL,
];

// 默认行的 alimama_share_fee 是 0.30：回退就成了 970 / 870，按 0 就成了 1000 / 900。
it.each(ILLEGAL_FEES)(
  '[AC-B1-04zz#8][BR-CALC-03] dto 服务费 $label 是非法不是缺失：不回退 alimama_share_fee，不按 0，对应的 N 为 null，告警；结算服务费非法的已结算行 collect 下进 rejected，其余留在 items',
  async ({ value }) => {
    const good = netRow(1);
    const paid = paidRow(2, fees(value, num('0.80')));
    const settled = netRow(3, fees(value, value));
    const estOnly = netRow(4, fees(value, num('0.80')));
    const rows = [good, paid, settled, estOnly];
    const paidOrder = { est_commission_fen: null, service_fee_fen: null, commission_fen: 1000n };
    const estOnlyOrder = {
      est_commission_fen: null,
      settle_commission_fen: 820n,
      service_fee_fen: 80n,
    };

    const plain = await throughAdapter(rows, PLAIN);
    expect(orderOf(plain.items, good).est_commission_fen).toBe(900n);
    expect(plain.rejected).toEqual([]);
    expect(orderOf(plain.items, paid)).toMatchObject(paidOrder);
    expect(orderOf(plain.items, settled)).toMatchObject({
      est_commission_fen: null,
      settle_commission_fen: null,
      service_fee_fen: null,
      commission_fen: 1000n,
    });
    expect(orderOf(plain.items, estOnly)).toMatchObject(estOnlyOrder);
    for (const field of ['alimm_tech_service_pre_fee', 'alimm_tech_service_fee']) {
      expect(plain.warned).toContainEqual({
        event: 'taobao_order_field_invalid',
        field: `alimm_share_info_dto.${field}`,
      });
    }

    const collected = await throughAdapter(rows, COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([
      good.trade_id,
      paid.trade_id,
      estOnly.trade_id,
    ]);
    expect(collected.rejected.map((row) => row.sub_order_id)).toEqual([settled.trade_id]);
    expect(collected.rejected[0]!.detail).not.toContain(BAD_AMOUNT);
    expect(orderOf(collected.items, paid)).toMatchObject(paidOrder);
    expect(orderOf(collected.items, estOnly)).toMatchObject(estOnlyOrder);
  },
);

const BROKEN: readonly {
  readonly label: string;
  readonly value: unknown;
  readonly warns: boolean;
}[] = [
  { label: '缺失', value: undefined, warns: true },
  { label: 'null', value: null, warns: false },
  { label: '「--」', value: '--', warns: false },
  { label: '非数字', value: BAD_AMOUNT, warns: true },
  ...ILLEGAL.map((item) => ({ ...item, warns: true })),
];

it.each(BROKEN)(
  '[AC-B1-04zz#9][BR-CALC-03] 预估佣金字段 $label：不开 collect 时 est 为 null、commission_fen 为 0（没有毛额可用），不回退到含补贴的 pub_share_pre_fee；collect 下进 rejected',
  async ({ value, warns }) => {
    const good = paidRow(1);
    const bad = paidRow(2, { [EST_FIELD]: value });

    const plain = await throughAdapter([good, bad], PLAIN);
    expect(orderOf(plain.items, good).est_commission_fen).toBe(900n);
    expect(orderOf(plain.items, bad)).toMatchObject({
      est_commission_fen: null,
      commission_fen: 0n,
    });
    if (warns) {
      expect(plain.warned).toContainEqual({
        event: 'taobao_order_field_invalid',
        field: EST_FIELD,
      });
    }

    const collected = await throughAdapter([good, bad], COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([good.trade_id]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed(EST_FIELD)),
      }),
    ]);
    expect(collected.rejected[0]!.detail).not.toContain(BAD_AMOUNT);
  },
);

it.each(BROKEN)(
  '[AC-B1-04zz#10][BR-CALC-03] 已结算行的结算佣金字段 $label：不开 collect 时 settle 为 null，collect 下进 rejected，未结算行照常',
  async ({ value, warns }) => {
    const good = netRow(1);
    const bad = netRow(2, { [SETTLE_FIELD]: value });
    const paid = paidRow(3, { [SETTLE_FIELD]: value });

    const plain = await throughAdapter([good, bad, paid], PLAIN);
    expect(orderOf(plain.items, good).settle_commission_fen).toBe(820n);
    expect(orderOf(plain.items, bad).settle_commission_fen).toBeNull();
    if (warns) {
      expect(plain.warned).toContainEqual({
        event: 'taobao_order_field_invalid',
        field: SETTLE_FIELD,
      });
    }

    const collected = await throughAdapter([good, bad, paid], COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([
      good.trade_id,
      paid.trade_id,
    ]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed(SETTLE_FIELD)),
      }),
    ]);
    expect(collected.rejected[0]!.detail).not.toContain(BAD_AMOUNT);
  },
);

it.each([
  ['10.07', '0.07', 1000n],
  ['1.15', '0.15', 100n],
  ['9.999', '0', 999n],
  ['0.29999999999999999', '0', 29n],
  ['10', '0', 1000n],
  ['2.00', '0.999', 101n],
  ['1.00', '0.009', 100n],
  ['12345678901234567.89', '0.89', 1234567890123456700n],
  ['-3.205', '0', -321n],
] as const)(
  '[AC-B1-04zz#11][BR-CALC-26] 佣金 %s、服务费 %s → %s 分：字面值逐字解析，各自 floor 后再减，不经浮点',
  async (text, fee, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const input = netRow(1, {
          [EST_FIELD]: value,
          [SETTLE_FIELD]: value,
          ...fees(num(fee), num(fee)),
        });
        const page = await throughAdapter([input], call);
        expect(page.rejected).toEqual([]);
        expect(orderOf(page.items, input)).toMatchObject({
          est_commission_fen: fen,
          settle_commission_fen: fen,
        });
      }
    }
  },
);

/** A yuan literal and its fen worked out by hand on bigint: mathematical floor. */
function yuan(signed: boolean) {
  return fc
    .tuple(
      signed ? fc.boolean() : fc.constant<boolean>(false),
      fc.bigInt({ min: 0n, max: 10n ** 15n }),
      fc.stringMatching(/^[0-9]{0,6}$/),
    )
    .map(([negative, whole, tail]) => {
      const exact = whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0'));
      const dropped = /[1-9]/.test(tail.slice(2));
      return {
        text: `${negative ? '-' : ''}${whole}${tail === '' ? '' : `.${tail}`}`,
        fen: negative ? -exact - (dropped ? 1n : 0n) : exact,
      };
    });
}

/** One row as listOrders would read it: the real body parser keeps JSON number literals. */
function parsedRow(input: Record<string, unknown>): unknown {
  return parseTaobaoOrderBody(reply(pageData([input])).body).rows[0];
}

// 与 taobao-negative/settled.test.ts 同样的写法：走报文解析 + 映射，不每轮重建适配器；属性体返回布尔，
// fc.assert 外只做一次汇总断言，反例经 not.toThrow 成为 AssertionError。
it('[AC-B1-04zz#12][BR-CALC-03][BR-CALC-26] 任意佣金与服务费：est、settle 逐分等于两边各自 floor 后的差，补贴取什么值都不影响', () => {
  const meta = { rawPayloadId: null, like: new FixedClock(instant).now() };
  expect(() =>
    fc.assert(
      fc.property(yuan(true), yuan(false), yuan(false), (commission, fee, subsidy) => {
        const input = netRow(1, {
          [EST_FIELD]: num(commission.text),
          [SETTLE_FIELD]: num(commission.text),
          pub_share_pre_fee_for_sdy: num(subsidy.text),
          pub_share_fee_for_sdy: num(subsidy.text),
          ...fees(num(fee.text), num(fee.text)),
        });
        const order = mapTaobaoOrder(parsedRow(input), meta, undefined);
        const net = commission.fen - fee.fen;
        return (
          order?.est_commission_fen === net &&
          order.settle_commission_fen === net &&
          order.commission_fen === (net < 0n ? 0n : net)
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 120_000);

it.each(MODES)(
  '[AC-B1-04zz#13][BR-CALC-26] $mode：负数原样：佣金为负或净额为负都保留，commission_fen 取 0；净额恰为 0 是 0',
  async ({ call }) => {
    const negative = netRow(1, { [EST_FIELD]: num('-1.00'), [SETTLE_FIELD]: num('-2.00') });
    const underwater = netRow(2, { [EST_FIELD]: num('0.50'), [SETTLE_FIELD]: num('0.30') });
    const even = netRow(3, { [EST_FIELD]: num('1.00'), [SETTLE_FIELD]: num('0.80') });
    const page = await throughAdapter([negative, underwater, even], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, negative)).toMatchObject({
      est_commission_fen: -200n,
      settle_commission_fen: -280n,
      commission_fen: 0n,
    });
    expect(orderOf(page.items, underwater)).toMatchObject({
      est_commission_fen: -50n,
      settle_commission_fen: -50n,
      commission_fen: 0n,
    });
    expect(orderOf(page.items, even)).toMatchObject({
      est_commission_fen: 0n,
      settle_commission_fen: 0n,
      commission_fen: 0n,
    });
  },
);

const BROKEN_PRE_FEE: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '缺失', value: undefined },
  { label: 'null', value: null },
  { label: '「--」', value: '--' },
  { label: '非数字', value: BAD_AMOUNT },
];

// 这一行为现实现已有，先看净额，所以在新口径之前是红的。
it.each(BROKEN_PRE_FEE)(
  '[AC-B1-04zz#18][BR-CALC-03] pub_share_pre_fee $label：仍是必需字段，佣金字段是好的也一样：不开 collect 跳过并告警，collect 下进 rejected',
  async ({ value }) => {
    const good = paidRow(1);
    const bad = paidRow(2, { pub_share_pre_fee: value });

    const plain = await throughAdapter([good, bad], PLAIN);
    expect(orderOf(plain.items, good).est_commission_fen).toBe(900n);
    expect(plain.items.map((order) => order.sub_order_id)).toEqual([good.trade_id]);
    expect(plain.warned).toContainEqual({
      event: 'taobao_order_row_skipped',
      field: 'pub_share_pre_fee',
    });

    const collected = await throughAdapter([good, bad], COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([good.trade_id]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed('pub_share_pre_fee')),
      }),
    ]);
  },
);

it.each(inBothModes([{ value: '0.00' }, { value: '-5.00' }, { value: '99.00' }]))(
  '[AC-B1-04zz#19][BR-CALC-18] $mode：pub_share_pre_fee 是 $value：合法值只是放行，不进 N，est、commission_fen 仍是 900',
  async ({ call, value }) => {
    const input = paidRow(1, { pub_share_pre_fee: value });
    const page = await throughAdapter([input], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, input)).toMatchObject({
      est_commission_fen: 900n,
      commission_fen: 900n,
    });
  },
);

const SETTLE_FEE_FIELD = 'alimm_share_info_dto.alimm_tech_service_fee';

const UNRESOLVED_SETTLE_FEE: readonly {
  readonly label: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly warned: string;
}[] = [
  {
    label: 'dto 结算服务费「-1.00」',
    row: fees(num('1.00'), '-1.00'),
    warned: SETTLE_FEE_FIELD,
  },
  {
    label: 'dto 结算服务费非数字',
    row: fees(num('1.00'), BAD_AMOUNT),
    warned: SETTLE_FEE_FIELD,
  },
  {
    label: '结算服务费两处都缺',
    row: { ...fees(num('1.00'), undefined), alimama_share_fee: undefined },
    warned: 'alimama_share_fee',
  },
];

// BR-CALC-03：缺字段进待处理，不生成快照。快照的 N 是 settle ?? est（BR-CALC-02），已结算行拿不到结算额而库里 est
// 还在，就成了按预估入账（B1-04zv 防的那件事）。collect 是同步走的路：这一行一律进 rejected（编排第 4 次 ①）。
it.each(UNRESOLVED_SETTLE_FEE)(
  '[AC-B1-04zz#20][BR-CALC-03] 已结算行 $label，预估服务费是好的：不开 collect 时 settle 为 null 加告警，不回退、不按 0；collect 下进 rejected，不留在 items',
  async ({ row, warned }) => {
    const good = netRow(1);
    const bad = netRow(2, row);

    const plain = await throughAdapter([good, bad], PLAIN);
    expect(orderOf(plain.items, good).settle_commission_fen).toBe(820n);
    expect(orderOf(plain.items, bad)).toMatchObject({
      settle_commission_fen: null,
      service_fee_fen: null,
    });
    expect(plain.warned).toContainEqual({ event: 'taobao_order_field_invalid', field: warned });

    const collected = await throughAdapter([good, bad], COLLECT);
    expect(orderOf(collected.items, good).settle_commission_fen).toBe(820n);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([good.trade_id]);
    expect(collected.rejected.map((rejected) => rejected.sub_order_id)).toEqual([bad.trade_id]);
    expect(collected.rejected[0]!.detail).not.toContain(BAD_AMOUNT);
  },
);

const FEE_UNUSABLE: readonly {
  readonly label: string;
  readonly fee: Readonly<Record<string, unknown>>;
  readonly warned: string;
}[] = [
  {
    label: 'dto 缺，alimama_share_fee「-1.00」',
    fee: { alimm_share_info_dto: undefined, alimama_share_fee: '-1.00' },
    warned: 'alimama_share_fee',
  },
  {
    label: 'dto 缺，alimama_share_fee「abc」',
    fee: { alimm_share_info_dto: undefined, alimama_share_fee: 'abc' },
    warned: 'alimama_share_fee',
  },
  {
    label: 'dto 只有 alimm_tech_service_rate，alimama_share_fee 缺',
    fee: {
      alimm_share_info_dto: { alimm_tech_service_rate: num('10') },
      alimama_share_fee: undefined,
    },
    warned: 'alimama_share_fee',
  },
  {
    label: 'dto 是字符串，alimama_share_fee 是好的',
    fee: { alimm_share_info_dto: BAD_AMOUNT },
    warned: 'alimm_share_info_dto',
  },
  {
    label: 'dto 是数组，alimama_share_fee 是好的',
    fee: {
      alimm_share_info_dto: [
        { alimm_tech_service_pre_fee: num('1.00'), alimm_tech_service_fee: num('0.80') },
      ],
    },
    warned: 'alimm_share_info_dto',
  },
];

// 负的 alimama_share_fee 按保留负号算是 1100，按 0 算是 1000 净额；费率不是金额，不拿它算；dto 坏了不回退
// （默认行的 alimama_share_fee 是 0.30，回退就成了 970）。编排第 4 次 ②③。
it.each(FEE_UNUSABLE)(
  '[AC-B1-04zz#23][BR-CALC-03] $label：拿不到服务费，est、service_fee_fen 为 null，不按 0，告警；未结算行留在 items，已结算行不开 collect 时 settle 也为 null，collect 下进 rejected',
  async ({ fee, warned }) => {
    const paid = paidRow(1, fee);
    const settled = netRow(2, fee);
    const noNet = { est_commission_fen: null, service_fee_fen: null, commission_fen: 1000n };

    const plain = await throughAdapter([paid, settled], PLAIN);
    expect(plain.rejected).toEqual([]);
    expect(orderOf(plain.items, paid)).toMatchObject(noNet);
    expect(orderOf(plain.items, settled)).toMatchObject({ ...noNet, settle_commission_fen: null });
    expect(plain.warned).toContainEqual({ event: 'taobao_order_field_invalid', field: warned });

    const collected = await throughAdapter([paid, settled], COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([paid.trade_id]);
    expect(orderOf(collected.items, paid)).toMatchObject(noNet);
    expect(collected.rejected.map((row) => row.sub_order_id)).toEqual([settled.trade_id]);
    expect(collected.rejected[0]!.detail).not.toContain(BAD_AMOUNT);
  },
);
