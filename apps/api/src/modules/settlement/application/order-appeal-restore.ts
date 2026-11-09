// B2-09gd: producer of the order-appeal restore difference (08 BR-FUND-22 申诉恢复 ①, BR-ID-36;
// contracts/openapi.yaml adminResolveAppeal: an order appeal revoked → settlement creates it). Consumer
// `settlement-order-appeal-restore` of appeal.resolved (EVENT_SUBSCRIPTIONS), on the consumer's
// transaction:
//   any other target or decision: acknowledged, nothing written;
//   a malformed event, no such order, or a VOID order without its entry row: rejects (retry, then dead
//   letter): a money producer does not guess;
//   the order key's lock, the order read again under it: not VOID or not reason BLACKLIST → one warn
//   line, acknowledged, nothing registered (a retry would not change it);
//   otherwise one ledger registerReconDiffOnce: type appeal_restore, source R3, ref_id
//   `{order_key}#RESTORE#{entry_id}` as the platform restore has it, so the handler is the same R12.
// Deduplicated by the history row that entered VOID, not by the appeal: a replay, a new event id or a
// second appeal revoked over the same voiding find the same difference; voided again and revoked again
// is a new one. Registering never changes the order, posts nothing and writes no audit (处理前不入账).
import type { DB } from '@couli/db';
import { chinaMonth, orderKey } from '@couli/domain';
import { subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { registerReconDiffOnce } from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import type {
  Clock,
  EventHandler,
  JobPayload,
  ReceivedEvent,
  RootLogger,
} from '../../platform/index.ts';
import { readOrderLocator } from '../credit/credit-store.ts';
import { readRebateEntryId } from '../infra/platform-restore-store.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { effectiveCommissionPositive } from './platform-restore-plan.ts';

export type OrderAppealRestoreConsumer = 'settlement-order-appeal-restore';

/** resolution.reason_code of this difference; what admin-recon-restore dispatches on. */
export const ORDER_APPEAL_RESTORE_REASON = 'BLACKLIST';

export interface OrderAppealRestoreDeps {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const TARGET_TYPES: ReadonlySet<string> = new Set(['account', 'order', 'blocked_request']);
const STATUSES: ReadonlySet<string> = new Set(['revoked', 'upheld']);

interface AppealResolved {
  readonly app_id: string;
  readonly appeal_id: string;
  readonly user_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
}

function readPayload(event: ReceivedEvent): AppealResolved {
  if (event.name !== 'appeal.resolved') {
    throw new Error('settlement: order appeal restore consumes appeal.resolved only');
  }
  const value = event.payload as Partial<Record<keyof AppealResolved, unknown>>;
  if (
    value.app_id !== event.appId ||
    typeof value.appeal_id !== 'string' ||
    value.appeal_id.length === 0 ||
    !(value.user_id === null || typeof value.user_id === 'string') ||
    typeof value.target_type !== 'string' ||
    !TARGET_TYPES.has(value.target_type) ||
    typeof value.target_id !== 'string' ||
    value.target_id.length === 0 ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status)
  ) {
    throw new Error('settlement: invalid appeal.resolved payload');
  }
  return value as AppealResolved;
}

async function register(
  trx: Transaction<DB>,
  deps: OrderAppealRestoreDeps,
  data: AppealResolved,
): Promise<void> {
  const appId = data.app_id;
  const locator = await readOrderLocator(trx, appId, data.target_id);
  if (locator === undefined)
    throw new Error('settlement: appeal.resolved names no order of the app');
  await lockOrderKey(trx, locator.platform, locator.sub_order_id);
  const order = await readRebateOrder(trx, {
    appId,
    orderId: data.target_id,
    attrAt: locator.attr_at,
  });
  if (order === undefined) throw new Error('settlement: appeal.resolved names no order of the app');
  if (order.rebate_status !== 'VOID' || order.reason !== ORDER_APPEAL_RESTORE_REASON) {
    deps.logger.warn(
      { app_id: appId, platform: order.platform, outcome: 'order_appeal_restore_skipped' },
      'order_appeal_restore_skipped',
    );
    return;
  }
  const entryId = await readRebateEntryId(trx, appId, order.order_id, 'VOID');
  if (entryId === undefined) throw new Error('settlement: the VOID order has no entry row');
  const key = orderKey(order.platform, order.sub_order_id);
  const expectedFen = effectiveCommissionPositive(
    order.settle_commission_fen,
    order.est_commission_fen,
  );
  const resolution: JobPayload = {
    reason_code: ORDER_APPEAL_RESTORE_REASON,
    appeal_id: data.appeal_id,
    order_id: order.order_id,
    order_key: key,
    user_id: order.user_id,
    rebate_status: 'VOID',
    platform_status: order.platform_status,
  };
  await registerReconDiffOnce(
    trx,
    {
      appId,
      type: 'appeal_restore',
      source: 'R3',
      period: chinaMonth(deps.clock.now()),
      refType: 'order',
      refId: `${key}#RESTORE#${entryId.toString(10)}`,
      expectedFen,
      actualFen: 0n,
      diffFen: subFen(expectedFen, 0n),
      dedupeKey: `appeal_restore:order:${appId}:${key}:${entryId.toString(10)}`,
      resolution,
    },
    { clock: deps.clock },
  );
}

/** The appeal.resolved handler that registers the restore difference of a revoked order appeal. */
export function createOrderAppealRestoreHandler(deps: OrderAppealRestoreDeps): EventHandler {
  return async (event, trx) => {
    const data = readPayload(event);
    if (data.target_type !== 'order' || data.status !== 'revoked') return;
    await register(trx, deps, data);
  };
}
