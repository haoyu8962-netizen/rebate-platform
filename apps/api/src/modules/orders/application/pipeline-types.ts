import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { readOrderAttributionLink } from '../../linking/index.ts';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, RejectedOrderRow, UnionOrder } from '../../union/index.ts';
import type { BindingRow } from '../domain/attribution.ts';
import type { PlatformRules } from '../domain/platform-rules/index.ts';
import type { OrderBlacklistDeps, OrderBlacklistRebatePort } from './blacklist-step.ts';
import type { StatusMap } from '../domain/status-map.ts';
import type { CommissionSnapshotPort, SnapshotOutcome } from './commission-snapshot-step.ts';
import type { OrderSyncWindow, SyncLogger } from './sync-ports.ts';
import type { OrderSourcePorts } from './source-backfill.ts';

/** B1-04zv：这次同步走的路径（规划/02 §7.1）；写进自动解决待处理的说明。 */
export type OrderSyncSource = 'increment' | 'rescan' | 'manual';

export interface OrderPipelineContext extends OrderSyncWindow {
  readonly requestId: string;
  /** 缺省按 increment：回扫的 query_kind 也写成 increment，所以路径单列一个字段。 */
  readonly source?: OrderSyncSource;
}

export interface PidRow {
  readonly pid_scene: string;
  readonly status: string;
  readonly site_id: string | null;
}

/** B1-08zzc r2（D10-3406）：slotCandidates 的行另带登记的 pid 原值；淘宝命中后 orders.pid 写它。 */
export interface SlotPidRow extends PidRow {
  readonly pid: string;
}

export interface ImportedOrder {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly attributed: boolean;
  readonly platform_status: OrderPlatformState;
  readonly received_at: Date | null;
  /**
   * B1-08k 第 ⑥ 步本次的快照结果（R2 的预估由 settlement 据此与快照表决定）：created / existing = 已有快照；
   * pending = 跨入资格但进了待处理；none = 本次不生成。只在注入 snapshots 时出现；未注入时不带此字段
   * （与 B1-08h 的入参逐字段一致，D10-69；同 OrderUpdateChange.snapshot）。
   */
  readonly snapshot?: SnapshotOutcome;
}

export interface OrderPipelineResult {
  readonly kind:
    'inserted' | 'updated' | 'dropped' | 'pending' | 'unchanged' | 'stale' | 'app_conflict';
  readonly order_id?: string;
  readonly reason?: string;
}

export interface OrderPipelineDeps {
  readonly sources?: OrderSourcePorts;
  /** 流水线事务内读取本 App 登记的短码链接。 */
  readonly readBuyTypeLink?: typeof readOrderAttributionLink;
  /** 未注入时使用订单平台规则表。 */
  readonly buyTypeRules?: (platform: RegisteredPlatform) => PlatformRules;
  /**
   * 事件总线（B1-08i，02 §11）：领域事件 order.created 与告警事件 order.illegal_transition、
   * order.attr_binding_conflict 都经它、与本次写库同一事务入队，入队失败整事务回滚。
   * 未注入（B1-08h 的用法）时不发事件，告警只记日志；装配在 B1-08n。
   */
  readonly events?: Pick<EventBus, 'publish'>;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly statusMaps: (platform: RegisteredPlatform) => StatusMap;
  readonly pids: {
    find(input: {
      appId: string;
      platform: RegisteredPlatform;
      unionAccountId: string;
      pid: string;
    }): Promise<readonly PidRow[]>;
    /**
     * B1-08zzc（BR-ATTR-02、D10-3355）：订单推广位按本平台的推广位键命中的 union_pids 行（本 App、本联盟账号，
     * pending / active / retired 都算，按 id 排序）。平台差异在 union：淘宝取登记行的 adzone（mm_ 末段或纯数字）
     * 等于订单 adzone_id 的行，行带 site_id，由流水线再核对订单 site_id；京东、拼多多按 pid 等值，行的 site_id 为空。
     * 生产装配（worker-runtime 的 pids: readers.pids）都带它；只给 find 的测试替身沿用 find 的等值匹配。
     * 每行带登记的 pid 原值（京东、拼多多即推广位本身），淘宝命中后写进 orders.pid（r2，D10-3406）。
     */
    slotCandidates?(input: {
      appId: string;
      platform: RegisteredPlatform;
      unionAccountId: string;
      slot: string;
    }): Promise<readonly SlotPidRow[]>;
    /**
     * B1-08zzc r2（D10-3355 / D10-3406）：本平台「登记 pid → 订单推广位键」的函数，平台差异在 union：淘宝为 union 的
     * taobaoAdzoneOf（mm_<a>_<b>_<c> 取 <c>、纯数字取其本身，与适配器推广位筛选同一个函数）；null = 推广位与登记
     * pid 等值（京东、拼多多）。更新步据此判「推广位变了」与未归因时 orders.pid 写什么；未提供按 null。
     */
    slotKey?(platform: RegisteredPlatform): ((pid: string) => string | null) | null;
  };
  readonly accounts: {
    syncStartAt(input: { appId: string; unionAccountId: string }): Promise<Date | null>;
  };
  readonly users: {
    findByAttrCode(input: { appId: string; attrCode: string }): Promise<string | null>;
  };
  readonly bindings: {
    findByRelation(input: {
      appId: string;
      unionAccountId: string;
      relationId: string;
    }): Promise<readonly BindingRow[]>;
  };
  readonly rebate: {
    onImported(trx: Transaction<DB>, order: ImportedOrder): Promise<void>;
    /** B1-09b 第 ③ 步命中且未入账（BR-ATTR-26 → BR-FUND-01 R6）；接线在资金线。 */
    onBlacklistHit?: OrderBlacklistRebatePort['onBlacklistHit'];
  };
  /**
   * 第 ③ 步黑名单（B1-09b，BR-ATTR-26）：risk 订单侧名单端口与尾号维度开关。未注入时整步跳过。
   */
  readonly blacklist?: OrderBlacklistDeps;
  /**
   * 分佣快照端口（B1-08k，BR-ATTR-01 ⑥ / BR-CALC-10）：首次入库即已归因且 PAID+ 时，在 history、待处理之后、
   * rebate.onImported 之前同事务调用；抛错整事务回滚。未注入时整步跳过（不调用、不写来源与待处理，
   * ImportedOrder 不带 snapshot 字段）。
   */
  readonly snapshots?: CommissionSnapshotPort;
  readonly updateStep?: {
    apply(
      trx: Transaction<DB>,
      current: Selectable<DB['orders']>,
      incoming: UnionOrder,
      ctx: OrderPipelineContext,
    ): Promise<OrderPipelineResult>;
  };
  readonly mtimeOrdering?: (platform: RegisteredPlatform) => boolean;
  readonly logger?: SyncLogger;
}

/** Normal resolution includes accepted, dropped, rejected and pending orders. */
export interface OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<void | OrderPipelineResult>;
  /**
   * B1-04zv：一页里映射失败的行进待处理（application/row-quarantine.ts）。可选只为测试替身：生产的流水线都有；
   * 没有它却收到坏行时任务失败，不丢行（quarantineRejected）。
   */
  quarantine?(rows: readonly RejectedOrderRow[], ctx: OrderPipelineContext): Promise<void>;
}

export interface OrderPipeline extends OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<OrderPipelineResult>;
  quarantine(rows: readonly RejectedOrderRow[], ctx: OrderPipelineContext): Promise<void>;
}

/** ① App 归属的结果：命中的那一行（带其登记 pid，后续 pid_scene 取它）、淘宝媒体不符、不是本 App 的推广位。 */
export type SlotMatch =
  | { readonly kind: 'hit'; readonly row: SlotPidRow }
  | { readonly kind: 'site_mismatch' }
  | { readonly kind: 'not_ours' };

const NOT_OURS: SlotMatch = { kind: 'not_ours' };

/**
 * ① App 归属（BR-ATTR-02、D10-3355）：推广位命中本 App、本联盟账号的 union_pids（pending / active / retired 都算）。
 * 候选行带 site_id（淘宝的推广位键含媒体）→ 命中取 site_id 与订单相等的那一行，订单缺 site_id 不猜按不命中，
 * 都不等为 site_mismatch；都不带（京东、拼多多）→ 取首行。首次入库与更新步（未归因订单推广位变化）共用。
 * 端口只给 find 的替身按等值匹配，命中行的 pid 即推广位本身。
 */
export async function matchOrderSlot(
  pids: OrderPipelineDeps['pids'],
  input: {
    readonly appId: string;
    readonly platform: RegisteredPlatform;
    readonly unionAccountId: string;
    readonly slot: string | null;
    readonly siteId: string | null;
  },
): Promise<SlotMatch> {
  const { slot } = input;
  if (slot === null || slot === '') return NOT_OURS;
  const key = {
    appId: input.appId,
    platform: input.platform,
    unionAccountId: input.unionAccountId,
  };
  if (pids.slotCandidates !== undefined) {
    const rows = await pids.slotCandidates({ ...key, slot });
    const first = rows[0];
    if (first === undefined) return NOT_OURS;
    if (rows.every((row) => row.site_id === null)) return { kind: 'hit', row: first };
    const site = input.siteId;
    if (site === null || site === '') return NOT_OURS;
    const hit = rows.find((row) => row.site_id === site);
    return hit === undefined ? { kind: 'site_mismatch' } : { kind: 'hit', row: hit };
  }
  const rows = await pids.find({ ...key, pid: slot });
  const row = rows[0];
  return row === undefined ? NOT_OURS : { kind: 'hit', row: { ...row, pid: slot } };
}
