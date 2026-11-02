// B1-08h：归因流水线主事务的读写（只写 orders 模块自己的表；一律 .withSchema('app')）。所有函数都
// 在调用方已取得子订单 advisory 锁的事务里运行（infra/order-lock.ts）。
import type { DB } from '@couli/db';
import { sql, type Insertable, type Selectable, type Transaction } from 'kysely';

type Trx = Transaction<DB>;

export interface OrderKeyRow {
  readonly order_id: string;
  readonly app_id: string;
  readonly attr_at: Date;
}

/** order_keys 是全局唯一键 (platform, sub_order_id)；不按 app 过滤，app 冲突由调用方判定。 */
export async function readOrderKey(
  trx: Trx,
  platform: string,
  subOrderId: string,
): Promise<OrderKeyRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('order_keys')
    .select(['order_id', 'app_id', 'attr_at'])
    .where('platform', '=', platform)
    .where('sub_order_id', '=', subOrderId)
    .executeTakeFirst();
}

/** Reads the orders row of an existing key (attr_at in the predicate prunes partitions). */
export async function readOrder(
  trx: Trx,
  key: OrderKeyRow,
): Promise<Selectable<DB['orders']> | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('app_id', '=', key.app_id)
    .executeTakeFirst();
}

export interface DropInput {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly reason: string;
  /** Accounting date YYYY-MM-DD (+08:00). */
  readonly date: string;
}

/**
 * BR-ATTR-02 丢弃计数：drop_keys 已有同键时不计；第一次写入时 drops(app, platform, date, reason)
 * 原子 +1。返回是否第一次写入。
 */
export async function recordDrop(trx: Trx, input: DropInput): Promise<boolean> {
  const app = trx.withSchema('app');
  const inserted = await app
    .insertInto('order_sync_drop_keys')
    .values({
      app_id: input.app_id,
      platform: input.platform,
      sub_order_id: input.sub_order_id,
      reason: input.reason,
    })
    .onConflict((oc) => oc.columns(['app_id', 'platform', 'sub_order_id', 'reason']).doNothing())
    .executeTakeFirst();
  if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) return false;
  await app
    .insertInto('order_sync_drops')
    .values({
      app_id: input.app_id,
      platform: input.platform,
      date: input.date,
      reason: input.reason,
      count: 1n,
    })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'date', 'reason'])
        .doUpdateSet({ count: sql<bigint>`order_sync_drops.count + 1` }),
    )
    .execute();
  return true;
}

export type SyncCounter = 'attr_param_invalid' | 'attr_binding_miss' | 'order_sync_no_mtime';

/** order_sync_counters(app, platform, date, counter) 原子 +1。 */
export async function bumpCounter(
  trx: Trx,
  input: { app_id: string; platform: string; date: string; counter: SyncCounter },
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_sync_counters')
    .values({ ...input, count: 1n })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'date', 'counter'])
        .doUpdateSet({ count: sql<bigint>`order_sync_counters.count + 1` }),
    )
    .execute();
}

/** order_sync_pending.reason 本模块写的取值（db/schema.sql 的 CHECK；快照相关四个为 B1-08k）。 */
export type PendingReason =
  | 'UNMAPPED_STATUS'
  | 'ILLEGAL_TRANSITION'
  | 'NO_RECEIVED_AT'
  | 'SERVICE_FEE_RATE_MISSING'
  | 'RULE_VERSION_PLATFORM_MISSING'
  | 'TLJ_FACE_VALUE_UNMATCHED'
  | 'AMOUNT_PARSE_FAILED'
  | 'ORDER_ROW_INVALID';

export interface PendingInput {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly order_id: string | null;
  readonly reason: PendingReason;
  readonly raw_status: string | null;
  readonly raw_payload_id: bigint | null;
  readonly detected_at: Date;
  /** 判定说明（B1-08i：非法迁移的状态与事件），不含个人信息；同键 open 已存在时不改。 */
  readonly detail?: string | null;
}

export interface PendingWrite {
  /** 该 open 记录的 id（新插入或已存在的那条；B1-08i 的告警事件据此派生事件 ID），驱动未回行时为 null。 */
  readonly id: bigint | null;
  /**
   * B1-04zs：真重复，即同键 open 已存在，且存量行的 raw_status、detail 都与本次写入值相同。新开或任一列不同为
   * false；驱动未回行时无从判断，也为 false，告警宁多不漏。
   */
  readonly repeat: boolean;
}

/**
 * 待处理记录：同键 open 记录已存在时只更新 detected_at（order_sync_pending_open_key）。「真重复」取自同一条语句
 * 的返回值，不先查后写：xmax = 0 只出现在新插入的行上，走 DO UPDATE 的行带着冲突时加的行锁；DO UPDATE 不改
 * raw_status、detail，返回的就是存量值。不用 RETURNING old：那是 PostgreSQL 18 才有的写法，而 ADR-0001 留着
 * 退回 17 的路。
 */
export async function writePending(trx: Trx, input: PendingInput): Promise<PendingWrite> {
  const row = await trx
    .withSchema('app')
    .insertInto('order_sync_pending')
    // B1-08t：新插入行的 created_at 取 Clock（= detected_at），不用库时间；同键冲突只刷新 detected_at。
    .values({ ...input, status: 'open', created_at: input.detected_at })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'sub_order_id', 'reason'])
        .where('status', '=', sql.lit('open'))
        .doUpdateSet((eb) => ({ detected_at: eb.ref('excluded.detected_at') })),
    )
    .returning(['id', 'raw_status', 'detail', sql<boolean>`(xmax = 0)`.as('inserted')])
    .executeTakeFirst();
  const repeat =
    row !== undefined &&
    !row.inserted &&
    row.raw_status === input.raw_status &&
    row.detail === (input.detail ?? null);
  return { id: row?.id ?? null, repeat };
}

/** 同 writePending，只要 open 记录的 id；驱动未回行时为 null。 */
export async function upsertPending(trx: Trx, input: PendingInput): Promise<bigint | null> {
  return (await writePending(trx, input)).id;
}

/**
 * B1-04zv：把同键 open 记录置 resolved（系统解决，resolved_by 为空）。只改 status='open' 的行：已 resolved、
 * dismissed 的不动。没有 open 记录时什么也不写。
 */
export async function resolveOpenPending(
  trx: Trx,
  key: {
    readonly app_id: string;
    readonly platform: string;
    readonly sub_order_id: string;
    readonly reason: PendingReason;
  },
  resolution: { readonly resolved_at: Date; readonly resolution_note: string },
): Promise<void> {
  // 不直接 UPDATE：绝大多数好行没有 open 记录，无事不写，unchanged 路径才是零写入。调用方已持订单 xact 锁，隔离
  // 写入也持同一把锁，同单上先查后写是串行的。
  const open = await trx
    .withSchema('app')
    .selectFrom('order_sync_pending')
    .select('id')
    .where('app_id', '=', key.app_id)
    .where('platform', '=', key.platform)
    .where('sub_order_id', '=', key.sub_order_id)
    .where('reason', '=', key.reason)
    .where('status', '=', 'open')
    .limit(1)
    .executeTakeFirst();
  if (open === undefined) return;
  await trx
    .withSchema('app')
    .updateTable('order_sync_pending')
    .set({ ...resolution, status: 'resolved', resolved_by: null })
    .where('app_id', '=', key.app_id)
    .where('platform', '=', key.platform)
    .where('sub_order_id', '=', key.sub_order_id)
    .where('reason', '=', key.reason)
    .where('status', '=', 'open')
    .execute();
}

/**
 * B1-08k（BR-CALC-11 细则 ③）：该单 order_status_history 里平台状态首条进入 PAID / RECEIVED / SETTLED 的时刻；
 * 没有为 null。
 */
export async function readFirstPaidAt(
  trx: Trx,
  order: { app_id: string; order_id: string },
): Promise<Date | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_status_history')
    .select('at')
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('field', '=', 'platform')
    .where('to_status', 'in', ['PAID', 'RECEIVED', 'SETTLED'])
    .orderBy('at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row?.at ?? null;
}

/** 已有子订单的同步更新（B1-08i）：只插入，不改不删（order_status_history append_only）。 */
export async function insertPlatformHistory(
  trx: Trx,
  order: { app_id: string; order_id: string },
  history: readonly HistoryInput[],
  at: Date,
): Promise<void> {
  for (const step of history) {
    await trx
      .withSchema('app')
      .insertInto('order_status_history')
      .values({
        app_id: order.app_id,
        order_id: order.order_id,
        field: 'platform',
        from_status: step.from_status,
        event: step.event,
        to_status: step.to_status,
        source: 'sync',
        at,
      })
      .execute();
  }
}

export interface HistoryInput {
  readonly from_status: string | null;
  readonly event: string;
  readonly to_status: string;
}

/**
 * 新子订单：先插 order_keys 拿到 order_id，再写分区表 orders（不写 rebate_status，库默认
 * UNATTRIBUTED，settlement 是唯一写者），然后按顺序写 history。
 */
export async function insertImportedOrder(
  trx: Trx,
  key: { platform: string; sub_order_id: string; order_id: string; app_id: string; attr_at: Date },
  order: Omit<Insertable<DB['orders']>, 'rebate_status'>,
  history: readonly HistoryInput[],
  at: Date,
): Promise<void> {
  const app = trx.withSchema('app');
  await app.insertInto('order_keys').values(key).execute();
  await app.insertInto('orders').values(order).execute();
  for (const step of history) {
    await app
      .insertInto('order_status_history')
      .values({
        app_id: key.app_id,
        order_id: key.order_id,
        field: 'platform',
        from_status: step.from_status,
        event: step.event,
        to_status: step.to_status,
        source: 'sync',
        at,
      })
      .execute();
  }
}
