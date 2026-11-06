// B1-08h：归因流水线主事务（BR-ATTR-01；规划/02 §7.3、§18；D10-35）。每个子订单一个事务：
// 第一句取该子订单的 advisory 锁，锁后重读 order_keys；判定全部完成后才写库。
// - 已存在：app 不同 → 零写入、P1 告警；同 App → 乱序（可选）→ content_hash 短路 → updateStep（B1-08i）。
// - 注入 events（B1-08i）时，经这同一个总线、同一事务：首次入库在 rebate.onImported 之后发 order.created，
//   淘宝绑定冲突随后发 order.attr_binding_conflict；首态为表外事件（非法首态）在写待处理之后发
//   order.illegal_transition（application/alert-events.ts）。入队抛错整事务回滚。
// - 新子订单：① App 归属（推广位白名单）→ attr_at（定金优先）→ 同步起点 → 首态（表外码 / 非法首态只写
//   pending，不建行）→ ② 用户归属 → ④ buy_type → 写 order_keys、orders、history（+ NO_RECEIVED_AT）、
//   未归因计数、无 mtime 计数（开启排序时）→ rebate.onImported（同事务）。①、无付款时间、同步起点之前 → 只记丢弃计数。
// - ⑤ 来源回填（B1-08j，BR-ATTR-15）：② 成功且注入 sources 时在判定阶段经端口匹配，四列随 orders INSERT 写入；
//   端口抛错整事务回滚。B1-08p：orders.shop_id 写报文店铺（未归因也写），店铺一并交给回填；店铺字段存在但
//   本条为空、场景已知且无 exact / product 命中 → 四列保持 NULL 待补（不写 none，domain/source-shop.ts）。
// - ⑥ 分佣快照（B1-08k，BR-ATTR-01 ⑥ / BR-CALC-10）：注入 snapshots 且首次入库即已归因、PAID+ 时，判定阶段定
//   paid_at_source（随 INSERT 写），history、待处理之后、rebate.onImported 之前同事务调端口
//   （application/commission-snapshot-step.ts）；结果经 ImportedOrder.snapshot 交 settlement。未注入时整步跳过，
//   ImportedOrder 不带 snapshot 字段（与 B1-08h 一致，D10-69）。
// - ③ 黑名单（B1-09b，BR-ATTR-26）：注入 blacklist 时，② 之后经 risk 名单端口同事务查询（只读）；rebate.onImported
//   之后按重读的返利状态处置（application/blacklist-step.ts）：写命中 → 未入账经 rebate.onBlacklistHit（R6）、
//   已入账入队 order.blacklist_hit_after_credit、VOID / CLAWED_BACK 不处理。将经 R6 作废的订单不生成快照。
//   不改 user_id、buy_type；未注入时整步跳过。
// - B1-04zg（D10-529）：京东 14、40 在进事务、走任何分支之前写一条 order_source_mismatch，不改后续流程；
//   京东 15 待付款的 NO_PAY_TIME 丢弃照记，不写 warn（domain/jd-status.ts）。
// - B1-04zv（D10-570）：结果是 inserted、updated、unchanged 时，同事务解决该单 open 的 ORDER_ROW_INVALID
//   （application/row-quarantine.ts），解决写失败整事务回滚；丢弃、app_conflict、stale、整条拒收都不解决。
// - B2-04zj（BR-FUND-01 P12、BR-FUND-09）：首次入库即已结算且报文给了结算额 → 随 INSERT 写结算佣金列，紧接着同事务
//   经 rebate.settlements 记一条 API 记录；首次入库没有 STATEMENT 可读。union_settled_at 报文给了就写（BR-FUND-04 ①）。
// 日志只打平铺字段（platform、app_id、reason、outcome），不打子订单号与买家参数。
import { accountingDate } from '@couli/domain';
import type { DB } from '@couli/db';
import type { Insertable, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { classifyBuyType, isKnownPidScene } from '../domain/attribution.ts';
import {
  isPaidOrLater,
  planCommissionSnapshot,
  snapshotPaidAtSource,
  type CommissionSnapshotPlan,
  type PlanCommissionSnapshotInput,
} from '../domain/commission-snapshot.ts';
import { orderContentHash } from '../domain/content-hash.ts';
import { planImportState } from '../domain/import-state.ts';
import { isAwaitingPaymentDrop, isOrderSourceMismatch } from '../domain/jd-status.ts';
import { rawItemId, rawPayloadId } from '../domain/order-fields.ts';
import { incomingShopId, shouldDeferOrderSource } from '../domain/source-shop.ts';
import { mapPlatformStatus } from '../domain/status-map.ts';
import { reportedSettleFen } from '../domain/update-plan.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import {
  bumpCounter,
  insertImportedOrder,
  readOrder,
  readOrderKey,
  recordDrop,
  upsertPending,
  type OrderKeyRow,
} from '../infra/pipeline-store.ts';
import { publishBindingConflict, publishIllegalTransition } from './alert-events.ts';
import { attributeOrderUser } from './attribute-user.ts';
import {
  applyOrderBlacklist,
  blacklistVoids,
  checkOrderBlacklist,
  type OrderBlacklistCheck,
  type OrderBlacklistRebatePort,
} from './blacklist-step.ts';
import { runCommissionSnapshot, type SnapshotOutcome } from './commission-snapshot-step.ts';
import { ROW_INVALID_SETTLED_BY, quarantineRows, resolveRowInvalid } from './row-quarantine.ts';
import { backfillOrderSource, sourceColumns } from './source-backfill.ts';
import type {
  OrderPipeline,
  OrderPipelineContext,
  OrderPipelineDeps,
  OrderPipelineResult,
} from './pipeline-types.ts';
import type { OrderUpdateDeps } from './update-step.ts';

export type { OrderPipeline, OrderPipelineContext, OrderPipelinePort } from './pipeline-types.ts';

export type DropReason = 'PID_NOT_OURS' | 'NO_PAY_TIME' | 'BEFORE_SYNC_START';

const NO_PARAMS: UnionOrderAttrParams = {
  relation_id: null,
  custom_parameters: null,
  sub_union_id: null,
};

/** 首次入库不写 rebate_status（settlement 是唯一写者），本次处理前即库默认值。 */
const IMPORTED_REBATE_STATUS = 'UNATTRIBUTED';

// TODO(规划/11 §4.5): 淘宝 SITE_MISMATCH 判定 — blocked on 淘宝订单映射（无 site_id）。
export function createOrderPipeline(
  deps: OrderPipelineDeps & {
    /** B2-04zj：更新步用的同一个 rebate 对象；settlements 见 OrderUpdateDeps。 */
    readonly rebate: Pick<OrderUpdateDeps['rebate'], 'settlements'>;
  },
): OrderPipeline {
  const log = deps.logger;
  const onBlacklistHit = deps.rebate.onBlacklistHit;

  async function drop(
    trx: Transaction<DB>,
    order: UnionOrder & { sub_order_id: string },
    ctx: OrderPipelineContext,
    reason: DropReason,
    attrAt: Date | null,
  ): Promise<OrderPipelineResult> {
    // 待编排裁定 2：无 attr_at 的丢弃按 Clock.now() 的 +08:00 日计数。
    const date = accountingDate(attrAt ?? deps.clock.now());
    await recordDrop(trx, {
      app_id: ctx.app_id,
      platform: order.platform,
      sub_order_id: order.sub_order_id,
      reason,
      date,
    });
    return { kind: 'dropped', reason };
  }

  /** BR-ATTR-01：开启乱序判定（attr.mtime_ordering）而平台没有返回修改时间。 */
  function missingMtime(order: UnionOrder, platform: RegisteredPlatform): boolean {
    return (deps.mtimeOrdering?.(platform) ?? false) && (order.modified_at ?? null) === null;
  }

  /** order_sync_no_mtime(platform, date) +1，date = attr_at 的 +08:00 日；随调用方事务提交或回滚。 */
  async function countNoMtime(
    trx: Transaction<DB>,
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
    attrAt: Date,
  ): Promise<void> {
    await bumpCounter(trx, {
      app_id: ctx.app_id,
      platform,
      date: accountingDate(attrAt),
      counter: 'order_sync_no_mtime',
    });
  }

  async function existing(
    trx: Transaction<DB>,
    key: OrderKeyRow,
    order: UnionOrder,
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<OrderPipelineResult> {
    if (key.app_id !== ctx.app_id) {
      // BR-ATTR-22：order_keys 已属其他 App → 不得更新订单，P1 告警。
      log?.error(
        { alert: 'P1', platform, app_id: ctx.app_id, outcome: 'app_conflict' },
        'order key belongs to another app',
      );
      return { kind: 'app_conflict', order_id: key.order_id };
    }
    const current = await readOrder(trx, key);
    if (current === undefined) {
      throw new Error('ORDER_ROW_MISSING: order_keys 有键但 orders 无对应行');
    }
    const ordering = deps.mtimeOrdering?.(platform) ?? false;
    if (ordering) {
      const incomingMtime = order.modified_at ?? null;
      if (incomingMtime === null) {
        await countNoMtime(trx, ctx, platform, current.attr_at);
      } else if (
        current.platform_modified_at !== null &&
        incomingMtime.getTime() < current.platform_modified_at.getTime()
      ) {
        log?.info({ platform, app_id: ctx.app_id, outcome: 'stale' }, 'stale order update dropped');
        return { kind: 'stale', order_id: current.order_id };
      }
    }
    if (orderContentHash(order) === current.content_hash) {
      return { kind: 'unchanged', order_id: current.order_id };
    }
    if (deps.updateStep === undefined) {
      throw new Error('NotImplemented: 已有订单的变更（updateStep，B1-08i）');
    }
    return deps.updateStep.apply(trx, current, order, ctx);
  }

  async function fresh(
    trx: Transaction<DB>,
    order: UnionOrder & { sub_order_id: string },
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<OrderPipelineResult> {
    const attrAt = order.deposit_paid_at ?? order.paid_at ?? null;
    // ① App 归属（BR-ATTR-02）：推广位命中本 App 的 union_pids（pending / active / retired 都算）。
    const slot = order.promotion_slot ?? null;
    const pidRows =
      slot === null || slot === ''
        ? []
        : await deps.pids.find({
            appId: ctx.app_id,
            platform,
            unionAccountId: ctx.union_account_id,
            pid: slot,
          });
    const pidRow = pidRows[0];
    if (pidRow === undefined) return drop(trx, order, ctx, 'PID_NOT_OURS', attrAt);
    // 归因时点（BR-ATTR-25）：COALESCE(deposit_paid_at, paid_at)；都空不入库。京东 15 待付款是常态，只记丢弃。
    if (attrAt === null) {
      if (!isAwaitingPaymentDrop(platform, order.raw_status ?? null)) {
        log?.warn(
          { platform, app_id: ctx.app_id, reason: 'NO_PAY_TIME', outcome: 'dropped' },
          'order without pay time dropped',
        );
      }
      return drop(trx, order, ctx, 'NO_PAY_TIME', null);
    }
    const syncStartAt = await deps.accounts.syncStartAt({
      appId: ctx.app_id,
      unionAccountId: ctx.union_account_id,
    });
    if (syncStartAt === null || attrAt.getTime() < syncStartAt.getTime()) {
      return drop(trx, order, ctx, 'BEFORE_SYNC_START', attrAt);
    }
    const now = deps.clock.now();
    const payloadId = rawPayloadId(order);
    const rawStatus = order.raw_status ?? null;
    // 首态（BR-FUND-01 / 02）：表外码与非法首态不建订单行，只写待处理。
    const mapped = mapPlatformStatus(deps.statusMaps(platform), rawStatus);
    const plan =
      mapped.kind === 'event'
        ? planImportState(mapped.event, order.received_at ?? null, order.settled_at ?? null)
        : null;
    if (plan === null || plan.kind === 'pending') {
      const reason = plan === null ? 'UNMAPPED_STATUS' : plan.reason;
      log?.warn(
        { platform, app_id: ctx.app_id, reason, outcome: 'pending' },
        'order status pending',
      );
      const pendingId = await upsertPending(trx, {
        app_id: ctx.app_id,
        platform,
        sub_order_id: order.sub_order_id,
        order_id: null,
        reason,
        raw_status: rawStatus,
        raw_payload_id: payloadId,
        detected_at: now,
      });
      // BR-ATTR-01：迁移表外的首态事件（非法首态）与待处理记录同事务记 order.illegal_transition；
      // 映射表外的码（UNMAPPED_STATUS，BR-FUND-02）只告警进待处理，08 未写该事件。
      if (reason === 'ILLEGAL_TRANSITION') {
        await publishIllegalTransition(deps.events, trx, {
          appId: ctx.app_id,
          orderId: null,
          pendingId,
          platform,
          rule: 'illegal',
          fromStatus: null,
          event: mapped.kind === 'event' ? mapped.event : null,
          outcome: 'rejected',
        });
      }
      return { kind: 'pending', reason };
    }
    // ② 用户归属（BR-ATTR-06 / 07）。
    const params = order.attr_params ?? NO_PARAMS;
    const user = await attributeOrderUser(deps, {
      appId: ctx.app_id,
      platform,
      unionAccountId: ctx.union_account_id,
      params,
      attrAt,
    });
    if (user.kind === 'unattributed' && user.conflict) {
      log?.error(
        { alert: 'P1', event: 'attr_binding_conflict', platform, app_id: ctx.app_id },
        'taobao binding conflict',
      );
    }
    // ③ 黑名单（BR-ATTR-26）：② 之后、④ 之前查询（只读）；未归因订单同样检查（② 失败继续 ③④⑦）。
    const blacklist: OrderBlacklistCheck | null =
      deps.blacklist === undefined
        ? null
        : await checkOrderBlacklist(trx, deps.blacklist, {
            app_id: ctx.app_id,
            platform,
            trade_parent_id: order.parent_order_id ?? null,
            relation_id: params.relation_id,
            union_account_id: ctx.union_account_id,
            attr_at: attrAt,
          });
    // 将经 R6 作废：第 ⑥ 步按作废后的返利状态判资格（BR-ATTR-01 ⑥「未作废」），不生成快照。
    const voiding = blacklistVoids(blacklist, IMPORTED_REBATE_STATUS, deps.rebate);
    // ④ buy_type / scene_basis（BR-ATTR-08）；未归因订单也写。
    if (!isKnownPidScene(pidRow.pid_scene)) {
      log?.warn(
        { platform, app_id: ctx.app_id, pid_scene: pidRow.pid_scene, outcome: 'scene_fallback' },
        'pid_scene not in BR-ATTR-08; buy_type falls back to self',
      );
    }
    const scene = classifyBuyType(platform, pidRow.pid_scene, params.custom_parameters);
    const itemId = rawItemId(order);
    if (itemId === '') {
      log?.warn({ platform, app_id: ctx.app_id, outcome: 'no_item_id' }, 'order without item id');
    }
    // ⑤ 来源回填（BR-ATTR-15；B1-08j）：只在本次把 user_id 由空写为非空（② 成功）且注入 sources 时，
    // 按订单推广位的 pid_scene 匹配；四列随 orders INSERT 一起写。未归因 / 未注入 → 四列 NULL，不调端口。
    // B1-08p：店铺取本次报文（UnionOrder.shop_id）；none 且店铺显式为空、场景已知 → 四列保持 NULL 待补。
    const shop = incomingShopId(order);
    const matched =
      user.kind === 'attributed' && deps.sources !== undefined
        ? await backfillOrderSource(deps.sources, {
            appId: ctx.app_id,
            platform,
            userId: user.user_id,
            attrAt,
            pidScene: pidRow.pid_scene,
            order,
            shopId: shop ?? null,
          })
        : null;
    const sourcePending =
      matched !== null &&
      shouldDeferOrderSource({
        source: matched,
        incomingShopId: shop,
        currentShopId: null,
        pidScene: pidRow.pid_scene,
      });
    const source = sourcePending ? null : matched;

    const orderId = newUuidV7(now);
    const attributed = user.kind === 'attributed';
    // ⑥ 分佣快照（B1-08k）：判定先于写库。首次入库 before 为空；预估与结算佣金取将写入的列（BR-CALC-02）；
    // 本次入库即 PAID+ 时首条已付历史就是本事务写的，时刻为 now。未注入端口整步跳过。
    const paidNow = isPaidOrLater(plan.platform_status);
    const settleFen = reportedSettleFen(order, plan);
    const snapshotInput: PlanCommissionSnapshotInput = {
      before: null,
      after: {
        user_id: user.user_id,
        platform_status: plan.platform_status,
        rebate_status_before: voiding ? 'VOID' : IMPORTED_REBATE_STATUS,
      },
      order: {
        app_id: ctx.app_id,
        order_id: orderId,
        platform,
        buy_type: scene.buy_type,
        activity_type: null,
        is_presale: order.deposit_paid_at != null,
        paid_at: order.paid_at ?? null,
        deposit_paid_at: order.deposit_paid_at ?? null,
        est_commission_fen: order.est_commission_fen ?? null,
        settle_commission_fen: settleFen,
        subsidy_commission_fen: null,
      },
      incoming: {
        modified_at: order.modified_at ?? null,
        service_fee_fen: order.service_fee_fen ?? null,
      },
      pidScene: pidRow.pid_scene,
      movedToPaidNow: paidNow,
      firstPaidAt: paidNow ? now : null,
      now,
    };
    const snapshotPlan: CommissionSnapshotPlan | null =
      deps.snapshots === undefined ? null : planCommissionSnapshot(snapshotInput);
    const paidAtSource =
      snapshotPlan === null ? null : snapshotPaidAtSource(snapshotInput, snapshotPlan);

    const unionSettledAt = order.settled_at ?? null;

    // —— 判定完成，开始写库 ——
    const row: Omit<Insertable<DB['orders']>, 'rebate_status'> = {
      order_id: orderId,
      app_id: ctx.app_id,
      platform,
      sub_order_id: order.sub_order_id,
      parent_order_id: order.parent_order_id ?? null,
      raw_item_id: itemId,
      // B1-08p：店铺只取联盟订单报文（拼多多 mall_id）；未归因订单也写，缺失为 NULL。
      shop_id: shop ?? null,
      pay_amount_fen: order.paid_fen,
      est_commission_fen: order.est_commission_fen ?? null,
      settle_commission_fen: settleFen,
      // B1-08v：联盟报文的平台服务费（拼多多 duo_id_service_fee；淘宝自 B1-04zz 起给实际扣的服务费；京东不给）
      // 按本次报文原样写，缺失为 NULL；未归因订单同样写。
      service_fee_fen: order.service_fee_fen ?? null,
      pid: slot,
      relation_id: params.relation_id,
      sub_union_id: params.sub_union_id,
      custom_params: params.custom_parameters,
      user_id: user.user_id,
      user_basis: attributed ? 'param' : null,
      buy_type: scene.buy_type,
      scene_basis: scene.scene_basis,
      platform_status: plan.platform_status,
      is_presale: order.deposit_paid_at != null,
      deposit_paid_at: order.deposit_paid_at ?? null,
      paid_at: order.paid_at ?? null,
      attr_at: attrAt,
      received_at: plan.received_at,
      settled_at: unionSettledAt,
      union_settled_at: unionSettledAt,
      platform_modified_at: order.modified_at ?? null,
      content_hash: orderContentHash(order),
      raw_payload_id: payloadId,
      ...(source === null ? {} : sourceColumns(source)),
      ...(paidAtSource === null ? {} : { paid_at_source: paidAtSource }),
    };
    await insertImportedOrder(
      trx,
      {
        platform,
        sub_order_id: order.sub_order_id,
        order_id: orderId,
        app_id: ctx.app_id,
        attr_at: attrAt,
      },
      row,
      plan.history,
      now,
    );
    if (settleFen !== null) {
      await deps.rebate.settlements?.recordApi(trx, {
        appId: ctx.app_id,
        orderId,
        commissionFen: settleFen,
        reportedSettledAt: unionSettledAt,
        orderSettledAt: null,
      });
    }
    if (plan.pending !== null) {
      await upsertPending(trx, {
        app_id: ctx.app_id,
        platform,
        sub_order_id: order.sub_order_id,
        order_id: orderId,
        reason: plan.pending,
        raw_status: rawStatus,
        raw_payload_id: payloadId,
        detected_at: now,
      });
    }
    // 待编排裁定 1：未归因计数按 attr_at 的 +08:00 日，只在首次入库进未归因池时计一次。
    if (user.kind === 'unattributed' && user.counter !== null) {
      await bumpCounter(trx, {
        app_id: ctx.app_id,
        platform,
        date: accountingDate(attrAt),
        counter: user.counter,
      });
    }
    // BR-ATTR-01（D10-39）：开启乱序判定而首次入库也没有 platform_modified_at → 照常按 content_hash
    // 入库，同事务计一次 order_sync_no_mtime；丢弃与只进待处理（不建行）的不计。
    if (missingMtime(order, platform)) await countNoMtime(trx, ctx, platform, attrAt);
    // ⑥ 分佣快照：端口抛错不吞，整事务（含订单、history、待处理）回滚。未注入端口时不带 snapshot 字段。
    const snapshot: SnapshotOutcome | undefined =
      deps.snapshots === undefined || snapshotPlan === null
        ? undefined
        : await runCommissionSnapshot(
            trx,
            deps.snapshots,
            snapshotPlan,
            {
              app_id: ctx.app_id,
              platform,
              sub_order_id: order.sub_order_id,
              order_id: orderId,
              raw_status: rawStatus,
              raw_payload_id: payloadId,
              now,
            },
            log,
          );
    await deps.rebate.onImported(trx, {
      app_id: ctx.app_id,
      order_id: orderId,
      attr_at: attrAt,
      attributed,
      platform_status: plan.platform_status,
      received_at: plan.received_at,
      ...(snapshot === undefined ? {} : { snapshot }),
    });
    // ③ 黑名单的处置：R6 的来源状态由首次入库（R1 / R2）给出，所以在 onImported 之后、按重读的返利状态。
    if (blacklist !== null && deps.blacklist !== undefined) {
      const stored = await readOrder(trx, {
        order_id: orderId,
        app_id: ctx.app_id,
        attr_at: attrAt,
      });
      if (stored === undefined) throw new Error('ORDER_ROW_MISSING: 首次入库后重读不到订单行');
      await applyOrderBlacklist(
        trx,
        {
          blacklist: deps.blacklist,
          ...(onBlacklistHit === undefined
            ? {}
            : ({
                onBlacklistHit: (t, hit) => onBlacklistHit.call(deps.rebate, t, hit),
              } satisfies Pick<OrderBlacklistRebatePort, 'onBlacklistHit'>)),
          ...(deps.events === undefined ? {} : { events: deps.events }),
          ...(log === undefined ? {} : { logger: log }),
        },
        { app_id: ctx.app_id, order_id: orderId, user_id: user.user_id, platform, attr_at: attrAt },
        blacklist,
        stored.rebate_status,
      );
    }
    // B1-08i（D10-41 第 1 条；02 §11）：注入 events 时，order.created 与首次入库同一事务入队。
    await deps.events?.publish(trx, {
      appId: ctx.app_id,
      name: 'order.created',
      payload: { order_id: orderId, platform, platform_status: plan.platform_status, attributed },
    });
    // BR-ATTR-07：多条绑定命中且用户不同 → 未归因入库，同一总线、同事务记 order.attr_binding_conflict。
    if (user.kind === 'unattributed' && user.conflict) {
      await publishBindingConflict(deps.events, trx, {
        appId: ctx.app_id,
        orderId,
        platform,
      });
    }
    if (source !== null) {
      log?.info(
        { platform, app_id: ctx.app_id, source_match: source.source_match, outcome: 'backfilled' },
        'order source backfilled',
      );
    } else if (sourcePending) {
      log?.info(
        { platform, app_id: ctx.app_id, outcome: 'source_pending' },
        'order source left blank until the shop is known',
      );
    }
    log?.info({ platform, app_id: ctx.app_id, outcome: 'inserted', attributed }, 'order imported');
    return { kind: 'inserted', order_id: orderId };
  }

  return {
    async process(order, ctx) {
      const subOrderId = order.sub_order_id;
      if (typeof subOrderId !== 'string' || subOrderId === '') {
        throw new Error('MISSING_SUB_ORDER_ID: 适配器未映射子订单号');
      }
      if (order.platform !== ctx.platform) {
        throw new Error('PLATFORM_MISMATCH: 订单平台与同步窗口平台不一致');
      }
      const platform = ctx.platform;
      const withSub = order as UnionOrder & { sub_order_id: string };
      // D10-529：放在所有分支之前，丢弃、冲突、乱序、已有单的行也恰好写一条；字段只有这四个。
      const rawStatus = order.raw_status ?? null;
      if (isOrderSourceMismatch(platform, rawStatus)) {
        log?.warn(
          { platform, app_id: ctx.app_id, raw_status: rawStatus, event: 'order_source_mismatch' },
          'jd order source mismatch',
        );
      }
      return deps.db.transaction().execute(async (trx) => {
        await lockOrderKey(trx, platform, subOrderId);
        const key = await readOrderKey(trx, platform, subOrderId);
        const result =
          key !== undefined
            ? await existing(trx, key, order, ctx, platform)
            : await fresh(trx, withSub, ctx, platform);
        if (ROW_INVALID_SETTLED_BY.has(result.kind)) {
          await resolveRowInvalid(trx, deps.clock, withSub, ctx);
        }
        return result;
      });
    },
    quarantine: (rows, ctx) => quarantineRows(deps, rows, ctx),
  };
}
