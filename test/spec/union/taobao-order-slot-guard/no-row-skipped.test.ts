// B1-04zzh（D10-692 S2）：collect 下坏行由订单同步写待处理表并打 order_row_invalid，适配器不再另打
// taobao_order_row_skipped（同一行两条告警）。行照样进 rejected，同页好行照常；不开 collect 的跳过加告警
// 不变（冻结的 AC-B1-04f#34 钉着）。
import { expect, it } from 'vitest';
import { rowOf, win } from '../taobao-orders/kit.ts';
import {
  COLLECT,
  fieldNamed,
  good,
  guarded,
  idOf,
  rejectedOf,
  resolvedPage,
  warned,
} from './guard-kit.ts';

/** Rows the collect mapping refuses, each naming its field; undefined leaves the key out. */
const BAD_ROWS: readonly {
  readonly label: string;
  readonly field: string;
  readonly row: Record<string, unknown>;
}[] = [
  { label: 'trade_id 缺失', field: 'trade_id', row: { ...good(2), trade_id: undefined } },
  {
    label: 'alipay_total_price 非数字',
    field: 'alipay_total_price',
    row: { ...good(2), alipay_total_price: 'sg-bad-amount' },
  },
  {
    label: 'pub_share_pre_fee 缺失',
    field: 'pub_share_pre_fee',
    row: { ...good(2), pub_share_pre_fee: undefined },
  },
  {
    label: 'pub_share_pre_fee_for_commission 缺失',
    field: 'pub_share_pre_fee_for_commission',
    row: { ...good(2), pub_share_pre_fee_for_commission: undefined },
  },
  {
    label: '已结算行缺 pub_share_fee_for_commission',
    field: 'pub_share_fee_for_commission',
    row: rowOf(2),
  },
];

it.each(BAD_ROWS)(
  '[AC-B1-04zzh#5] collect：$label → 进 rejected，适配器 warn 钩子里没有 taobao_order_row_skipped',
  async ({ field, row }) => {
    const s = guarded([good(1), row, good(3)], { payloadId: '80501' });
    const page = await resolvedPage(() => s.adapter.listOrders(win, {}, COLLECT));
    expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(3)]);
    expect(rejectedOf(page)).toEqual([
      expect.objectContaining({
        raw_payload_id: '80501',
        detail: expect.stringMatching(fieldNamed(field)),
      }),
    ]);
    expect(warned(s.orderWarn).map((event) => event.event)).not.toContain(
      'taobao_order_row_skipped',
    );
  },
);
