// B1-10k：后台找回审核的写入用例——子项通过 / 驳回（BR-ATTR-30、BR-ATTR-20、BR-ATTR-32；契约
// adminApproveClaimItem / adminRejectClaimItem）。本文件只给应用服务；路由由 B1-10m 的
// http/admin/claim-review.controller.ts 挂在 admin 入口，settlement 端口由 app.module 注入真实现。
// 事务（一次审核一个事务）：
//   ① 首句取子订单 advisory 锁（与同步、管理员指派同一把，order-lock.ts），再 SELECT … FOR UPDATE 重读订单；
//   ② 按重读结果判定（domain/claim-review.ts）；通过且成立时找出同子订单他人待审子项；
//   ③ 一条语句按 claim id 升序 FOR UPDATE 锁住全部受影响的 claims，锁内重读被审子项做 CAS（20902 claim_item）；
//   ④ 通过成立：来源回填（BR-ATTR-15）→ 分佣快照（B1-08k 的 runCommissionSnapshot，未注入端口记 none）→
//      settlement 端口 rebate.onClaimApproved（写前快照入参；locked 与 rebate_status 由端口按 R3 写）→
//      orders 写 user_id / user_basis=claim（端口之后，取回端口写后的 rebate_status 记历史，不另读）→
//      order_status_history(field=rebate, source=claim)；他人待审子项系统驳回 NOT_IN_POOL；
//   ⑤ 子项决定（生成的 transitionClaimItem），各受影响 claim 全部已决时汇总（summarizeClaimDecisions +
//      transitionClaim）；被审子项所属 claim 写最新说明；审计（审计写入器绑本事务、要写时才构造）；
//      每个本次结案的 claim 在本事务内入队 claim.resolved（载荷 {claim_id, app_id, user_id, status}，规划未定）。
// 端口、审计、事件任一失败都原样抛出，整事务回滚。审核结果通知申请人（CLAIM_RESULT）由 claim.resolved 的
// 消费端承接，不在本任务。
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  summarizeClaimDecisions,
  transitionClaim,
  transitionClaimItem,
  type ClaimItemState,
  type ClaimState,
} from '@couli/domain';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus } from '../../platform/index.ts';
import {
  isRegisteredPlatform,
  type RegisteredPlatform,
  type UnionOrder,
} from '../../union/index.ts';
import { isUuid } from '../domain/admin-claim-view.ts';
import {
  decideClaimReview,
  claimSnapshotInput,
  isStaffRejectReason,
  normalizeReviewReason,
  type ClaimReviewMode,
  type ClaimReviewOutcome,
  type StaffRejectReason,
} from '../domain/claim-review.ts';
import { planCommissionSnapshot, snapshotPaidAtSource } from '../domain/commission-snapshot.ts';
import { platformRules, type ItemIdField } from '../domain/platform-rules/index.ts';
import { createAdminClaimReads } from '../infra/admin-claim-reads.ts';
import {
  claimDecisions,
  findReviewClaim,
  findReviewItem,
  insertClaimRebateHistory,
  lockClaims,
  lockOrderRow,
  pendingSiblingItems,
  readItem,
  writeClaim,
  writeClaimAttribution,
  writeItemDecision,
  type OrderAttributionWrite,
  type ReviewClaimRow,
  type ReviewItemRow,
} from '../infra/claim-review-store.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { readFirstPaidAt } from '../infra/pipeline-store.ts';
import { AdminClaims, type AdminClaimPorts } from './admin-claims.ts';
import {
  runCommissionSnapshot,
  type CommissionSnapshotPort,
  type SnapshotOutcome,
} from './commission-snapshot-step.ts';
import { backfillOrderSource, sourceColumns, type OrderSourcePorts } from './source-backfill.ts';

export interface ClaimReviewActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ClaimReviewCommand {
  readonly claimId: string;
  readonly itemId: string;
  readonly expected_row_version: number;
  readonly reason: string;
}

export interface ClaimRejectCommand extends ClaimReviewCommand {
  // Accept runtime input here so system-only / unknown codes can be refused with 20001.
  readonly reject_reason: string;
}

export interface ClaimApprovedInput {
  /** Immutable snapshot from SELECT FOR UPDATE, before orders writes attribution. */
  readonly before: Selectable<DB['orders']>;
  readonly userId: string;
  readonly now: Date;
  readonly snapshot: SnapshotOutcome;
}

export interface ClaimReviewDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly details: AdminClaimPorts;
  readonly events: Pick<EventBus, 'publish'>;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  // Settlement alone writes locked and rebate_status (B2-04la's attribution port).
  readonly rebate: {
    onClaimApproved(trx: Transaction<DB>, input: ClaimApprovedInput): Promise<void>;
  };
  readonly snapshots?: CommissionSnapshotPort;
  readonly sources?: OrderSourcePorts;
  readonly pidScene?: (order: Selectable<DB['orders']>) => Promise<string | null>;
  // 给了就在本事务句柄上读（优先于 sources / pidScene）：持锁的事务不再占一条连接等第二条，
  // 连接池耗尽时不互相死等（B1-10m money r1）。
  readonly sourcesOn?: (trx: Transaction<DB>) => OrderSourcePorts;
  readonly pidSceneOn?: (trx: Transaction<DB>) => NonNullable<ClaimReviewDeps['pidScene']>;
}

export type ClaimReviewResult =
  | { readonly code: 0; readonly data: Schema<'AdminClaimDetail'> }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20902; readonly data: { readonly resource: 'claim_item' } };

const STALE: ClaimReviewResult = { code: 20902, data: { resource: 'claim_item' } };

/** Operational failures propagate and roll back, including audit / event / port failures. */
export async function approveClaimItem(
  deps: ClaimReviewDeps,
  actor: ClaimReviewActor,
  command: ClaimReviewCommand,
): Promise<ClaimReviewResult> {
  return review(deps, actor, command, 'approve', null);
}

export async function rejectClaimItem(
  deps: ClaimReviewDeps,
  actor: ClaimReviewActor,
  command: ClaimRejectCommand,
): Promise<ClaimReviewResult> {
  return review(deps, actor, command, 'reject', command.reject_reason);
}

async function review(
  deps: ClaimReviewDeps,
  actor: ClaimReviewActor,
  command: ClaimReviewCommand,
  mode: ClaimReviewMode,
  requestedRaw: string | null,
): Promise<ClaimReviewResult> {
  // 输入校验：说明去首尾空白后 5～200 字；驳回原因只收六个客服码。全部在读库之前。
  const note = normalizeReviewReason(command.reason);
  const refused: string[] = [];
  if (note === null) refused.push('reason');
  let requested: StaffRejectReason | null = null;
  if (mode === 'reject') {
    if (isStaffRejectReason(requestedRaw)) requested = requestedRaw;
    else refused.push('reject_reason');
  }
  if (refused.length > 0 || note === null) return { code: 20001, data: { fields: refused } };

  const { appId } = actor;
  if (!isUuid(command.claimId)) return { code: 20001, data: { fields: ['claim_id'] } };
  const claim = await findReviewClaim(deps.db, appId, command.claimId);
  if (claim === undefined) return { code: 20001, data: { fields: ['claim_id'] } };
  if (!isUuid(command.itemId)) return { code: 20001, data: { fields: ['item_id'] } };
  const target = await findReviewItem(deps.db, appId, claim.id, command.itemId);
  if (target === undefined) return { code: 20001, data: { fields: ['item_id'] } };
  if (!pendingAt(target, command.expected_row_version)) return STALE;

  const committed = await deps.db.transaction().execute((trx) =>
    reviewInTransaction(deps, trx, actor, {
      mode,
      note,
      requested,
      target,
      expected: command.expected_row_version,
    }),
  );
  if (committed === 'stale') return STALE;
  const detail = await new AdminClaims({
    reads: createAdminClaimReads(deps.db),
    ...deps.details,
  }).detail(appId, claim.id, undefined);
  return { code: 0, data: detail };
}

function pendingAt(item: ReviewItemRow, expected: number): boolean {
  return item.decision === null && item.row_version === expected;
}

interface ReviewRequest {
  readonly mode: ClaimReviewMode;
  readonly note: string;
  readonly requested: StaffRejectReason | null;
  readonly target: ReviewItemRow;
  readonly expected: number;
}

async function reviewInTransaction(
  deps: ClaimReviewDeps,
  trx: Transaction<DB>,
  actor: ClaimReviewActor,
  request: ReviewRequest,
): Promise<'done' | 'stale'> {
  const { appId } = actor;
  const { target } = request;
  // ① 首句子订单锁，再 FOR UPDATE 重读订单（BR-ATTR-20 ①）。
  await lockOrderKey(trx, target.platform, target.sub_order_id);
  const order = await lockOrderRow(trx, appId, target.order_id);
  if (order === undefined) throw new Error('orders: claim item names no order of its app');
  const now = deps.clock.now();

  // ② 判定（通过：已归属 → BR-ATTR-32 结案；VOID → ORDER_INVALID；驳回：VOID → ORDER_INVALID）。
  const outcome = decideClaimReview(
    request.mode,
    order,
    target.applicant_user_id,
    request.requested,
  );
  const siblings = outcome.attribute ? await pendingSiblingItems(trx, appId, target) : [];

  // ③ 一次按 id 升序锁住全部受影响的 claims，锁内重读被审子项（CAS）。
  const claimIds = [...new Set([target.claim_id, ...siblings.map((s) => s.claim_id)])].sort();
  const locked = new Map<string, ReviewClaimRow>(
    (await lockClaims(trx, appId, claimIds)).map((row) => [row.id, row]),
  );
  const current = await readItem(trx, appId, target.id);
  if (current === undefined || !pendingAt(current, request.expected)) return 'stale';

  // ④ 通过成立：归属写入（快照、settlement、orders 列、历史、来源回填）。
  if (outcome.attribute) {
    await attribute(deps, trx, order, target.applicant_user_id, now);
  }

  // ⑤ 子项决定与汇总。
  const decision = itemDecision(outcome);
  await decideItem(trx, appId, current, request.expected, {
    decision,
    rejectReason: outcome.rejectReason,
    decidedBy: outcome.byReviewer ? actor.adminId : null,
    now,
  });
  const touched = new Set<string>([target.claim_id]);
  for (const sibling of siblings) {
    const moved = transitionClaimItem(null, 'REJECT');
    if (!moved.ok) throw new Error('orders: claim item transition refused');
    const written = await writeItemDecision(trx, {
      appId,
      itemId: sibling.id,
      claimId: sibling.claim_id,
      expectedRowVersion: sibling.row_version,
      decision: moved.to,
      rejectReason: 'NOT_IN_POOL',
      decidedBy: null,
      now,
    });
    if (!written) throw new Error('orders: pending claim item changed under the order lock');
    touched.add(sibling.claim_id);
  }

  const resolved: { claim: ReviewClaimRow; status: ClaimState }[] = [];
  for (const claimId of [...touched].sort()) {
    const claim = locked.get(claimId);
    if (claim === undefined) throw new Error('orders: affected claim was not locked');
    const event = summarizeClaimDecisions(
      (await claimDecisions(trx, appId, claimId)) as (ClaimItemState | null)[],
    );
    let status: ClaimState | undefined;
    if (event !== null) {
      const moved = transitionClaim(claim.status as ClaimState, event);
      if (!moved.ok) throw new Error(`orders: claim ${claim.status} cannot take ${event}`);
      status = moved.to;
      resolved.push({ claim, status });
    }
    const own = claimId === target.claim_id;
    if (own || status !== undefined) {
      await writeClaim(trx, {
        appId,
        claimId,
        fromStatus: claim.status,
        ...(status === undefined ? {} : { status }),
        ...(own ? { reason: request.note } : {}),
        now,
      });
    }
  }

  // 审计：审计写入器在要写时才构造（20902 等早退分支不构造）。
  await deps.auditOn(trx).append({
    appId,
    actor: actor.adminId,
    action: request.mode === 'approve' ? 'claim_item_approve' : 'claim_item_reject',
    target: `claim_items:${target.id}`,
    before: { decision: null, row_version: request.expected },
    after: {
      reason: request.note,
      ...(request.mode === 'reject' ? { requested_reject_reason: request.requested } : {}),
      decision,
      reject_reason: outcome.rejectReason,
      ...(outcome.attribute ? { user_id: target.applicant_user_id } : {}),
    },
    ip: actor.ip,
  });

  for (const { claim, status } of resolved) {
    await deps.events.publish(trx, {
      appId,
      name: 'claim.resolved',
      payload: { claim_id: claim.id, app_id: appId, user_id: claim.user_id, status },
    });
  }
  return 'done';
}

function itemDecision(outcome: ClaimReviewOutcome): ClaimItemState {
  const moved = transitionClaimItem(null, outcome.event);
  if (!moved.ok) throw new Error('orders: claim item transition refused');
  return moved.to;
}

async function decideItem(
  trx: Transaction<DB>,
  appId: string,
  item: ReviewItemRow,
  expected: number,
  write: {
    decision: ClaimItemState;
    rejectReason: string | null;
    decidedBy: string | null;
    now: Date;
  },
): Promise<void> {
  const written = await writeItemDecision(trx, {
    appId,
    itemId: item.id,
    claimId: item.claim_id,
    expectedRowVersion: expected,
    ...write,
  });
  if (!written) throw new Error('orders: claim item changed under its claim lock');
}

/** BR-ATTR-20 ③（找回通过）：顺序见文件头 ④。 */
async function attribute(
  deps: ClaimReviewDeps,
  trx: Transaction<DB>,
  before: Selectable<DB['orders']>,
  userId: string,
  now: Date,
): Promise<void> {
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

  // 分佣快照（BR-ATTR-01 ⑥，经 B1-08k 的步骤）；未注入端口记 none。
  let snapshot: SnapshotOutcome = 'none';
  if (deps.snapshots !== undefined) {
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

  // settlement 按 R3 写 rebate_status 与 locked；入参是写前快照。
  await deps.rebate.onClaimApproved(trx, { before, userId, now, snapshot });
  const after = await writeClaimAttribution(trx, before, write, now);
  if (!after.locked || after.rebate_status === before.rebate_status) {
    throw new Error('orders: settlement did not apply R3 to the claimed order');
  }
  await insertClaimRebateHistory(trx, before, before.rebate_status, after.rebate_status, now);
}

/** 来源回填的商品键：库内 product_key 优先（首次入库已按 BR-PROD-03 推导），否则交端口推导。 */
export function storedSourcePorts(
  ports: OrderSourcePorts,
  order: Selectable<DB['orders']>,
): OrderSourcePorts {
  const stored = order.product_key;
  const { linkByCode, clickCode, windowHours, sourceConfig } = ports;
  return {
    linkLogs: (input) => ports.linkLogs(input),
    productKey: async (input) =>
      stored !== null && stored !== '' ? stored : ports.productKey(input),
    ...(linkByCode === undefined ? {} : { linkByCode: (input) => linkByCode.call(ports, input) }),
    ...(clickCode === undefined ? {} : { clickCode: (p) => clickCode.call(ports, p) }),
    ...(windowHours === undefined ? {} : { windowHours: () => windowHours.call(ports) }),
    ...(sourceConfig === undefined
      ? {}
      : { sourceConfig: (appId, p) => sourceConfig.call(ports, appId, p) }),
  };
}

/** 由库内订单行还原回填要读的报文字段（订单参数、推广位、商品 ID、店铺）；本次没有新报文。 */
export function storedUnionOrder(
  order: Selectable<DB['orders']>,
  platform: RegisteredPlatform,
): UnionOrder {
  // 商品 ID 只填该平台的那一个字段（规则表 itemIdField）。
  const item: Partial<Record<ItemIdField, string>> = {};
  item[platformRules(platform).itemIdField] = order.raw_item_id;
  return {
    platform,
    ...item,
    order_id: order.sub_order_id,
    paid_fen: order.pay_amount_fen ?? 0n,
    commission_fen: order.est_commission_fen ?? 0n,
    sub_order_id: order.sub_order_id,
    parent_order_id: order.parent_order_id,
    promotion_slot: order.pid,
    attr_params: {
      relation_id: order.relation_id,
      custom_parameters: order.custom_params,
      sub_union_id: order.sub_union_id,
    },
    shop_id: order.shop_id,
  };
}
