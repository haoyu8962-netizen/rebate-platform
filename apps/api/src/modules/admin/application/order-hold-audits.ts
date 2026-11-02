// B1-10i: the latest manual hold of one order for orders' console order detail (GET
// /admin/v1/orders/{order_id}: last_hold_by, last_hold_note, last_hold_at; 方案 K-7). Read only
// over audit_logs by app_id and target `orders:<order_id>`, action `order_hold` (the record POST
// /admin/v1/orders/{order_id}/hold writes, B1-09l): its admin, time and the note of its `after`
// snapshot (null when absent or not a string). Unhold and every other action never count; the
// system's automatic hold is order_auto_hold, so an order_hold row always names an account. No
// judgement here: whether a current system hold hides it is orders' rule. app.module hands this
// to orders, so orders never reads admin's tables.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely, NotNull } from 'kysely';

/** The audit action of a manual hold. */
export const ORDER_HOLD_AUDIT_ACTION = 'order_hold';

export interface OrderHoldAudit {
  readonly admin_id: string;
  readonly note: string | null;
  readonly at: Date;
}

export interface OrderHoldAuditReader {
  /** The newest order_hold record of the order in the app, or null when there is none. */
  latestHold(appId: string, orderId: string): Promise<OrderHoldAudit | null>;
}

function noteOf(after: unknown): string | null {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return null;
  const note = (after as Record<string, unknown>).note;
  return typeof note === 'string' ? note : null;
}

export function createOrderHoldAuditReader(db: Kysely<DB>): OrderHoldAuditReader {
  return Object.freeze({
    async latestHold(appId: string, orderId: string) {
      const row = await db
        .withSchema('app')
        .selectFrom('audit_logs')
        .select(['admin_id', 'after', 'at'])
        .where('app_id', '=', appId)
        .where('target', '=', `orders:${orderId}`)
        .where('action', '=', ORDER_HOLD_AUDIT_ACTION)
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .$narrowType<{ admin_id: NotNull }>()
        .executeTakeFirst();
      if (row === undefined) return null;
      return { admin_id: row.admin_id, note: noteOf(row.after), at: row.at };
    },
  });
}
