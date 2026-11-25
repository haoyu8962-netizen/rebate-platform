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
  type SettlementBillStatus,
} from '@couli/domain';
import { addFen, parseFen, splitByBp, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { pino, type Logger } from 'pino';
import { newUuidV7, type Clock, type JobPayload } from '../../platform/index.ts';
import { lockCreditGateExclusive } from '../batch/credit-gate.ts';
import { decidingSettlement, latestSeqWithin } from '../settlements/index.ts';
import {
  createFollowUnion,
  logRegenerationDeferred,
  regenerationCapOf,
  regenerationQuota,
} from './follow-union.ts';
import type { BillSnapshotRegeneration } from './regenerate.ts';
import type { BillSnapshot, BillSnapshotSelection, BillSourceRow } from './types.ts';
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

export type {
  BillSnapshot,
  BillSnapshotSelection,
  BillSourceOrder,
  BillSourceRow,
  BillSourceSettlement,
  BillUnionConclusion,
} from './types.ts';

export interface BillValidation {
  readonly orderKey: string;
  readonly orderId: string | null;
  readonly result: BillValidationResult;
  readonly settleSeq: number | null;
}

/** 与 ledger 的差错单登记口（生产装配为只写口 registerReconDiffWriteOnly）兼容的登记输入；金额含义由发现差异的调用方给出。 */
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
    // D10-2982 ②：调用方不用返回值（生产的只写口返回 { inserted }，测试替身有的返回整行）；登记后不读差错单表。
  ): Promise<unknown>;
  /** 同事务保存逐单结果，包括 off 平台；不写入 settle_batch_items 冒充候选。 */
  saveValidations(
    trx: Transaction<DB>,
    input: BillSourceSelection,
    rows: readonly BillValidation[],
  ): Promise<void>;
  /**
   * B2-09zb: called in the generating transaction just before it commits, only on `generated` (the
   * worker sends the positive-difference run's `settle_adjust` job there, so it is queued exactly
   * when the bill run is done). Absent: nothing.
   */
  onGenerated?(trx: Transaction<DB>, input: BillJobInput): Promise<void>;
  /**
   * B2-18 (BR-FUND-04 ④, BR-FUND-01 R7): re-values the commission snapshot on the union's
   * settlement when B_settle and the current base differ beyond the tolerance, in the generating
   * transaction. Optional: absent, the order is handled as a failed regeneration (engineering alert,
   * stays WAITING, no difference registered).
   */
  readonly regenerateSnapshot?: BillSnapshotRegeneration;
  /** B2-18 (BR-FUND-04 ④ regeneration cap, D10-2982): test-only; production passes none (default 500); a non-positive-integer throws RangeError. */
  readonly regenerationCap?: number;
  /**
   * B2-18: the engineering alert of an unresolved amount mismatch (error level), the supplement's
   * warn and the settle_regeneration_deferred event (warn); same name and shape as
   * SupplementDependencies.logger. Absent: a pino instance that only writes warn and above.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
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
// ④ 的分类结果（2026-11-21 改写）：联盟有结算而我方状态不符登记 union_mismatch、计 error_count；hold /
// 维权中计 held_count；应结未结（missing_settlement）只累加进 settle_bills.unsettled_count。金额不一致
// （B2-18，BR-FUND-01 R7）不登记差错单、不计 error_count：同一事务里按联盟结算数据追加一个金额版本再校验
// （./follow-union.ts），一致即候选；仍不一致、重生成失败、端口未注入或零结算的告警工程、保持 WAITING、
// 累加进 amount_mismatch_count。四个计数都在账单行锁内、同一条 UPDATE、与出账同一事务写入。
// 「以联盟为准」的差错单结论不再读（D10-2415 ③）。没有结算记录写入路径的平台仍入不了账（D10-2402）。
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
  readonly unsettledCount: number;
  readonly amountMismatchCount: number;
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

/** 取到平台结算互斥锁之后复读的入账开关（同 readConfig 的读法：经 config.get，只认明确的 on）。 */
async function readCreditEnabled(
  deps: BillJobDependencies,
  appId: string,
  platform: string,
): Promise<boolean> {
  const enabled = await deps.config.get(appId, `credit.enabled.${platform}`);
  return enabled === 'on' || enabled === true;
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

export function createBillJob(dependencies: BillJobDependencies): BillJob {
  const deps = dependencies;
  const logger: Pick<Logger, 'warn' | 'error'> = deps.logger ?? pino({ level: 'warn' });
  const followUnion = createFollowUnion(deps);

  async function generate(
    trx: Transaction<DB>,
    input: BillJobInput,
    billId: string,
    now: Date,
    regenerationCap: number,
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
    // BR-FUND-16 加锁流程第 0 步：平台结算互斥锁排他模式，持有到本事务提交（onGenerated 期间仍在）；在账单行锁
    // 与重放判定之后取（补充也是先账单行、后平台锁），重放不取。
    await lockCreditGateExclusive(trx, appId, platform);
    // BR-FUND-04 ⑨：等锁期间开关可能被关，是否生成主批次以取到锁之后读到的 credit.enabled.<platform> 为准。
    const creditEnabled = await readCreditEnabled(deps, appId, platform);
    const rows = await deps.readSource(trx, selection);
    const cutoffMs = now.getTime();

    const validations: BillValidation[] = [];
    const candidates = new Map<string, CandidateFacts>();
    const credited: CreditedFacts[] = [];
    let errorCount = 0;
    let heldCount = 0;
    // 应结未结（BR-FUND-04 ④，2026-11-21）：只计数，不登记差错单、不计 error_count。
    let unsettledCount = 0;
    // B2-18：重生成后仍不一致、重生成失败 / 未注入、零结算的单数（只计数，不登记差错单）。
    let amountMismatchCount = 0;
    // BR-FUND-04 ④「一次出账的重生成上限」：本次出账的名额（只数重生成成功、订单键锁留到提交的单），
    // 与本次被留下（名额已满、本来要进取锁重生成那条路）的张数；后者不进任何计数列，只打一条日志事件。
    const quota = regenerationQuota(regenerationCap);
    let regenerationDeferred = 0;

    for (const row of rows) {
      // 两个数不是同一条记录（B2-04zp，BR-FUND-09）：金额、来源、取得时间看决定金额的 chosen；settle_seq 看
      // 截点内整单最大 seq。R5 与 R5a 比的是整单最大 seq（BR-FUND-04 ⑦），记成 chosen.seq 的话，STATEMENT
      // 之后再来一条 API 的单每轮都会被 settlement_changed 跳过，永远入不了账。
      const chosen = decidingSettlement(row.settlements, cutoffMs);
      const order = row.order;
      // 先不读快照判范围与类别（占位快照与 union_authoritative=true 只用来区分「需要比金额」，不是差错单结论），
      // 金额由 follow-union 按当前版本快照复核。
      const preliminary = classifySettlementBillOrder({
        bill_period: billId,
        generation_started_at: now,
        order:
          order === null
            ? null
            : {
                rebate_status: order.rebateStatus,
                settle_period: order.settlePeriod,
                hold: order.hold,
                rights_pending: order.rightsPending,
                snapshots: [{ commission_version: 0, base_fen: 0n }],
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
      let settleSeq = chosen === null ? null : latestSeqWithin(row.settlements, cutoffMs, chosen);
      // 决定金额那条结算记录的佣金：锁前取 chosen；锁后重判时取锁后重读到的（r2，资金评审 r1 第 3 条）。
      let decidingFen: bigint | null = chosen === null ? null : chosen.commissionFen;
      let judged = false;
      if (order !== null && preliminary === 'candidate' && chosen !== null) {
        // B2-18：金额比较与「跟随联盟」重生成（./follow-union.ts）；不登记差错单、不计 error_count。
        const outcome = await followUnion.check(
          trx,
          { appId, billId, now, toleranceFen: config.toleranceFen, run: 'bill', logger, quota },
          row,
          order,
          chosen,
        );
        if (outcome.kind === 'candidate') {
          judged = true;
          result = 'candidate';
          settleSeq = outcome.settleSeq;
          // BR-FUND-05：Σ 受益人份额含被剥夺与暂缓的受益人，逐角色向下取整；尾差归平台。
          const split = splitByBp(
            outcome.bSettleFen,
            outcome.snapshot.beneficiaries.map((b) => BigInt(b.ratioBp)),
          );
          candidates.set(row.orderKey, {
            orderKey: row.orderKey,
            orderId: order.orderId,
            settleSeq: outcome.settleSeq,
            bSettleFen: outcome.bSettleFen,
            commissionFen: outcome.commissionFen,
            beneficiaryFen: sumFen(split.shares),
            retainedFen: split.remainder,
          });
        } else if (outcome.kind === 'mismatch') {
          // 告警已由 follow-union 打出；订单保持 WAITING、不进批次，只计入 amount_mismatch_count。
          judged = true;
          result = 'amount_mismatch';
          amountMismatchCount += 1;
        } else if (outcome.kind === 'regeneration_deferred') {
          // 名额已满（D10-3046 (2)(3)）：不重算、不取锁、不入批、不登记差错单、不告警、保持 WAITING；
          // 不进逐单结果（不计进任务行的处理数与跳过数），四个计数都不变。
          regenerationDeferred += 1;
          continue;
        } else {
          // 锁后重读到订单已不在候选范围（例如同步期间被 hold、转为 VOID）：按重读结果走下面与锁前同一组分支
          // （r2，资金评审 r1 第 3 条），不比较金额。
          if (outcome.result === null) continue;
          result = outcome.result;
          settleSeq = outcome.settleSeq;
          decidingFen = outcome.commissionFen;
        }
      }
      if (judged) {
        // 候选 / 金额不一致已在上面处理完。
      } else if (result === 'missing_settlement' && order !== null) {
        // BR-FUND-04 ④（2026-11-21）：settle_period = 账单月、未 hold、未维权而截至生成开始仍无联盟结算
        // 数据的，只计入账单的「应结未结」数，不生成差错单（settle_missing 取值保留、不再生成），不计
        // error_count；订单行不动（仍 WAITING、settle_period 不变），结算数据到达后进补充批次或下一期账单。
        unsettledCount += 1;
      } else if (result === 'unexpected_settlement' && decidingFen !== null) {
        // BR-FUND-09：联盟有结算而我方 ESTIMATED / VOID / CLAWED_BACK 或无单，登记联盟差错。
        errorCount += 1;
        await deps.registerDiff(
          trx,
          diffInput(appId, billId, 'union_mismatch', row.orderKey, 0n, decidingFen),
          { clock: deps.clock },
        );
      } else if (result === 'deferred') {
        heldCount += 1;
      } else if (result === 'already_credited' && order !== null && settleSeq !== null) {
        credited.push({
          orderKey: row.orderKey,
          orderId: order.orderId,
          settleSeq,
        });
      }

      validations.push({
        orderKey: row.orderKey,
        orderId: order === null ? null : order.orderId,
        result,
        settleSeq,
      });
    }
    logRegenerationDeferred(logger, { appId, billId, platform, run: 'bill' }, regenerationDeferred);

    await deps.saveValidations(trx, selection, validations);

    let totals: Totals = {
      orderCount: 0,
      commissionFen: 0n,
      beneficiaryFen: 0n,
      retainedFen: 0n,
      errorCount,
      heldCount,
      unsettledCount,
      amountMismatchCount,
    };

    if (creditEnabled) {
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
        // 与 error_count、held_count 同一条 UPDATE、同一事务、同一把账单行锁内读出的旧值累加；
        // 迁移前的行为 NULL，按 0 起加；出过主批次就落具体数（没有时为 0）。
        unsettled_count: (bill.unsettled_count ?? 0) + totals.unsettledCount,
        // B2-18（D10-2521 ①）：与 unsettled_count 同口径——旧值 + 本平台数，不取较大值、不另起 UPDATE。
        amount_mismatch_count: (bill.amount_mismatch_count ?? 0) + totals.amountMismatchCount,
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
    if (deps.onGenerated !== undefined) await deps.onGenerated(trx, input);
    return { outcome: 'generated', billId, status };
  }

  return {
    async run(db, input) {
      // 先于任何读写：非正整数的上限抛 RangeError（缺省与注入同一段校验，D10-3046）。
      const regenerationCap = regenerationCapOf(deps.regenerationCap);
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
        return await db
          .transaction()
          .execute((trx) => generate(trx, input, billId, now, regenerationCap));
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
