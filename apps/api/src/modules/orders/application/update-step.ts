// B1-08i：已有子订单（同 App、未被乱序丢弃、content_hash 变化）的同步更新（BR-FUND-01 / 02 / 03 / 07、
// BR-ATTR-01；规划/02 §11、§18；D10-41）。在 B1-08h 流水线已取 advisory 锁的事务里运行。
// - 判定先于写库（domain/update-plan.ts）：表外事件、P10 倒退（开关开）、表外码且已入账 → 整条不落 orders，
//   只写 order_sync_pending 并告警（order_illegal_transition），结果 pending，不抛错（IllegalTransition 不重试）。
// - 其余：一条 CAS UPDATE（row_version + 当前 platform_status）；影响 0 行 → 重读一次重新判定，仍 0 行抛
//   ORDER_CAS_CONFLICT。写序：UPDATE orders → history（按步序，只插入）→ pending → settlement 端口 → order.updated
//   → 告警事件。
// - 告警事件与 order.updated 经同一个注入的 events 总线、与上述写入同一事务入队（application/alert-events.ts），
//   入队抛错整事务回滚：表外事件与 P10 倒退（含开关关）→ order.illegal_transition；已归属订单归因参数变化 →
//   order.attr_param_changed；重跑归属遇淘宝绑定冲突 → order.attr_binding_conflict。映射表外的码
//   （UNMAPPED_STATUS）08 未写该事件，只告警进待处理。
// - 未归因（user_id 为空，含 VOID 的 R3b）每次重跑用户归属：命中且 locked=false 才写 user_id、user_basis=param。
// - ⑤ 来源回填（B1-08j，BR-ATTR-15）：本次写 user_id、库内 source_match 为空且注入 sources 时，按订单推广位
//   （本次 UPDATE 将写入的 pid——未归因重跑写入本次报文的推广位，未改时即原值——经 pids 端口取首行 pid_scene；
//   推广位为空、端口未注入或查不到 → 场景未知：② product / ③ shop 不跨场景匹配，① exact 照常，否则 none，
//   并在写后告警；只有推广位本身是 fallback 才不限场景，D10-60）、current.shop_id 与本次报文匹配，四列并入
//   同一条 CAS UPDATE（WHERE 另加 source_match IS NULL）；端口抛错整事务回滚。不改 product_key。
// - 店铺（B1-08p，domain/source-shop.ts）：orders.shop_id 只在库内为空、本次报文非空时写（并入同一条 CAS UPDATE）。
//   未归因重跑成功的回填店铺取 current.shop_id ?? 本次报文店铺；结果 none 而店铺字段显式为空、场景已知 →
//   四列保持 NULL 待补。已归属、source_match 仍为空、库内无店铺而本次报文带来店铺 → 按 current.user_id /
//   attr_at / 推广位与本次店铺重跑一次回填，四列与 shop_id 同一条 CAS UPDATE（WHERE source_match IS NULL）。
//   08 无重试次数与放弃条件：不计数，店铺不来就保持 NULL。
// - ⑥ 分佣快照（B1-08k，BR-ATTR-01 ⑥ / BR-CALC-10）：注入 snapshots 时，按本次 ⑦ 迁移与 ② 归属后的取值判定
//   是否首次跨入资格（P2、R3a 在 PAID+）；跨入时 paid_at_source（库内为空才写）并入同一条 CAS UPDATE，history、
//   待处理之后、settlement 端口之前同事务调端口（application/commission-snapshot-step.ts），结果经
//   change.snapshot 交 settlement。未注入时整步跳过，change 不带 snapshot 字段。整条不落 orders 的不判定。
// - 快照补偿重试（B1-08t，application/snapshot-retry-step.ts）：注入 snapshots、本次写库成功、没有跨入资格但仍满足
//   ⑥ 条件、库内有未转人工的 open 快照类待处理行 → 在同一位置重试一次；成功与处置待处理同事务，结果经
//   change.snapshot 交 settlement；满 24 小时仍失败记转人工标记，紧接着同事务入队 order.snapshot_retry_exhausted
//   （B1-08u，入队抛错整事务回滚），并打一次告警日志（与事件并存作冗余）。
// - ③ 黑名单（B1-09b，BR-ATTR-26）：注入 blacklist 时，② 之后经 risk 名单端口同事务查询（只读，订单父单号、
//   relation_id 取本次 UPDATE 之后的值，attr_at 不变）；CAS 写入成功后、history 与待处理之后按库内（本次迁移前）
//   返利状态处置（application/blacklist-step.ts）：未入账经 rebate.onBlacklistHit（R6），先于 settlement 端口；
//   已入账入队 order.blacklist_hit_after_credit；VOID / CLAWED_BACK 不处理。将经 R6 作废的不生成快照、不补偿重试。
//   只在 content_hash 变化时运行（同内容已被流水线短路），不回扫；不改 user_id、buy_type。
// - 平台恢复（B1-08zc，BR-FUND-22，application/platform-restore-step.ts）：注入 platformRestore 时，CAS 写入之后、
//   ⑥ 之前同事务判定：库内返利状态 VOID / CLAWED_BACK、reason 属 REFUND / RIGHTS / COMMISSION_ZERO 或进入当前返利
//   状态的历史事件属 PLATFORM_INVALID / INVALID_AFTER_SETTLE，且本次为 P9 或佣金列由空 / ≤0 变为 >0 → 经端口登记
//   platform_restore 差错单（键用进入行 id，一次作废 / 扣回一张），新插入才打一条告警；不改返利状态、不写分录。
// - 结算记录（B2-04zj，BR-FUND-09）：planOrderSyncColumns 之前经 rebate.settlements 读最新 STATEMENT 金额，有就是
//   结算佣金列的值；本次报文的结算额算数（domain reportedSettleFen）就在 CAS 与 history 之后、待处理与 settlement
//   端口之前同事务记一条 API 记录，内容不变不加行。判定看算数的结算额，不看事件名；CREDITED 单照记。
//   union_settled_at（BR-FUND-04 ①）：报文给了 settled_at 就写，不看平台状态与结算额，空值不覆盖。
// - 返利状态、hold、order_rights、order_settlements 只由 settlement 经端口决定；本模块不写这些列。
//   端口除 change / info 外另带本次报文的来源（映射事件与原始码），settlement 据此区分维权与处罚（P8）。
// 日志只打平铺字段（platform、app_id、reason、outcome、rule、event），不打子订单号与买家参数。
import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import { countPddServiceFeeMissing, type EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import {
  crossesSnapshotEligibility,
  isPaidOrLater,
  isSnapshotEligible,
  planCommissionSnapshot,
  snapshotPaidAtSource,
  type CommissionSnapshotPlan,
  type PlanCommissionSnapshotInput,
} from '../domain/commission-snapshot.ts';
import { rawPayloadId } from '../domain/order-fields.ts';
import { planSnapshotRetry, resolveRetryPaidAt } from '../domain/snapshot-retry.ts';
import {
  incomingShopId,
  shopIdToWrite,
  shouldDeferOrderSource,
  shouldRetryOrderSource,
} from '../domain/source-shop.ts';
import type { PlatformStatusEvent } from '../domain/status-map.ts';
import {
  planOrderSyncColumns,
  planOrderUpdate,
  reportedSettleFen,
  type OrderUpdatePlan,
} from '../domain/update-plan.ts';
import { casUpdateOrder, type OrderUpdateSet } from '../infra/order-update-store.ts';
import {
  insertPlatformHistory,
  readFirstPaidAt,
  readOrder,
  upsertPending,
  writePending,
} from '../infra/pipeline-store.ts';
import {
  isHandedOff,
  readOpenSnapshotRows,
  writePaidAtSource,
} from '../infra/snapshot-retry-store.ts';
import {
  publishBindingConflict,
  publishIllegalTransition,
  publishParamChanged,
  publishSnapshotRetryExhausted,
  type OrderAttrParamColumn,
} from './alert-events.ts';
import { attributeOrderUser } from './attribute-user.ts';
import {
  runCommissionSnapshot,
  type CommissionSnapshotPort,
  type SnapshotOutcome,
} from './commission-snapshot-step.ts';
import {
  logSnapshotRetryExhausted,
  runSnapshotRetry,
  type SnapshotRetryAlert,
} from './snapshot-retry-step.ts';
import { backfillOrderSource, sourceColumns } from './source-backfill.ts';
import {
  applyOrderBlacklist,
  blacklistVoids,
  checkOrderBlacklist,
  type OrderBlacklistCheck,
  type OrderBlacklistDeps,
  type OrderBlacklistRebatePort,
  type OrderBlacklistStepDeps,
} from './blacklist-step.ts';
import type {
  OrderPipelineContext,
  OrderPipelineDeps,
  OrderPipelineResult,
} from './pipeline-types.ts';
import {
  runPlatformRestore,
  type PlatformRestoreDiffPort,
  type PlatformRestoreOutcome,
} from './platform-restore-step.ts';
import { findPlatformRules } from '../domain/platform-rules/index.ts';

export interface OrderUpdateChange {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly from_status: string;
  readonly to_status: string;
  readonly rule: string | null;
  readonly received_at: Date | null;
  readonly est_before: bigint | null;
  readonly est_after: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly attributed_now: boolean;
  /**
   * B1-08k 第 ⑥ 步本次的快照结果（P2 / R3a 的预估由 settlement 据此与快照表决定）；只在注入 snapshots 时出现，
   * 未注入时不带此字段（与 B1-08i 的 change 逐字段一致）。
   */
  readonly snapshot?: SnapshotOutcome;
}

export interface UnmappedOrderInfo {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
}

/**
 * 本次报文的平台状态来源（BR-FUND-01 P7 / P8、BR-FUND-02），作为 onUpdated / onUnmappedStatus 的第三个参数。
 * P8 是 noop：维权与处罚都不改状态、rule 同为 P8，只有 event 能区分。settlement 据 event 选 order_rights 类型：
 * PLATFORM_RIGHTS → RIGHTS，PLATFORM_PUNISH → PUNISH（原因码 PUNISH），P7 的 PLATFORM_INVALID →
 * INVALID_AFTER_SETTLE；R6 / R8 的作废与扣回原因同样据 event 取，不从 rule 或 to_status 推断。
 * 单独成参而不并入 change / info：两者的字段集由冻结规则测试逐字断言（AC-B1-08i#20 / #27）。
 */
export interface OrderStatusSource {
  /** 原始码经映射表得到的内部事件（P5 / P14 补走中间步时仍是报文本身的事件，如 PLATFORM_SETTLED）；表外码为 null。 */
  readonly event: PlatformStatusEvent | null;
  /** 平台原始状态码，入参原样（不 trim、不归一）；平台未给为 null。 */
  readonly raw_status: string | null;
}

/**
 * B2-04zj：settlement 的结算记录端口（order_settlements 唯一写者，BR-FUND-09）的 orders 视角；都在调用方事务、
 * 订单锁内运行，抛错整事务回滚。
 */
export interface OrderSettlementRecordsPort {
  /** 本次算数的结算额写一条 API 记录；内容与最新 API 记录相同则不写。 */
  recordApi(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly orderId: string;
      readonly commissionFen: bigint;
      /** 报文给的结算时间，没给为 null：这个值是记录内容的一部分。 */
      readonly reportedSettledAt: Date | null;
      /** orders.settled_at：记录 settled_at 列的回退，不算内容。 */
      readonly orderSettledAt: Date | null;
    },
  ): Promise<unknown>;
  /** 最新（seq 最大）STATEMENT 记录的金额；没有为 null。 */
  latestStatementFen(
    trx: Transaction<DB>,
    ref: { readonly appId: string; readonly orderId: string },
  ): Promise<bigint | null>;
}

export interface OrderUpdateDeps extends Pick<
  OrderPipelineDeps,
  'clock' | 'users' | 'bindings' | 'statusMaps' | 'logger'
> {
  readonly sources?: OrderPipelineDeps['sources'];
  readonly pids?: OrderPipelineDeps['pids'];
  /** settlement 实现（B1-08n 接线）；与本次写库同一事务调用，抛错整事务回滚。 */
  readonly rebate: {
    onUpdated(
      trx: Transaction<DB>,
      change: OrderUpdateChange,
      source: OrderStatusSource,
    ): Promise<void>;
    onUnmappedStatus(
      trx: Transaction<DB>,
      info: UnmappedOrderInfo,
      source: OrderStatusSource,
    ): Promise<void>;
    /** B1-09b 第 ③ 步命中且未入账（BR-ATTR-26 → BR-FUND-01 R6）；接线在资金线。 */
    onBlacklistHit?: OrderBlacklistRebatePort['onBlacklistHit'];
    /**
     * B2-04zj：结算记录端口；生产由 createRebatePort 一并给出，只有不带 settlement 的替身才没有，
     * 没有时不读 STATEMENT、不写记录。
     */
    readonly settlements?: OrderSettlementRecordsPort;
  };
  /** 第 ③ 步黑名单（B1-09b）；同 OrderPipelineDeps.blacklist，未注入时整步跳过。 */
  readonly blacklist?: OrderBlacklistDeps;
  /** 领域事件 order.updated 与三个告警事件共用的总线；与本次写库同一事务入队，抛错整事务回滚。 */
  readonly events: Pick<EventBus, 'publish'>;
  readonly regressionHold?: (platform: Parameters<OrderPipelineDeps['statusMaps']>[0]) => boolean;
  /** 分佣快照端口（B1-08k）；同 OrderPipelineDeps.snapshots，未注入时第 ⑥ 步整步跳过。订单推广位场景经 pids 取。 */
  readonly snapshots?: CommissionSnapshotPort;
  /**
   * B1-08zc 平台恢复差错单端口（BR-FUND-22，ledger 实现、app.module 注入）；与本次写库同一事务调用，抛错整事务回滚。
   * 未注入时不登记，只保留 P9 原有告警。
   */
  readonly platformRestore?: PlatformRestoreDiffPort;
}

type OrderRow = Selectable<DB['orders']>;

const NO_PARAMS: UnionOrderAttrParams = {
  relation_id: null,
  custom_parameters: null,
  sub_union_id: null,
};

/** 告警级别：08 未写明，order_attr_param_changed 为 P2（BR-ATTR-01），其余订单同步异常按 P1。 */
const ALERT_SYNC = 'P1';
const ALERT_PARAM = 'P2';
/** B1-08zc：新登记一张 platform_restore 差错单时的告警（BR-FUND-22）。 */
const ALERT_PLATFORM_RESTORE = 'platform_restore';

/** orders.buy_type 由首次入库写定（BR-ATTR-08，self / share）；别的值是数据损坏，不猜。 */
function orderBuyType(value: string | null): 'self' | 'share' {
  if (value === 'self' || value === 'share') return value;
  throw new Error('ORDER_BUY_TYPE_INVALID: orders.buy_type 不是 self / share');
}

function pendingDetail(plan: OrderUpdatePlan, from: string): string | null {
  if (plan.pending !== 'ILLEGAL_TRANSITION') return null;
  return `order_illegal_transition ${plan.rule ?? 'illegal'} ${from}→${plan.event ?? '-'}`;
}

export function createOrderUpdateStep(
  deps: OrderUpdateDeps,
): NonNullable<OrderPipelineDeps['updateStep']> {
  const log = deps.logger;
  const rebatePort = deps.rebate;
  const onBlacklistHit = rebatePort.onBlacklistHit;
  const blacklistStep: OrderBlacklistStepDeps | null =
    deps.blacklist === undefined
      ? null
      : {
          blacklist: deps.blacklist,
          ...(onBlacklistHit === undefined
            ? {}
            : ({
                onBlacklistHit: (trx, hit) => onBlacklistHit.call(rebatePort, trx, hit),
              } satisfies Pick<OrderBlacklistRebatePort, 'onBlacklistHit'>)),
          events: deps.events,
          ...(log === undefined ? {} : { logger: log }),
        };

  /**
   * 整条报文不落 orders：只写待处理并告警；同键 open 记录只刷新 detected_at。被拒的行 content_hash 不变，回扫每轮
   * 都会再拒一次：同键 open 的 raw_status、detail 都与本次相同才不打 P1 日志（B1-04zs），新开或任一列不同都打
   * （BR-FUND-02）；事件照常发（同一 open 记录事件 ID 不变，总线去重）。
   */
  async function reject(
    trx: Transaction<DB>,
    current: OrderRow,
    incoming: UnionOrder,
    platform: RegisteredPlatform,
    plan: OrderUpdatePlan,
  ): Promise<OrderPipelineResult> {
    const reason = plan.pending ?? 'ILLEGAL_TRANSITION';
    const { id: pendingId, repeat } = await writePending(trx, {
      app_id: current.app_id,
      platform,
      sub_order_id: current.sub_order_id,
      order_id: current.order_id,
      reason,
      raw_status: incoming.raw_status ?? null,
      raw_payload_id: rawPayloadId(incoming),
      detected_at: deps.clock.now(),
      detail: pendingDetail(plan, current.platform_status),
    });
    if (reason === 'ILLEGAL_TRANSITION') {
      await publishIllegalTransition(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        pendingId,
        platform,
        rule: plan.rule ?? 'illegal',
        fromStatus: current.platform_status,
        event: plan.event ?? null,
        outcome: 'rejected',
      });
    }
    if (!repeat) {
      log?.error(
        {
          alert: ALERT_SYNC,
          event: 'order_illegal_transition',
          platform,
          app_id: current.app_id,
          reason,
          rule: plan.rule,
          outcome: 'rejected',
        },
        'order sync update rejected; order columns untouched',
      );
    }
    return { kind: 'pending', order_id: current.order_id, reason };
  }

  type Attempt = OrderPipelineResult | 'conflict';

  /**
   * 订单推广位的 pid_scene（BR-ATTR-15 ②「pid_scene = 订单推广位的 pid_scene」）：pid 是本次 UPDATE 写入后
   * 订单的推广位（不是库内旧值），取 pids 端口的首行；端口未注入、无 pid 或查无 → null。
   */
  async function orderPidScene(
    current: OrderRow,
    pid: string | null,
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<string | null> {
    if (deps.pids === undefined || pid === null || pid === '') return null;
    const rows = await deps.pids.find({
      appId: current.app_id,
      platform,
      unionAccountId: ctx.union_account_id,
      pid,
    });
    return rows[0]?.pid_scene ?? null;
  }

  async function attempt(
    trx: Transaction<DB>,
    current: OrderRow,
    incoming: UnionOrder,
    ctx: OrderPipelineContext,
  ): Promise<Attempt> {
    const platform = ctx.platform;
    const from = current.platform_status as OrderPlatformState;
    const hold = deps.regressionHold?.(platform) ?? true;
    const plan = planOrderUpdate(
      {
        platform_status: from,
        rebate_status: current.rebate_status,
        received_at: current.received_at,
      },
      incoming,
      deps.statusMaps(platform),
      hold,
    );
    if (plan.kind === 'pending') return reject(trx, current, incoming, platform, plan);

    const settlements = rebatePort.settlements;
    const orderRef = { appId: current.app_id, orderId: current.order_id };
    const statementFen = (await settlements?.latestStatementFen(trx, orderRef)) ?? null;
    const columns = planOrderSyncColumns(current, incoming, plan, statementFen);
    const now = deps.clock.now();
    const set: OrderUpdateSet = {
      ...columns,
      ...(plan.platform_status !== from ? { platform_status: plan.platform_status } : {}),
      // B1-08v（待编排裁定 2 默认）：服务费按本次写库报文原样写，报文没给即 NULL，不保留库内旧值。
      service_fee_fen: incoming.service_fee_fen ?? null,
      row_version: current.row_version + 1,
      updated_at: now,
    };

    // BR-FUND-04 ①：不进 planOrderSyncColumns（B1-08i 冻结的同步列集合），空值不覆盖。
    const unionSettledAt = incoming.settled_at ?? null;
    if (unionSettledAt !== null) Object.assign(set, { union_settled_at: unionSettledAt });

    // 归属参数（BR-ATTR-01）：已归属不覆盖四项参数，变化只告警；未归因写入参并重跑 ②（BR-ATTR-06 / 07）。
    const params = incoming.attr_params ?? NO_PARAMS;
    const slot = incoming.promotion_slot ?? null;
    const changedParams: OrderAttrParamColumn[] = [
      ...(slot !== current.pid ? (['pid'] as const) : []),
      ...(params.relation_id !== current.relation_id ? (['relation_id'] as const) : []),
      ...(params.sub_union_id !== current.sub_union_id ? (['sub_union_id'] as const) : []),
      ...(params.custom_parameters !== current.custom_params ? (['custom_params'] as const) : []),
    ];
    const paramsChanged = changedParams.length > 0;
    const unattributed = current.user_id === null;
    let attributedNow = false;
    let bindingConflict = false;
    let backfilled: string | null = null;
    let sourcePending = false;
    let pidSceneMissing = false;
    /** 已为来源回填查过的订单推广位场景（undefined = 本次还没查）。 */
    let knownPidScene: string | null | undefined;
    // B1-08p 店铺：只空 → 非空（口径 2）。
    const shop = incomingShopId(incoming);
    const shopWrite = shopIdToWrite(current.shop_id, shop);
    if (shopWrite !== null) Object.assign(set, { shop_id: shopWrite });
    if (unattributed) {
      Object.assign(set, {
        pid: slot,
        relation_id: params.relation_id,
        sub_union_id: params.sub_union_id,
        custom_params: params.custom_parameters,
      });
      // 用户归属仍用首次的 attr_at（BR-ATTR-25），不用后来的 paid_at 或同步时间。
      const user = await attributeOrderUser(deps, {
        appId: current.app_id,
        platform,
        unionAccountId: ctx.union_account_id,
        params,
        attrAt: current.attr_at,
      });
      if (user.kind === 'attributed' && !current.locked) {
        // R3a / R3b：只写 user_id、user_basis=param，不置 locked，不碰 rebate_status。
        Object.assign(set, { user_id: user.user_id, user_basis: 'param' });
        attributedNow = true;
        // ⑤ 来源回填：只在本次把 user_id 由空写为非空、且尚无 source_match（含 none）时执行。
        if (deps.sources !== undefined && current.source_match === null) {
          // 推广位以本次写入后的为准：set 里有 pid（未归因重跑写入本次报文的推广位）就用它，否则是原值。
          const orderPid = set.pid !== undefined ? set.pid : current.pid;
          const pidScene = await orderPidScene(current, orderPid, ctx, platform);
          knownPidScene = pidScene;
          pidSceneMissing = pidScene === null;
          const source = await backfillOrderSource(deps.sources, {
            appId: current.app_id,
            platform,
            userId: user.user_id,
            attrAt: current.attr_at,
            // 场景未知传 null：不当作 fallback（BR-ATTR-15 ② 只对 fallback 推广位不限，D10-60）。
            pidScene,
            order: incoming,
            // B1-08p：库内已有店铺优先，否则用本次报文带来的店铺。
            shopId: current.shop_id ?? shop ?? null,
          });
          sourcePending = shouldDeferOrderSource({
            source,
            incomingShopId: shop,
            currentShopId: current.shop_id,
            pidScene,
          });
          if (!sourcePending) {
            Object.assign(set, sourceColumns(source));
            backfilled = source.source_match;
          }
        }
      }
      bindingConflict = user.kind === 'unattributed' && user.conflict;
    } else if (
      current.user_id !== null &&
      deps.sources !== undefined &&
      shouldRetryOrderSource({
        userId: current.user_id,
        sourceMatch: current.source_match,
        currentShopId: current.shop_id,
        incomingShopId: shop,
      })
    ) {
      // B1-08p 口径 5：已归属订单此前待补，本次同步带来店铺 → 按库内 user_id / attr_at / 推广位重跑一次。
      // 已归属订单不改推广位（参数变化只告警），所以推广位即库内值；exact 读本次报文的订单参数。
      const pidScene = await orderPidScene(current, current.pid, ctx, platform);
      knownPidScene = pidScene;
      pidSceneMissing = pidScene === null;
      const source = await backfillOrderSource(deps.sources, {
        appId: current.app_id,
        platform,
        userId: current.user_id,
        attrAt: current.attr_at,
        pidScene,
        order: incoming,
        shopId: shopWrite,
      });
      Object.assign(set, sourceColumns(source));
      backfilled = source.source_match;
    }

    // ③ 黑名单（BR-ATTR-26）：判定阶段只读查询；处置在 CAS 写入成功之后。
    const blacklist: OrderBlacklistCheck | null =
      blacklistStep === null
        ? null
        : await checkOrderBlacklist(trx, blacklistStep.blacklist, {
            app_id: current.app_id,
            platform,
            trade_parent_id: columns.parent_order_id,
            relation_id: set.relation_id !== undefined ? set.relation_id : current.relation_id,
            union_account_id: ctx.union_account_id,
            attr_at: current.attr_at,
          });
    // 将经 R6 作废：第 ⑥ 步与补偿重试都按作废后的返利状态判资格（BR-ATTR-01 ⑥「未作废」）。
    const rebateAfterBlacklist =
      blacklistStep !== null && blacklistVoids(blacklist, current.rebate_status, blacklistStep)
        ? 'VOID'
        : current.rebate_status;

    // ⑥ 分佣快照（B1-08k）：判定先于写库。before = 库内现值；after = 本次迁移与归属之后（rebate_status 不由本模块
    // 写，用库内值：UNATTRIBUTED + 本次写入 user_id 的 R3a 算资格，VOID 的 R3b 不算）；金额取本次将写入的列。
    const snapshots = deps.snapshots;
    let snapshotPlan: CommissionSnapshotPlan | null = null;
    let snapshotSceneMissing = false;
    const eligibilityBefore = {
      user_id: current.user_id,
      platform_status: from,
      rebate_status: current.rebate_status,
    };
    const eligibilityAfter = {
      user_id: set.user_id ?? current.user_id,
      platform_status: plan.platform_status,
      rebate_status_before: rebateAfterBlacklist,
    };
    if (
      snapshots !== undefined &&
      crossesSnapshotEligibility(eligibilityBefore, eligibilityAfter)
    ) {
      const orderPid = set.pid !== undefined ? set.pid : current.pid;
      const pidScene =
        knownPidScene !== undefined
          ? knownPidScene
          : await orderPidScene(current, orderPid, ctx, platform);
      // 待编排裁定 7：推广位场景查不到 → 按非淘礼金处理，写后告警。
      snapshotSceneMissing = pidScene === null;
      // BR-CALC-11 细则 ②③：「迁到 PAID 的那次」以库内尚无已付历史、本次计划里有到 PAID+ 的步为准；
      // 首条已付时刻取旧历史，没有而本次迁入则为 now。
      const priorPaidAt = await readFirstPaidAt(trx, current);
      const steppedToPaid = plan.history.some((step) => isPaidOrLater(step.to_status));
      const snapshotInput: PlanCommissionSnapshotInput = {
        before: eligibilityBefore,
        after: eligibilityAfter,
        order: {
          app_id: current.app_id,
          order_id: current.order_id,
          platform,
          buy_type: orderBuyType(current.buy_type),
          activity_type: current.activity_type,
          is_presale: current.is_presale,
          paid_at: columns.paid_at,
          deposit_paid_at: columns.deposit_paid_at,
          est_commission_fen: columns.est_commission_fen,
          settle_commission_fen: columns.settle_commission_fen,
          subsidy_commission_fen: current.subsidy_commission_fen,
        },
        incoming: {
          modified_at: incoming.modified_at ?? null,
          service_fee_fen: incoming.service_fee_fen ?? null,
        },
        pidScene,
        movedToPaidNow: priorPaidAt === null && steppedToPaid,
        firstPaidAt: priorPaidAt ?? (steppedToPaid ? now : null),
        now,
      };
      snapshotPlan = planCommissionSnapshot(snapshotInput);
      const paidAtSource = snapshotPaidAtSource(snapshotInput, snapshotPlan);
      // BR-CALC-11：在订单记 paid_at_source；已有值不覆盖。
      if (paidAtSource !== null && current.paid_at_source === null) {
        Object.assign(set, { paid_at_source: paidAtSource });
      }
    }

    const updated = await casUpdateOrder(trx, current, set, {
      unattributed,
      attributing: attributedNow,
      backfilling: backfilled !== null,
    });
    if (!updated) return 'conflict';

    await insertPlatformHistory(trx, current, plan.history, now);
    // BR-FUND-09：先于 settlement 端口，closeAnsweredRights 读到的最新记录就是这一条。
    const settleFen = reportedSettleFen(incoming, plan);
    if (settleFen !== null) {
      await settlements?.recordApi(trx, {
        ...orderRef,
        commissionFen: settleFen,
        reportedSettledAt: unionSettledAt,
        orderSettledAt: current.settled_at,
      });
    }
    let pendingId: bigint | null = null;
    if (plan.pending !== null) {
      pendingId = await upsertPending(trx, {
        app_id: current.app_id,
        platform,
        sub_order_id: current.sub_order_id,
        order_id: current.order_id,
        reason: plan.pending,
        raw_status: incoming.raw_status ?? null,
        raw_payload_id: columns.raw_payload_id,
        detected_at: now,
        detail: pendingDetail(plan, from),
      });
    }
    // ③ 黑名单的处置：R6 的来源是本次迁移前的返利状态（库内值，锁内读）；先于 ⑥ 与 settlement 端口。
    if (blacklistStep !== null && blacklist !== null) {
      await applyOrderBlacklist(
        trx,
        blacklistStep,
        {
          app_id: current.app_id,
          order_id: current.order_id,
          user_id: set.user_id ?? current.user_id,
          platform,
          attr_at: current.attr_at,
        },
        blacklist,
        current.rebate_status,
      );
    }
    // B1-08zc 平台恢复检测（BR-FUND-22）：CAS 写入之后、同一事务；按库内（锁内读、本模块不改）的返利状态与原因判定，
    // 经端口登记 platform_restore 差错单。不复活订单、不写分录；端口抛错不吞，整事务回滚。
    const restore: PlatformRestoreOutcome =
      deps.platformRestore === undefined
        ? { kind: 'none' }
        : await runPlatformRestore(trx, deps.platformRestore, {
            app_id: current.app_id,
            order_id: current.order_id,
            platform,
            sub_order_id: current.sub_order_id,
            rebate_status: current.rebate_status,
            reason: current.reason,
            platformBefore: from,
            platformAfter: plan.platform_status,
            estBefore: current.est_commission_fen,
            estAfter: columns.est_commission_fen,
            settleBefore: current.settle_commission_fen,
            settleAfter: columns.settle_commission_fen,
            now,
          });
    // ⑥ 分佣快照：history、待处理之后、settlement 端口之前；端口抛错不吞，整事务回滚。
    let snapshot: SnapshotOutcome | undefined;
    let retryAlert: SnapshotRetryAlert | null = null;
    if (snapshots !== undefined) {
      const stepContext = {
        app_id: current.app_id,
        platform,
        sub_order_id: current.sub_order_id,
        order_id: current.order_id,
        raw_status: incoming.raw_status ?? null,
        raw_payload_id: columns.raw_payload_id,
        now,
      };
      if (snapshotPlan !== null) {
        snapshot = await runCommissionSnapshot(trx, snapshots, snapshotPlan, stepContext, log);
      } else if (
        eligibilityAfter.user_id !== null &&
        isSnapshotEligible({
          user_id: eligibilityAfter.user_id,
          platform_status: eligibilityAfter.platform_status,
          rebate_status: rebateAfterBlacklist,
        })
      ) {
        // B1-08t 补偿重试：本次没有跨入资格、仍满足 ⑥ 条件、库内还有 open 的快照类待处理行 → 重试一次。
        // 信号只看待处理行（不看快照是否存在）；端口幂等，已有快照回 existing。已转人工的不再自动重试。
        const rows = await readOpenSnapshotRows(trx, {
          app_id: current.app_id,
          platform,
          sub_order_id: current.sub_order_id,
        });
        if (rows.length === 0) {
          snapshot = 'none';
        } else if (isHandedOff(rows)) {
          snapshot = 'pending';
        } else {
          const ownerUserId = eligibilityAfter.user_id;
          const orderPid = set.pid !== undefined ? set.pid : current.pid;
          const pidScene =
            knownPidScene !== undefined
              ? knownPidScene
              : await orderPidScene(current, orderPid, ctx, platform);
          snapshotSceneMissing = pidScene === null;
          const source = current.paid_at_source;
          const firstPaidAt =
            source === 'observed' || source === null ? await readFirstPaidAt(trx, current) : null;
          const paid = resolveRetryPaidAt({
            paidAtSource: source,
            paidAt: columns.paid_at,
            depositPaidAt: columns.deposit_paid_at,
            firstPaidAt,
            now,
          });
          const retryPlan = planSnapshotRetry({
            order: {
              app_id: current.app_id,
              order_id: current.order_id,
              platform,
              buy_type: orderBuyType(current.buy_type),
              activity_type: current.activity_type,
              est_commission_fen: columns.est_commission_fen,
              settle_commission_fen: columns.settle_commission_fen,
              subsidy_commission_fen: current.subsidy_commission_fen,
            },
            ownerUserId,
            paid,
            serviceFeeFen: incoming.service_fee_fen ?? null,
            pidScene,
          });
          // BR-CALC-11：库内 paid_at_source 为空时照 B1-08k 写入（已有值不覆盖）。
          if (retryPlan.kind === 'call' && paid !== null && paid.writeSource) {
            await writePaidAtSource(trx, current, retryPlan.input.paidAtSource, now);
          }
          const retried = await runSnapshotRetry(trx, snapshots, retryPlan, stepContext, rows, log);
          snapshot = retried.outcome;
          retryAlert = retried.alert;
          // B1-08u：转人工标记之后、同一事务入队耗尽告警；抛错不吞，标记与本次写库一并回滚。
          if (retryAlert !== null) {
            await publishSnapshotRetryExhausted(deps.events, trx, retryAlert);
          }
        }
      } else {
        snapshot = 'none';
      }
    }
    const source: OrderStatusSource = {
      event: plan.event ?? null,
      raw_status: incoming.raw_status ?? null,
    };
    if (plan.pending === 'UNMAPPED_STATUS') {
      await deps.rebate.onUnmappedStatus(
        trx,
        {
          app_id: current.app_id,
          order_id: current.order_id,
          attr_at: current.attr_at,
          rebate_status: current.rebate_status,
        },
        source,
      );
    }
    await deps.rebate.onUpdated(
      trx,
      {
        app_id: current.app_id,
        order_id: current.order_id,
        attr_at: current.attr_at,
        from_status: from,
        to_status: plan.platform_status,
        rule: plan.rule,
        received_at: columns.received_at,
        est_before: current.est_commission_fen,
        est_after: columns.est_commission_fen,
        settle_commission_fen: columns.settle_commission_fen,
        attributed_now: attributedNow,
        ...(snapshot === undefined ? {} : { snapshot }),
      },
      source,
    );
    await deps.events.publish(trx, {
      appId: current.app_id,
      name: 'order.updated',
      payload: {
        order_id: current.order_id,
        platform,
        from_status: from,
        to_status: plan.platform_status,
        rule: plan.rule,
        attributed_now: attributedNow,
      },
    });
    // 告警事件与 order.updated 同一总线、同一事务（BR-ATTR-01 ⑦、BR-ATTR-07、BR-FUND-01 P10；02 §11）。
    if (plan.pending === 'ILLEGAL_TRANSITION') {
      // P10 且开关关：状态不迁移、其余列已照写，仍与待处理记录同事务记 order.illegal_transition。
      await publishIllegalTransition(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        pendingId,
        platform,
        rule: plan.rule ?? 'illegal',
        fromStatus: from,
        event: plan.event ?? null,
        outcome: 'status_kept',
      });
    }
    if (!unattributed && paramsChanged) {
      await publishParamChanged(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        platform,
        changed: changedParams,
      });
    }
    if (bindingConflict) {
      await publishBindingConflict(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        platform,
      });
    }

    // —— 告警日志（写库成功后才打，重读重试不重复）——
    const base = { platform, app_id: current.app_id };
    if (plan.pending === 'ILLEGAL_TRANSITION' || plan.pending === 'UNMAPPED_STATUS') {
      log?.error(
        {
          ...base,
          alert: ALERT_SYNC,
          event: 'order_illegal_transition',
          reason: plan.pending,
          rule: plan.rule,
          outcome: 'status_kept',
        },
        'order sync status not moved; other columns updated',
      );
    } else if (plan.pending === 'NO_RECEIVED_AT') {
      log?.warn(
        { ...base, reason: plan.pending, rule: plan.rule, outcome: 'pending' },
        'order receipt without platform received time',
      );
    }
    if (plan.rule === 'P9' && plan.history.length > 0) {
      log?.warn(
        { ...base, alert: ALERT_SYNC, rule: 'P9', outcome: 'invalid_recovered' },
        'invalid order reported active again; rebate status unchanged',
      );
    }
    if (restore.kind === 'registered' && restore.inserted) {
      log?.warn(
        {
          ...base,
          alert: ALERT_PLATFORM_RESTORE,
          order_id: current.order_id,
          recon_diff_id: restore.reconDiffId,
          trigger: restore.trigger,
          reason_code: restore.reasonCode,
          rebate_status: restore.rebateStatus,
        },
        'voided or clawed-back order restored by the platform; recon diff registered',
      );
    } else if (restore.kind === 'entry_missing') {
      log?.warn(
        {
          ...base,
          alert: ALERT_SYNC,
          order_id: current.order_id,
          trigger: restore.trigger,
          outcome: 'platform_restore_entry_missing',
        },
        'platform restore detected but no rebate history row entered the current status; not registered',
      );
    }
    if (!unattributed && paramsChanged) {
      log?.warn(
        { ...base, alert: ALERT_PARAM, event: 'order_attr_param_changed', outcome: 'params_kept' },
        'attribution parameters changed on an attributed order',
      );
    } else if (unattributed && slot !== current.pid) {
      // 待编排裁定 6：未归因订单写入新参数，不重跑 App 归属；推广位变化只告警。
      log?.warn(
        { ...base, outcome: 'pid_changed' },
        'promotion slot changed on an unattributed order',
      );
    }
    if (bindingConflict) {
      log?.error(
        { ...base, alert: ALERT_SYNC, event: 'attr_binding_conflict', outcome: 'unattributed' },
        'taobao binding conflict',
      );
    }
    if (pidSceneMissing) {
      log?.warn(
        { ...base, reason: 'PID_SCENE_NOT_FOUND', outcome: 'source_scene_unknown' },
        'order promotion slot scene unknown; source backfill skipped product / shop matching',
      );
    }
    if (retryAlert !== null) logSnapshotRetryExhausted(log, retryAlert);
    if (snapshotSceneMissing) {
      log?.warn(
        { ...base, reason: 'PID_SCENE_NOT_FOUND', outcome: 'snapshot_scene_unknown' },
        'order promotion slot scene unknown; commission snapshot treats it as non-taolijin',
      );
    }
    if (backfilled !== null) {
      log?.info(
        { ...base, source_match: backfilled, outcome: 'backfilled' },
        'order source backfilled',
      );
    } else if (sourcePending) {
      log?.info(
        { ...base, outcome: 'source_pending' },
        'order source left blank until the shop is known',
      );
    }
    log?.info(
      { ...base, outcome: 'updated', rule: plan.rule, attributed_now: attributedNow },
      'order updated',
    );
    // B1-08zh（D10-574）：已有 est 的单后续缺服务费，est 不覆盖、版本不前进（planOrderSyncColumns）；
    // 不进待处理（那是快照重试的信号），只计数并告警。不带金额和单号。
    if (
      findPlatformRules(platform)?.serviceFeeDeducted === true &&
      (incoming.service_fee_fen ?? null) === null &&
      (incoming.est_commission_fen ?? null) === null &&
      current.est_commission_fen !== null
    ) {
      countPddServiceFeeMissing();
      log?.warn({ platform, order_id: current.order_id }, 'pdd_service_fee_missing');
    }
    return { kind: 'updated', order_id: current.order_id };
  }

  return {
    async apply(trx, current, incoming, ctx) {
      const first = await attempt(trx, current, incoming, ctx);
      if (first !== 'conflict') return first;
      // 02 §18：CAS 影响 0 行 → 重读一次，按迁移表重新判定。
      const reread = await readOrder(trx, current);
      if (reread === undefined) {
        throw new Error('ORDER_ROW_MISSING: CAS 冲突后重读不到订单行');
      }
      const second = await attempt(trx, reread, incoming, ctx);
      if (second !== 'conflict') return second;
      throw new Error('ORDER_CAS_CONFLICT: 订单并发更新，两次 CAS 均未命中');
    },
  };
}
