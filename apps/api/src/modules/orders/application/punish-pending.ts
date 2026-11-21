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
// - order_id: our order of (app, platform, sub_order_id) when we hold it, else null (the evidence
//   is kept either way). detected_at: the window's sync instant (the injected Clock).
// - A failed write is thrown (the queue retries the window).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RegisteredPlatform } from '../../union/index.ts';
import type { PendingReason } from '../infra/pipeline-store.ts';

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

/** The production pending port over app.order_sync_pending (one transaction per signal). */
export function createPunishPendingRecorder(deps: PunishPendingRecorderDeps): PunishPendingPort {
  void deps;
  throw new Error('NotImplemented: createPunishPendingRecorder');
}
