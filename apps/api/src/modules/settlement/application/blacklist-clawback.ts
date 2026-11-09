// B2-04zzl: the manual review of a CREDITED order that hit the blacklist (08 BR-ATTR-26, BR-FUND-01
// R8 BLACKLIST_CONFIRMED, BR-FUND-08; contracts/openapi.yaml blacklistClawbackAdminReconDiff,
// CT-24zzf r1–r3; D10-1035, D10-1095, D10-1101). The rule tests in
// test/spec/settlement/blacklist-clawback/** pin what is written here.
//
// 1. createBlacklistAfterCreditHandler(options) → EventHandler(event, trx)
//    Consumer `settlement-blacklist-after-credit` of order.blacklist_hit_after_credit, registered
//    once by the worker entry (SettlementModule.forWorker). event.payload is { order_id, platform,
//    dimensions }. Under the order key's advisory lock, on the consumer's transaction:
//    - The order still CREDITED: one recon_diffs row through ledger's registerReconDiffOnce: type
//      blacklist_after_credit, source R3, period the accounting month at registration, ref_type
//      order, ref_id `{order_key}#BLACKLIST#{dimensions sorted, joined by ','}`, expected_fen the
//      order's booked_n_fen, actual_fen 0, diff_fen expected − actual, resolution { dimensions }.
//    - dedupe_key has no period, so one order and dimension set registers once whatever the
//      delivery, the event id or the month; a stored row is never overwritten, closed or not.
//      Another dimension set of the same order is another row, whatever the earlier row's status.
//    - An order of no such app, or no longer CREDITED: nothing written, the delivery is acknowledged.
//    - No voucher, no withdrawal hold, no change to the order (BR-ATTR-26 asks for a manual review).
//    - The switch is not read: order.blacklist_clawback.enabled gates the confirmation only.
//
// 2. confirmBlacklistClawback(deps, operator, reconDiffId, request) → the exact bytes to send
//    Under platform idempotency in its transactional mode (subject a:<admin_users.id>, the concrete
//    path, the Idempotency-Key header; 2xxxx refusals are not stored). In the contract's order of
//    checks: the body (note) → the app's R1–R3 difference → its status → its type and ref_id's order
//    → the switch (on only when the stored value is true) → the order key's advisory lock, the
//    difference's row (its status judged again), then deps.clawback.apply with cause
//    BLACKLIST_CONFIRMED and ref { kind: 'blacklist', reconDiffId }, which takes the users rows and
//    the balances (settlement AGENTS.md 硬规则 3) and answers skipped when the order is no longer
//    CREDITED (→ 20902 order, nothing written).
//    clawed_back_fen is what the beneficiaries' nets fell by across the apply, read through ledger
//    getOrderNets on the transaction: it counts a share booked to bad debt and leaves out the
//    platform's part (contract AdminReconDiffBlacklistClawback). Any failure rolls everything back
//    (5xx) and leaves no idempotency record.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { chinaMonth, orderKey } from '@couli/domain';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  adjustRestoredReconDiff,
  getOrderNets,
  lockReconDiffForRestore,
  readReconDiffForRestore,
  registerReconDiffOnce,
  type OrderNets,
  type ReconDiffRestoreRow,
} from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type EventBus,
  type EventHandler,
  type FieldCrypto,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type RootLogger,
} from '../../platform/index.ts';
import type { ClawbackOrder } from '../clawback/index.ts';
import { readOrderLocator } from '../credit/credit-store.ts';
import { findOrderOfKey } from '../infra/platform-restore-store.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';

/** The consumer's name in the event catalog (queue evt.settlement-blacklist-after-credit). */
export const BLACKLIST_AFTER_CREDIT_CONSUMER = 'settlement-blacklist-after-credit';
/** The audit action of the contract (blacklistClawbackAdminReconDiff). */
export const RECON_DIFF_BLACKLIST_CLAWBACK_AUDIT_ACTION = 'recon_diff_blacklist_clawback';

/** content's switch: on only when the stored value is true; unset is off (D10-1095 ③). */
const SWITCH = 'order.blacklist_clawback.enabled';
const DIFF_TYPE = 'blacklist_after_credit';
const REF_SEPARATOR = '#BLACKLIST#';
const CREDITED = 'CREDITED';
const CLAWED_BACK = 'CLAWED_BACK';
/** Contract AdminReconDiffBlacklistClawbackRequest.note: 1–200 characters after trimming. */
const NOTE_MAX = 200;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

export interface BlacklistAfterCreditOptions {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
}

export interface BlacklistClawbackDeps {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the confirmation's transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly clawback: Pick<ClawbackOrder, 'apply'>;
  /** content's configuration: order.blacklist_clawback.enabled is on only when it is true. */
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
}

/** What app.module hands in: settlement's R8 over the owners' exports, as on the worker. */
export interface AdminBlacklistClawbackPorts {
  readonly blacklistClawback: (
    assembly: {
      readonly db: Kysely<DB>;
      readonly clock: Clock;
      readonly logger: RootLogger;
      readonly events: Pick<EventBus, 'publish'>;
    },
    crypto: FieldCrypto,
  ) => Pick<ClawbackOrder, 'apply'>;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface BlacklistClawbackOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface BlacklistClawbackRequest {
  readonly body: Schema<'AdminReconDiffBlacklistClawbackRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** `{order_key}#BLACKLIST#{dimensions in dictionary order, joined by ','}`, without repeats. */
export function blacklistRefIdOf(key: string, dimensions: readonly string[]): string {
  return `${key}${REF_SEPARATOR}${sortedDimensions(dimensions).join(',')}`;
}

function sortedDimensions(dimensions: readonly string[]): string[] {
  return [...new Set(dimensions)].sort();
}

/** The order a difference's ref names; null for a ref_type or ref_id of any other shape. */
export function parseBlacklistRef(
  refType: string | null,
  refId: string | null,
): { readonly platform: string; readonly subOrderId: string } | null {
  if (refType !== 'order' || refId === null) return null;
  const at = refId.indexOf(REF_SEPARATOR);
  if (at <= 0) return null;
  const key = refId.slice(0, at);
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1 || key.includes(':', colon + 1)) return null;
  return { platform: key.slice(0, colon), subOrderId: key.slice(colon + 1) };
}

/** What the beneficiaries' nets fell by between two reads; the platform's net is not counted. */
export function clawedBackFenOf(before: OrderNets, after: OrderNets): bigint {
  const identity = (b: OrderNets['beneficiaries'][number]) =>
    JSON.stringify([b.beneficiary_user_id, b.role]);
  const remaining = new Map(after.beneficiaries.map((b) => [identity(b), b.net_fen]));
  let total = 0n;
  for (const b of before.beneficiaries) {
    const taken = subFen(b.net_fen, remaining.get(identity(b)) ?? 0n);
    if (taken > 0n) total = addFen(total, taken);
  }
  return total;
}

function hitOf(payload: unknown): { orderId: string; dimensions: string[] } {
  const hit = payload as { order_id?: unknown; dimensions?: unknown } | null;
  const orderId = hit?.order_id;
  const dimensions = hit?.dimensions;
  if (typeof orderId !== 'string' || orderId === '') {
    throw new TypeError('settlement blacklist review: order_id must be a nonempty string');
  }
  if (
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    !dimensions.every((d): d is string => typeof d === 'string' && d !== '')
  ) {
    throw new TypeError('settlement blacklist review: dimensions must be nonempty strings');
  }
  return { orderId, dimensions };
}

/** The handler registerEventConsumer runs inside its claim transaction (worker wiring). */
export function createBlacklistAfterCreditHandler(
  options: BlacklistAfterCreditOptions,
): EventHandler {
  const { clock, logger } = options;
  return async (event, trx) => {
    const { appId } = event;
    const { orderId, dimensions } = hitOf(event.payload);
    const locator = await readOrderLocator(trx, appId, orderId);
    if (locator === undefined) {
      logger.warn({ app_id: appId, order_id: orderId }, 'blacklist_review_order_not_found');
      return;
    }
    await lockOrderKey(trx, locator.platform, locator.sub_order_id);
    const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
    if (order?.rebate_status !== CREDITED) return;
    if (order.booked_n_fen === null) {
      throw new Error('settlement blacklist review: CREDITED order without booked_n_fen');
    }
    const refId = blacklistRefIdOf(orderKey(locator.platform, locator.sub_order_id), dimensions);
    const { inserted } = await registerReconDiffOnce(
      trx,
      {
        appId,
        type: DIFF_TYPE,
        source: 'R3',
        period: chinaMonth(clock.now()),
        refType: 'order',
        refId,
        expectedFen: order.booked_n_fen,
        actualFen: 0n,
        diffFen: subFen(order.booked_n_fen, 0n),
        dedupeKey: `${DIFF_TYPE}:${refId}`,
        resolution: { dimensions: sortedDimensions(dimensions) },
      },
      { clock },
    );
    if (inserted) logger.info({ app_id: appId, order_id: orderId }, 'blacklist_review_registered');
  };
}

function isOpen(row: ReconDiffRestoreRow): boolean {
  return row.status === 'open' || row.status === 'processing';
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

/** 20001 data.fields=[recon_diff_id] with the reason of the contract. */
function guardRefusal(
  reason: 'blacklist_clawback_not_supported' | 'blacklist_clawback_disabled',
  traceId: string,
): HandlerResult {
  const refused = fieldsErrorEnvelope(['recon_diff_id'], traceId);
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(resource: 'recon_diff' | 'order', traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: { code: 20902, msg: CONFLICT_MESSAGE, data: { resource }, trace_id: traceId },
  };
}

/** POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback, under the guard. */
export function confirmBlacklistClawback(
  deps: BlacklistClawbackDeps,
  operator: BlacklistClawbackOperator,
  reconDiffId: string,
  request: BlacklistClawbackRequest,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const traceId = request.traceId;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: `/admin/v1/recon-diffs/${reconDiffId}/blacklist-clawback`,
      key: request.key,
      body: request.body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      let note: string | undefined;
      if (request.body.note !== undefined) {
        note = request.body.note.trim();
        const length = [...note].length;
        if (length < 1 || length > NOTE_MAX) return fieldsRefusal(['note'], traceId);
      }
      const seen = await readReconDiffForRestore(trx, appId, reconDiffId);
      if (seen === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
      if (!isOpen(seen)) return conflictRefusal('recon_diff', traceId);
      const ref = seen.type === DIFF_TYPE ? parseBlacklistRef(seen.ref_type, seen.ref_id) : null;
      if (ref === null) return guardRefusal('blacklist_clawback_not_supported', traceId);
      const located = await findOrderOfKey(trx, appId, ref.platform, ref.subOrderId);
      if (located === undefined) return guardRefusal('blacklist_clawback_not_supported', traceId);
      if ((await deps.config.get(appId, SWITCH)) !== true) {
        return guardRefusal('blacklist_clawback_disabled', traceId);
      }

      await lockOrderKey(trx, ref.platform, ref.subOrderId);
      const row = await lockReconDiffForRestore(trx, appId, seen.id);
      if (row === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
      if (!isOpen(row)) return conflictRefusal('recon_diff', traceId);

      const key = orderKey(ref.platform, ref.subOrderId);
      const before = await getOrderNets(trx, { appId, orderKey: key });
      const result = await deps.clawback.apply(trx, {
        appId,
        orderId: located.order_id,
        cause: 'BLACKLIST_CONFIRMED',
        ref: { kind: 'blacklist', reconDiffId: row.id },
        newCommissionFen: null,
        rightsDeductFen: null,
      });
      if (result.outcome === 'skipped' && result.reason === 'not_credited') {
        return conflictRefusal('order', traceId);
      }
      if (result.outcome !== 'clawed_back' || result.transition !== 'R8') {
        // A full cause on a CREDITED order is always R8; refuse rather than close the difference.
        throw new Error(`settlement blacklist clawback: unexpected outcome ${result.outcome}`);
      }
      const total = clawedBackFenOf(before, await getOrderNets(trx, { appId, orderKey: key }));

      const now = deps.clock.now();
      const written = await adjustRestoredReconDiff(trx, {
        appId,
        id: row.id,
        handlerId: adminId,
        at: now,
        resolution: {
          ...((row.resolution ?? {}) as Record<string, unknown>),
          clawback: {
            operator: adminId,
            clawed_back_at: now.toISOString(),
            clawed_back_fen: fenToJsonNumber(total),
          },
          ...(note === undefined ? {} : { note }),
        },
      });
      // The row is locked above, so the compare-and-set cannot miss: nothing may commit without it.
      if (written === undefined)
        throw new Error('settlement blacklist clawback: difference left open');
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RECON_DIFF_BLACKLIST_CLAWBACK_AUDIT_ACTION,
        target: row.id,
        before: { status: row.status, order_key: key, rebate_status: CREDITED },
        after: {
          status: written.status,
          order_key: key,
          rebate_status: CLAWED_BACK,
          clawed_back_fen: total.toString(),
        },
        ip: operator.ip,
      });
      const data: Schema<'AdminReconDiffBlacklistClawback'> = {
        recon_diff: written,
        clawed_back_fen: fenToJsonNumber(total),
        rebate_status_after: CLAWED_BACK,
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
