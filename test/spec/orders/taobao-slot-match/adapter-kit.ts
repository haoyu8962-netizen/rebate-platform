import type { CallCtx } from '../../../../apps/api/src/modules/union/index.ts';
import { ctx, listed, num, onePage, row, setup, win } from '../../union/taobao-orders/kit.ts';

export const SITE = '3001';
export const ADZONE = '2002';
export const FULL_PID = 'mm_1001_3001_2002';

export function paidRow(tradeId: string, fields: Record<string, unknown> = {}) {
  return row({
    trade_id: tradeId,
    tk_status: num('12'),
    tk_earning_time: undefined,
    adzone_id: num(ADZONE),
    site_id: num(SITE),
    ...fields,
  });
}

export function listPaidOrders(
  rows: readonly unknown[],
  slots: readonly string[],
  call: CallCtx = ctx,
) {
  const { adapter } = setup(onePage(rows), { slots });
  return listed(adapter.listOrders(win, {}, call));
}
