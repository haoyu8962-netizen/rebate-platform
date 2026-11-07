import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type InviteRewardOrderFact = Pick<
  Selectable<DB['orders']>,
  | 'app_id'
  | 'order_id'
  | 'user_id'
  | 'buy_type'
  | 'base_fen'
  | 'pay_amount_fen'
  | 'attr_at'
  | 'credited_at'
  | 'rebate_status'
  | 'refunded_quantity'
  | 'refunded_quantity_at_credit'
  | 'rights_pending'
> & {
  has_rights: boolean;
  /** Always selected (o.platform); optional in the type to match growth's InviteRewardOrder.platform. */
  platform?: string | null;
};

export interface InviteRewardOrderFactsReader {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; order_id: string },
  ): Promise<InviteRewardOrderFact | null>;
  listSelfOrdersInWindow(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly InviteRewardOrderFact[]>;
}

const FACT_COLUMNS = [
  'o.app_id',
  'o.order_id',
  'o.user_id',
  'o.buy_type',
  'o.base_fen',
  'o.pay_amount_fen',
  'o.attr_at',
  'o.credited_at',
  'o.rebate_status',
  'o.refunded_quantity',
  'o.refunded_quantity_at_credit',
  'o.rights_pending',
  'o.platform',
] as const;

/**
 * Read orders and order_rights on the caller's transaction, with app and attr_at boundaries
 * (task B1-35 §9.2 第 10 条; 08 BR-INV-24 ②「有效期」). Read-only, no row locks, no logging.
 * attr_at is the order's normalised placing instant (BR-ATTR-25), never paid_at or created_at.
 * has_rights: any order_rights row of the sub-order, whatever its status.
 * platform: orders.platform as stored (jd / taobao / pdd …), handed to growth unchanged; growth's
 * clawback judgement gates only jd's refunded_quantity comparison on orders.jd.refunded_quantity_r9_enabled
 * (B1-08zj, FU-INVITE-REWARD-ORDER-PLATFORM; a missing platform would be judged as non-jd).
 */
export function createInviteRewardOrderFacts(): InviteRewardOrderFactsReader {
  function base(trx: Transaction<DB>) {
    return trx
      .withSchema('app')
      .selectFrom('orders as o')
      .select(FACT_COLUMNS)
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('order_rights as r')
              .select('r.id')
              .whereRef('r.app_id', '=', 'o.app_id')
              .whereRef('r.order_id', '=', 'o.order_id'),
          )
          .$castTo<boolean>()
          .as('has_rights'),
      );
  }
  return {
    async read(trx, input) {
      const row = await base(trx)
        .where('o.app_id', '=', input.app_id)
        .where('o.order_id', '=', input.order_id)
        .executeTakeFirst();
      return row ?? null;
    },
    async listSelfOrdersInWindow(trx, input) {
      return base(trx)
        .where('o.app_id', '=', input.app_id)
        .where('o.user_id', '=', input.user_id)
        .where('o.buy_type', '=', 'self')
        .where('o.attr_at', '>=', input.from)
        .where('o.attr_at', '<', input.to)
        .orderBy('o.attr_at')
        .orderBy('o.order_id')
        .execute();
    },
  };
}
