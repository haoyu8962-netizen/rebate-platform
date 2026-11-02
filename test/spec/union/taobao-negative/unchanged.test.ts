// B1-04zw：保留负数不放宽别的。未结算行不读 pub_share_fee；非法写法仍非法；「--」、缺失、null 仍是无值；
// 其他可选金额与比例的负值（含「-0.00」）仍是 null 加告警。这些在实现前本来就成立，所以每条先看同页的
// control()，见 negative-wire.ts。
import { expect, it } from 'vitest';
import type { TaobaoOrderFields } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { fieldNamed } from '../row-quarantine/wires.ts';
import { num, rowOf } from '../taobao-orders/kit.ts';
import {
  COLLECT,
  control,
  forms,
  ILLEGAL,
  inBothModes,
  orderOf,
  PLAIN,
  throughAdapter,
} from './negative-wire.ts';

const NOT_SETTLED: readonly { readonly label: string; readonly earning: unknown }[] = [
  { label: '「--」', earning: '--' },
  { label: '缺失', earning: undefined },
  { label: 'null', earning: null },
];

it.each(inBothModes(NOT_SETTLED))(
  '[AC-B1-04zw#5] $mode：tk_earning_time $label 的行不读负 pub_share_fee，settle_commission_fen 仍 null',
  async ({ call, earning }) => {
    const unsettled = { ...rowOf(2), pub_share_fee: '-1.00', tk_earning_time: earning };
    const page = await throughAdapter([control(), unsettled], call);
    expect(orderOf(page.items, control()).settle_commission_fen).toBe(-100n);
    expect(orderOf(page.items, unsettled).settle_commission_fen).toBeNull();
    expect(page.rejected).toEqual([]);
  },
);

it.each(ILLEGAL)(
  '[AC-B1-04zw#6] 已结算 pub_share_fee $label 仍非法：collect 下进 rejected，不开 collect 是 null 加告警',
  async ({ value }) => {
    const bad: Record<string, unknown> = { ...rowOf(2), pub_share_fee: value };
    const collected = await throughAdapter([control(), bad], COLLECT);
    expect(orderOf(collected.items, control()).settle_commission_fen).toBe(-100n);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([control().trade_id]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed('pub_share_fee')),
      }),
    ]);

    const plain = await throughAdapter([bad], PLAIN);
    expect(orderOf(plain.items, bad).settle_commission_fen).toBeNull();
    expect(plain.warned).toContainEqual(
      expect.objectContaining({ event: 'taobao_order_field_invalid', field: 'pub_share_fee' }),
    );
  },
);

const REQUIRED_ILLEGAL = ['pub_share_pre_fee', 'alipay_total_price'].flatMap((field) =>
  ILLEGAL.map((item) => ({ ...item, field })),
);

it.each(REQUIRED_ILLEGAL)(
  '[AC-B1-04zw#6] 必需字段 $field $label 仍非法：collect 下进 rejected，不开 collect 跳过该行并告警',
  async ({ field, value }) => {
    const bad = { ...rowOf(2), [field]: value };
    const collected = await throughAdapter([control(), bad], COLLECT);
    expect(orderOf(collected.items, control()).settle_commission_fen).toBe(-100n);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([control().trade_id]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: bad.trade_id,
        detail: expect.stringMatching(fieldNamed(field)),
      }),
    ]);

    const plain = await throughAdapter([control(), bad], PLAIN);
    expect(plain.items.map((order) => order.sub_order_id)).toEqual([control().trade_id]);
    expect(plain.warned).toContainEqual(
      expect.objectContaining({ event: 'taobao_order_row_skipped', field }),
    );
  },
);

// 已结算行的 pub_share_fee 是这一行的 N（BR-CALC-03）：无值时 collect 下进 rejected，这条的现行为不变。
// 告警也不变：缺字段告警一次，「--」和 null 是安静的无值。
const NO_VALUE: readonly {
  readonly label: string;
  readonly value: unknown;
  readonly warnedFields: readonly string[];
}[] = [
  { label: '「--」', value: '--', warnedFields: [] },
  { label: '缺失', value: undefined, warnedFields: ['pub_share_fee'] },
  { label: 'null', value: null, warnedFields: [] },
];

it.each(NO_VALUE)(
  '[AC-B1-04zw#6] pub_share_fee $label 仍是无值：不开 collect 是 null；collect 下已结算行进 rejected，未结算行照常',
  async ({ value, warnedFields }) => {
    const empty: Record<string, unknown> = { ...rowOf(2), pub_share_fee: value };
    const plain = await throughAdapter([control(), empty], PLAIN);
    expect(orderOf(plain.items, control()).settle_commission_fen).toBe(-100n);
    expect(orderOf(plain.items, empty).settle_commission_fen).toBeNull();
    expect(plain.warned.map((warning) => warning.field)).toEqual(warnedFields);

    const unsettled: Record<string, unknown> = {
      ...rowOf(3),
      pub_share_fee: value,
      tk_earning_time: '--',
    };
    const collected = await throughAdapter([control(), empty, unsettled], COLLECT);
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([
      control().trade_id,
      unsettled.trade_id,
    ]);
    expect(collected.rejected).toEqual([
      expect.objectContaining({
        sub_order_id: empty.trade_id,
        detail: expect.stringMatching(fieldNamed('pub_share_fee')),
      }),
    ]);
  },
);

interface OtherField {
  /** The upstream field name a warning carries. */
  readonly field: string;
  readonly mapped: keyof TaobaoOrderFields;
  readonly put: (value: unknown) => Record<string, unknown>;
}

function topLevel(field: string, mapped: keyof TaobaoOrderFields): OtherField {
  return { field, mapped, put: (value) => ({ [field]: value }) };
}

function techFee(name: string, mapped: keyof TaobaoOrderFields): OtherField {
  return {
    field: `alimm_share_info_dto.${name}`,
    mapped,
    put: (value) => ({
      alimm_share_info_dto: {
        alimm_tech_service_fee: num('1'),
        alimm_tech_service_pre_fee: num('0.5'),
        [name]: value,
      },
    }),
  };
}

const OTHER_FIELDS: readonly OtherField[] = [
  topLevel('item_price', 'item_price_fen'),
  topLevel('subsidy_fee', 'subsidy_fen'),
  topLevel('alimama_share_fee', 'alimama_share_fen'),
  topLevel('total_commission_fee', 'total_commission_fen'),
  techFee('alimm_tech_service_fee', 'tech_service_fee_fen'),
  techFee('alimm_tech_service_pre_fee', 'tech_service_pre_fee_fen'),
  topLevel('income_rate', 'income_rate_bp'),
  topLevel('pub_share_rate', 'pub_share_rate_bp'),
  topLevel('total_commission_rate', 'total_commission_rate_bp'),
];

it.each(inBothModes(OTHER_FIELDS))(
  '[AC-B1-04zw#6] $mode：$field 的「-1.00」「-0.00」（字符串与 JSON number）仍 null 加告警，行照常返回',
  async ({ call, field, mapped, put }) => {
    for (const value of [...forms('-1.00'), ...forms('-0.00')]) {
      const other = { ...rowOf(2), ...put(value) };
      const page = await throughAdapter([control(), other], call);
      expect(orderOf(page.items, control()).settle_commission_fen).toBe(-100n);
      expect(orderOf(page.items, other)[mapped]).toBeNull();
      expect(page.rejected).toEqual([]);
      expect(page.warned).toEqual([{ event: 'taobao_order_field_invalid', field }]);
    }
  },
);
