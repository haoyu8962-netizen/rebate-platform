// B1-09b：归因流水线第 ③ 步黑名单的端口形状（BR-ATTR-26；BR-ATTR-01 ③）。只在流水线运行时（首次入库，或
// content_hash 变化）检查；不做全表回扫。与本次写库同一事务。
// - 名单查询与命中写入经 risk 导出的订单侧名单端口（B1-09a）；这里按结构声明，risk 的实现直接满足。
// - 命中且未入账 → rebate.onBlacklistHit（settlement apply BLACKLIST_HIT，R6）；未注入时只记 manual_review 并告警，
//   不改订单列。已入账 → 入队 order.blacklist_hit_after_credit。VOID / CLAWED_BACK 不处理。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { EventBus } from '../../platform/index.ts';
import {
  planBlacklistHit,
  type BlacklistDimension,
  type BlacklistDisposition,
  type BlacklistPlan,
  type BlacklistRiskAction,
} from '../domain/blacklist.ts';
import { publishBlacklistAfterCredit } from './alert-events.ts';
import type { SyncLogger } from './sync-ports.ts';

export interface OrderBlacklistQuery {
  readonly app_id: string;
  readonly platform: string;
  /** 订单父订单号（淘宝 trade_parent_id，即 orders.parent_order_id）。 */
  readonly trade_parent_id: string | null;
  readonly relation_id: string | null;
  /** 订单推广位所属的联盟账号。 */
  readonly union_account_id: string | null;
  readonly attr_at: Date;
  /** B1-03zk：已入库订单的 id；申诉撤销后的再命中豁免按单判定（BR-ATTR-26）。首次入库没有。 */
  readonly order_id?: string;
}

export interface OrderBlacklistMatch {
  readonly blocklist_id: string;
  readonly dimension: BlacklistDimension;
  readonly value: string;
}

export interface OrderBlacklistHitRecord {
  readonly app_id: string;
  readonly user_id: string | null;
  readonly order_id: string;
  readonly dimension: BlacklistDimension;
  readonly value: string;
  readonly risk_action: BlacklistRiskAction;
  /** 命中来自本次判定的 match，规则状态已判过：risk 不再读（BR-ID-36，一次判定一次读）。 */
  readonly decided_in_force?: true;
}

/** risk 订单侧名单端口（B1-09a）中本步用到的两项；都在调用方事务内执行。 */
export interface OrderBlacklistPorts {
  match(trx: Transaction<DB>, input: OrderBlacklistQuery): Promise<readonly OrderBlacklistMatch[]>;
  recordHit(trx: Transaction<DB>, input: OrderBlacklistHitRecord): Promise<void>;
}

export interface OrderBlacklistDeps {
  readonly blocklist: OrderBlacklistPorts;
  /** attr.blacklist.order_suffix_void_enabled（默认 false）。 */
  readonly suffixVoidEnabled: (appId: string) => Promise<boolean>;
}

/** 交给返利端口的命中（settlement 按 BLACKLIST_HIT 走 R6，reason_code=BLACKLIST）。 */
export interface OrderBlacklistHit {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
}

export interface OrderBlacklistRebatePort {
  onBlacklistHit(trx: Transaction<DB>, hit: OrderBlacklistHit): Promise<void>;
}

/** 第 ③ 步读到的名单命中与尾号维度开关（判定阶段读，写库阶段按订单当时的返利状态处置）。 */
export interface OrderBlacklistCheck {
  readonly matches: readonly OrderBlacklistMatch[];
  readonly suffixVoidEnabled: boolean;
}

/** 第 ③ 步处置所需的订单字段；user_id 取 ② 归属之后的值（未归因为 null）。 */
export interface OrderBlacklistSubject {
  readonly app_id: string;
  readonly order_id: string;
  readonly user_id: string | null;
  readonly platform: string;
  readonly attr_at: Date;
}

export interface OrderBlacklistStepDeps {
  readonly blacklist: OrderBlacklistDeps;
  /** settlement 的 BLACKLIST_HIT（R6）；未接线时未入账命中降为只记 manual_review 并告警。 */
  readonly onBlacklistHit?: OrderBlacklistRebatePort['onBlacklistHit'];
  /** order.blacklist_hit_after_credit 的总线；未注入时已入账命中只记 manual_review 并告警。 */
  readonly events?: Pick<EventBus, 'publish'>;
  readonly logger?: SyncLogger;
}

/** 名单查询（只读，调用方事务内）；尾号开关只在有尾号命中时读。 */
export async function checkOrderBlacklist(
  trx: Transaction<DB>,
  deps: OrderBlacklistDeps,
  query: OrderBlacklistQuery,
): Promise<OrderBlacklistCheck> {
  const matches = await deps.blocklist.match(trx, query);
  const suffixVoidEnabled = matches.some((match) => match.dimension === 'order_no_suffix')
    ? await deps.suffixVoidEnabled(query.app_id)
    : false;
  return { matches, suffixVoidEnabled };
}

function plan(check: OrderBlacklistCheck, rebateStatus: string): BlacklistPlan {
  return planBlacklistHit({
    matches: check.matches,
    rebate_status: rebateStatus,
    suffix_void_enabled: check.suffixVoidEnabled,
  });
}

/**
 * 按该返利状态处置时，订单是否会经返利端口作废（R6）。第 ⑥ 步据此不为将作废的订单生成快照
 * （BR-ATTR-01 ⑥「未作废」）；返利端口未接线时不作废，返回 false。
 */
export function blacklistVoids(
  check: OrderBlacklistCheck | null,
  rebateStatus: string,
  deps: Pick<OrderBlacklistStepDeps, 'onBlacklistHit'>,
): boolean {
  if (check === null || deps.onBlacklistHit === undefined) return false;
  return plan(check, rebateStatus).disposition === 'void';
}

/**
 * 写库阶段的处置（BR-ATTR-26「命中后的处理」），与本次写库同一事务；任何一步抛错整事务回滚。
 * 先经 risk 端口逐条写命中，再按处置调返利端口（void）或入队复核事件（after_credit）。
 * 命中都来自本次 checkOrderBlacklist 的 match，带 decided_in_force：状态缓存在判定与写命中之间过期时，
 * 命中仍写，不会作废了返利却没有命中记录（BR-ID-36，D10-536）。
 * 端口或总线缺失时不改订单：命中改记 manual_review，打一条 P1 告警（只带平铺字段）。
 */
export async function applyOrderBlacklist(
  trx: Transaction<DB>,
  deps: OrderBlacklistStepDeps,
  subject: OrderBlacklistSubject,
  check: OrderBlacklistCheck,
  rebateStatus: string,
): Promise<BlacklistDisposition> {
  const decided = plan(check, rebateStatus);
  const missing =
    decided.disposition === 'void'
      ? deps.onBlacklistHit === undefined
      : decided.disposition === 'after_credit'
        ? deps.events === undefined
        : false;
  const disposition: BlacklistDisposition = missing ? 'none' : decided.disposition;
  for (const hit of decided.hits) {
    await deps.blacklist.blocklist.recordHit(trx, {
      app_id: subject.app_id,
      user_id: subject.user_id,
      order_id: subject.order_id,
      dimension: hit.dimension,
      value: hit.value,
      risk_action: missing ? 'manual_review' : hit.risk_action,
      decided_in_force: true,
    });
  }
  if (disposition === 'void' && deps.onBlacklistHit !== undefined) {
    await deps.onBlacklistHit(trx, {
      app_id: subject.app_id,
      order_id: subject.order_id,
      attr_at: subject.attr_at,
    });
  } else if (disposition === 'after_credit' && deps.events !== undefined) {
    await publishBlacklistAfterCredit(deps.events, trx, {
      appId: subject.app_id,
      orderId: subject.order_id,
      platform: subject.platform,
      dimensions: decided.hits.map((hit) => hit.dimension),
    });
  }
  const base = { platform: subject.platform, app_id: subject.app_id };
  if (missing) {
    deps.logger?.warn(
      {
        ...base,
        alert: 'P1',
        event: 'blacklist_hit',
        reason: decided.disposition === 'void' ? 'REBATE_PORT_MISSING' : 'EVENT_BUS_MISSING',
        outcome: 'review_only',
      },
      'blacklist hit recorded for manual review only; order left unchanged',
    );
  } else if (decided.hits.length > 0) {
    deps.logger?.info(
      { ...base, event: 'blacklist_hit', outcome: disposition, hits: decided.hits.length },
      'order blacklist hit',
    );
  }
  return disposition;
}
