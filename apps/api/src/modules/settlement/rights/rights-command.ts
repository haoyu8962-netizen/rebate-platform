// B2-04l: settlement's rights command — orders' RightsCommandPort.record (B1-09c), the only writer
// of order_rights and orders.rights_pending (BR-FUND-01). Rule tests: test/spec/settlement/rights/**.
//
// record(trx, input): on the caller's transaction (never opens, commits or rolls one back); the
// caller already holds orders' lockOrderKey for the sub-order and re-read `before` FOR UPDATE. In
// order (decide before writing, BR-FUND-01):
//   1. platform_status of the order outside {PAID, RECEIVED, SETTLED} (the from-states of P7 / P8)
//      → { kind: 'not_applicable' }, nothing written.
//   2. K-2 key (app_id, order_id, type, platform_rights_no), NULLS NOT DISTINCT:
//      - no stored row → insert one (source, type, status, amount_fen, deduction_commission_fen,
//        occurred_at, platform_rights_no as given; created_at = updated_at = input.now) → applied;
//      - a stored PROCESSING row and an incoming SUCCEEDED / FAILED, or a stored WAIT_COMMISSION
//        row and an incoming SUCCEEDED that carries deduction_commission_fen → the result of that
//        same record (BR-FUND-06「维权结果」): the row is updated in place (same id; status,
//        amounts, row_version + 1, updated_at = input.now) → applied;
//      - D10-699 (B1-04zza money r1 S0): a stored FAILED row of source API and an incoming API
//        record whose stored status is SUCCEEDED (the union reports success after the record was
//        closed without charging us, e.g. Taobao refund_status 14 / 15 then 12 / 13) → the same
//        in-place result as above (applied), plus one system audit row through the injected
//        audit port and one alert, reason union_reported_success_after_closed; without an injected
//        audit port (D10-723) the record throws before writing anything (fail-closed, the caller's
//        transaction rolls back whole);
//      - anything else on a stored key (a replay, a closed SUCCEEDED row, an ADMIN / IMPORT FAILED
//        row, FAILED → PROCESSING / WAIT_COMMISSION, FAILED again) → duplicate, nothing written,
//        never a second clawback.
//      (In-place result kept as reported to the orchestrator; BR-FUND-06 needs it for platforms
//      that report PROCESSING first.)
//   3. by the row's status after step 2:
//      - PROCESSING: nothing more (BR-FUND-06: blocks crediting through rights_pending only);
//      - FAILED: record closed, amounts unchanged;
//      - SUCCEEDED, rebate_status UNATTRIBUTED / ESTIMATED / WAITING (BR-FUND-07, R6 / R7 through
//        the generated transition()): PUNISH → R6 PUNISH (VOID, reason PUNISH);
//        INVALID_AFTER_SETTLE / REFUND_AFTER_SETTLE → R6 PLATFORM_INVALID (VOID, reason REFUND);
//        RIGHTS: N_new = effective union commission (BR-CALC-02: settle_commission_fen, else
//        est_commission_fen) − deduction_commission_fen; positive part 0 → R6 RIGHTS_FULL (VOID,
//        reason RIGHTS); otherwise R7 RIGHTS_PARTIAL (status unchanged; R7 is not from
//        UNATTRIBUTED); no deduction → the row becomes WAIT_COMMISSION, status unchanged
//        (BR-FUND-06 例「部分成功、佣金未更新」). VOID publishes order.invalidated on the same
//        transaction; never a voucher;
//      - SUCCEEDED, rebate_status CREDITED: the clawback's rights success entry (BR-FUND-08, same
//        rules as B2-04s): cause by type (RIGHTS → RIGHTS, PUNISH → PUNISH, INVALID_AFTER_SETTLE,
//        REFUND_AFTER_SETTLE), rights_event_id `R{order_rights.id}`, N_new ② = booked_n_fen −
//        deduction_commission_fen (below 0 → 0); no deduction → ③ WAIT_COMMISSION (row
//        WAIT_COMMISSION, order_sync_pending CLAWBACK_NO_COMMISSION, alert). Lock order as B2-04m /
//        B2-04s: order_key advisory lock → identity users rows → ledger.lockBalances;
//      - SUCCEEDED, rebate_status VOID / CLAWED_BACK: recorded only (terminal; BR-FUND-01 细则
//        「订单锁定」: order_rights are still recorded); status, booked pair and ledger unchanged.
//   4. orders.rights_pending recomputed in the same transaction (some row of the order PROCESSING
//      or WAIT_COMMISSION) and written with a CAS (row_version + 1, updated_at = input.now) only
//      when it changes.
// B2-04zze (08 BR-TEXT-05「子原因 reason_sub」; D10-862): the R6 / R8 this command triggers write
// orders.reason_sub with the reason (rebate port / clawback), from the record type and the
// union's violation_type of a punishment (passed through, never stored). A successful punishment
// on a terminal VOID / CLAWED_BACK order whose parent stays PUNISH only refines PUNISH_ORDER (or
// an empty sub-reason) to a mapped sub-reason; status, reason, history and ledger are unchanged.
// B1-09v (08 BR-TEXT-05 子原因 写入来源 ②; D10-819 ①③): a record carrying a sub-reason chosen by
// hand (input.manual_reason_sub, a punish import's reason_sub; value null is 「无」) stores it on
// its new order_rights row (reason_sub, reason_sub_manual true). Only an order this record leaves
// with reason PUNISH gets it: R6 (rebate port) and R8 (clawback) write it instead of the automatic
// mapping with orders.reason_sub_manual in their own CAS; a terminal VOID / CLAWED_BACK order whose
// reason is already PUNISH gets it in its own CAS (casManualReasonSub; the choice by hand replaces
// an automatic value). An order ended for another reason (REFUND, RIGHTS, …) keeps reason,
// reason_sub and the flag. A replayed key (duplicate) writes nothing. Amounts, status, reason and
// history never follow the sub-reason. A stored record resolved by a later input (money r1 S2,
// manualOnResolve) keeps the choice: the row's when the input has none (the order is marked with
// it), else the input's, written onto the row with the result.
// D10-957: a duplicate punishment (stored SUCCEEDED, incoming SUCCEEDED, order VOID / CLAWED_BACK)
// that carries an explicit choice by hand writes it onto the stored row and, when the order's
// reason is PUNISH, onto orders.reason_sub with reason_sub_manual (the latest choice by hand wins,
// over an automatic value or an earlier choice); without a choice only the automatic refine of
// B2-04zze runs (never over a choice by hand). Still a duplicate: no second row, R6 or clawback.
// Whenever an import's choice replaces the sub-reason of an order already ended PUNISH (this
// duplicate, or a new record on such an order), one audit order_reason_sub_set is written on the
// same transaction through deps.manualAudit: actor the import's creator, target orders:<id>,
// before / after reason, reason_sub (none as null), reason_sub_manual, source rights_import and
// the import id; no personal information. Without the writer it throws before writing (D10-723's
// fail-closed). Unchanged (already that value by hand): no write, no audit.
// B1-09za (D10-969, 人工对人工以最新为准; B1-09v money r2 S2): a choice by hand kept only on a stored
// row (no origin: the resolving input carries none of its own) is older than any choice made on the
// order since (改子原因, including 「无」). When the row is closed by a later input (manualOnResolve)
// or reopened (D10-699) it only fills an order whose reason_sub_manual is false; an order already
// chosen by hand keeps its sub-reason and no replacement audit is written. When it does replace the
// sub-reason of an order already ended PUNISH, one audit order_reason_sub_set is written on the same
// transaction through deps.audit (actor system:settlement, source stored_rights_choice, the
// order_rights id; no personal information); without that port it throws before writing.
// createReasonSubAdminCommandPort: orders' 改子原因 (adminSetOrderReasonSub) — only orders.reason_sub
// and reason_sub_manual, CAS on rebate_status, reason and the expected row_version.
// BR-FUND-06 is 待验证 (which platforms send a「处理中」signal): no platform signal is invented
// here; a platform without one only reaches record with the result.
// Time only from input.now / the injected Clock; amounts only through @couli/money.
import type { OrderReasonSub } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { subFen } from '@couli/money';
import type { Selectable, Transaction } from 'kysely';
import type {
  RightsCommandPort,
  RightsRecordInput,
  RightsRecordResult,
} from '../../orders/index.ts';
import type { AuditPort, Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type { ClawbackCause, ClawbackOrder } from '../clawback/index.ts';
import { computeRightsPending, casRightsPending } from '../clawback/clawback-store.ts';
import type { PrecreditEvent, RebatePort, ReasonSubWrite } from '../rebate/application/rebate.ts';
import { isPrecredit } from '../rebate/domain/rules.ts';
import { rightsReasonOf, type RightsReasonDecision } from '../rebate/domain/rights-reason.ts';
import {
  REASON_SUB_UNMAPPED_ALERT,
  reasonSubOnLaterPunish,
  type ReasonSubContext,
  type ReasonSubMaps,
} from '../rebate/domain/reason-sub.ts';
import { casReasonSub, readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { defaultReasonSubMaps } from '../rebate/infra/reason-sub-table.ts';
import {
  casManualReasonSub,
  findRights,
  insertRights,
  readOpenDeductionTotal,
  updateRightsResult,
  writeRightsManual,
  type OrderRightsRow,
  type RightsSystemAuditInput,
} from './rights-store.ts';

/** D10-699: the reason (audit and alert) of a closed API record the union later reports successful. */
export const RIGHTS_SUCCESS_AFTER_CLOSED = 'union_reported_success_after_closed';
/** The audit action of that change (target order_rights:<id>). */
export const RIGHTS_REOPEN_AUDIT_ACTION = 'order_rights_success_after_closed';
/** The system identity of the audit row (contracts/enums/admin.yaml audit_system_actor, CT-26z). */
const RIGHTS_AUDIT_ACTOR = 'system:settlement';

/** One reopen audit row: the store's shape, under settlement's own system identity. */
export type RightsReopenAuditInput = Omit<RightsSystemAuditInput, 'actor'> & {
  readonly actor: typeof RIGHTS_AUDIT_ACTOR;
};

/** One side of a sub-reason replaced by a stored row's choice by hand (B1-09za, D10-969). */
export type StoredChoiceAuditSide = {
  readonly reason: string | null;
  readonly source: string;
  readonly order_rights_id: string;
  readonly reason_sub: string | null;
  readonly reason_sub_manual: boolean;
};

/** B1-09za: the order_reason_sub_set audit of a stored row's choice, under settlement's identity. */
export type StoredChoiceAuditInput = {
  readonly appId: string;
  readonly actor: typeof RIGHTS_AUDIT_ACTOR;
  readonly action: typeof REASON_SUB_SET_AUDIT_ACTION;
  readonly target: string;
  readonly before: StoredChoiceAuditSide;
  readonly after: StoredChoiceAuditSide;
};

/** admin's system audit on the caller's transaction, by shape (settlement imports no admin code). */
export interface RightsSystemAudit {
  appendAction(
    trx: Transaction<DB>,
    input: RightsReopenAuditInput | StoredChoiceAuditInput,
  ): Promise<void>;
}

export interface RightsCommandDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  /** B2-04s clawback orchestration; its rights success entry handles CREDITED orders. */
  readonly clawback: ClawbackOrder;
  /** B2-04j rebate port: R6 / R7 commands before credit (apply). */
  readonly rebate: Pick<RebatePort, 'apply'>;
  /**
   * D10-699: the system audit of a closed API record reopened as successful (production: admin's
   * createSystemAuditWriter). D10-723: the audit is only written through this port; absent, such a
   * reopen is refused before anything is written. B1-09za: a stored row's choice by hand that
   * replaces an ended PUNISH order's sub-reason is audited through it too, and refused without it
   * (every other path works without it).
   */
  readonly audit?: RightsSystemAudit;
  /**
   * B2-04zze: the sub-reason tables (specs/reason-sub-map/); absent → the process' tables, read
   * once when the port is built.
   */
  readonly reasonSubMaps?: ReasonSubMaps;
  /**
   * B1-09v (D10-957): admin's audit writer on the caller's transaction (production:
   * createAuditWriter on trx), for an import's choice by hand that replaces the sub-reason of an
   * order already ended PUNISH. Absent: such a replacement throws before anything is written.
   */
  readonly manualAudit?: (trx: Transaction<DB>) => Pick<AuditPort, 'append'>;
}

/** B1-09v: the audit action of a sub-reason chosen by hand (orders' 改子原因 uses the same). */
export const REASON_SUB_SET_AUDIT_ACTION = 'order_reason_sub_set';
/** D10-957: the audit's source of a choice made in a punish import. */
export const REASON_SUB_SOURCE_IMPORT = 'rights_import';
/** B1-09za (D10-969): the audit's source of a choice kept on a stored order_rights row. */
export const REASON_SUB_SOURCE_STORED = 'stored_rights_choice';

/** B1-09v: a choice made by hand as the record carries it (value null is 「无」). */
type ManualChoice = NonNullable<RightsRecordInput['manual_reason_sub']>;

type StoredStatus = 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED';

/** B1-09za: the stored order_rights row whose own choice by hand marks the order. */
interface StoredChoiceRef {
  readonly rightsId: string;
}

/** Who audits a replacement of an ended order's sub-reason by a choice made by hand. */
type SubAudit =
  | { readonly kind: 'import'; readonly writer: Pick<AuditPort, 'append'> }
  | { readonly kind: 'stored'; readonly audit: RightsSystemAudit; readonly rightsId: string };

/** P7 / P8 from-states: only these platform states take a rights record. */
function acceptsRights(platformStatus: string): boolean {
  return platformStatus === 'PAID' || platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

function isTerminal(rebateStatus: string): boolean {
  return rebateStatus === 'VOID' || rebateStatus === 'CLAWED_BACK';
}

/**
 * The status the record is stored with. A successful partial rights result without the deduction
 * (BR-FUND-06 例「部分成功、佣金未更新」, BR-FUND-08 ③) waits for the union: WAIT_COMMISSION,
 * except on a terminal order, where it is only recorded.
 */
function storedStatusOf(input: RightsRecordInput): StoredStatus {
  if (input.status === 'PROCESSING' || input.status === 'FAILED') return input.status;
  if (
    input.type === 'RIGHTS' &&
    input.deduction_commission_fen === null &&
    !isTerminal(input.before.rebate_status)
  ) {
    // Before credit the rebate port's sync hook closes it once the union's new commission arrives
    // (B2-04lb); after credit the clawback does.
    return 'WAIT_COMMISSION';
  }
  return 'SUCCEEDED';
}

function checkInput(input: RightsRecordInput): void {
  const fen = input.deduction_commission_fen;
  if (fen !== null && (typeof fen !== 'bigint' || fen < 0n)) {
    throw new TypeError('settlement rights: deduction_commission_fen must be a nonnegative bigint');
  }
  if (input.before.order_id !== input.order_id) {
    throw new TypeError('settlement rights: before row does not match order_id');
  }
}

/** The clawback cause of a successful record on a CREDITED order (BR-FUND-08 sub_type table). */
function causeOf(type: RightsRecordInput['type']): ClawbackCause {
  switch (type) {
    case 'RIGHTS':
      return 'RIGHTS';
    case 'PUNISH':
      return 'PUNISH';
    case 'INVALID_AFTER_SETTLE':
      return 'INVALID_AFTER_SETTLE';
    case 'REFUND_AFTER_SETTLE':
      return 'REFUND_AFTER_SETTLE';
    default:
      throw new TypeError('settlement rights: unknown order_rights type');
  }
}

/**
 * D10-699: the only transition out of a closed record — stored FAILED from the union (source API),
 * the union now reporting success (an API record stored as SUCCEEDED, i.e. with its deduction).
 */
function reopensAsSucceeded(
  stored: OrderRightsRow,
  input: RightsRecordInput,
  status: StoredStatus,
): boolean {
  return (
    stored.status === 'FAILED' &&
    stored.source === 'API' &&
    input.source === 'API' &&
    status === 'SUCCEEDED'
  );
}

/**
 * B2-04zze: what the record tells the sub-reason written with the reason. B1-09v: a punishment's
 * choice made by hand rides along (the rebate port and the clawback write it under PUNISH only).
 */
function subContextOf(input: RightsRecordInput): ReasonSubWrite {
  const manual = manualOf(input);
  const decision = rightsReasonOfInput(input);
  const context: ReasonSubContext = {
    rightsType: input.type,
    ...(input.type === 'PUNISH' ? { violationType: input.violation_type ?? null } : {}),
    ...(decision?.reason === 'REFUND' ? { refundSub: decision.refundSub } : {}),
  };
  const write: ReasonSubWrite =
    decision === undefined ? context : { ...context, rightsReason: decision.reason };
  return manual === undefined ? write : { ...write, manual };
}

/**
 * B2-04zzs (08 BR-TEXT-05 细则「写入来源」①): the reason a full result of a RIGHTS record writes, from
 * the union's timing the record carries (Taobao earning_time, passed through by the sync, never
 * stored); undefined for any other type. Without the timing (absent) it stays RIGHTS.
 */
function rightsReasonOfInput(input: RightsRecordInput): RightsReasonDecision | undefined {
  if (input.type !== 'RIGHTS') return undefined;
  const earningAt = input.earning_at;
  return rightsReasonOf({
    platform: input.before.platform,
    receivedAt: input.before.received_at,
    occurredAt: input.occurred_at,
    timing: earningAt === undefined ? undefined : { earningAt },
  });
}

/** B2-04zzs: the clawback's r8Reason of a RIGHTS record (absent for any other type). */
function r8ReasonOf(input: RightsRecordInput): { readonly r8Reason?: 'REFUND' | 'RIGHTS' } {
  const decision = rightsReasonOfInput(input);
  return decision === undefined ? {} : { r8Reason: decision.reason };
}

/** B1-09v: the record's sub-reason chosen by hand; only a punishment carries one. */
function manualOf(input: RightsRecordInput): ManualChoice | undefined {
  return input.type === 'PUNISH' ? input.manual_reason_sub : undefined;
}

/**
 * B1-09v (D10-957): what an explicit choice by hand does on an order already ended (VOID /
 * CLAWED_BACK): the order's sub-reason is replaced only under reason PUNISH and only when it is
 * not already that value by hand; the stored row (a duplicate's) is written back unless it already
 * holds that value by hand. The audit follows the order's replacement.
 * B1-09za (D10-969): `older` — the choice is a stored row's own (no origin), older than any choice
 * made on the order since: it replaces only an order whose reason_sub_manual is false.
 */
export function manualOnEnded(
  order: {
    readonly reason: string | null;
    readonly reason_sub: string | null;
    readonly reason_sub_manual: boolean;
  },
  stored: Pick<OrderRightsRow, 'reason_sub' | 'reason_sub_manual'> | undefined,
  manual: Pick<ManualChoice, 'value'>,
  older = false,
): { readonly order: boolean; readonly row: boolean } {
  const replaces =
    order.reason === 'PUNISH' &&
    (older
      ? !order.reason_sub_manual
      : !(order.reason_sub_manual && order.reason_sub === manual.value));
  const row =
    order.reason === 'PUNISH' &&
    stored !== undefined &&
    !(stored.reason_sub_manual && stored.reason_sub === manual.value);
  return { order: replaces, row };
}

/** What manualOnResolve decides for the resolving input. */
export interface ResolvedChoice {
  readonly manual: ManualChoice | undefined;
  /** The input's choice goes onto the stored row with the result. */
  readonly writeRow: boolean;
  /**
   * B1-09za (D10-969): the choice is the stored row's own (no origin), older than any choice made
   * on the order since; it fills only an order not chosen by hand, and is audited when it replaces
   * an ended order's sub-reason.
   */
  readonly fromRow: boolean;
}

const NO_CHOICE: ResolvedChoice = Object.freeze({
  manual: undefined,
  writeRow: false,
  fromRow: false,
});

/**
 * B1-09v (money r1 S2, 08 BR-TEXT-05「人工选过的不被自动覆盖」): the choice made by hand that holds
 * when an incoming input resolves a stored record (PROCESSING / WAIT_COMMISSION → result, or a
 * reopen). The incoming input's own choice wins and goes onto the row unless the row already holds
 * exactly it (`writeRow`); without one, the row's stored choice (reason_sub_manual true) is used to
 * mark the order, so a later sync does not drop it; neither: no choice. Only a punishment carries a
 * choice (the K-2 key includes the type, so the stored row is of the same type). A stored value
 * outside the PUNISH sub-reasons is a broken row and throws before anything is written.
 * B1-09za (D10-969, 人工对人工以最新为准): the row's choice is older than any choice made on the
 * order (read under the lock) since; an order whose reason_sub_manual is true (改子原因, 「无」
 * included) keeps its own, so the row's choice is not used (no choice; the automatic mapping never
 * writes over a choice by hand either).
 */
export function manualOnResolve(
  stored: Pick<OrderRightsRow, 'type' | 'reason_sub' | 'reason_sub_manual'>,
  input: Pick<RightsRecordInput, 'type' | 'manual_reason_sub'>,
  order: { readonly reason_sub_manual: boolean },
): ResolvedChoice {
  if (input.type !== 'PUNISH' || stored.type !== 'PUNISH') return NO_CHOICE;
  const incoming = input.manual_reason_sub;
  if (incoming !== undefined) {
    const same = stored.reason_sub_manual && stored.reason_sub === incoming.value;
    return { manual: incoming, writeRow: !same, fromRow: false };
  }
  if (!stored.reason_sub_manual || order.reason_sub_manual) return NO_CHOICE;
  const value = stored.reason_sub;
  if (value !== null && !isPunishSub(value)) {
    throw new TypeError('settlement rights: stored reason_sub is not a PUNISH sub-reason');
  }
  return { manual: { value }, writeRow: false, fromRow: true };
}

function isPunishSub(value: string): value is OrderReasonSub {
  return (SUBS_OF_REASON.PUNISH as readonly string[]).includes(value);
}

/** The sub-reasons of each parent reason that has some (08 BR-TEXT-05; enum order_reason_sub). */
const SUBS_OF_REASON: Readonly<Record<string, readonly OrderReasonSub[]>> = Object.freeze({
  PUNISH: [
    'VIOLATION_PROMO',
    'SHOP_TK',
    'INSITE_PROMO',
    'PROXY_BUY',
    'FAKE_TRADE',
    'INSITE_RESALE',
    'OVER_LIMIT',
    'MARKET_DISRUPT',
    'MULTI_TRADE_ABNORMAL',
    'SINGLE_TRADE_ABNORMAL',
    'RISK_ORDER',
    'PUNISH_ORDER',
  ],
  REFUND: ['IN_SALE', 'AFTER_SETTLE'],
  RIGHTS: ['AFTER_SALE'],
});

/** B1-09v: orders' 改子原因 input (orders' AdminReasonSubInput, by shape). */
export interface ReasonSubAdminInput {
  /** The caller holds lockOrderKey and re-read this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly expected_row_version: number;
  /** null: 「无」. */
  readonly reason_sub: OrderReasonSub | null;
  readonly now: Date;
}

export interface ReasonSubAdminCommandPort {
  adminSetReasonSub(
    trx: Transaction<DB>,
    input: ReasonSubAdminInput,
  ): Promise<{ readonly kind: 'applied' | 'cas_conflict' }>;
}

/**
 * B1-09v: 改子原因 on the caller's transaction (orders holds the order key lock and re-read the row
 * FOR UPDATE; orders answered the choice's 20001 and writes the audit). Only orders.reason_sub (none
 * → null) and reason_sub_manual = true change, with row_version + 1 and updated_at; CAS on
 * rebate_status, reason and the expected row_version. No status transition, history or event. A
 * value that does not belong to the order's reason is a caller error and throws before writing.
 */
export function createReasonSubAdminCommandPort(deps: {
  readonly logger: Pick<RootLogger, 'info'>;
}): ReasonSubAdminCommandPort {
  const { logger } = deps;
  async function adminSetReasonSub(trx: Transaction<DB>, input: ReasonSubAdminInput) {
    const order = input.before;
    const subs = order.reason === null ? undefined : SUBS_OF_REASON[order.reason];
    if (subs === undefined || (input.reason_sub !== null && !subs.includes(input.reason_sub))) {
      throw new TypeError('settlement rights: reason_sub does not belong to the order reason');
    }
    if (order.row_version !== input.expected_row_version) return { kind: 'cas_conflict' } as const;
    const ok = await casManualReasonSub(trx, order, input.reason_sub, input.now);
    if (!ok) return { kind: 'cas_conflict' } as const;
    logger.info(
      { app_id: order.app_id, platform: order.platform, reason: order.reason, outcome: 'applied' },
      'order sub-reason set by hand',
    );
    return { kind: 'applied' } as const;
  }
  return Object.freeze({ adminSetReasonSub });
}

export function createRightsCommandPort(deps: RightsCommandDependencies): RightsCommandPort {
  const { logger, clawback, rebate, audit } = deps;
  const reasonSubMaps = deps.reasonSubMaps ?? defaultReasonSubMaps();

  /**
   * B2-04zze: a successful punishment on a terminal order (status and reason unchanged): only a
   * PUNISH_ORDER / empty sub-reason of a PUNISH order is refined, in its own CAS.
   */
  async function refineTerminalSub(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    mappedOnly = false,
    storedChoice?: StoredChoiceRef,
  ): Promise<void> {
    if (input.type !== 'PUNISH') return;
    const ref = {
      appId: input.before.app_id,
      orderId: input.order_id,
      attrAt: input.before.attr_at,
    };
    const order = await readRebateOrder(trx, ref);
    if (order === undefined) throw new Error('settlement rights: order not found for app');
    if (!isTerminal(order.rebate_status)) return;
    const manual = mappedOnly ? undefined : manualOf(input);
    if (manual !== undefined) {
      // B1-09v: the choice made by hand reaches only an order whose parent is PUNISH, and
      // replaces whatever the automatic mapping wrote; another parent keeps its sub-reason.
      // B1-09za: a stored row's (older) choice never replaces a choice made by hand.
      const older = storedChoice !== undefined && manual.origin === undefined;
      if (!manualOnEnded(order, undefined, manual, older).order) return;
      const writer = older ? storedAuditFor(storedChoice) : auditFor(trx, manual);
      await replaceEndedSub(trx, order, manual, input.now, writer);
      return;
    }
    const decision = reasonSubOnLaterPunish(order, input.violation_type, reasonSubMaps, {
      mappedOnly,
    });
    if (!decision.write) return;
    const ok = await casReasonSub(trx, order, decision.value, input.now);
    if (!ok) throw new Error('settlement rights: reason_sub CAS matched no row');
    if (decision.unmapped !== null) {
      // D10-862 ①: platform and raw text only (no order / rights number, user or amount).
      logger.warn(
        {
          alert: REASON_SUB_UNMAPPED_ALERT,
          platform: order.platform,
          violation_type: decision.unmapped.raw,
          reason_sub: 'PUNISH_ORDER',
        },
        'violation text outside the sub-reason table; fallback sub-reason written',
      );
    }
  }

  /** D10-957: the audit writer an import's replacement needs; checked before anything is written. */
  function auditFor(trx: Transaction<DB>, manual: ManualChoice): SubAudit | null {
    if (manual.origin === undefined) return null;
    const writer = deps.manualAudit?.(trx);
    if (writer === undefined) {
      throw new Error('settlement rights: an import replacing a sub-reason needs the audit writer');
    }
    return { kind: 'import', writer };
  }

  /** B1-09za: the system audit a stored row's replacement needs; checked before writing. */
  function storedAuditFor(storedChoice: StoredChoiceRef): SubAudit {
    if (audit === undefined) {
      throw new Error(
        'settlement rights: a stored choice replacing a sub-reason needs the audit port',
      );
    }
    return { kind: 'stored', audit, rightsId: storedChoice.rightsId };
  }

  /**
   * B1-09v / D10-957: the order (already ended PUNISH, read under the lock) gets the choice by hand
   * in its own CAS, then the audit of the import that chose it (same transaction). B1-09za: or of
   * the stored row that kept it (system audit, the order_rights id).
   */
  async function replaceEndedSub(
    trx: Transaction<DB>,
    order: NonNullable<Awaited<ReturnType<typeof readRebateOrder>>>,
    manual: ManualChoice,
    now: Date,
    writer: SubAudit | null,
  ): Promise<void> {
    const ok = await casManualReasonSub(trx, order, manual.value, now);
    if (!ok) throw new Error('settlement rights: manual reason_sub CAS matched no row');
    if (writer?.kind === 'stored') {
      const side = {
        reason: order.reason,
        source: REASON_SUB_SOURCE_STORED,
        order_rights_id: writer.rightsId,
      };
      const entry: StoredChoiceAuditInput = {
        appId: order.app_id,
        actor: RIGHTS_AUDIT_ACTOR,
        action: REASON_SUB_SET_AUDIT_ACTION,
        target: `orders:${order.order_id}`,
        before: {
          ...side,
          reason_sub: order.reason_sub,
          reason_sub_manual: order.reason_sub_manual,
        },
        after: { ...side, reason_sub: manual.value, reason_sub_manual: true },
      };
      await writer.audit.appendAction(trx, entry);
    }
    const origin = manual.origin;
    if (writer?.kind === 'import' && origin !== undefined) {
      const side = {
        reason: order.reason,
        source: REASON_SUB_SOURCE_IMPORT,
        import_id: origin.import_id,
      };
      await writer.writer.append({
        appId: order.app_id,
        actor: origin.admin_id,
        action: REASON_SUB_SET_AUDIT_ACTION,
        target: `orders:${order.order_id}`,
        before: {
          ...side,
          reason_sub: order.reason_sub,
          reason_sub_manual: order.reason_sub_manual,
        },
        after: { ...side, reason_sub: manual.value, reason_sub_manual: true },
        ip: null,
      });
    }
    logger.info(
      { app_id: order.app_id, platform: order.platform, reason: order.reason, outcome: 'manual' },
      'ended order sub-reason replaced by a choice made by hand',
    );
  }

  /**
   * D10-957: a duplicate punishment on an ended order carrying an explicit choice by hand: the
   * stored row and (reason PUNISH) the order take it; the latest choice by hand wins. The writer
   * is checked before the first write; status, amounts, reason and ledger never change.
   */
  async function manualOnDuplicate(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    stored: OrderRightsRow,
    manual: ManualChoice,
  ): Promise<void> {
    const ref = {
      appId: input.before.app_id,
      orderId: input.order_id,
      attrAt: input.before.attr_at,
    };
    const order = await readRebateOrder(trx, ref);
    if (order === undefined) throw new Error('settlement rights: order not found for app');
    if (!isTerminal(order.rebate_status)) return;
    const plan = manualOnEnded(order, stored, manual);
    const writer = plan.order ? auditFor(trx, manual) : null;
    if (plan.row) {
      const ok = await writeRightsManual(trx, stored, manual, input.now);
      if (!ok) throw new Error('settlement rights: order_rights manual CAS matched no row');
    }
    if (plan.order) await replaceEndedSub(trx, order, manual, input.now, writer);
  }

  /** BR-FUND-06 / 07 before credit: R6 / R7 through the rebate port (generated transition()). */
  async function precredit(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    status: StoredStatus,
  ): Promise<void> {
    if (status !== 'SUCCEEDED') return;
    const order = input.before;
    const ref = { appId: order.app_id, orderId: order.order_id, attrAt: order.attr_at };
    const unchanged = {
      ...ref,
      estBefore: order.est_commission_fen,
      estAfter: order.est_commission_fen,
      settleCommissionFen: order.settle_commission_fen,
    };
    const base = { app_id: order.app_id, platform: order.platform, type: input.type };
    let event: PrecreditEvent;
    let change = unchanged;
    if (input.type === 'PUNISH') event = 'PUNISH';
    else if (input.type === 'INVALID_AFTER_SETTLE' || input.type === 'REFUND_AFTER_SETTLE') {
      event = 'PLATFORM_INVALID';
    } else {
      const deduction = input.deduction_commission_fen;
      // BR-CALC-02 effective union commission: settlement first, else the estimate.
      const effective = order.settle_commission_fen ?? order.est_commission_fen;
      if (deduction === null) return;
      if (effective === null) {
        logger.warn(
          { ...base, alert: 'rights_commission_unknown', outcome: 'recorded' },
          'rights deduction on an order without any union commission; recorded only',
        );
        return;
      }
      // D10-474 ① / D10-483: every deduction the union has not answered yet (answered_at empty)
      // adds up; this record is already stored, so it is among them. N_new = effective − total,
      // at or below 0 → the full side (R6).
      const open = await readOpenDeductionTotal(trx, order.app_id, order.order_id);
      const nNew = subFen(effective, open > deduction ? open : deduction);
      if (nNew <= 0n) {
        event = 'RIGHTS_FULL';
      } else {
        if (order.rebate_status === 'UNATTRIBUTED') {
          // R7 has no UNATTRIBUTED source: the partial result is recorded only.
          logger.info({ ...base, outcome: 'recorded' }, 'partial rights on an unattributed order');
          return;
        }
        event = 'RIGHTS_PARTIAL';
        // The effective commission becomes N_new for commission's valuation (R7 重算预估). N_new is
        // not a column: the stored order_rights rows carry it, and the credit (R5) subtracts the
        // deductions still open (answered_at empty) from the settlement record (B2-04lb).
        change =
          order.settle_commission_fen === null
            ? { ...unchanged, estAfter: nNew }
            : { ...unchanged, settleCommissionFen: nNew };
      }
    }
    await rebate.apply(trx, change, event, subContextOf(input));
  }

  /** BR-FUND-08 on a CREDITED order: the clawback's rights success entry (ref R{order_rights.id}). */
  async function credited(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    status: StoredStatus,
    rightsId: string,
  ): Promise<void> {
    if (status !== 'SUCCEEDED' && status !== 'WAIT_COMMISSION') return;
    const result = await clawback.apply(trx, {
      appId: input.before.app_id,
      orderId: input.order_id,
      cause: causeOf(input.type),
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: null,
      rightsDeductFen: input.type === 'RIGHTS' ? input.deduction_commission_fen : null,
      reasonSub: subContextOf(input),
      // B2-04zzs: an R8 of this record writes the BR-TEXT-05 ① reason; the cause stays RIGHTS
      // (N_new from the deduction, sub_type RIGHTS, R9 for a partial result).
      ...r8ReasonOf(input),
    });
    logger.info(
      {
        app_id: input.before.app_id,
        platform: input.before.platform,
        type: input.type,
        outcome: result.outcome,
      },
      'rights result routed to the clawback',
    );
  }

  /** rights_pending recomputed on the row as it stands now (BR-FUND-01), written only on change. */
  async function syncRightsPending(trx: Transaction<DB>, input: RightsRecordInput): Promise<void> {
    const ref = {
      appId: input.before.app_id,
      orderId: input.order_id,
      attrAt: input.before.attr_at,
    };
    const order = await readRebateOrder(trx, ref);
    if (order === undefined) throw new Error('settlement rights: order not found for app');
    const pending = await computeRightsPending(trx, ref.appId, ref.orderId);
    if (pending === order.rights_pending) return;
    const ok = await casRightsPending(trx, order, pending, input.now);
    if (!ok) throw new Error('settlement rights: rights_pending CAS matched no row');
  }

  async function record(
    trx: Transaction<DB>,
    input: RightsRecordInput,
  ): Promise<RightsRecordResult> {
    checkInput(input);
    const order = input.before;
    const base = { app_id: order.app_id, platform: order.platform, type: input.type };
    if (!acceptsRights(order.platform_status)) {
      logger.info({ ...base, outcome: 'not_applicable' }, 'rights record outside P7 / P8 states');
      return { kind: 'not_applicable' };
    }

    const status = storedStatusOf(input);
    const key = {
      appId: order.app_id,
      orderId: input.order_id,
      type: input.type,
      platformRightsNo: input.platform_rights_no,
    };
    const result = {
      status,
      amountFen: input.amount_fen,
      deductionFen: input.deduction_commission_fen,
      occurredAt: input.occurred_at,
      now: input.now,
    };
    let rightsId: string;
    let reopened: OrderRightsRow | undefined;
    // B1-09v (money r1 S2): what marks the order below; a resolved stored record may change it.
    let effective = input;
    // B1-09za: set when that choice is the stored row's own (older than the order's).
    let storedChoice: StoredChoiceRef | undefined;
    const stored = await findRights(trx, key);
    if (stored === undefined) {
      const id = await insertRights(trx, {
        ...key,
        ...result,
        source: input.source,
        manualReasonSub: manualOf(input),
      });
      if (id === null) {
        // The unique index already holds this key (never under the order lock; kept safe).
        logger.info({ ...base, outcome: 'duplicate' }, 'rights record key already stored');
        return { kind: 'duplicate' };
      }
      rightsId = id;
    } else {
      const reopens = reopensAsSucceeded(stored, input, status);
      const resolves =
        (stored.status === 'PROCESSING' && status !== 'PROCESSING') ||
        (stored.status === 'WAIT_COMMISSION' && status === 'SUCCEEDED') ||
        reopens;
      if (!resolves) {
        if (
          input.type === 'PUNISH' &&
          stored.status === 'SUCCEEDED' &&
          status === 'SUCCEEDED' &&
          isTerminal(order.rebate_status)
        ) {
          // B2-04zze (money r1 S1): the same punishment replayed with a violation text the first
          // delivery lacked refines PUNISH_ORDER / an empty sub-reason; the record, status,
          // amounts and history stay; still a duplicate. D10-957: with an explicit choice by
          // hand (an import's reason_sub) the choice replaces the sub-reason instead.
          const manual = manualOf(input);
          if (manual === undefined) await refineTerminalSub(trx, input, true);
          else await manualOnDuplicate(trx, input, stored, manual);
        }
        logger.info({ ...base, outcome: 'duplicate' }, 'rights record replayed');
        return { kind: 'duplicate' };
      }
      if (reopens && audit === undefined) {
        // D10-723: no audit port, no reopen — refused before any write (fail-closed).
        throw new Error('settlement rights: reopening a closed record needs the audit port');
      }
      // B1-09v (money r1 S2): a choice made by hand survives the resolve — the row's own when
      // the input has none, else the input's, written onto the row so row and order agree.
      // B1-09za (D10-969): the row's own choice never fills an order already chosen by hand.
      const choice = manualOnResolve(stored, input, order);
      effective = { ...input, manual_reason_sub: choice.manual };
      if (choice.fromRow && choice.manual !== undefined) {
        storedChoice = { rightsId: stored.id };
        if (
          isTerminal(order.rebate_status) &&
          status === 'SUCCEEDED' &&
          manualOnEnded(order, undefined, choice.manual, true).order
        ) {
          // Its replacement is audited; without the port, refused before anything is written.
          storedAuditFor(storedChoice);
        }
      }
      const ok = await updateRightsResult(trx, stored, {
        ...result,
        ...(choice.writeRow ? { manualReasonSub: choice.manual } : {}),
      });
      if (!ok) throw new Error('settlement rights: order_rights CAS matched no row');
      rightsId = stored.id;
      if (reopens) reopened = stored;
    }

    if (reopened !== undefined && audit !== undefined) {
      // D10-699: on this transaction, so the audit commits or rolls back with the result.
      await audit.appendAction(trx, {
        appId: order.app_id,
        actor: RIGHTS_AUDIT_ACTOR,
        action: RIGHTS_REOPEN_AUDIT_ACTION,
        target: `order_rights:${reopened.id}`,
        before: { order_rights_id: reopened.id, status: reopened.status, source: reopened.source },
        after: {
          order_rights_id: reopened.id,
          status,
          source: input.source,
          reason: RIGHTS_SUCCESS_AFTER_CLOSED,
        },
      });
      logger.warn(
        {
          ...base,
          alert: RIGHTS_SUCCESS_AFTER_CLOSED,
          reason: RIGHTS_SUCCESS_AFTER_CLOSED,
          rebate_status: order.rebate_status,
          outcome: 'reopened',
        },
        'closed rights record reported successful by the union; handled as succeeded',
      );
    }

    if (isPrecredit(order.rebate_status)) await precredit(trx, effective, status);
    else if (order.rebate_status === 'CREDITED') {
      await credited(trx, effective, status, rightsId);
    } else if (isTerminal(order.rebate_status) && status === 'SUCCEEDED') {
      // VOID / CLAWED_BACK: recorded only (BR-FUND-01 细则「订单锁定」); B2-04zze refines the
      // display sub-reason of a PUNISH order only.
      await refineTerminalSub(trx, effective, false, storedChoice);
    }

    await syncRightsPending(trx, input);
    logger.info({ ...base, status, outcome: 'applied' }, 'rights record applied');
    return { kind: 'applied' };
  }

  return Object.freeze({ record });
}
