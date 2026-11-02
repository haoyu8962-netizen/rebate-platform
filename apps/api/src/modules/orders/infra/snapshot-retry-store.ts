// B1-08t：快照类待处理行的读写（order_sync_pending，写者 orders）。读写都在调用方已取子订单锁的事务里；
// 只有候选扫描与 App 列表不取锁（锁内另行重读）。只改 status / resolved_* / resolution_note，不删行。
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  PID_SCENE_PLATFORM,
  SNAPSHOT_RETRY_DUE_MS,
  SNAPSHOT_RETRY_HANDOFF_NOTE,
  SNAPSHOT_RETRY_REASONS,
  snapshotResolutionNote,
} from '../domain/snapshot-retry.ts';

type Trx = Transaction<DB>;

export interface SubOrderRef {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
}

export type SnapshotPendingRow = Pick<
  Selectable<DB['order_sync_pending']>,
  'id' | 'reason' | 'detected_at' | 'created_at' | 'resolution_note'
>;

/** 该子订单 open 的快照类待处理行（不看 order_id、不看 detail），按 created_at、id 升序。 */
export async function readOpenSnapshotRows(
  trx: Trx,
  ref: SubOrderRef,
): Promise<SnapshotPendingRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('order_sync_pending')
    .select(['id', 'reason', 'detected_at', 'created_at', 'resolution_note'])
    .where('app_id', '=', ref.app_id)
    .where('platform', '=', ref.platform)
    .where('sub_order_id', '=', ref.sub_order_id)
    .where('status', '=', 'open')
    .where('reason', 'in', SNAPSHOT_RETRY_REASONS)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export function isHandedOff(rows: readonly SnapshotPendingRow[]): boolean {
  return rows.some((row) => row.resolution_note === SNAPSHOT_RETRY_HANDOFF_NOTE);
}

/** 快照 created / existing：同一事务把该子订单全部 open 快照类行置为系统处置（resolved_by 为空）。 */
export async function resolveSnapshotRows(
  trx: Trx,
  ref: SubOrderRef,
  outcome: 'created' | 'existing',
  now: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('order_sync_pending')
    .set({
      status: 'resolved',
      resolved_at: now,
      resolved_by: null,
      resolution_note: snapshotResolutionNote(outcome),
    })
    .where('app_id', '=', ref.app_id)
    .where('platform', '=', ref.platform)
    .where('sub_order_id', '=', ref.sub_order_id)
    .where('status', '=', 'open')
    .where('reason', 'in', SNAPSHOT_RETRY_REASONS)
    .execute();
}

/** 满 24 小时仍失败：行保持 open 留给后台人工处置，只记转人工标记，此后不再自动重试。 */
export async function markSnapshotHandoff(trx: Trx, ref: SubOrderRef): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('order_sync_pending')
    .set({ resolution_note: SNAPSHOT_RETRY_HANDOFF_NOTE })
    .where('app_id', '=', ref.app_id)
    .where('platform', '=', ref.platform)
    .where('sub_order_id', '=', ref.sub_order_id)
    .where('status', '=', 'open')
    .where('reason', 'in', SNAPSHOT_RETRY_REASONS)
    .execute();
}

/** 按子订单键读订单行（扫描路径锁内重读）。 */
export async function readOrderByKey(
  trx: Trx,
  ref: SubOrderRef,
): Promise<Selectable<DB['orders']> | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', ref.app_id)
    .where('platform', '=', ref.platform)
    .where('sub_order_id', '=', ref.sub_order_id)
    .executeTakeFirst();
}

/**
 * 扫描必然 skip 的单（B1-08v，待编排裁定 3）：与 domain isScanSkipCertain 同口径，两处须同改。每个子订单只连到一行
 * orders；表达式里每一项都不为 NULL（is not distinct from / is not null），外层再 coalesce，避免 NULL 排序。
 */
const SCAN_SKIP_CERTAIN = sql<boolean>`coalesce(bool_or(
  coalesce(o.settle_commission_fen, o.est_commission_fen) is not null and (
    (o.paid_at_source is not distinct from 'platform' and o.paid_at is null)
    or (o.paid_at_source is not null and o.paid_at_source not in ('platform', 'observed'))
    or o.platform = ${PID_SCENE_PLATFORM}
  )
), false)`;

/**
 * 一轮扫描的候选子订单：同 App、open 快照类行最晚一次 detected_at ≤ now − 1 小时、未转人工，订单当前满足 ⑥
 * 资格（不满足的留后台人工处置，不占批量名额）；扫描必然 skip 的单（拼多多服务费列为空、paidAt 不可恢复、淘宝）排在
 * 末尾（B1-08v：skip 不刷新 detected_at，排在前面会占满每轮名额、饿死后面的订单），其余按最早 detected_at、最小 id
 * 升序，至多 limit 个。锁内另行重读。
 */
export async function selectDueSubOrders(
  db: Kysely<DB>,
  appId: string,
  now: Date,
  limit: number,
): Promise<SubOrderRef[]> {
  // 到期阈值 now − 1 小时在库里算（应用代码不构造 Date）；now 来自注入的 Clock。
  const threshold = sql<Date>`${now}::timestamptz - make_interval(secs => ${SNAPSHOT_RETRY_DUE_MS / 1000})`;
  const rows = await db
    .withSchema('app')
    .selectFrom('order_sync_pending as p')
    .innerJoin('orders as o', (join) =>
      join
        .onRef('o.app_id', '=', 'p.app_id')
        .onRef('o.platform', '=', 'p.platform')
        .onRef('o.sub_order_id', '=', 'p.sub_order_id'),
    )
    .select(['p.platform', 'p.sub_order_id'])
    .where('p.app_id', '=', appId)
    .where('p.status', '=', 'open')
    .where('p.reason', 'in', SNAPSHOT_RETRY_REASONS)
    .where('o.user_id', 'is not', null)
    .where('o.platform_status', 'in', ['PAID', 'RECEIVED', 'SETTLED'])
    .where('o.rebate_status', 'not in', ['VOID', 'CLAWED_BACK'])
    .groupBy(['p.platform', 'p.sub_order_id'])
    .having((eb) => eb.fn.max('p.detected_at'), '<=', threshold)
    .having(
      sql<boolean>`bool_and(p.resolution_note is distinct from ${SNAPSHOT_RETRY_HANDOFF_NOTE})`,
      '=',
      true,
    )
    .orderBy(SCAN_SKIP_CERTAIN)
    .orderBy((eb) => eb.fn.min('p.detected_at'))
    .orderBy((eb) => eb.fn.min('p.id'))
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    app_id: appId,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
  }));
}

/** 有 open 快照类行的 App（定时器按 App 投递扫描任务）。 */
export async function listSnapshotRetryAppIds(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('order_sync_pending')
    .select('app_id')
    .distinct()
    .where('status', '=', 'open')
    .where('reason', 'in', SNAPSHOT_RETRY_REASONS)
    .orderBy('app_id')
    .execute();
  return rows.map((row) => row.app_id);
}

/** 库内 paid_at_source 为空时照 B1-08k 写入（已有值不覆盖）；不改 paid_at。 */
export async function writePaidAtSource(
  trx: Trx,
  order: { app_id: string; order_id: string; attr_at: Date },
  source: string,
  now: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('orders')
    .set((eb) => ({
      paid_at_source: source,
      row_version: eb('row_version', '+', 1),
      updated_at: now,
    }))
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('attr_at', '=', order.attr_at)
    .where('paid_at_source', 'is', null)
    .execute();
}
