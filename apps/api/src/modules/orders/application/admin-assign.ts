// B1-10f：后台未归因订单指派的用例（POST /admin/v1/orders/{order_id}/reassign；契约 adminReassignOrder，
// 权限点 order.assign、动态码档；BR-ATTR-31、BR-ATTR-20 ①③、BR-FUND-01 R3 / R3b）。本文件只给应用服务；
// 路由由 B1-10m 的 http/admin/order-actions.controller.ts 挂在 admin 入口，settlement 端口由 app.module 注入真实现。
// 事务（一次指派一个事务）：
//   ① 首句取子订单 advisory 锁（与同步、找回同一把，order-lock.ts），再 SELECT … FOR UPDATE 重读订单；
//   ② 复查：user_id 非空、或 locked 与 expected_locked 不符 → 20902（resource=order_attribution），不做
//      任何修改；同一事务里读目标用户的风控状态（banned → target_banned）与注销阶段（cooling /
//      processing → target_deleting，done → target_deleted），拒绝为 20001 data.fields=[user_id]
//      与 data.reason，不写订单、不生成快照，写审计（被拒原因）；冻结、申诉中照常指派；
//   ③ 复查通过：来源回填（BR-ATTR-15）→ 分佣快照（UNATTRIBUTED 走 R3 时经 runCommissionSnapshot；
//      VOID 走 R3b 不生成）→ settlement 端口 rebate.onAdminAssigned（入参是写前快照；locked 与
//      rebate_status 由端口按 R3 / R3b 写）→ orders 写 user_id、user_basis=admin → order_status_history
//      （field=rebate、source=admin）→ order_assignments（只插入，source=admin）→ 该子订单其他用户的
//      待审找回子项 rejected NOT_IN_POOL（claim 全部已决时汇总）→ 审计 → 本事务内入队 order.reassigned
//      与本次结案的 claim.resolved。目标同时命中多项时按 已注销 → 注销中 → 封禁 的先后给 reason。
// 端口、审计、事件任一失败都原样抛出，整事务回滚。响应是提交后 B1-10i 的订单详情读取。
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  summarizeClaimDecisions,
  transitionClaim,
  transitionClaimItem,
  transitionOrderRebate,
  type ClaimItemState,
  type ClaimState,
  type OrderRebateState,
} from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { newUuidV7, type AuditPort, type Clock, type EventBus } from '../../platform/index.ts';
import { isRegisteredPlatform } from '../../union/index.ts';
import { isUuid } from '../domain/admin-claim-view.ts';
import { claimSnapshotInput, normalizeReviewReason } from '../domain/claim-review.ts';
import { planCommissionSnapshot, snapshotPaidAtSource } from '../domain/commission-snapshot.ts';
import {
  insertAdminAssignment,
  insertAdminRebateHistory,
  pendingItemsOfOthers,
  writeAdminAttribution,
} from '../infra/admin-assign-store.ts';
import { readOrderLockTarget, rereadOrderForUpdate } from '../infra/admin-hold-store.ts';
import { createAdminOrderReads } from '../infra/admin-order-reads.ts';
import {
  claimDecisions,
  lockClaims,
  writeClaim,
  writeItemDecision,
  type OrderAttributionWrite,
  type ReviewClaimRow,
} from '../infra/claim-review-store.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { readFirstPaidAt } from '../infra/pipeline-store.ts';
import { AdminOrders, type AdminOrderPorts } from './admin-orders.ts';
import { storedSourcePorts, storedUnionOrder } from './claim-review.ts';
import {
  runCommissionSnapshot,
  type CommissionSnapshotPort,
  type SnapshotOutcome,
} from './commission-snapshot-step.ts';
import { backfillOrderSource, sourceColumns, type OrderSourcePorts } from './source-backfill.ts';

export interface AdminAssignActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminAssignCommand {
  readonly orderId: string;
  /** 目标用户。 */
  readonly user_id: string;
  /** 操作员看到的订单 user_id：只能为空（未归因订单）。 */
  readonly expected_user_id: null;
  /** 操作员看到的 flags.locked。 */
  readonly expected_locked: boolean;
  /** 指派原因（5～200 字，BR-ATTR-20 ③），写进审计。 */
  readonly reason: string;
}

/** settlement 端口的入参（claim-review 的 ClaimApprovedInput 同形）。 */
export interface AdminAssignedInput {
  /** SELECT … FOR UPDATE 重读到的整行，orders 写归属之前。 */
  readonly before: Selectable<DB['orders']>;
  readonly userId: string;
  readonly now: Date;
  /** R3 的快照结果；R3b（VOID）不生成快照，为 none。 */
  readonly snapshot: SnapshotOutcome;
}

/** settlement 的返利端口：只有它写 locked 与 rebate_status（R3：UNATTRIBUTED → ESTIMATED / WAITING；R3b：VOID 不变）。 */
export interface AdminAssignRebatePort {
  onAdminAssigned(trx: Transaction<DB>, input: AdminAssignedInput): Promise<void>;
}

export interface AdminAssignTargetInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

/** risk 的批量风控状态读取（createRiskStateBatchReader 同形）；只在调用方事务上执行。 */
export interface AdminAssignRiskReader {
  read(
    executor: Transaction<DB>,
    input: AdminAssignTargetInput,
  ): Promise<ReadonlyMap<string, { readonly state: string }>>;
}

/** identity 的注销阶段读取（createDeletionStageReader 同形：none / cooling / processing / done）。 */
export interface AdminAssignDeletionReader {
  read(
    executor: Transaction<DB>,
    input: AdminAssignTargetInput,
  ): Promise<ReadonlyMap<string, string>>;
}

export interface AdminAssignTargetReaders {
  readonly risk: AdminAssignRiskReader;
  readonly deletion: AdminAssignDeletionReader;
}

/** 目标用户不能作为归属对象时的 data.reason（契约 adminReassignOrder）。 */
export type AdminAssignTargetRefusal = 'target_banned' | 'target_deleting' | 'target_deleted';

/** 审计 action（指派成功与目标被拒都记，target 为 `orders:<order_id>`）。 */
export type AdminAssignAuditAction = 'order_assign';

export interface AdminAssignDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly events: Pick<EventBus, 'publish'>;
  readonly rebate: AdminAssignRebatePort;
  readonly targets: AdminAssignTargetReaders;
  readonly snapshots?: CommissionSnapshotPort;
  readonly sources?: OrderSourcePorts;
  readonly pidScene?: (order: Selectable<DB['orders']>) => Promise<string | null>;
  // 给了就在本事务句柄上读（优先于 sources / pidScene）：持锁的事务不再占一条连接等第二条，
  // 连接池耗尽时不互相死等（B1-10m money r1）。
  readonly sourcesOn?: (trx: Transaction<DB>) => OrderSourcePorts;
  readonly pidSceneOn?: (trx: Transaction<DB>) => NonNullable<AdminAssignDeps['pidScene']>;
  /** B1-10i 的详情端口，供响应。 */
  readonly details: AdminOrderPorts;
}

export type AdminAssignOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminOrderDetail'> }
  | {
      readonly code: 20001;
      readonly data: {
        readonly fields: readonly string[];
        readonly reason?: AdminAssignTargetRefusal;
      };
    }
  | { readonly code: 20902; readonly data: { readonly resource: 'order_attribution' } };

const CONFLICT = { code: 20902, data: { resource: 'order_attribution' } } as const;
const AUDIT_ACTION: AdminAssignAuditAction = 'order_assign';

function fieldsError(field: string): AdminAssignOutcome {
  return { code: 20001, data: { fields: [field] } };
}

/** 锁内判定的结果：done 已写完；其余在事务内不写订单（target 被拒时只写审计）。 */
type InTransaction =
  | { readonly kind: 'done' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'order_missing' }
  | { readonly kind: 'user_unknown' }
  | { readonly kind: 'refused'; readonly reason: AdminAssignTargetRefusal };

/** 运行时故障（端口、审计、事件、数据库）原样抛出并整事务回滚。 */
export async function assignOrder(
  deps: AdminAssignDeps,
  actor: AdminAssignActor,
  command: AdminAssignCommand,
): Promise<AdminAssignOutcome> {
  // 输入校验：原因去首尾空白后 5～200 字（BR-ATTR-20 ③）；非 UUID 的 id 不进库（不在库里转换出错）。
  const reason = normalizeReviewReason(command.reason);
  if (reason === null) return fieldsError('reason');
  if ((command.expected_user_id as unknown) !== null) return fieldsError('expected_user_id');
  if (typeof command.expected_locked !== 'boolean') return fieldsError('expected_locked');
  if (typeof command.orderId !== 'string' || !isUuid(command.orderId)) {
    return fieldsError('order_id');
  }
  if (typeof command.user_id !== 'string' || !isUuid(command.user_id)) {
    return fieldsError('user_id');
  }
  const orderId = command.orderId.toLowerCase();
  const userId = command.user_id.toLowerCase();
  const target = await readOrderLockTarget(deps.db, actor.appId, orderId);
  if (target === undefined) return fieldsError('order_id');

  const result = await deps.db.transaction().execute(async (trx): Promise<InTransaction> => {
    // ① 首句子订单锁，再 FOR UPDATE 重读订单（BR-ATTR-20 ①）。
    await lockOrderKey(trx, target.platform, target.sub_order_id);
    const before = await rereadOrderForUpdate(trx, actor.appId, orderId);
    if (before === undefined) return { kind: 'order_missing' };
    // ② 复查：只接受 user_id 为空、locked 与期望一致；返利状态须能接 ADMIN_REASSIGN（R3 / R3b）。
    if (before.user_id !== null || before.locked !== command.expected_locked) {
      return { kind: 'conflict' };
    }
    const moved = transitionOrderRebate(before.rebate_status as OrderRebateState, 'ADMIN_REASSIGN');
    if (!moved.ok) return { kind: 'conflict' };
    const now = deps.clock.now();

    // 同一事务读目标用户的注销阶段与风控状态（BR-ATTR-31 细则「判定时点」）。
    const input = { appId: actor.appId, userIds: [userId] };
    const stage = (await deps.targets.deletion.read(trx, input)).get(userId);
    const risk = (await deps.targets.risk.read(trx, input)).get(userId);
    if (stage === undefined || risk === undefined) return { kind: 'user_unknown' };
    const refusal = targetRefusal(stage, risk.state);
    if (refusal !== null) {
      // 被拒：不写订单、不生成快照，只写审计（被拒原因），提交。
      await deps.auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: AUDIT_ACTION,
        target: `orders:${before.order_id}`,
        before: { user_id: null, locked: before.locked, rebate_status: before.rebate_status },
        after: { user_id: userId, reason, refused: refusal },
        ip: actor.ip,
      });
      return { kind: 'refused', reason: refusal };
    }

    // ③ 归属写入（来源回填、快照、settlement、orders 列、历史）。
    const after = await attribute(deps, trx, before, userId, moved.noop, now);
    const assignmentId = newUuidV7(now);
    await insertAdminAssignment(trx, {
      id: assignmentId,
      appId: actor.appId,
      orderId: before.order_id,
      toUserId: userId,
      reason,
      adminId: actor.adminId,
      now,
    });
    const resolved = await rejectOthersPending(trx, actor.appId, before, userId, now);

    await deps.auditOn(trx).append({
      appId: actor.appId,
      actor: actor.adminId,
      action: AUDIT_ACTION,
      target: `orders:${before.order_id}`,
      before: { user_id: null, locked: before.locked, rebate_status: before.rebate_status },
      after: {
        user_id: userId,
        reason,
        user_basis: 'admin',
        locked: after.locked,
        rebate_status: after.rebate_status,
        assignment_id: assignmentId,
      },
      ip: actor.ip,
    });
    await deps.events.publish(trx, {
      appId: actor.appId,
      name: 'order.reassigned',
      payload: {
        order_id: before.order_id,
        app_id: actor.appId,
        user_id: userId,
        assignment_id: assignmentId,
      },
    });
    for (const { claim, status } of resolved) {
      await deps.events.publish(trx, {
        appId: actor.appId,
        name: 'claim.resolved',
        payload: { claim_id: claim.id, app_id: actor.appId, user_id: claim.user_id, status },
      });
    }
    return { kind: 'done' };
  });

  if (result.kind === 'conflict') return CONFLICT;
  if (result.kind === 'order_missing') return fieldsError('order_id');
  if (result.kind === 'user_unknown') return fieldsError('user_id');
  if (result.kind === 'refused') {
    return { code: 20001, data: { fields: ['user_id'], reason: result.reason } };
  }
  const details = new AdminOrders({ ...deps.details, reads: createAdminOrderReads(deps.db) });
  return { code: 0, data: await details.detail(actor.appId, orderId, undefined) };
}

/** BR-ATTR-31 细则「改归属的目标用户」：已注销、注销中（冷静期 / 处理中）、封禁拒绝；冻结、申诉中照常。 */
function targetRefusal(stage: string, riskState: string): AdminAssignTargetRefusal | null {
  if (stage === 'done') return 'target_deleted';
  if (stage === 'cooling' || stage === 'processing') return 'target_deleting';
  if (riskState === 'banned') return 'target_banned';
  return null;
}

/** BR-ATTR-20 ③（管理员指派）：顺序见文件头 ③；`same` 为 R3b（VOID 不变、不生成快照）。 */
async function attribute(
  deps: AdminAssignDeps,
  trx: Transaction<DB>,
  before: Selectable<DB['orders']>,
  userId: string,
  same: boolean,
  now: Date,
): Promise<{ readonly rebate_status: string; readonly locked: boolean }> {
  const readScene = deps.pidSceneOn?.(trx) ?? deps.pidScene;
  const sources = deps.sourcesOn?.(trx) ?? deps.sources;
  let scene: { value: string | null } | undefined;
  // B1-08zzi（D10-3808，BR-CALC-19）：先用入库 / 未归因重跑命中时持久化的场景（attr_pid_scene），非空即用，
  // 后台改登记行场景不改变本单判定；为空（存量单）才现查登记行。来源回填与快照共用这一个值。
  const pidScene = async (): Promise<string | null> => {
    scene ??= {
      value: before.attr_pid_scene ?? (readScene === undefined ? null : await readScene(before)),
    };
    return scene.value;
  };
  const write: { -readonly [K in keyof OrderAttributionWrite]: OrderAttributionWrite[K] } = {
    user_id: userId,
  };

  // 来源回填（BR-ATTR-15）：只在尚无 source_match（含 none）时；端口抛错原样抛出。
  const platform = before.platform;
  if (sources !== undefined && before.source_match === null && isRegisteredPlatform(platform)) {
    const source = await backfillOrderSource(storedSourcePorts(sources, before), {
      appId: before.app_id,
      platform,
      userId,
      attrAt: before.attr_at,
      pidScene: await pidScene(),
      order: storedUnionOrder(before, platform),
      shopId: before.shop_id,
    });
    Object.assign(write, sourceColumns(source));
  }

  // 分佣快照（R3 经 runCommissionSnapshot；R3b 与预售定金阶段由计划给出 skip）；未注入端口记 none。
  let snapshot: SnapshotOutcome = 'none';
  if (deps.snapshots !== undefined && !same) {
    const input = claimSnapshotInput(
      before,
      userId,
      await pidScene(),
      await readFirstPaidAt(trx, before),
      now,
    );
    const plan = planCommissionSnapshot(input);
    const paidAtSource = snapshotPaidAtSource(input, plan);
    if (paidAtSource !== null && before.paid_at_source === null) {
      write.paid_at_source = paidAtSource;
    }
    snapshot = await runCommissionSnapshot(
      trx,
      deps.snapshots,
      plan,
      {
        app_id: before.app_id,
        platform: before.platform,
        sub_order_id: before.sub_order_id,
        order_id: before.order_id,
        raw_status: null,
        raw_payload_id: before.raw_payload_id,
        now,
      },
      undefined,
    );
  }

  // settlement 按 R3 / R3b 写 rebate_status 与 locked；入参是写前快照。
  await deps.rebate.onAdminAssigned(trx, { before, userId, now, snapshot });
  const after = await writeAdminAttribution(trx, before, write, now);
  const statusApplied = same
    ? after.rebate_status === before.rebate_status
    : after.rebate_status !== before.rebate_status;
  if (!after.locked || !statusApplied) {
    throw new Error('orders: settlement did not apply R3 / R3b to the assigned order');
  }
  await insertAdminRebateHistory(trx, before, before.rebate_status, after.rebate_status, now);
  return after;
}

/**
 * BR-ATTR-30（NOT_IN_POOL）：该子订单其他用户的待审找回子项系统驳回（decided_by 为空）；受影响的 claims
 * 一条语句按 id 升序锁住，全部已决的按 summarizeClaimDecisions 汇总。返回本次结案的 claims。
 */
async function rejectOthersPending(
  trx: Transaction<DB>,
  appId: string,
  order: Selectable<DB['orders']>,
  userId: string,
  now: Date,
): Promise<{ claim: ReviewClaimRow; status: ClaimState }[]> {
  const items = await pendingItemsOfOthers(trx, appId, order, userId);
  if (items.length === 0) return [];
  const claimIds = [...new Set(items.map((item) => item.claim_id))].sort();
  const locked = new Map<string, ReviewClaimRow>(
    (await lockClaims(trx, appId, claimIds)).map((row) => [row.id, row]),
  );
  for (const item of items) {
    const moved = transitionClaimItem(null, 'REJECT');
    if (!moved.ok) throw new Error('orders: claim item transition refused');
    const written = await writeItemDecision(trx, {
      appId,
      itemId: item.id,
      claimId: item.claim_id,
      expectedRowVersion: item.row_version,
      decision: moved.to,
      rejectReason: 'NOT_IN_POOL',
      decidedBy: null,
      now,
    });
    if (!written) throw new Error('orders: pending claim item changed under the order lock');
  }
  const resolved: { claim: ReviewClaimRow; status: ClaimState }[] = [];
  for (const claimId of claimIds) {
    const claim = locked.get(claimId);
    if (claim === undefined) throw new Error('orders: affected claim was not locked');
    const event = summarizeClaimDecisions(
      (await claimDecisions(trx, appId, claimId)) as (ClaimItemState | null)[],
    );
    if (event === null) continue;
    const moved = transitionClaim(claim.status as ClaimState, event);
    if (!moved.ok) throw new Error(`orders: claim ${claim.status} cannot take ${event}`);
    await writeClaim(trx, { appId, claimId, fromStatus: claim.status, status: moved.to, now });
    resolved.push({ claim, status: moved.to });
  }
  return resolved;
}
