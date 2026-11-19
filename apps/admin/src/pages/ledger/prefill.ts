// 余额流水页的预填地址（F1-08fe）：调账 / 红冲 / 核销成功条的【查看凭证】带着用户与能定位的业务单号
// 跳到 /ledger?user_id=…&ref=…（参数名同 adminListLedgerEntries 的查询参数），本页进页时按地址预填
// 「用户 UID」与「业务单号」并照常查询（只改读取查询参数的部分，不新增写操作）。

/** A ledger page opened for one user, optionally narrowed to one voucher biz_id (`ref`). */
export interface LedgerPrefill {
  readonly userId: string;
  readonly ref?: string;
}

/** The console address of the ledger page for `prefill`: /ledger?user_id=…[&ref=…]. */
export function ledgerRoute(prefill: LedgerPrefill): string {
  const params = new URLSearchParams({ user_id: prefill.userId });
  if (prefill.ref !== undefined) params.set('ref', prefill.ref);
  return `/ledger?${params.toString()}`;
}

/**
 * The prefill of a ledger page opened at `search` (location.search): user_id and ref trimmed;
 * undefined without a user; a blank ref is left out; other parameters are not taken.
 */
export function prefillFromSearch(search: string): LedgerPrefill | undefined {
  const params = new URLSearchParams(search);
  const userId = (params.get('user_id') ?? '').trim();
  if (userId === '') return undefined;
  const ref = (params.get('ref') ?? '').trim();
  return ref === '' ? { userId } : { userId, ref };
}
