// B1-04zzh（D10-692 S2）：tk_status 是已结算的唯一判据（D10-588）。缺失或非法时不知道这单结没结算，
// 不得按「未结算」放行进 items（否则已结算单会按预估入账）：collect 下进 rejected，detail 点名 tk_status、
// 不带取值，raw_status 为 null，单号照取；同页好行照常。
import { expect, it } from 'vitest';
import { num, win } from '../taobao-orders/kit.ts';
import { COLLECT, fieldNamed, good, guarded, idOf, rejectedOf, resolvedPage } from './guard-kit.ts';

/** A value that must never reach `detail`. */
const BAD_STATUS = 'sg-bad-tk-status-2718';

/** tk_status values that are no status at all; undefined leaves the key out. */
const BAD_STATUSES: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '缺失', value: undefined },
  { label: 'JSON null', value: null },
  { label: '「--」', value: '--' },
  { label: '非数字串', value: BAD_STATUS },
  { label: '小数', value: num('3.5') },
  { label: '对象', value: { code: num('3') } },
];

/** A row that would be settled by every other field: tk_earning_time and the settlement amounts. */
function settledLooking(index: number, status: unknown): Record<string, unknown> {
  return { ...good(index), tk_status: status };
}

/** A row that looks unsettled otherwise (no earning time, settlement amounts "--"). */
function unsettledLooking(index: number, status: unknown): Record<string, unknown> {
  return {
    ...good(index),
    tk_status: status,
    tk_earning_time: '--',
    pub_share_fee: '--',
    pub_share_fee_for_commission: '--',
  };
}

const CASES = [
  ...BAD_STATUSES.map((status) => ({
    shape: '带结算时间与结算额',
    make: settledLooking,
    ...status,
  })),
  ...BAD_STATUSES.map((status) => ({ shape: '无结算时间', make: unsettledLooking, ...status })),
];

it.each(CASES)(
  '[AC-B1-04zzh#4] collect：$shape的行 tk_status $label → 进 rejected（detail 点名 tk_status），不按未结算放进 items',
  async ({ make, value }) => {
    const s = guarded([good(1), make(2, value), good(3)], { payloadId: '80401' });
    const page = await resolvedPage(() => s.adapter.listOrders(win, {}, COLLECT));
    expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(3)]);
    const rejected = rejectedOf(page);
    expect(rejected).toEqual([
      expect.objectContaining({
        sub_order_id: idOf(2),
        raw_status: null,
        raw_payload_id: '80401',
        detail: expect.stringMatching(fieldNamed('tk_status')),
      }),
    ]);
    for (const secret of [BAD_STATUS, '88.80', '7.66']) {
      expect(rejected[0]!.detail).not.toContain(secret);
    }
  },
);
