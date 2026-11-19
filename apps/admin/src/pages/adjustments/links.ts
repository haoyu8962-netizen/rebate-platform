// 调账与核销的小链接（F1-08fe，只加导航）：成功提示【查看凭证】要带的余额流水预填（凭证 biz_id，
// BR-FUND-16），以及别的页（余额流水「关联单据」）打开本页时带的路由状态：打开某张调账单的详情，或直接
// 进「坏账核销」页签。只是起始视图，不发写请求；读取照本页原有的读法。
import type { LedgerPrefill } from '../ledger/prefill.ts';
import type { Executed } from './write.ts';

/** The voucher an executed adjustment (new form or reversal) wrote: biz_id = its adjust_id. */
export function voucherOf(executed: Executed): LedgerPrefill {
  return { userId: executed.adjustment.user_id, ref: executed.adjustment.adjust_id };
}

/** Router state of /adjustments opened from another page. */
export type AdjustmentsOpening =
  { readonly adjustmentsTab: 'writeoffs' } | { readonly adjustmentDetail: string };

/** How the page opens for router `state`: the tab to show first and the detail to open. */
export interface Opening {
  readonly tab?: 'adjustments' | 'writeoffs';
  readonly detail?: string;
}

export function openingOf(state: unknown): Opening {
  if (typeof state !== 'object' || state === null) return {};
  if ('adjustmentsTab' in state && state.adjustmentsTab === 'writeoffs')
    return { tab: 'writeoffs' };
  if ('adjustmentDetail' in state) {
    const detail = state.adjustmentDetail;
    if (typeof detail === 'string' && detail !== '') return { tab: 'adjustments', detail };
  }
  return {};
}
