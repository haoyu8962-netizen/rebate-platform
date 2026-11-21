// B1-04zzab: the pending records a punish window writes instead of a punishment (08 BR-FUND-22 决-06
// 实测前 A, BR-FUND-02; 规划/12 §1.3 处罚表「解冻」行; orchestrator D10-2335 (c3), D10-2412). Rule tests:
// test/spec/orders/taobao-punish-unfreeze/**.
// - punish_status '1' (unfrozen) → UNFREEZE_SIGNAL; a value other than '0' / '1' → UNMAPPED_STATUS
//   (raw_status the value as delivered). Neither goes to the rights writer: no order_rights row, no
//   R6 / R8, no ledger entry, and an earlier PUNISH clawback stays as it is.
// - One open record per (app, platform, sub_order_id, reason): order_sync_pending_open_key decides, not
//   a read before the insert; a repeat (the window looks back 30 days every 30 minutes, retries,
//   two windows at once) keeps the one open record and throws nothing. A resolved / dismissed
//   record does not stop a new open one.
// - order_id: our order of (app, platform, sub_order_id) when we hold it (order_keys read with the
//   app in the predicate), else null (the evidence is kept either way). detected_at: the window's
//   sync instant (the injected Clock).
// - The window's own upsert (infra/punish-pending-store.ts, not the order sync's writePending): on
//   the open record of the key already there, raw_status stays, this signal's source and value are
//   appended to detail once (a repeat adds nothing), a null order_id is filled with ours (a set one
//   kept), detected_at is the later of the two.
// - A failed write is thrown (the queue retries the window).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RegisteredPlatform } from '../../union/index.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import type { PendingReason } from '../infra/pipeline-store.ts';
import { readOwnOrderId, upsertPunishPending } from '../infra/punish-pending-store.ts';
import { isOrderKeyable } from './row-quarantine.ts';

/** The order_sync_pending reasons a punish window writes. */
export type PunishPendingReason = Extract<PendingReason, 'UNFREEZE_SIGNAL' | 'UNMAPPED_STATUS'>;

/** One punish row that is not a punishment, as the window hands it to the pending port. */
export interface PunishPendingSignal {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  /** The row's order_id: the same number the rights writer finds the sub-order by. */
  readonly sub_order_id: string;
  readonly reason: PunishPendingReason;
  /** UnionPunish.punish_status as delivered. */
  readonly raw_status: string;
  readonly detected_at: Date;
}

export interface PunishPendingPort {
  record(signal: PunishPendingSignal): Promise<void>;
}

export interface PunishPendingRecorderDeps {
  readonly db: Kysely<DB>;
}

/**
 * How a punish row's punish_status is taken (规划/12 §1.3 处罚表; D10-2412):
 * - 'punish': '0' (frozen), or the field absent (null / undefined: kept as on main, counted apart);
 * - a pending reason: '1' (unfrozen) → UNFREEZE_SIGNAL, any other value → UNMAPPED_STATUS.
 */
export function punishStatusKind(
  status: string | null | undefined,
): 'punish' | PunishPendingReason {
  if (status === null || status === undefined || status === '0') return 'punish';
  return status === '1' ? 'UNFREEZE_SIGNAL' : 'UNMAPPED_STATUS';
}

/**
 * The production pending port over app.order_sync_pending (one transaction per signal). As the
 * row quarantine (application/row-quarantine.ts): the sub-order's advisory lock first (when the
 * number can be an order key; the global key, so it is serialised with the order pipeline),
 * order_keys read for order_id with app_id in the predicate, then upsertPunishPending — one
 * INSERT … ON CONFLICT on order_sync_pending_open_key (see its comment for the conflict update).
 * Writes nothing else: no orders column, no order_rights, no event.
 */
export function createPunishPendingRecorder(deps: PunishPendingRecorderDeps): PunishPendingPort {
  return {
    async record(signal) {
      await deps.db.transaction().execute(async (trx) => {
        let orderId: string | null = null;
        if (isOrderKeyable(signal.platform, signal.sub_order_id)) {
          await lockOrderKey(trx, signal.platform, signal.sub_order_id);
          orderId = await readOwnOrderId(trx, signal.app_id, signal.platform, signal.sub_order_id);
        }
        await upsertPunishPending(trx, {
          app_id: signal.app_id,
          platform: signal.platform,
          sub_order_id: signal.sub_order_id,
          order_id: orderId,
          reason: signal.reason,
          raw_status: signal.raw_status,
          detected_at: signal.detected_at,
        });
      });
    },
  };
}
