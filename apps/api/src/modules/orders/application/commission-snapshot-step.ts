// B1-08k：归因流水线第 ⑥ 步「分佣快照调用」的执行（BR-ATTR-01 ⑥、BR-CALC-10）。首次入库
// （pipeline-port.ts）与已有订单更新（update-step.ts）共用：在调用方已取子订单锁的同一事务里，按纯判定
// （domain/commission-snapshot.ts）的结果调用注入的 commission 快照端口。
// - skip → 'none'；计划 pending（金额全空 / 拼多多服务费缺失）→ 不调端口，写 order_sync_pending 并告警。
// - 端口 created / existing 原样交 settlement；端口 pending（无已发布版本、缺平台规则或预留）→ 写
//   RULE_VERSION_PLATFORM_MISSING 待处理并告警，订单照常提交；端口抛错不吞，整事务回滚（本页重试）。
// - 淘礼金面额未匹配（BR-CALC-19）：照常调端口（rebate_mode=none、红包面额空，D10-68），另写
//   TLJ_FACE_VALUE_UNMATCHED 待处理并告警。
// - 待处理同键 open 已存在时只刷新 detected_at（upsertPending）。不实现自动重试（D10-68 待裁定）。
// - B2-03q（D10-568）：created 后保持「commission_version ≥ 1 时该版本一定有金额行」：版本 0 同事务置 1；已 ≥ 1 的
//   经端口 refresh 写当前版本的行。existing / pending / skip 不动；端口没有 refresh（只有 create 的假端口）也不动。
// 日志只打平铺字段（platform、app_id、reason、outcome），不打子订单号、用户与买家参数。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type {
  CommissionSnapshotCallInput,
  CommissionSnapshotPlan,
} from '../domain/commission-snapshot.ts';
import { upsertPending, type PendingReason } from '../infra/pipeline-store.ts';
import type { SyncLogger } from './sync-ports.ts';

/** 交给 settlement 的快照结果（ImportedOrder.snapshot / OrderUpdateChange.snapshot）。 */
export type SnapshotOutcome = 'created' | 'existing' | 'pending' | 'none';

/** commission 快照端口返回值里本模块用到的部分（与 CreateCommissionSnapshotResult 结构兼容）。 */
export type CommissionSnapshotPortResult =
  { readonly kind: 'created' | 'existing' } | { readonly kind: 'pending'; readonly reason: string };

/**
 * commission 的快照端口（B2-03g `createCommissionSnapshot(trx, input, deps)`；装配为
 * `{ create: (trx, i) => createCommissionSnapshot(trx, i, commissionDeps) }`）。只用调用方事务；
 * 未注入时第 ⑥ 步整步跳过。生产装配用 commission 的 createCommissionSnapshotPort，带 refresh。
 */
export interface CommissionSnapshotPort {
  create(
    trx: Transaction<DB>,
    input: CommissionSnapshotCallInput,
  ): Promise<CommissionSnapshotPortResult>;
  /** D10-568：写订单当前版本的金额行与 totals，该版本已有行就不写。 */
  refresh?(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string; readonly attrAt: Date },
  ): Promise<void>;
}

export interface SnapshotStepContext {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly order_id: string;
  readonly raw_status: string | null;
  readonly raw_payload_id: bigint | null;
  readonly now: Date;
}

const DETAIL_PREFIX = 'commission_snapshot';

export async function runCommissionSnapshot(
  trx: Transaction<DB>,
  port: CommissionSnapshotPort,
  plan: CommissionSnapshotPlan,
  ctx: SnapshotStepContext,
  log: SyncLogger | undefined,
): Promise<SnapshotOutcome> {
  if (plan.kind === 'skip') return 'none';
  const base = { platform: ctx.platform, app_id: ctx.app_id };
  if (plan.kind === 'pending') {
    await pending(trx, ctx, plan.reason, `${DETAIL_PREFIX} ${plan.reason}`);
    log?.warn(
      { ...base, reason: plan.reason, outcome: 'snapshot_pending' },
      'commission snapshot not requested; order kept in sync pending',
    );
    return 'pending';
  }
  const result = await port.create(trx, plan.input);
  if (plan.input.tljRedpacketFen === null) {
    await pending(
      trx,
      ctx,
      'TLJ_FACE_VALUE_UNMATCHED',
      `${DETAIL_PREFIX} tlj face value unmatched`,
    );
    log?.warn(
      { ...base, reason: 'TLJ_FACE_VALUE_UNMATCHED', outcome: 'snapshot_rebate_none' },
      'taolijin face value unmatched; snapshot uses rebate_mode none',
    );
  }
  if (result.kind === 'pending') {
    await pending(trx, ctx, 'RULE_VERSION_PLATFORM_MISSING', `${DETAIL_PREFIX} ${result.reason}`);
    log?.warn(
      { ...base, reason: 'RULE_VERSION_PLATFORM_MISSING', outcome: 'snapshot_pending' },
      'commission snapshot pending; order kept in sync pending',
    );
    return 'pending';
  }
  if (result.kind === 'created') await settleVersion(trx, port, ctx);
  return result.kind;
}

/**
 * row_version 不动：settlement 的 R3 按调用方写前读到的 row_version 做 CAS；本语句靠 commission_version = 0
 * 自己的乐观锁，调用方持有子订单锁，同步写版本号的路径都在锁内。
 */
async function settleVersion(
  trx: Transaction<DB>,
  port: CommissionSnapshotPort,
  ctx: SnapshotStepContext,
): Promise<void> {
  if (port.refresh === undefined) return;
  const app = trx.withSchema('app');
  const { attr_at: attrAt } = await app
    .selectFrom('order_keys')
    .select('attr_at')
    .where('app_id', '=', ctx.app_id)
    .where('order_id', '=', ctx.order_id)
    .executeTakeFirstOrThrow();
  const moved = await app
    .updateTable('orders')
    .set({ commission_version: 1, updated_at: ctx.now })
    .where('app_id', '=', ctx.app_id)
    .where('order_id', '=', ctx.order_id)
    .where('attr_at', '=', attrAt)
    .where('commission_version', '=', 0)
    .executeTakeFirst();
  if (moved.numUpdatedRows > 0n) return;
  await port.refresh(trx, { appId: ctx.app_id, orderId: ctx.order_id, attrAt });
}

async function pending(
  trx: Transaction<DB>,
  ctx: SnapshotStepContext,
  reason: PendingReason,
  detail: string,
): Promise<void> {
  await upsertPending(trx, {
    app_id: ctx.app_id,
    platform: ctx.platform,
    sub_order_id: ctx.sub_order_id,
    order_id: ctx.order_id,
    reason,
    raw_status: ctx.raw_status,
    raw_payload_id: ctx.raw_payload_id,
    detected_at: ctx.now,
    detail,
  });
}
