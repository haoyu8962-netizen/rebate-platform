// B2-09gd: the commission snapshot of an R12 restore (08 BR-CALC-10, BR-FUND-22 迁移表 R12、处理时再核;
// 编排 D10-1093, D10-1105, D10-1117). A VOID order may never have had a snapshot: step ⑥ does not make
// one for an order voided in the same run (BR-ATTR-01 ③ before ⑥), and after R12 the sync no longer
// sees it cross into eligibility. So R12 makes it, on the restore's transaction, under the order key's
// lock the caller holds, with the inputs of the snapshot retry.
// - Not attributed, not yet PAID or later, or a snapshot already made: 'ready', nothing written.
// - The paid time cannot be recovered, a taobao order's promotion-spot scene cannot be read, or no
//   published rule version can be selected: 'unavailable', nothing written; the caller does not restore.
// - A commission not reported yet, or a selected version without the platform's rule or reserve: 'ready'
//   with the usual snapshot-class pending row, which the retry scan and the update path pick up.
// Everything goes through runCommissionSnapshot; a port failure rejects and rolls the restore back.
// Logs carry flat fields only.
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import { isPaidOrLater, type CommissionSnapshotCallInput } from '../domain/commission-snapshot.ts';
import { findPlatformRules } from '../domain/platform-rules/index.ts';
import { planSnapshotRetry, resolveRetryPaidAt } from '../domain/snapshot-retry.ts';
import { readFirstPaidAt } from '../infra/pipeline-store.ts';
import { writePaidAtSource } from '../infra/snapshot-retry-store.ts';
import { runCommissionSnapshot, type CommissionSnapshotPort } from './commission-snapshot-step.ts';
import type { SyncLogger } from './sync-ports.ts';

export type RestoreSnapshotOutcome = 'ready' | 'unavailable';

/** commission's createCommissionSnapshot reason when no published version can be selected. */
const NO_PUBLISHED_VERSION = 'no published rule version';

export interface RestoreSnapshotDeps {
  readonly snapshots: CommissionSnapshotPort;
  /** The order pid's scene on the caller's transaction; null when it cannot be read. */
  readonly pidScene: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly platform: string; readonly pid: string },
  ) => Promise<string | null>;
  /** Whether the order has its commission_splits row, on the caller's transaction. */
  readonly hasSnapshot: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ) => Promise<boolean>;
  /** Whether the app has any published rule version, on the caller's transaction. */
  readonly hasPublishedVersion: (trx: Transaction<DB>, appId: string) => Promise<boolean>;
  readonly logger: SyncLogger;
}

/** Raised by the guarded port before anything is written; never leaves this file. */
class NoPublishedVersion extends Error {}

function buyTypeOf(value: string | null): 'self' | 'share' {
  if (value === 'self' || value === 'share') return value;
  throw new Error('ORDER_BUY_TYPE_INVALID: orders.buy_type 不是 self / share');
}

export function createRestoreSnapshot(deps: RestoreSnapshotDeps) {
  const guarded: CommissionSnapshotPort = {
    async create(trx, input) {
      const result = await deps.snapshots.create(trx, input);
      if (result.kind === 'pending' && result.reason === NO_PUBLISHED_VERSION) {
        throw new NoPublishedVersion();
      }
      return result;
    },
    ...(deps.snapshots.refresh === undefined ? {} : { refresh: deps.snapshots.refresh }),
  };
  const refused = (order: Selectable<DB['orders']>, reason: string): RestoreSnapshotOutcome => {
    deps.logger.warn(
      { platform: order.platform, app_id: order.app_id, reason, outcome: 'restore_refused' },
      'commission snapshot cannot be generated; the order is not restored',
    );
    return 'unavailable';
  };

  return async function restoreSnapshot(
    trx: Transaction<DB>,
    order: Selectable<DB['orders']>,
    now: Date,
  ): Promise<RestoreSnapshotOutcome> {
    if (order.user_id === null || !isPaidOrLater(order.platform_status)) return 'ready';
    // Not commission_version: the sync moves it for a VOID order that never had a snapshot.
    if (await deps.hasSnapshot(trx, { appId: order.app_id, orderId: order.order_id })) {
      return 'ready';
    }

    const source = order.paid_at_source;
    const firstPaidAt =
      source === 'observed' || source === null ? await readFirstPaidAt(trx, order) : null;
    const paid = resolveRetryPaidAt({
      paidAtSource: source,
      paidAt: order.paid_at,
      depositPaidAt: order.deposit_paid_at,
      firstPaidAt,
      now,
    });
    if (paid === null) return refused(order, 'paid_at_unknown');

    const scene =
      order.pid === null || order.pid === ''
        ? null
        : await deps.pidScene(trx, {
            appId: order.app_id,
            platform: order.platform,
            pid: order.pid,
          });
    if (scene === null && findPlatformRules(order.platform)?.taolijinPidScene === true) {
      return refused(order, 'pid_scene_unknown');
    }

    const plan = planSnapshotRetry({
      order: {
        app_id: order.app_id,
        order_id: order.order_id,
        platform: order.platform as CommissionSnapshotCallInput['platform'],
        buy_type: buyTypeOf(order.buy_type),
        activity_type: order.activity_type,
        est_commission_fen: order.est_commission_fen,
        settle_commission_fen: order.settle_commission_fen,
        subsidy_commission_fen: order.subsidy_commission_fen,
      },
      ownerUserId: order.user_id,
      paid,
      serviceFeeFen: order.service_fee_fen ?? 'unknown',
      pidScene: scene,
    });
    // planSnapshotRetry skips only for the two cases refused above.
    if (plan.kind === 'skip') return refused(order, plan.reason);
    // A plan that stops before the port (no commission yet) never learns there is no version.
    if (plan.kind === 'pending' && !(await deps.hasPublishedVersion(trx, order.app_id))) {
      return refused(order, 'no_published_rule_version');
    }
    try {
      await runCommissionSnapshot(
        trx,
        guarded,
        plan,
        {
          app_id: order.app_id,
          platform: order.platform,
          sub_order_id: order.sub_order_id,
          order_id: order.order_id,
          raw_status: null,
          raw_payload_id: order.raw_payload_id,
          now,
        },
        deps.logger,
      );
    } catch (error) {
      if (error instanceof NoPublishedVersion) return refused(order, 'no_published_rule_version');
      throw error;
    }
    // BR-CALC-11: as the retry does, only once the snapshot was asked for with this source.
    if (plan.kind === 'call' && paid.writeSource) {
      await writePaidAtSource(trx, order, plan.input.paidAtSource, now);
    }
    return 'ready';
  };
}

export type RestoreSnapshot = ReturnType<typeof createRestoreSnapshot>;
