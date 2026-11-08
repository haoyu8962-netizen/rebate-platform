// B1-09k: the kind=rights / punish row processors of the rights_import job (08 BR-FUND-06 细则
// 「维权导入任务」; orchestrator ruling D10-152; plan orders-plan-b109-v2 §B1-09k, C-9, J-13, J-22,
// K-3). Rule tests: test/spec/orders/rights-import-rows/**. One row is at most one order_rights
// record, written only through settlement's rights.record (recordOrderRights, B1-09c): orders never
// writes order_rights itself (02 §4.1).
//   - row.values (template column names; the real templates wait for the owner's samples, K-3):
//     `sub_order_id` (text, trimmed), `parent_order_id` (optional column), `platform` (optional
//     column: the platform code of the row), `rights_no` (the platform's rights / violation number;
//     empty → null), `status` (rights only: PROCESSING / SUCCEEDED / FAILED), `amount` and
//     `deduction_commission` (yuan with at most two decimals, a text or a number cell; empty →
//     null), `occurred_at` (required: an ISO 8601 text — with Z or an offset as given, without one
//     or date only read at +08:00 — or a Date cell of the sheet);
//   - judged in this order, a failed row writes nothing: a required cell missing or unreadable →
//     invalid_row; the row's platform ≠ the task's → platform_mismatch; only a parent order number
//     (no sub-order number, or the number is a parent order's: never expanded to its children) →
//     sub_order_no_missing; no sub-order of the task's app and platform → order_not_found; with a
//     window (task from / to) the sub-order's paid_at (time_basis paid) or received_at (time_basis
//     received) must lie in [from, to): outside → skipped (nothing written), received basis and no
//     received_at → received_at_missing (paid basis and no paid_at → outside). No window: no row is
//     filtered. The window is judged on the order re-read under the lock;
//   - rights → type RIGHTS, the row's status; punish → type PUNISH, status SUCCEEDED; source IMPORT,
//     now = the injected Clock; `before` is the order row re-read FOR UPDATE after lockOrderKey of
//     the sub-order (one transaction per row, the lock first);
//   - amounts only through @couli/money's decimal string conversion (a number cell is read as its
//     decimal text), never Number × 100: '0.29' → 29n, '1.15' → 115n;
//   - port answers: applied → succeeded; duplicate (BR-FUND-06 key already imported) → duplicate,
//     not a failure, nothing written again; not_applicable (settlement wrote nothing) → skipped,
//     not a failure and not retried; a thrown error propagates (the job retries the row);
//   - with the job's transaction (rights-import-ports.ts) every statement runs on it and nothing is
//     committed here, so a redelivered row counts once; without one each row is its own transaction;
//   - rights.record not injected: no processor is returned for rights / punish, so the job ends the
//     task failed and logs it at error (J-22); no order_rights is written;
//   - B1-09v (08 BR-TEXT-05 子原因 写入来源 ②, D10-819 ①): a punish task created with a reason_sub
//     part (rights_imports.reason_sub, read on the row's transaction) hands it to rights.record as
//     manual_reason_sub (`none` → null: no sub-reason, still chosen by hand); without one the input
//     carries no manual_reason_sub and the automatic mapping decides, as before. Rights tasks never
//     carry one (D10-819 ②). The choice carries its origin (the task's import_id and created_by)
//     for settlement's audit when it replaces an ended PUNISH order's sub-reason (D10-957).
import type { OrderReasonSub } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { isRegisteredPlatform } from '../../union/index.ts';
import { checkRightsRow, type RightsRowKind } from '../domain/rights-row.ts';
import {
  REASON_SUB_NONE,
  isPunishImportReasonSub,
  type RightsImportRowOutcome,
} from '../domain/rights-import.ts';
import { rereadOrderForUpdate } from '../infra/admin-hold-store.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { readRightsImportReasonSub } from '../infra/rights-import-store.ts';
import { findOrderForRights } from '../infra/rights-order-lookup.ts';
import type {
  RightsImportProcessors,
  RightsImportRow,
  RightsImportRowProcessor,
  RightsImportTaskInfo,
} from './rights-import-ports.ts';
import {
  recordOrderRights,
  type OrderRightsPorts,
  type RightsRecordInput,
} from './rights-ports.ts';

export interface RightsImportRowDeps {
  /** Opens the row's transaction when the job hands none. */
  readonly db: Kysely<DB>;
  /** RightsRecordInput.now. */
  readonly clock: Clock;
  /** settlement's rights.record (B1-09c); absent → no rights / punish processor (J-22). */
  readonly ports: OrderRightsPorts | undefined;
}

const failed = (reason: Extract<RightsImportRowOutcome, { kind: 'failed' }>['reason']) =>
  ({ kind: 'failed', reason }) as const satisfies RightsImportRowOutcome;
const SKIPPED: RightsImportRowOutcome = { kind: 'skipped' };

/**
 * B1-09v: the manual sub-reason of a punish task as rights.record takes it (`none` → value null),
 * from the task's stored rights_imports.reason_sub; undefined for a rights / channel task, or when
 * the task was created without one (or holds a value outside PUNISH's set). D10-957: the choice
 * names its import and the admin who created it, for settlement's audit when it replaces the
 * sub-reason of an order already ended PUNISH.
 */
export function manualChoiceOf(
  task: Pick<RightsImportTaskInfo, 'kind' | 'import_id' | 'created_by'>,
  stored: string | null | undefined,
): RightsRecordInput['manual_reason_sub'] {
  if (task.kind !== 'punish') return undefined;
  const value = stored ?? undefined;
  if (!isPunishImportReasonSub(value)) return undefined;
  return {
    value: value === REASON_SUB_NONE ? null : (value satisfies OrderReasonSub),
    origin: { import_id: task.import_id, admin_id: task.created_by },
  };
}

/** manualChoiceOf on the task's stored part, read on the row's transaction (punish tasks only). */
async function manualReasonSubOf(
  trx: Transaction<DB>,
  task: RightsImportTaskInfo,
): Promise<RightsRecordInput['manual_reason_sub']> {
  if (task.kind !== 'punish') return undefined;
  return manualChoiceOf(task, await readRightsImportReasonSub(trx, task.app_id, task.import_id));
}

/** The window check of the locked order; null: inside the window, or no window. */
function windowOutcome(
  task: RightsImportTaskInfo,
  order: Selectable<DB['orders']>,
): RightsImportRowOutcome | null {
  if (task.from === null || task.to === null || task.time_basis === null) return null;
  const at = task.time_basis === 'received' ? order.received_at : order.paid_at;
  if (at === null) return task.time_basis === 'received' ? failed('received_at_missing') : SKIPPED;
  const ms = at.getTime();
  return ms >= task.from.getTime() && ms < task.to.getTime() ? null : SKIPPED;
}

function createProcessor(
  kind: RightsRowKind,
  deps: RightsImportRowDeps & { readonly ports: OrderRightsPorts },
): RightsImportRowProcessor {
  const { db, clock, ports } = deps;

  async function onTrx(
    trx: Transaction<DB>,
    task: RightsImportTaskInfo,
    row: RightsImportRow,
  ): Promise<RightsImportRowOutcome> {
    const checked = checkRightsRow(kind, row.values, task.created_at);
    if (!checked.ok) return failed('invalid_row');
    const cells = checked.row;
    if (cells.platform !== null && cells.platform !== task.platform) {
      return failed('platform_mismatch');
    }
    if (cells.sub_order_id === null) return failed('sub_order_no_missing');
    if (!isRegisteredPlatform(task.platform)) return failed('order_not_found');
    const found = await findOrderForRights(trx, {
      app_id: task.app_id,
      platform: task.platform,
      platform_order_no: cells.sub_order_id,
    });
    if (found.kind === 'sub_order_no_missing') return failed('sub_order_no_missing');
    if (found.kind === 'not_found') return failed('order_not_found');
    const target = found.order;
    await lockOrderKey(trx, target.platform, target.sub_order_id);
    const before = await rereadOrderForUpdate(trx, task.app_id, target.order_id);
    if (before === undefined) return failed('order_not_found');
    const outside = windowOutcome(task, before);
    if (outside !== null) return outside;
    const manual = await manualReasonSubOf(trx, task);
    const input: RightsRecordInput = {
      before,
      order_id: before.order_id,
      source: 'IMPORT',
      type: kind === 'rights' ? 'RIGHTS' : 'PUNISH',
      status: cells.status,
      amount_fen: cells.amount_fen,
      deduction_commission_fen: cells.deduction_commission_fen,
      occurred_at: cells.occurred_at,
      platform_rights_no: cells.rights_no,
      now: clock.now(),
      ...(manual === undefined ? {} : { manual_reason_sub: manual }),
    };
    const result = await recordOrderRights(trx, ports, input);
    if (result.kind === 'applied') return { kind: 'succeeded' };
    if (result.kind === 'duplicate') return { kind: 'duplicate' };
    return SKIPPED;
  }

  return {
    async process(task, row, trx) {
      return trx === undefined
        ? await db.transaction().execute((own) => onTrx(own, task, row))
        : await onTrx(trx, task, row);
    },
  };
}

/** The rights and punish processors (both, or neither when rights.record is not injected). */
export function createRightsImportProcessors(deps: RightsImportRowDeps): RightsImportProcessors {
  const { ports } = deps;
  if (ports === undefined || typeof ports.rights?.record !== 'function') return {};
  const ready = { ...deps, ports };
  return { rights: createProcessor('rights', ready), punish: createProcessor('punish', ready) };
}
