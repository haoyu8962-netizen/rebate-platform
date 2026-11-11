// B1-12j: read-only port for trade notifications (BR-FUND-03, BR-TEXT-09). It returns the
// persisted amount rows of the order's current commission version exactly as stored: no
// recomputation, no filtering of zero shares (the notifier picks share > 0), no fallback to
// another version. The current version is the one recorded on the order row (orchestrator
// decision B1-12j §B.1), read in the same SELECT; nothing is written and no lock is taken, so it
// also runs inside READ ONLY transactions.
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';

export interface ReadNotifyBeneficiariesInput {
  app_id: string;
  order_id: string;
  /**
   * B1-18kn（D10-1274；BR-TEXT-09、BR-CALC-15 终态一路）：为真时订单在终态（VOID、CLAWED_BACK）
   * 就不返回任何金额行，供找回结果通知 CLAIM_RESULT 的 {rebate} 按 0 计终态订单。默认（不传或
   * false）照旧不看订单状态：将来 ORDER_INVALID / CLAWBACK 扇出要读终态订单的受益人，所以不改默认。
   */
  exclude_terminal?: boolean;
}

/** BR-CALC-15 的终态：这些订单的金额行不计入任何应得或待入账。 */
const TERMINAL_REBATE_STATUSES = ['VOID', 'CLAWED_BACK'] as const;

export type NotifyBeneficiary = Pick<
  Selectable<DB['commission_split_amounts']>,
  'user_id' | 'role' | 'amount_fen'
>;

/** B1-12j：只读订单当前版本的金额快照，保留零份额，按 role、user_id 排序；exclude_terminal 见入参。 */
export async function readNotifyBeneficiaries(
  db: Kysely<DB>,
  input: ReadNotifyBeneficiariesInput,
): Promise<NotifyBeneficiary[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('commission_split_amounts as a')
    .innerJoin('orders as o', (join) => {
      const current = join
        .onRef('o.app_id', '=', 'a.app_id')
        .onRef('o.order_id', '=', 'a.order_id')
        .onRef('o.commission_version', '=', 'a.commission_version');
      // 只在显式要求时加终态过滤，默认语句与参数一字不变。
      return input.exclude_terminal === true
        ? current.on('o.rebate_status', 'not in', [...TERMINAL_REBATE_STATUSES])
        : current;
    })
    .select(['a.user_id', 'a.role', 'a.amount_fen'])
    .where('a.app_id', '=', input.app_id)
    .where('a.order_id', '=', input.order_id)
    .where('o.app_id', '=', input.app_id)
    .where('o.order_id', '=', input.order_id)
    .orderBy('a.role')
    .orderBy('a.user_id')
    .execute();
  return rows.map((row) => ({ user_id: row.user_id, role: row.role, amount_fen: row.amount_fen }));
}
