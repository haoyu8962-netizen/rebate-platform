// 余额流水「关联单据」（F1-08fe，只加导航）：AdminLedgerEntry.link（type + id）指向的现有后台页。
// - withdrawal → 提现单详情 /withdrawals/{withdrawal_id}；
// - adjustment → 调账与核销，打开该调账单详情；writeoff → 调账与核销的「坏账核销」页签；
// - order → 订单列表，按子订单号搜索（link.id 是 order_key = platform:sub_order_id，不是订单详情
//   地址里的 order_id，所以只能落在列表上，搜不到时列表照常为空）。
import type { Schema } from '@couli/contracts-ts';
import type { AdjustmentsOpening } from '../adjustments/links.ts';

export type LedgerLink = Schema<'AdminLedgerLink'>;

/** A console address with an optional router state. */
export interface LinkTarget {
  readonly to: string;
  readonly state?: unknown;
}

/** Longest q of the orders list (after removing spaces, as the orders page checks it). */
const ORDER_QUERY_MAX = 64;

/** The sub-order number of an order_key (platform:sub_order_id), else the id as it is. */
function orderQueryOf(id: string): string | undefined {
  const colon = id.indexOf(':');
  const q = (colon < 0 ? id : id.slice(colon + 1)).replace(/\s+/g, '');
  return q === '' || q.length > ORDER_QUERY_MAX ? undefined : q;
}

export function linkTarget(link: LedgerLink): LinkTarget {
  switch (link.type) {
    case 'withdrawal':
      return { to: `/withdrawals/${encodeURIComponent(link.id)}` };
    case 'adjustment': {
      const state: AdjustmentsOpening = { adjustmentDetail: link.id };
      return { to: '/adjustments', state };
    }
    case 'writeoff': {
      const state: AdjustmentsOpening = { adjustmentsTab: 'writeoffs' };
      return { to: '/adjustments', state };
    }
    case 'order': {
      const q = orderQueryOf(link.id);
      return q === undefined
        ? { to: '/orders' }
        : { to: '/orders', state: { ordersQuery: { page: 1, q } } };
    }
  }
}

/** Router state of /users that opens one user's detail (as the top-bar search does). */
export function userDetailTarget(userId: string): LinkTarget {
  return { to: '/users', state: { searchUser: userId } };
}
