// B2-09g: POST /admin/v1/recon-diffs/{recon_diff_id}/restore (contracts/openapi.yaml
// restoreAdminReconDiff, CT-24ze; 08 BR-FUND-22 ③, BR-CALC-09, BR-CALC-13; 编排裁定 D10-468 ①,
// D10-469 ① ② ③). The controller (http/admin/) only authorises through the AdminOperationGuard
// (order.restore, step-up tier totp), takes the parameters and calls restoreAdminReconDiff.
// B2-09ga (编排裁定 D10-482, BR-ID-26): a member identified as under 18 at the restore gets no
// promotion share back.
//
// restoreAdminReconDiff runs under platform idempotency in its transactional mode (subject
// a:<admin_users.id>, the concrete path, the Idempotency-Key header); 2xxxx refusals are not stored.
// On the claim's transaction, in the contract's order of checks:
//   the body (note, when given, 1–200 characters after trimming, else 20001 [note]);
//   the app's R1–R3 difference (unknown / another app / R4 / not a uuid → 20001 [recon_diff_id]); a
//   status other than open / processing → 20902 recon_diff; not an account-appeal restore → 20001
//   [recon_diff_id] reason restore_not_supported. That read takes no lock: it names the order key.
// Locks (settlement AGENTS.md 硬规则 3): the order key's advisory lock, the difference's row (its
// status judged again), the users row, ledger.lockBalances.
//   The member's state is read through the BeneficiaryGate after the users row's lock: deleting or
//   deleted → 20001 [recon_diff_id] reason restore_user_deleted (D10-469 ①, default filled in by the
//   agent; 12 §4.8 no write to that account). Every other state is paid, also a member banned again
//   by a later round (D10-469 ②, default filled in by the agent), except that D10-482 goes first: a
//   member identified as under 18 at this instant is not paid a promotion share (share / direct /
//   indirect), whatever the risk state; that role gets a forfeited event with reason minor instead
//   of the active one and reports restored_fen 0. The self share is paid as usual.
// Then for each other role of resolution.shares, with the order, the snapshot and the nets read
// inside the order key's lock: the active beneficiary event; floor(booked_base_fen × ratio_bp /
// 10000) less the role's net (ledger getOrderNets, BR-FUND-08), never expected_fen, the FORFEIT voucher or the
// current settled commission. A positive difference posts ADMIN_ADJUST:RESTORE:APPEAL; a difference
// ≤ 0 posts nothing, pays 0 and is not netted against another role (D10-469 ③, default filled in by
// the agent). A role that left the snapshot (R14) is owed nothing, as in the beneficiary credit.
// Last the difference to adjusted through ledger's command and the audit record recon_diff_restore.
// rebate_status and withdrawal holds are not touched. Any failure rolls everything back (5xx) and
// leaves no idempotency record.
// B2-09gb (编排 D10-973): a platform_restore difference (BR-FUND-22 R12 / R13) goes, after the same
// body, difference and status checks, to platform-restore.ts on the same transaction; the
// account-appeal path below is unchanged.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { buildVouchers, orderKey, type BuiltVoucher } from '@couli/domain';
import { addFen, fenToJsonNumber, splitByBp, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  adjustRestoredReconDiff,
  getOrderNets,
  lockReconDiffForRestore,
  readReconDiffForRestore,
  type Ledger,
  type PostingEntry,
  type PostingVoucher,
  type ReconDiffRestoreRow,
} from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type RootLogger,
} from '../../platform/index.ts';
import type {
  BeneficiaryGate,
  BeneficiaryGateOptions,
  MinorStatusReader,
} from '../credit/beneficiary-gate.ts';
import { readOrderLocator } from '../credit/credit-store.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import {
  restorePlatformDiff,
  type PlatformRestoreRefusal,
  type PlatformRestoreSnapshot,
} from './platform-restore.ts';

/** The data.reason of a 20001 [recon_diff_id] on a difference that cannot be restored here. */
export type ReconDiffRestoreRefusal = 'restore_user_deleted' | PlatformRestoreRefusal;

type RestoreRole = 'self' | 'share' | 'direct' | 'indirect';

/**
 * commission's version-independent read of the snapshot's attribution (structural); the reserve
 * and the share states are read by the platform restore (R13).
 */
export type RestoreSnapshot = PlatformRestoreSnapshot;

type ReadRestoreSnapshot = (
  trx: Transaction<DB>,
  selection: { readonly appId: string; readonly orderId: string },
) => Promise<RestoreSnapshot>;

type AppendRestoreEvent = (
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly orderId: string;
    readonly userId: string;
    readonly role: RestoreRole;
    readonly status: 'active' | 'forfeited';
    /** The appeal restore writes minor (D10-482); the platform restore banned / deleted / minor. */
    readonly reason: 'minor' | 'banned' | 'deleted' | null;
  },
  dependencies: { readonly clock: Clock },
) => Promise<void>;

/** What app.module hands in: identity's and commission's ports (settlement imports neither). */
export interface AdminReconRestorePorts {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
  /** identity lockUsersForUpdate. */
  readonly lockUsers: BeneficiaryGateOptions['lockUsers'];
  /** identity createUserDeletionStatusReader (users.status only, BR-CALC-13). */
  readonly deletionStatus: (db: Kysely<DB>) => BeneficiaryGateOptions['deletionStatus'];
  /** identity createRealnameStatusBatchReader: only a verified realname identifies a minor. */
  readonly realnameStatus: (db: Kysely<DB>) => BeneficiaryGateOptions['realnameStatus'];
  /** risk createRiskStateBatchReader. */
  readonly riskState: (db: Kysely<DB>) => BeneficiaryGateOptions['riskState'];
  /** identity createMinorStatusBatchReader (B1-03zc). */
  readonly minors: (crypto: FieldCrypto) => MinorStatusReader;
  /**
   * commission readCommissionAttribution: only beneficiaries and ratios are read, so a
   * commission_version restated after the credit (BR-FUND-01 R9b) cannot fail the restore.
   */
  readonly readRestoreSnapshot: ReadRestoreSnapshot;
  /** commission appendBeneficiaryEvent. */
  readonly appendBeneficiaryEvent: AppendRestoreEvent;
  /** ledger's createLedger with payout's recovery hook. */
  readonly ledger: (context: { readonly clock: Clock; readonly eventBus: EventBus }) => Ledger;
}

export interface RestoreAdminReconDiffDeps {
  readonly clock: Clock;
  /** B2-09gb: the platform restore's warnings (negative differences left unposted). */
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the restore transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly gate: BeneficiaryGate;
  readonly readRestoreSnapshot: ReadRestoreSnapshot;
  readonly appendBeneficiaryEvent: AppendRestoreEvent;
  readonly ledger: Ledger;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface ReconDiffRestoreOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ReconDiffRestoreRequest {
  readonly body: Schema<'AdminReconDiffRestoreRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** The audit action of the contract (restoreAdminReconDiff). */
export const RECON_DIFF_RESTORE_AUDIT_ACTION = 'recon_diff_restore';

/** Contract AdminReconDiffRestoreRequest.note: 1–200 characters after trimming when given. */
const NOTE_MAX = 200;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
/** The difference risk's producer registers (risk/application/appeal-restore.ts). */
const RESTORE_TYPE = 'appeal_restore';
/** The difference orders' producer registers (orders/application/platform-restore-step.ts). */
const PLATFORM_RESTORE_TYPE = 'platform_restore';
const RESTORE_REASON_CODE = 'APPEAL_RESTORE';
const VOUCHER_TEMPLATE = 'ADMIN_ADJUST:RESTORE:APPEAL';
const VOUCHER_KIND = 'ADMIN_ADJUST';
const BIZ_TYPE = 'ADMIN_RESTORE';
const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];

/** The concrete request path (the idempotency scope). */
function restorePathOf(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${reconDiffId}/restore`;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

/** 20001 data.fields=[recon_diff_id] with the reason of the contract. */
function guardRefusal(reason: ReconDiffRestoreRefusal, traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(['recon_diff_id'], traceId);
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'recon_diff' },
      trace_id: traceId,
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isRole(value: unknown): value is RestoreRole {
  return typeof value === 'string' && ROLES.includes(value);
}

function isOpen(row: ReconDiffRestoreRow): boolean {
  return row.status === 'open' || row.status === 'processing';
}

interface RestoreTarget {
  readonly stored: Record<string, unknown>;
  readonly orderId: string;
  readonly userId: string;
  readonly roles: readonly RestoreRole[];
}

/** The account-appeal restore a difference stands for; null for any other difference. */
function restoreTargetOf(row: ReconDiffRestoreRow): RestoreTarget | null {
  const stored = asObject(row.resolution);
  if (row.type !== RESTORE_TYPE || stored?.['reason_code'] !== RESTORE_REASON_CODE) return null;
  const orderId = text(stored['order_id']);
  const userId = text(stored['user_id']);
  const shares = stored['shares'];
  if (orderId === null || userId === null) return null;
  if (!Array.isArray(shares) || shares.length === 0) return null;
  const roles = shares.map((share: unknown) => asObject(share)?.['role']);
  if (!roles.every(isRole) || new Set(roles).size !== roles.length) return null;
  return { stored, orderId, userId, roles };
}

/** The member's entitlement of a role: the snapshot's ratio on the booked base (BR-FUND-22 ③). */
function owedFen(snapshot: RestoreSnapshot, base: bigint, userId: string, role: RestoreRole) {
  const { shares } = splitByBp(
    base,
    snapshot.beneficiaries.map((b) => BigInt(b.ratioBp)),
  );
  const index = snapshot.beneficiaries.findIndex((b) => b.userId === userId && b.role === role);
  return shares[index] ?? 0n;
}

function postingOf(
  appId: string,
  key: string,
  adminId: string,
  reconDiffId: string,
  beneficiary: { readonly userId: string; readonly role: RestoreRole; readonly accountId: string },
  built: BuiltVoucher,
): PostingVoucher {
  const entries: PostingEntry[] = built.entries.map((entry) => ({
    account:
      entry.account.owner_type === 'user'
        ? { ownerType: 'user', accountId: beneficiary.accountId }
        : { ownerType: 'platform', subject: entry.account.subject },
    sub_account: entry.sub_account ?? 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
  return {
    appId,
    uniqKey: built.uniq_key,
    bizType: BIZ_TYPE,
    bizId: reconDiffId,
    operator: `admin:${adminId}`,
    memo: null,
    orderKey: key,
    beneficiaryUserId: beneficiary.userId,
    role: beneficiary.role,
    voucherKind: VOUCHER_KIND,
    entries,
  };
}

/** Handles one account-appeal restore difference of the operator's app (BR-FUND-22 ③). */
export function restoreAdminReconDiff(
  deps: RestoreAdminReconDiffDeps,
  operator: ReconDiffRestoreOperator,
  reconDiffId: string,
  request: ReconDiffRestoreRequest,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const traceId = request.traceId;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: restorePathOf(reconDiffId),
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
      if (!isOpen(seen)) return conflictRefusal(traceId);
      if (seen.type === PLATFORM_RESTORE_TYPE) {
        return restorePlatformDiff(deps, trx, {
          appId,
          adminId,
          ip: operator.ip,
          traceId,
          note,
          seen,
          auditAction: RECON_DIFF_RESTORE_AUDIT_ACTION,
        });
      }
      const target = restoreTargetOf(seen);
      if (target === null) return guardRefusal('restore_not_supported', traceId);
      const { orderId, userId } = target;

      const locator = await readOrderLocator(trx, appId, orderId);
      if (locator === undefined) throw new Error('settlement restore: order not found for app');
      await lockOrderKey(trx, locator.platform, locator.sub_order_id);
      const row = await lockReconDiffForRestore(trx, appId, seen.id);
      if (row === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
      if (!isOpen(row)) return conflictRefusal(traceId);

      const locked = await deps.gate.lockUsers(trx, { appId, userIds: [userId] });
      const states = await deps.gate.readStates(trx, { appId, userIds: [userId] });
      const state = states.get(userId);
      if (!locked.has(userId) || state === undefined) {
        throw new Error('settlement restore: the member of the difference is not in the app');
      }
      if (state.deletion_status !== null) return guardRefusal('restore_user_deleted', traceId);

      await deps.ledger.openUserAccount(trx, { appId, userId });
      const balances = await deps.ledger.lockBalances(trx, { appId, userIds: [userId] });
      const accountId = balances.find((balance) => balance.user_id === userId)?.account_id;
      if (accountId === undefined) throw new Error('settlement restore: no locked balance');

      const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
      if (order === undefined) throw new Error('settlement restore: order not found for app');
      if (order.booked_base_fen === null) {
        throw new Error('settlement restore: order without a booked base');
      }
      const snapshot = await deps.readRestoreSnapshot(trx, { appId, orderId });
      const key = orderKey(locator.platform, locator.sub_order_id);
      const { beneficiaries } = await getOrderNets(trx, { appId, orderKey: key });

      const shares: { role: RestoreRole; restored_fen: string }[] = [];
      let total = 0n;
      for (const role of target.roles) {
        if (state.is_minor && role !== 'self') {
          // D10-482: not paid, and it stays forfeited for the adjustments after this one.
          await deps.appendBeneficiaryEvent(
            trx,
            { appId, orderId, userId, role, status: 'forfeited', reason: 'minor' },
            { clock: deps.clock },
          );
          shares.push({ role, restored_fen: '0' });
          continue;
        }
        await deps.appendBeneficiaryEvent(
          trx,
          { appId, orderId, userId, role, status: 'active', reason: null },
          { clock: deps.clock },
        );
        const net =
          beneficiaries.find((b) => b.beneficiary_user_id === userId && b.role === role)?.net_fen ??
          0n;
        const owed = owedFen(snapshot, order.booked_base_fen, userId, role);
        const difference = subFen(owed, net);
        const paid = difference > 0n ? difference : 0n;
        if (paid > 0n) {
          const vouchers = buildVouchers(VOUCHER_TEMPLATE, {
            order_key: key,
            user_id: userId,
            role,
            '差错单 id': row.id,
            restore_fen: paid,
          });
          for (const built of vouchers) {
            await deps.ledger.post(
              trx,
              postingOf(appId, key, adminId, row.id, { userId, role, accountId }, built),
            );
          }
          total = addFen(total, paid);
        }
        shares.push({ role, restored_fen: paid.toString() });
      }

      const now = deps.clock.now();
      const written = await adjustRestoredReconDiff(trx, {
        appId,
        id: row.id,
        handlerId: adminId,
        at: now,
        resolution: {
          ...target.stored,
          restore: {
            shares,
            restored_fen: total.toString(),
            operator: adminId,
            restored_at: now.toISOString(),
          },
          ...(note === undefined ? {} : { note }),
        },
      });
      // The row is locked above, so the compare-and-set cannot miss: nothing may commit without it.
      if (written === undefined) throw new Error('settlement restore: the difference left open');
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RECON_DIFF_RESTORE_AUDIT_ACTION,
        target: row.id,
        before: { status: row.status, user_id: userId, order_key: key },
        after: {
          status: written.status,
          user_id: userId,
          order_key: key,
          shares,
          restored_fen: total.toString(),
        },
        ip: operator.ip,
      });
      const data: Schema<'AdminReconDiffRestore'> = {
        recon_diff: written,
        restored_fen: fenToJsonNumber(total),
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
