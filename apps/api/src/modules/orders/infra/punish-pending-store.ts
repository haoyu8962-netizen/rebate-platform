// B1-04zzab: the order_sync_pending write of the punish window's pending recorder only
// (application/punish-pending.ts). Not the order sync's writePending / upsertPending
// (pipeline-store.ts): their 「同键冲突只刷新 detected_at、不改 raw_status / detail」 and their repeat
// judgement stay as they are for their callers. Every function here runs in the recorder's
// transaction, after the sub-order's advisory lock (infra/order-lock.ts).
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { PendingReason } from './pipeline-store.ts';

type Trx = Transaction<DB>;

/**
 * Our order of (app, platform, sub_order_id), or null: order_keys read with the app in the
 * predicate, so another app's order_id / attr_at is never read into this app's write (the lock
 * stays on the global sub-order key, taken by the caller).
 */
export async function readOwnOrderId(
  trx: Trx,
  appId: string,
  platform: string,
  subOrderId: string,
): Promise<string | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_keys')
    .select('order_id')
    .where('platform', '=', platform)
    .where('sub_order_id', '=', subOrderId)
    .where('app_id', '=', appId)
    .executeTakeFirst();
  return row?.order_id ?? null;
}

/** At most this many characters of a delivered punish_status go into a detail mark. */
export const PUNISH_MARK_VALUE_MAX = 64;
/** Marks are not appended once the open record's detail is this long (no unbounded growth). */
export const PUNISH_DETAIL_MAX = 2000;
/** Between marks (and after a detail another writer left) in one open record's detail. */
export const PUNISH_MARK_SEPARATOR = '; ';
const MARK_PREFIX = 'punish.window punish_status=';

/**
 * The detail mark of one punish signal: `punish.window punish_status=<value>`, the value cut to
 * PUNISH_MARK_VALUE_MAX code points and escaped so that it never holds the separator (every UTF-16
 * unit outside [0-9A-Za-z_.-] as %uXXXX; lossless, never throws on a lone surrogate).
 */
export function punishMark(rawStatus: string): string {
  const cut = Array.from(rawStatus).slice(0, PUNISH_MARK_VALUE_MAX).join('');
  let escaped = '';
  for (let i = 0; i < cut.length; i += 1) {
    const ch = cut.charAt(i);
    escaped += /[0-9A-Za-z_.-]/.test(ch)
      ? ch
      : `%u${cut.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `${MARK_PREFIX}${escaped}`;
}

export interface PunishPendingInput {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  /** readOwnOrderId's result. */
  readonly order_id: string | null;
  readonly reason: Extract<PendingReason, 'UNFREEZE_SIGNAL' | 'UNMAPPED_STATUS'>;
  /** punish_status as delivered. */
  readonly raw_status: string;
  readonly detected_at: Date;
}

/**
 * One INSERT … ON CONFLICT on order_sync_pending_open_key (no read before it). A new open record:
 * raw_status as delivered, detail = punishMark(raw_status), created_at = detected_at (the Clock).
 * The open record of the key already there (left by this window, or by the order sync's own
 * UNMAPPED_STATUS) — in the one statement:
 * - raw_status, raw_payload_id, created_at, status: as they are;
 * - order_id: kept when set, else ours (null stays null);
 * - detected_at: the later of the stored one and this one (a slower window does not move it back);
 * - detail: this signal's mark appended (separator PUNISH_MARK_SEPARATOR) unless the detail already
 *   holds that mark as one of its parts (a repeat adds nothing), or is PUNISH_DETAIL_MAX long; a
 *   null detail becomes the mark.
 */
export async function upsertPunishPending(trx: Trx, input: PunishPendingInput): Promise<void> {
  const mark = punishMark(input.raw_status);
  await trx
    .withSchema('app')
    .insertInto('order_sync_pending')
    .values({
      app_id: input.app_id,
      platform: input.platform,
      sub_order_id: input.sub_order_id,
      order_id: input.order_id,
      reason: input.reason,
      raw_status: input.raw_status,
      raw_payload_id: null,
      detail: mark,
      detected_at: input.detected_at,
      status: 'open',
      created_at: input.detected_at,
    })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'sub_order_id', 'reason'])
        .where('status', '=', sql.lit('open'))
        .doUpdateSet({
          detected_at: sql<Date>`greatest(order_sync_pending.detected_at, excluded.detected_at)`,
          order_id: sql<string | null>`coalesce(order_sync_pending.order_id, excluded.order_id)`,
          detail: sql<string>`case
            when order_sync_pending.detail is null then excluded.detail
            when excluded.detail = any(string_to_array(order_sync_pending.detail, ${PUNISH_MARK_SEPARATOR})) then order_sync_pending.detail
            when length(order_sync_pending.detail) >= ${PUNISH_DETAIL_MAX} then order_sync_pending.detail
            else order_sync_pending.detail || ${PUNISH_MARK_SEPARATOR} || excluded.detail
          end`,
        }),
    )
    .execute();
}
