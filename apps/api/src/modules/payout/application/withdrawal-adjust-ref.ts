// B2-12c: payout's read port for the linked withdrawals of a manual adjustment (08 BR-FUND-24 ②③⑥,
// BR-WDR-33 ⑨): each withdrawal of the app named by the form, with its member and the cash subject
// of its payout channel (alipay → CASH_ALIPAY, wechat → CASH_WECHAT, bank_card → CASH_BANK). Read
// on the caller's executor; IDs not of the app (or not a uuid) are omitted, as is a withdrawal
// whose channel has no cash subject. No writes, no row locks, no logging of payee data.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export type WithdrawalCashSubject = 'CASH_ALIPAY' | 'CASH_WECHAT' | 'CASH_BANK';

export interface WithdrawalAdjustRef {
  readonly withdrawalId: string;
  readonly userId: string;
  readonly cashSubject: WithdrawalCashSubject;
}

/** BR-WDR-33 ⑨: the cash subject of each payout channel (as the landing's W5 posts it). */
const CASH_SUBJECTS: Readonly<Record<string, WithdrawalCashSubject>> = Object.freeze({
  alipay: 'CASH_ALIPAY',
  wechat: 'CASH_WECHAT',
  bank_card: 'CASH_BANK',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readWithdrawalAdjustRefs(
  executor: Kysely<DB> | Transaction<DB>,
  input: { readonly appId: string; readonly withdrawalIds: readonly string[] },
): Promise<ReadonlyMap<string, WithdrawalAdjustRef>> {
  const ids = [...new Set(input.withdrawalIds.filter((id) => UUID.test(id)))].map((id) =>
    id.toLowerCase(),
  );
  const result = new Map<string, WithdrawalAdjustRef>();
  if (ids.length === 0) return result;
  const rows = await executor
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['id', 'user_id', 'payout_channel'])
    .where('app_id', '=', input.appId)
    .where('id', '=', sql<string>`ANY(${ids}::uuid[])`)
    .execute();
  for (const row of rows) {
    const cashSubject = Object.hasOwn(CASH_SUBJECTS, row.payout_channel)
      ? CASH_SUBJECTS[row.payout_channel]
      : undefined;
    if (cashSubject === undefined) continue;
    result.set(row.id, { withdrawalId: row.id, userId: row.user_id, cashSubject });
  }
  return result;
}
