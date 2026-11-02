import type { DB } from '@couli/db';
import type { ReconDiffType } from '@couli/contracts-ts';
import {
  accountingDate,
  chinaDayRange,
  classifySettlementBillOrder,
  deriveSettlementBillStatus,
  settlementBillPeriod,
  splitSettlementBillBatches,
  transitionSettleBatch,
  type BillValidationResult,
  type OrderRebateState,
  type SettlementBillStatus,
} from '@couli/domain';
import { addFen, applyReserve, parseFen, splitByBp, subFen } from '@couli/money';
import type { Kysely, Transaction, Selectable } from 'kysely';
import { newUuidV7, type Clock, type JobPayload } from '../../platform/index.ts';
import {
  claimSettleJob,
  completeSettleJob,
  failSettleJob,
  type SettleJobKey,
} from './settle-job.ts';

export interface BillJobInput {
  readonly appId: string;
  readonly platform: string;
  /** 名义账单日时刻；补跑保留原值，实际截点取 Clock。 */
  readonly runAt: Date;
}

export interface BillSourceSelection extends BillJobInput {
  readonly billId: string;
  readonly generationStartedAt: Date;
}

export interface BillSourceOrder {
  readonly orderId: string;
  readonly rebateStatus: Exclude<OrderRebateState, 'UNATTRIBUTED'>;
  readonly settlePeriod: string | null;
  readonly hold: boolean;
  readonly rightsPending: boolean;
  readonly commissionVersion: number;
  /** 由差错单结论读口提供，不以 closed 状态冒充「以联盟为准」。 */
  readonly unionAuthoritative: boolean;
  /** 编排裁定 D10-506 ②：结论绑定的金额；读口给了金额才有，有就必须金额相等才算相符。 */
  readonly unionConclusions?: readonly BillUnionConclusion[];
}

/** 一张「以联盟为准」差错单的 expected_fen / actual_fen。 */
export interface BillUnionConclusion {
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
}

export interface BillSourceSettlement {
  readonly seq: number;
  readonly source: 'API' | 'STATEMENT';
  readonly createdAt: Date;
  readonly settledAt: Date;
  readonly commissionFen: bigint;
}

/** 来源端口提供本 app/platform 的事实，范围、截点及最大 seq 由账单任务校验。 */
export interface BillSourceRow {
  readonly orderKey: string;
  readonly order: BillSourceOrder | null;
  readonly settlements: readonly BillSourceSettlement[];
}

export interface BillValidation {
  readonly orderKey: string;
  readonly orderId: string | null;
  readonly result: BillValidationResult;
  readonly settleSeq: number | null;
}

/** 消费方结构类型，与 B2-04i 公开读口兼容；不把 Nest 模块图引入纯服务测试。 */
export interface BillSnapshotSelection {
  readonly appId: string;
  readonly orderId: string;
  readonly commissionVersion: number;
}

export interface BillSnapshot {
  readonly baseFen: bigint;
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
  }[];
}

/** 与 ledger.registerReconDiff 兼容的登记输入；金额含义由发现差异的调用方给出。 */
export interface BillReconDiffInput {
  readonly appId: string;
  readonly type: ReconDiffType;
  readonly source: 'R1' | 'R2' | 'R3' | 'R4';
  readonly period: string;
  readonly refType: string;
  readonly refId: string;
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly diffFen: bigint;
  readonly dedupeKey: string | null;
  readonly resolution: JobPayload | null;
}

export interface BillJobDependencies {
  readonly clock: Clock;
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readSource(trx: Transaction<DB>, input: BillSourceSelection): Promise<readonly BillSourceRow[]>;
  readSnapshot(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<BillSnapshot | null>;
  /** 不可变快照里的淘礼金扣减；现有 B2-04i 尚未导出此字段。 */
  readTljDeductFen(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<bigint>;
  snapshotStatus(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly accountingDate: string },
    clock: Clock,
  ): Promise<{
    readonly state: 'pending' | 'complete' | 'timed_out';
    readonly snapshotId: string | null;
    readonly waitingComparable: boolean | null;
  }>;
  registerDiff(
    trx: Transaction<DB>,
    input: BillReconDiffInput,
    dependencies: { readonly clock: Clock },
  ): Promise<Selectable<DB['recon_diffs']>>;
  /** 同事务保存逐单结果，包括 off 平台；不写入 settle_batch_items 冒充候选。 */
  saveValidations(
    trx: Transaction<DB>,
    input: BillSourceSelection,
    rows: readonly BillValidation[],
  ): Promise<void>;
}

export interface BillJobResult {
  readonly outcome: 'generated' | 'duplicate' | 'deferred' | 'not_due';
  readonly billId: string;
  readonly status: SettlementBillStatus | null;
}

export interface BillJob {
  run(db: Kysely<DB>, input: BillJobInput): Promise<BillJobResult>;
}

// ---------------------------------------------------------------------------
// 实现（BR-FUND-04 ③④⑤⑨⑫、BR-FUND-18）。
// 调度在 worker/schedule.ts；orders 事实、淘礼金扣减、快照读口与差错登记都经依赖注入。
// settle_jobs.status 只经 ./settle-job.ts（生成的 settle-job transition()，按旧状态 CAS）。

const JOB = 'bill';
const DEFAULT_BILL_DAY = 24;
const MIN_BILL_DAY = 22;
const MAX_BILL_DAY = 28;
const DEFAULT_MAX_ORDERS = 5000;
/** 一条 INSERT 的明细行数上限，避免超出 PG 参数个数上限。 */
const INSERT_CHUNK = 1000;
const DIFF_SOURCE = 'R1';
const DIFF_REF_TYPE = 'order';

type ItemRole = 'self' | 'share' | 'direct' | 'indirect';

interface BillConfig {
  readonly toleranceFen: bigint;
  readonly maxOrders: number;
  readonly creditEnabled: boolean;
}

interface ChosenSettlement {
  readonly seq: number;
  readonly commissionFen: bigint;
}

interface CandidateFacts {
  readonly orderKey: string;
  readonly orderId: string;
  readonly settleSeq: number;
  readonly bSettleFen: bigint;
  readonly commissionFen: bigint;
  readonly beneficiaryFen: bigint;
  readonly retainedFen: bigint;
}

interface CreditedFacts {
  readonly orderKey: string;
  readonly orderId: string;
  readonly settleSeq: number;
}

interface ItemRow {
  readonly item_type: 'order' | 'beneficiary';
  readonly order_id: string;
  readonly user_id: string | null;
  readonly role: ItemRole | null;
  readonly beneficiary_credit_id: string | null;
  readonly settle_seq: number;
  readonly b_settle_fen: bigint | null;
}

interface Totals {
  readonly orderCount: number;
  readonly commissionFen: bigint;
  readonly beneficiaryFen: bigint;
  readonly retainedFen: bigint;
  readonly errorCount: number;
  readonly heldCount: number;
}

function positiveInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`config ${name} must be a positive integer`);
  }
  return parsed;
}

async function readBillDay(deps: BillJobDependencies, appId: string): Promise<number> {
  const day = positiveInteger(await deps.config.get(appId, 'settle.bill_day'), 'settle.bill_day');
  if (day === null) return DEFAULT_BILL_DAY;
  if (day < MIN_BILL_DAY || day > MAX_BILL_DAY) {
    throw new RangeError('config settle.bill_day must be within 22-28');
  }
  return day;
}

async function readConfig(
  deps: BillJobDependencies,
  appId: string,
  platform: string,
): Promise<BillConfig> {
  const rawTolerance = await deps.config.get(appId, 'settle.batch.match_tolerance_fen');
  const toleranceFen =
    rawTolerance === undefined || rawTolerance === null ? 0n : parseFen(rawTolerance);
  if (toleranceFen < 0n) {
    throw new RangeError('config settle.batch.match_tolerance_fen must be non-negative');
  }
  const maxOrders =
    positiveInteger(
      await deps.config.get(appId, 'settle.batch.max_orders'),
      'settle.batch.max_orders',
    ) ?? DEFAULT_MAX_ORDERS;
  // credit.enabled.<platform> 默认 off（BR-CALC-03）；只认明确的 on。
  const enabled = await deps.config.get(appId, `credit.enabled.${platform}`);
  return { toleranceFen, maxOrders, creditEnabled: enabled === 'on' || enabled === true };
}

/** D 的前一自然日（+08:00），只经 calendar 原语，不构造 Date。 */
function previousDay(date: string): string {
  const day = Number(date.slice(8, 10));
  if (day > 1) return `${date.slice(0, 8)}${String(day - 1).padStart(2, '0')}`;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const prevMonth =
    month === 1
      ? `${String(year - 1).padStart(4, '0')}-12`
      : `${date.slice(0, 4)}-${String(month - 1).padStart(2, '0')}`;
  for (const last of [31, 30, 29, 28]) {
    const candidate = `${prevMonth}-${String(last)}`;
    try {
      if (chinaDayRange(candidate).end.slice(0, 10) === date) return candidate;
    } catch {
      // 该月没有这一天，试下一个。
    }
  }
  throw new RangeError(`cannot derive the day before ${date}`);
}

/** 截至生成开始时刻（含）我方已取得的最大 seq；不以联盟结算时间排序。 */
function chooseSettlement(
  settlements: readonly BillSourceSettlement[],
  cutoffMs: number,
): (BillSourceSettlement & ChosenSettlement) | null {
  let chosen: BillSourceSettlement | null = null;
  for (const s of settlements) {
    if (s.createdAt.getTime() > cutoffMs) continue;
    if (chosen === null || s.seq > chosen.seq) chosen = s;
  }
  return chosen;
}

/** BR-CALC-02：B = max(0, floor(max(0,N) × (10000 − reserve_bp) / 10000) − tlj_deduct_fen)。 */
function convertBase(commissionFen: bigint, reserveBp: number, tljDeductFen: bigint): bigint {
  const afterReserve = applyReserve(commissionFen, BigInt(reserveBp)).after_reserve_fen;
  return afterReserve > tljDeductFen ? subFen(afterReserve, tljDeductFen) : 0n;
}

function sumFen(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const v of values) total = addFen(total, v);
  return total;
}

function parseCounts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, number>) };
}

function parseTotals(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, string>) };
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += size) out.push(rows.slice(start, start + size));
  return out;
}

function diffInput(
  appId: string,
  billId: string,
  type: ReconDiffType,
  orderKey: string,
  expectedFen: bigint,
  actualFen: bigint,
): BillReconDiffInput {
  return {
    appId,
    type,
    source: DIFF_SOURCE,
    period: billId,
    refType: DIFF_REF_TYPE,
    refId: orderKey,
    expectedFen,
    actualFen,
    diffFen: subFen(expectedFen, actualFen),
    dedupeKey: null,
    resolution: null,
  };
}

/**
 * 编排裁定 D10-506 ②：「以联盟为准」只在当前基数与 B_settle 都精确等于结论金额时成立（不走容差），
 * 否则结论不适用，照常比较。
 */
export function unionConclusionApplies(
  order: BillSourceOrder,
  baseFen: bigint,
  bSettleFen: bigint,
): boolean {
  if (!order.unionAuthoritative) return false;
  if (order.unionConclusions === undefined) return true;
  return order.unionConclusions.some(
    (c) => c.expectedFen === baseFen && c.actualFen === bSettleFen,
  );
}

/**
 * 编排裁定 D10-506 ③：登记账单金额不一致。本账单首张是裸 {order_key} 行；裸行已被别的金额占着时，
 * 登记 {order_key}#AMT#{base}:{b_settle}（CT-24zf，dedupe_key 留空，靠含 period 的业务键）。
 * 两步都按业务键幂等、精确匹配，不用 LIKE：本账单已有这个金额的单（裸行或 #AMT# 行）就不增加。
 */
export async function registerAmountMismatch(
  deps: Pick<BillJobDependencies, 'clock' | 'registerDiff'>,
  trx: Transaction<DB>,
  input: BillReconDiffInput,
): Promise<void> {
  const { expectedFen, actualFen } = input;
  const first = await deps.registerDiff(trx, input, { clock: deps.clock });
  if (first.expected_fen === expectedFen && first.actual_fen === actualFen) return;
  const refId = `${input.refId}#AMT#${String(expectedFen)}:${String(actualFen)}`;
  await deps.registerDiff(trx, { ...input, refId }, { clock: deps.clock });
}

export function createBillJob(dependencies: BillJobDependencies): BillJob {
  const deps = dependencies;

  async function readSnapshotOrThrow(
    trx: Transaction<DB>,
    selection: BillSnapshotSelection,
  ): Promise<BillSnapshot> {
    const snapshot = await deps.readSnapshot(trx, selection);
    if (snapshot === null) {
      throw new Error(
        `settlement bill: commission snapshot v${String(selection.commissionVersion)} missing`,
      );
    }
    return snapshot;
  }

  async function generate(
    trx: Transaction<DB>,
    input: BillJobInput,
    billId: string,
    now: Date,
  ): Promise<BillJobResult> {
    const { appId, platform } = input;
    const key: SettleJobKey = { appId, job: JOB, platform, runAt: input.runAt };
    // 新键 START；同键 failed 行 RETRY 同一行重跑；done / running 判为重放、不改行。
    const jobId = await claimSettleJob(trx, key, now);
    if (jobId === null) return { outcome: 'duplicate', billId, status: null };

    await trx
      .withSchema('app')
      .insertInto('settle_bills')
      .values({ app_id: appId, bill_id: billId, generation_started_at: now, generated_at: null })
      .onConflict((oc) => oc.columns(['app_id', 'bill_id']).doNothing())
      .execute();
    // 同账单的各平台任务在账单行上串行，合计按平台合并，不互相覆盖。
    const bill = await trx
      .withSchema('app')
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', appId)
      .where('bill_id', '=', billId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const counts = parseCounts(bill.platform_order_counts);
    if (Object.prototype.hasOwnProperty.call(counts, platform)) {
      // 该平台本账单已出过主批次（另一 run_at 的投递）；不重复生成，后续走补充批次（⑧）。
      await completeSettleJob(trx, jobId, now, 0, 0);
      return { outcome: 'duplicate', billId, status: null };
    }

    const config = await readConfig(deps, appId, platform);
    const selection: BillSourceSelection = {
      appId,
      platform,
      runAt: input.runAt,
      billId,
      generationStartedAt: now,
    };
    const rows = await deps.readSource(trx, selection);
    const cutoffMs = now.getTime();

    const validations: BillValidation[] = [];
    const candidates = new Map<string, CandidateFacts>();
    const credited: CreditedFacts[] = [];
    let errorCount = 0;
    let heldCount = 0;

    for (const row of rows) {
      const chosen = chooseSettlement(row.settlements, cutoffMs);
      const order = row.order;
      const facts = (snapshots: readonly { commission_version: number; base_fen: bigint }[]) =>
        order === null
          ? null
          : {
              rebate_status: order.rebateStatus,
              settle_period: order.settlePeriod,
              hold: order.hold,
              rights_pending: order.rightsPending,
              snapshots,
              union_authoritative: order.unionAuthoritative,
            };
      // 先不读快照判范围与类别（以联盟为准的占位只用来区分「需要比金额」），再按需读快照复核。
      const preliminary = classifySettlementBillOrder({
        bill_period: billId,
        generation_started_at: now,
        order:
          order === null
            ? null
            : {
                ...facts([{ commission_version: 0, base_fen: 0n }])!,
                union_authoritative: true,
              },
        settlement:
          chosen === null
            ? null
            : {
                source: chosen.source,
                created_at: chosen.createdAt,
                settle_commission_fen: chosen.commissionFen,
                b_settle_fen: 0n,
              },
        match_tolerance_fen: config.toleranceFen,
      });
      if (preliminary === null) continue;

      let result: BillValidationResult = preliminary;
      if (order !== null && preliminary === 'candidate' && chosen !== null) {
        const snapshotSelection = {
          appId,
          orderId: order.orderId,
          commissionVersion: order.commissionVersion,
        };
        const snapshot = await readSnapshotOrThrow(trx, snapshotSelection);
        const tlj = await deps.readTljDeductFen(trx, snapshotSelection);
        const bSettle = convertBase(chosen.commissionFen, snapshot.reserveBp, tlj);
        const final = classifySettlementBillOrder({
          bill_period: billId,
          generation_started_at: now,
          order: {
            ...facts([
              { commission_version: order.commissionVersion, base_fen: snapshot.baseFen },
            ])!,
            union_authoritative: unionConclusionApplies(order, snapshot.baseFen, bSettle),
          },
          settlement: {
            source: chosen.source,
            created_at: chosen.createdAt,
            settle_commission_fen: chosen.commissionFen,
            b_settle_fen: bSettle,
          },
          match_tolerance_fen: config.toleranceFen,
        });
        if (final === null) throw new Error('settlement bill: classification changed scope');
        result = final;
        if (result === 'candidate') {
          // BR-FUND-05：Σ 受益人份额含被剥夺与暂缓的受益人，逐角色向下取整；尾差归平台。
          const split = splitByBp(
            bSettle,
            snapshot.beneficiaries.map((b) => BigInt(b.ratioBp)),
          );
          candidates.set(row.orderKey, {
            orderKey: row.orderKey,
            orderId: order.orderId,
            settleSeq: chosen.seq,
            bSettleFen: bSettle,
            commissionFen: chosen.commissionFen,
            beneficiaryFen: sumFen(split.shares),
            retainedFen: split.remainder,
          });
        } else {
          errorCount += 1;
          await registerAmountMismatch(
            deps,
            trx,
            diffInput(
              appId,
              billId,
              'settle_amount_mismatch',
              row.orderKey,
              snapshot.baseFen,
              bSettle,
            ),
          );
        }
      } else if (preliminary === 'missing_settlement' && order !== null) {
        errorCount += 1;
        const snapshot = await deps.readSnapshot(trx, {
          appId,
          orderId: order.orderId,
          commissionVersion: order.commissionVersion,
        });
        await deps.registerDiff(
          trx,
          diffInput(appId, billId, 'settle_missing', row.orderKey, snapshot?.baseFen ?? 0n, 0n),
          { clock: deps.clock },
        );
      } else if (preliminary === 'unexpected_settlement' && chosen !== null) {
        // BR-FUND-09：联盟有结算而我方 ESTIMATED / VOID / CLAWED_BACK 或无单，登记联盟差错。
        errorCount += 1;
        await deps.registerDiff(
          trx,
          diffInput(appId, billId, 'union_mismatch', row.orderKey, 0n, chosen.commissionFen),
          { clock: deps.clock },
        );
      } else if (preliminary === 'deferred') {
        heldCount += 1;
      } else if (preliminary === 'already_credited' && order !== null && chosen !== null) {
        credited.push({ orderKey: row.orderKey, orderId: order.orderId, settleSeq: chosen.seq });
      }

      validations.push({
        orderKey: row.orderKey,
        orderId: order === null ? null : order.orderId,
        result,
        settleSeq: chosen === null ? null : chosen.seq,
      });
    }

    await deps.saveValidations(trx, selection, validations);

    let totals: Totals = {
      orderCount: 0,
      commissionFen: 0n,
      beneficiaryFen: 0n,
      retainedFen: 0n,
      errorCount,
      heldCount,
    };

    if (config.creditEnabled) {
      const drafts = splitSettlementBillBatches(
        billId,
        validations.map((v) => ({
          platform,
          order_key: v.orderKey,
          credit_enabled: true,
          result: v.result,
        })),
        config.maxOrders,
      );
      const batches: ItemRow[][] = drafts.map((draft) =>
        draft.order_keys.map((key) => {
          const c = candidates.get(key);
          if (c === undefined) throw new Error('settlement bill: batch key without candidate');
          return {
            item_type: 'order',
            order_id: c.orderId,
            user_id: null,
            role: null,
            beneficiary_credit_id: null,
            settle_seq: c.settleSeq,
            b_settle_fen: c.bSettleFen,
          };
        }),
      );

      // ⑫ 补记项：只取本平台 CREDITED 子订单上 open 的义务；金额在执行时才算。
      const beneficiaryItems = await openObligationItems(trx, appId, credited);
      for (const item of beneficiaryItems) {
        const last = batches[batches.length - 1];
        if (last !== undefined && last.length < config.maxOrders) last.push(item);
        else batches.push([item]);
      }

      for (const items of batches) {
        const transition = transitionSettleBatch(null, 'GENERATE');
        if (!transition.ok || transition.noop || transition.to !== 'DRAFT') {
          throw new Error('settlement bill: SB1 GENERATE is not allowed');
        }
        const batchId = newUuidV7(now);
        await trx
          .withSchema('app')
          .insertInto('settle_batches')
          .values({
            batch_id: batchId,
            app_id: appId,
            bill_id: billId,
            platform,
            kind: 'main',
            status: transition.to,
            settle_mode: 'IMMEDIATE',
            scheduled_at: null,
            confirmed_by: null,
            confirmed_at: null,
            cancelled_reason: null,
            settle_run_id: null,
            order_count: items.filter((i) => i.item_type === 'order').length,
            started_at: null,
            finished_at: null,
            paused_by_switch_at: null,
          })
          .execute();
        for (const part of chunks(items, INSERT_CHUNK)) {
          await trx
            .withSchema('app')
            .insertInto('settle_batch_items')
            .values(
              part.map((item) => ({
                id: newUuidV7(now),
                app_id: appId,
                batch_id: batchId,
                item_type: item.item_type,
                order_id: item.order_id,
                user_id: item.user_id,
                role: item.role,
                beneficiary_credit_id: item.beneficiary_credit_id,
                settle_seq: item.settle_seq,
                b_settle_fen: item.b_settle_fen,
                amount_fen: null,
                result: null,
                skip_reason: null,
              })),
            )
            .execute();
        }
      }

      const included = [...candidates.values()];
      totals = {
        ...totals,
        orderCount: included.length,
        commissionFen: sumFen(included.map((c) => c.commissionFen)),
        beneficiaryFen: sumFen(included.map((c) => c.beneficiaryFen)),
        retainedFen: sumFen(included.map((c) => c.retainedFen)),
      };
    }

    // ⑤ 账单合计：按平台合并到同月账单；off 平台只记 0 与校验计数（⑨）。
    const commissionTotals = parseTotals(bill.platform_settle_commission_totals);
    counts[platform] = totals.orderCount;
    commissionTotals[platform] = totals.commissionFen.toString();
    await trx
      .withSchema('app')
      .updateTable('settle_bills')
      .set({
        generated_at: now,
        platform_order_counts: JSON.stringify(counts),
        platform_settle_commission_totals: JSON.stringify(commissionTotals),
        beneficiary_total_fen: addFen(bill.beneficiary_total_fen ?? 0n, totals.beneficiaryFen),
        platform_retained_fen: addFen(bill.platform_retained_fen ?? 0n, totals.retainedFen),
        error_count: (bill.error_count ?? 0) + totals.errorCount,
        held_count: (bill.held_count ?? 0) + totals.heldCount,
      })
      .where('app_id', '=', appId)
      .where('bill_id', '=', billId)
      .execute();

    await completeSettleJob(trx, jobId, now, validations.length, heldCount);

    const batches = await trx
      .withSchema('app')
      .selectFrom('settle_batches')
      .select(['status', 'settle_mode', 'scheduled_at'])
      .where('app_id', '=', appId)
      .where('bill_id', '=', billId)
      .where('kind', '=', 'main')
      .execute();
    const status = deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 0,
      batches: batches.map((b) => ({
        round: 0,
        status: b.status as 'DRAFT',
        settle_mode: b.settle_mode as 'IMMEDIATE' | 'SCHEDULED',
        scheduled_at: b.scheduled_at,
      })),
      now,
    });
    return { outcome: 'generated', billId, status };
  }

  return {
    async run(db, input) {
      const billId = settlementBillPeriod(input.runAt);
      const billDay = await readBillDay(deps, input.appId);
      if (Number(accountingDate(input.runAt).slice(8, 10)) !== billDay) {
        return { outcome: 'not_due', billId, status: null };
      }
      const now = deps.clock.now();
      // BR-FUND-18：等执行当日（D+1）对 D 日的资产快照完成或已超时；未完成不写任何东西。
      const snapshot = await deps.snapshotStatus(
        db,
        { appId: input.appId, accountingDate: previousDay(accountingDate(now)) },
        deps.clock,
      );
      if (snapshot.state === 'pending') return { outcome: 'deferred', billId, status: null };
      try {
        return await db.transaction().execute((trx) => generate(trx, input, billId, now));
      } catch (error) {
        // 生成事务已整体回滚；另起事务把该键记为 failed（FAIL），重投递同一 run_at 时经 RETRY 重跑。
        const key: SettleJobKey = {
          appId: input.appId,
          job: JOB,
          platform: input.platform,
          runAt: input.runAt,
        };
        try {
          await failSettleJob(db, key, deps.clock.now());
        } catch {
          // 记失败本身出错时保留原始错误；行仍缺失或为 failed，重投递照常可恢复。
        }
        throw error;
      }
    },
  };
}

async function openObligationItems(
  trx: Transaction<DB>,
  appId: string,
  credited: readonly CreditedFacts[],
): Promise<ItemRow[]> {
  if (credited.length === 0) return [];
  const byOrder = new Map(credited.map((c) => [c.orderId, c]));
  const items: { key: string; id: string; row: ItemRow }[] = [];
  for (const part of chunks([...byOrder.keys()], INSERT_CHUNK)) {
    const open = await trx
      .withSchema('app')
      .selectFrom('beneficiary_credits')
      .select(['beneficiary_credit_id', 'order_id', 'user_id', 'role'])
      .where('app_id', '=', appId)
      .where('status', '=', 'open')
      .where('order_id', 'in', part)
      .execute();
    for (const o of open) {
      const facts = byOrder.get(o.order_id)!;
      items.push({
        key: facts.orderKey,
        id: o.beneficiary_credit_id,
        row: {
          item_type: 'beneficiary',
          order_id: o.order_id,
          user_id: o.user_id,
          role: o.role as ItemRole,
          beneficiary_credit_id: o.beneficiary_credit_id,
          settle_seq: facts.settleSeq,
          b_settle_fen: null,
        },
      });
    }
  }
  items.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return items.map((i) => i.row);
}
