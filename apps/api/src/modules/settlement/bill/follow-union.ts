// B2-18 (BR-FUND-04 ④ 2026-11-21, 细则校验结果表第 2 行 / 例 2; BR-FUND-01 R7; BR-CALC-02 / 10 / 15):
// the amount check of one in-scope WAITING sub-order with union settlement data, shared by the bill
// job and the supplement launch. It replaces the old 「金额不一致 → 登记差错单、等财务以联盟为准结案」.
//
// 1. Read the current commission version's snapshot; B_settle = BR-CALC-02 over the deciding
//    settlement record (latest STATEMENT, else latest API; BR-FUND-09) with the snapshot's reserve_bp
//    and the stored 淘礼金扣减.
// 2. Union settlement commission 0 (or below) while the base is > 0: stopped before any tolerance
//    (编排 D10-2532) — no regeneration, engineering alert.
// 3. Within the tolerance (BR-CALC-15): a candidate, no new version.
// 4. Beyond it: inside a savepoint of the caller's transaction take orders' order key advisory lock
//    (settlement/AGENTS.md lock order: order key → users → ledger; nothing else is locked here),
//    re-read the order row, its settlement records and the current version, judge again on what was
//    read after the lock, and only if it still differs call the regeneration port (one new amount
//    version valued on the union's settlement, version = current + 1), then validate once more.
// 5. Any failure — still different, the port threw, no port injected, zero settlement — rolls the
//    savepoint back (the version, its rows and orders.commission_version stay as they were) and logs
//    one error-level engineering alert (alert, app_id, bill_id, order_id; no platform order number,
//    order key or beneficiary). The caller counts it into amount_mismatch_count (the bill job only),
//    registers no recon diff and puts the order in no batch; it stays WAITING.
//    A unique violation (a concurrent writer of the same version number) is judged once more on a
//    fresh read after the lock instead of being left as a failure.
// r2 (资金评审 r1): (第 1 条) after the lock, when the deciding settlement record without a cut-off is
//    another record than the one within the cut-off and converts to a different base, the order is
//    skipped this run (reason settlement_changed_after_cutoff) — never rewrite the current snapshot
//    with a settlement amount that has since been superseded; (第 2 条) a version advanced by another
//    transaction between the source read and the snapshot read is judged under the lock instead of
//    aborting the whole run; (第 3 条) a non-candidate result re-read after the lock carries the
//    deciding commission back so that the caller runs its usual branch for it.
//
// B2-18d (BR-FUND-04 ④ 细则「一次出账的重生成上限」, D10-2982 ① / D10-3046): one run (a bill-day job or
//    one supplement) holds at most REGENERATION_CAP order key locks until it commits — only an order
//    whose regeneration succeeded keeps its lock (and takes one slot). Once the slots are used up, an
//    order that would take the savepoint → lock → re-read → regenerate path (beyond the tolerance
//    before the lock, or a version advanced by another transaction so nothing can be judged before
//    the lock) is left for the next supplement: checked before the savepoint and the lock, nothing
//    written, no alert. Every other classification is unchanged. Under the lock, an order that is
//    not regenerated (matching on the re-read, or no longer a candidate) wrote nothing: the savepoint
//    is rolled back so that its lock is let go before commit and it takes no slot.
//
// Never read here: the recon diff 「以联盟为准」 conclusions (D10-2415 ③, D10-2567) or recon_diffs at
// all. Vouchers, entries and balances only come from R5 after the batch is confirmed.
// pdd / jd orders still cannot be credited (no settlement record write path, D10-2402); unchanged.
import type { DB } from '@couli/db';
import {
  classifySettlementBillOrder,
  type BillOrderFacts,
  type BillValidationResult,
} from '@couli/domain';
import { applyReserve, subFen } from '@couli/money';
import { sql, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import { lockOrderKey } from '../../orders/index.ts';
import { readOrderLocator } from '../credit/credit-store.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { decidingSettlement, latestSeqWithin } from '../settlements/index.ts';
import { readOrderSettlements } from './infra/order-settlements.ts';
import type { BillSnapshotRegeneration } from './regenerate.ts';
import type {
  BillSnapshot,
  BillSnapshotSelection,
  BillSourceOrder,
  BillSourceRow,
  BillSourceSettlement,
} from './types.ts';

/** The fixed identifier of the engineering alert (pinned by the rule tests). */
export const AMOUNT_MISMATCH_ALERT = 'settle_amount_mismatch_unresolved';

const SAVEPOINT = 'settle_bill_follow_union';

/**
 * BR-FUND-04 ④ 细则「一次出账的重生成上限」：500 张（技术常量，不进配置）。只数重生成成功、订单键锁留到事务提交的
 * 子订单。月结与补充同一个缺省值；BillJobDependencies.regenerationCap 只供测试注入。
 */
export const REGENERATION_CAP = 500;

/** 名额已满时本次留下的张数的日志事件（D10-2987 / D10-2988 / D10-3046 (4)）：warn，消息即事件名。 */
export const REGENERATION_DEFERRED_EVENT = 'settle_regeneration_deferred';

/**
 * 本次出账的上限：缺省与注入走同一段校验（D10-3046），非正整数（0、负数、小数、非数）抛 RangeError。调用方在
 * 写任何行之前调用。
 */
export function regenerationCapOf(injected: number | undefined): number {
  const cap = injected ?? REGENERATION_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError('settlement bill: regenerationCap must be a positive integer');
  }
  return cap;
}

/** 一次出账的重生成名额；每次出账（每个生成事务）新建一个，失败重跑时从 0 起。 */
export interface RegenerationQuota {
  readonly cap: number;
  /** 已重生成成功、订单键锁留到提交的张数（只由 check 在 RELEASE 重生成的保存点后加 1）。 */
  used: number;
}

export function regenerationQuota(cap: number): RegenerationQuota {
  return { cap, used: 0 };
}

/** 逐单处理结束后调用一次：留下 0 张不打；不带订单号、受益人与 alert 字段。 */
export function logRegenerationDeferred(
  logger: Pick<Logger, 'warn'>,
  at: {
    readonly appId: string;
    readonly billId: string;
    readonly platform: string;
    readonly run: 'bill' | 'supplement';
  },
  deferredCount: number,
): void {
  if (deferredCount <= 0) return;
  logger.warn(
    {
      app_id: at.appId,
      bill_id: at.billId,
      platform: at.platform,
      run: at.run,
      deferred_count: deferredCount,
    },
    REGENERATION_DEFERRED_EVENT,
  );
}
const UNIQUE_VIOLATION = '23505';

export type FollowUnionLogger = Pick<Logger, 'error'>;

export type FollowUnionFailure =
  | 'zero_settlement'
  | 'regeneration_unavailable'
  | 'regeneration_failed'
  | 'still_mismatched'
  /**
   * r2（资金评审 r1 第 1 条，S0）：锁后重读发现截点之后又有改变结算额的决定性结算记录。本轮不用截点内的
   * 旧结算额重写当前快照，跳过该单，留给补充或下一期账单（那时截点已包含新记录）。
   */
  | 'settlement_changed_after_cutoff';

/** 告警正文里的性质说明（编排 D10-2620）：只用于 settlement_changed_after_cutoff。 */
export const SETTLEMENT_CHANGED_AFTER_CUTOFF_NOTE =
  '属并发时序：结算数据在出账截点之后有更新，本轮跳过；下一期账单或补充会自动对上，无需人工处理';

/** The subset of BillJobDependencies the amount check uses (structurally the same members). */
export interface FollowUnionDependencies {
  readSnapshot(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<BillSnapshot | null>;
  readTljDeductFen(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<bigint>;
  readonly regenerateSnapshot?: BillSnapshotRegeneration;
}

export interface FollowUnionContext {
  readonly appId: string;
  readonly billId: string;
  /** Generation start: the settlement records' cut-off. */
  readonly now: Date;
  readonly toleranceFen: bigint;
  /** 'bill' or 'supplement', for the alert only. */
  readonly run: 'bill' | 'supplement';
  readonly logger: FollowUnionLogger;
  /** This run's regeneration slots (shared by every check of the run). */
  readonly quota: RegenerationQuota;
}

export type FollowUnionOutcome =
  | {
      readonly kind: 'candidate';
      readonly settleSeq: number;
      readonly bSettleFen: bigint;
      /** The deciding settlement record's commission (N). */
      readonly commissionFen: bigint;
      /** The snapshot the order is batched on (the regenerated version when one was written). */
      readonly snapshot: BillSnapshot;
    }
  | { readonly kind: 'mismatch'; readonly reason: FollowUnionFailure }
  /**
   * BR-FUND-04 ④ 重生成上限：名额已满，这张本来要进取锁重生成那条路的单本轮不处理——没开保存点、没取订单键锁、
   * 没写任何东西、没告警。调用方不入批、不登记差错单、不计任何计数、不放进逐单结果，只数张数打日志事件。
   */
  | { readonly kind: 'regeneration_deferred' }
  /**
   * Re-read after the lock, the order is no longer a candidate / mismatch (e.g. held or voided
   * meanwhile). The caller handles `result` exactly like the same preliminary result (r2, 资金评审 r1
   * 第 3 条): `commissionFen` is the deciding settlement record's commission read after the lock
   * (null when there is none), for the union_mismatch diff of an unexpected_settlement.
   */
  | {
      readonly kind: 'other';
      readonly result: BillValidationResult | null;
      readonly settleSeq: number | null;
      readonly commissionFen: bigint | null;
    };

/** BR-CALC-02：B = max(0, floor(max(0,N) × (10000 − reserve_bp) / 10000) − tlj_deduct_fen)。 */
export function convertBase(
  commissionFen: bigint,
  reserveBp: number,
  tljDeductFen: bigint,
): bigint {
  const afterReserve = applyReserve(commissionFen, BigInt(reserveBp)).after_reserve_fen;
  return afterReserve > tljDeductFen ? subFen(afterReserve, tljDeductFen) : 0n;
}

/**
 * 编排 D10-2532：联盟结算佣金为 0（或更低）而快照基数 > 0 一律拦下，先于容差判断；
 * 基数与结算都为 0 的不拦（仍按容差判为候选）。
 */
export function isZeroSettlementBlocked(commissionFen: bigint, baseFen: bigint): boolean {
  return commissionFen <= 0n && baseFen > 0n;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * r2（资金评审 r1 第 1 条）：(a) 截点内的决定性结算记录 `withinCutoff` 与 (b) 不设截点的当前决定性结算记录
 * `latest`（同 BR-FUND-09：有 STATEMENT 取最新 STATEMENT，否则最新 API）不是同一条记录、且按同一快照
 * 的 reserve_bp 与淘礼金扣减换算出的基数不同 → 截点之后结算额变了。
 */
export function settlementChangedAfterCutoff(
  withinCutoff: Pick<BillSourceSettlement, 'seq' | 'commissionFen'>,
  latest: Pick<BillSourceSettlement, 'seq' | 'commissionFen'> | null,
  reserveBp: number,
  tljDeductFen: bigint,
): boolean {
  if (latest === null || latest.seq === withinCutoff.seq) return false;
  return (
    convertBase(latest.commissionFen, reserveBp, tljDeductFen) !==
    convertBase(withinCutoff.commissionFen, reserveBp, tljDeductFen)
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface Facts {
  readonly order: Pick<
    BillSourceOrder,
    'orderId' | 'rebateStatus' | 'settlePeriod' | 'hold' | 'rightsPending' | 'commissionVersion'
  >;
  readonly settlements: readonly BillSourceSettlement[];
}

function orderFacts(
  order: Facts['order'],
  snapshot: { readonly version: number; readonly baseFen: bigint },
): BillOrderFacts {
  return {
    rebate_status: order.rebateStatus,
    settle_period: order.settlePeriod,
    hold: order.hold,
    rights_pending: order.rightsPending,
    snapshots: [{ commission_version: snapshot.version, base_fen: snapshot.baseFen }],
    // The 「以联盟为准」 conclusion is no longer an input of the bill (D10-2415 ③).
    union_authoritative: false,
  };
}

export function createFollowUnion(deps: FollowUnionDependencies) {
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

  /** Scope and class without reading the snapshot (a placeholder base only marks 「需要比金额」). */
  function preliminary(
    ctx: FollowUnionContext,
    facts: Facts,
    chosen: BillSourceSettlement | null,
  ): BillValidationResult | null {
    return classifySettlementBillOrder({
      bill_period: ctx.billId,
      generation_started_at: ctx.now,
      order: { ...orderFacts(facts.order, { version: 0, baseFen: 0n }), union_authoritative: true },
      settlement:
        chosen === null
          ? null
          : {
              source: chosen.source,
              created_at: chosen.createdAt,
              settle_commission_fen: chosen.commissionFen,
              b_settle_fen: 0n,
            },
      match_tolerance_fen: ctx.toleranceFen,
    });
  }

  /** The amount judgement on one version: candidate within the tolerance, else amount_mismatch. */
  function judge(
    ctx: FollowUnionContext,
    facts: Facts,
    chosen: BillSourceSettlement,
    version: number,
    baseFen: bigint,
    bSettleFen: bigint,
  ): BillValidationResult {
    const result = classifySettlementBillOrder({
      bill_period: ctx.billId,
      generation_started_at: ctx.now,
      order: orderFacts(facts.order, { version, baseFen }),
      settlement: {
        source: chosen.source,
        created_at: chosen.createdAt,
        settle_commission_fen: chosen.commissionFen,
        b_settle_fen: bSettleFen,
      },
      match_tolerance_fen: ctx.toleranceFen,
    });
    if (result === null) throw new Error('settlement bill: classification changed scope');
    return result;
  }

  async function valued(
    trx: Transaction<DB>,
    appId: string,
    orderId: string,
    version: number,
    chosen: BillSourceSettlement,
  ): Promise<{ snapshot: BillSnapshot; bSettleFen: bigint; tljDeductFen: bigint }> {
    const selection = { appId, orderId, commissionVersion: version };
    const snapshot = await readSnapshotOrThrow(trx, selection);
    const tlj = await deps.readTljDeductFen(trx, selection);
    return {
      snapshot,
      bSettleFen: convertBase(chosen.commissionFen, snapshot.reserveBp, tlj),
      tljDeductFen: tlj,
    };
  }

  /** orders.commission_version as committed now (no lock), or undefined when the row is gone. */
  async function committedVersion(
    trx: Transaction<DB>,
    appId: string,
    orderId: string,
  ): Promise<number | undefined> {
    const locator = await readOrderLocator(trx, appId, orderId);
    if (locator === undefined) return undefined;
    const row = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
    return row?.commission_version;
  }

  function alert(
    ctx: FollowUnionContext,
    orderId: string,
    reason: FollowUnionFailure,
    error?: unknown,
  ): FollowUnionOutcome {
    const changed = reason === 'settlement_changed_after_cutoff';
    ctx.logger.error(
      {
        alert: AMOUNT_MISMATCH_ALERT,
        app_id: ctx.appId,
        bill_id: ctx.billId,
        order_id: orderId,
        run: ctx.run,
        reason,
        ...(changed ? { note: SETTLEMENT_CHANGED_AFTER_CUTOFF_NOTE } : {}),
        ...(error === undefined ? {} : { error_name: errorName(error) }),
      },
      changed
        ? `settlement bill: ${SETTLEMENT_CHANGED_AFTER_CUTOFF_NOTE}`
        : 'settlement bill: amount mismatch not resolved by following the union settlement',
    );
    return { kind: 'mismatch', reason };
  }

  /**
   * Steps 4–5 under the order key lock; throws on a failed write (the caller rolls back).
   * `regenerated` is true only on the candidate returned after a successful regeneration — the one
   * outcome whose savepoint is released with the lock kept until commit.
   */
  async function underLock(
    trx: Transaction<DB>,
    ctx: FollowUnionContext,
    orderId: string,
  ): Promise<{ readonly outcome: FollowUnionOutcome; readonly regenerated: boolean }> {
    const plain = (outcome: FollowUnionOutcome) => ({ outcome, regenerated: false });
    const locator = await readOrderLocator(trx, ctx.appId, orderId);
    if (locator === undefined) throw new Error('settlement bill: order not found for app');
    await lockOrderKey(trx, locator.platform, locator.sub_order_id);

    // Re-read after the lock: what decides is what the order sync committed before it let go.
    const row = await readRebateOrder(trx, { appId: ctx.appId, orderId, attrAt: locator.attr_at });
    if (row === undefined) throw new Error('settlement bill: order not found for app');
    if (row.rebate_status === 'UNATTRIBUTED')
      return plain({ kind: 'other', result: null, settleSeq: null, commissionFen: null });
    const settlements = await readOrderSettlements(trx, ctx.appId, orderId);
    const cutoffMs = ctx.now.getTime();
    const chosen = decidingSettlement(settlements, cutoffMs);
    const facts: Facts = {
      order: {
        orderId,
        rebateStatus: row.rebate_status as BillSourceOrder['rebateStatus'],
        settlePeriod: row.settle_period,
        hold: row.hold,
        rightsPending: row.rights_pending,
        commissionVersion: row.commission_version,
      },
      settlements,
    };
    const settleSeq = chosen === null ? null : latestSeqWithin(settlements, cutoffMs, chosen);
    const scoped = preliminary(ctx, facts, chosen);
    if (scoped !== 'candidate' || chosen === null || settleSeq === null) {
      return plain({
        kind: 'other',
        result: scoped,
        settleSeq,
        commissionFen: chosen === null ? null : chosen.commissionFen,
      });
    }

    const current = await valued(trx, ctx.appId, orderId, row.commission_version, chosen);
    if (isZeroSettlementBlocked(chosen.commissionFen, current.snapshot.baseFen)) {
      return plain({ kind: 'mismatch', reason: 'zero_settlement' });
    }
    const base = current.snapshot.baseFen;
    if (
      judge(ctx, facts, chosen, row.commission_version, base, current.bSettleFen) === 'candidate'
    ) {
      return plain({
        kind: 'candidate',
        settleSeq,
        commissionFen: chosen.commissionFen,
        snapshot: current.snapshot,
        bSettleFen: current.bSettleFen,
      });
    }

    // r2（资金评审 r1 第 1 条，S0）：截点之后结算额已变，不用截点内的旧结算额重写当前快照。
    const latest = decidingSettlement(settlements, Number.POSITIVE_INFINITY);
    if (
      settlementChangedAfterCutoff(chosen, latest, current.snapshot.reserveBp, current.tljDeductFen)
    ) {
      return plain({ kind: 'mismatch', reason: 'settlement_changed_after_cutoff' });
    }

    const port = deps.regenerateSnapshot;
    if (port === undefined) return plain({ kind: 'mismatch', reason: 'regeneration_unavailable' });
    const written = await port.regenerate(trx, {
      appId: ctx.appId,
      orderId,
      commissionVersion: row.commission_version,
      settleCommissionFen: chosen.commissionFen,
      bSettleFen: current.bSettleFen,
    });
    // Validate once more, on the version the port appended (readSnapshot asserts it is the greatest).
    const next = await valued(trx, ctx.appId, orderId, written.commissionVersion, chosen);
    const again = judge(
      ctx,
      facts,
      chosen,
      written.commissionVersion,
      next.snapshot.baseFen,
      next.bSettleFen,
    );
    if (again !== 'candidate') return plain({ kind: 'mismatch', reason: 'still_mismatched' });
    return {
      outcome: {
        kind: 'candidate',
        settleSeq,
        commissionFen: chosen.commissionFen,
        snapshot: next.snapshot,
        bSettleFen: next.bSettleFen,
      },
      regenerated: true,
    };
  }

  return {
    /**
     * One in-scope sub-order that the bill source classified as needing the amount check
     * (preliminary 'candidate', settlement data present). Writes only through the regeneration
     * port, inside a savepoint of `trx`.
     */
    async check(
      trx: Transaction<DB>,
      ctx: FollowUnionContext,
      row: BillSourceRow,
      order: BillSourceOrder,
      chosen: BillSourceSettlement,
    ): Promise<FollowUnionOutcome> {
      const cutoffMs = ctx.now.getTime();
      // r2（资金评审 r1 第 2 条）：来源行读出之后、读快照之前，别的事务（如同时发起的补充）可能已把这张单的
      // 版本推进；快照读口只接受最大版本而抛错。此时不中止整次出账：确认版本确已推进后转入下面保存点与订单键锁
      // 内按重读到的当前版本重判，只影响这一张。版本没变的错误照旧抛出。
      let current: Awaited<ReturnType<typeof valued>> | null = null;
      try {
        current = await valued(trx, ctx.appId, order.orderId, order.commissionVersion, chosen);
      } catch (error: unknown) {
        const committed = await committedVersion(trx, ctx.appId, order.orderId);
        if (committed === undefined || committed === order.commissionVersion) throw error;
      }
      if (current !== null) {
        // Zero settlement first, whatever the tolerance (D10-2532).
        if (isZeroSettlementBlocked(chosen.commissionFen, current.snapshot.baseFen)) {
          return alert(ctx, order.orderId, 'zero_settlement');
        }
        const facts: Facts = { order, settlements: row.settlements };
        const first = judge(
          ctx,
          facts,
          chosen,
          order.commissionVersion,
          current.snapshot.baseFen,
          current.bSettleFen,
        );
        if (first === 'candidate') {
          return {
            kind: 'candidate',
            settleSeq: latestSeqWithin(row.settlements, cutoffMs, chosen),
            commissionFen: chosen.commissionFen,
            snapshot: current.snapshot,
            bSettleFen: current.bSettleFen,
          };
        }
        if (deps.regenerateSnapshot === undefined) {
          return alert(ctx, order.orderId, 'regeneration_unavailable');
        }
      }

      // BR-FUND-04 ④ 重生成上限（D10-3046 (2) 与 r1 第 4 节第 8 条）：名额判断在开保存点、取订单键锁之前。到这里的
      // 只有本来要进取锁那条路的单——锁前已判出超出容差（端口已注入），或版本刚被别的事务推进、锁前无从判断
      // （current === null）；零结算、相符、端口未注入的已在上面返回，暂缓、应结未结、状态不符的根本不进 check。
      if (ctx.quota.used >= ctx.quota.cap) return { kind: 'regeneration_deferred' };

      // At most two passes: a unique violation is judged again on a fresh read after the lock.
      for (let attempt = 1; ; attempt += 1) {
        await sql`SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        let locked: Awaited<ReturnType<typeof underLock>>;
        try {
          locked = await underLock(trx, ctx, order.orderId);
        } catch (error: unknown) {
          await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
          await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
          if (attempt === 1 && isUniqueViolation(error)) continue;
          return alert(ctx, order.orderId, 'regeneration_failed', error);
        }
        const outcome = locked.outcome;
        if (outcome.kind === 'mismatch') {
          // Leave no half-written version behind: the order stays exactly as it was read.
          await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
          await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
          return alert(ctx, order.orderId, outcome.reason);
        }
        if (locked.regenerated) {
          // 重生成成功：版本与指针留在本事务里，订单键锁留到提交，占一个名额。
          await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
          ctx.quota.used += 1;
          return outcome;
        }
        // 取锁后没有重生成（锁后重读即相符，或已不是候选；D10-3046 (1)）：保存点内只取了锁、只读了，回滚到保存点把
        // 订单键锁放掉、不占名额；结果照重读到的交给调用方。
        await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        return outcome;
      }
    },
  };
}

export type FollowUnion = ReturnType<typeof createFollowUnion>;
