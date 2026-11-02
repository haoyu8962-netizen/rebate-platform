// B1-04zv（BR-CALC-03：字段缺失或非数字 → 进待处理并告警，不生成快照，不按 0 处理；D10-522 ⑤、D10-570）：
// listOrders 单列坏行的去处。适配器把映射失败的行放进 OrderPage.rejected，这里写 order_sync_pending
// （reason=ORDER_ROW_INVALID），订单各列一概不碰；好行照常走流水线，水位照常前进。
// - 每行一个事务，有单号的先取该子订单的 advisory 锁，与流水线串行（orders/AGENTS.md 第 2 条）；order_id 只填
//   同 App 的订单，别的 App 的键留空。无单号的行用适配器算好的 row_key（`row:` + 行内容哈希），同行同键，不取锁
//   （没有订单与它竞争，orderKey 也不收带冒号的键），同键并发由 order_sync_pending_open_key 兜底。单号本身不能
//   作订单键（带冒号、空串）的行同样不取锁、不查 order_keys，order_id 留空：坏行的单号可能就是坏的，抛错会让
//   待处理写不进去，窗口重试到死信；流水线的 orderKey 也拒绝这种单号，库里不会有它的订单。
// - 告警：新开或坏法变了打一条 P1（order_row_invalid）；同键 open 的 raw_status、detail 都相同是真重复，只刷新
//   detected_at、不重打（writePending，B1-04zs）。写失败抛错，任务失败、水位不动。
// - 自动解决：平台改好之后同单再来，流水线在订单入库、更新或确认一致的同一事务里解决 open 记录。`row:` 键
//   不可能等于走到解决这一步的真单号（流水线的 orderKey 拒绝带冒号的单号），只能人工解决。
// 日志只打平铺字段，不打子订单号与金额。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RejectedOrderRow, UnionOrder } from '../../union/index.ts';
import { lockOrderKey, orderLockKeyText } from '../infra/order-lock.ts';
import { readOrderKey, resolveOpenPending, writePending } from '../infra/pipeline-store.ts';
import type {
  OrderPipelineContext,
  OrderPipelineDeps,
  OrderPipelinePort,
  OrderPipelineResult,
} from './pipeline-types.ts';

const ORDER_ROW_INVALID = 'ORDER_ROW_INVALID';

/**
 * 一页没有好行、坏行又不少于这个数，按上游格式变了处理：坏行仍写待处理，但任务抛错、水位不动，保持停摆加告警。
 * 否则格式一变，水位空跑过去，整窗订单都丢进待处理。判的是「这页没有好行」，不是坏行数：有一条好行说明格式没变。
 * 门槛 5 由 D10-570 ⑥ 定：行数更少的全坏页可能只是偶发坏行恰好落在尾页，不足以判断格式变了。页按顺序处理，
 * 第一张全坏页就停住，所以后面不足 5 行的尾页不会让水位越过它。
 */
export const ORDER_ROW_WHOLE_PAGE_MIN = 5;

/** 这些结果说明好行真的入库、更新或与库内一致；丢弃、app_conflict、stale、pending 都不算。 */
export const ROW_INVALID_SETTLED_BY: ReadonlySet<OrderPipelineResult['kind']> = new Set([
  'inserted',
  'updated',
  'unchanged',
]);

/** 判定与取锁同源：lockOrderKey 用的键文本算得出来才算能作订单键，不另写一份规则。 */
function isOrderKeyable(platform: string, subOrderId: string): boolean {
  try {
    orderLockKeyText(platform, subOrderId);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export async function quarantineRows(
  deps: Pick<OrderPipelineDeps, 'db' | 'clock' | 'logger'>,
  rows: readonly RejectedOrderRow[],
  ctx: OrderPipelineContext,
): Promise<void> {
  const { app_id: appId, platform } = ctx;
  for (const row of rows) {
    const { repeat } = await deps.db.transaction().execute(async (trx) => {
      let orderId: string | null = null;
      if (row.sub_order_id !== null && isOrderKeyable(platform, row.sub_order_id)) {
        await lockOrderKey(trx, platform, row.sub_order_id);
        const key = await readOrderKey(trx, platform, row.sub_order_id);
        if (key?.app_id === appId) orderId = key.order_id;
      }
      return writePending(trx, {
        app_id: appId,
        platform,
        sub_order_id: row.row_key,
        order_id: orderId,
        reason: ORDER_ROW_INVALID,
        raw_status: row.raw_status,
        raw_payload_id: row.raw_payload_id === null ? null : BigInt(row.raw_payload_id),
        detected_at: deps.clock.now(),
        detail: row.detail,
      });
    });
    if (!repeat) {
      deps.logger?.error(
        {
          alert: 'P1',
          event: 'order_row_invalid',
          platform,
          app_id: appId,
          reason: ORDER_ROW_INVALID,
          detail: row.detail,
          outcome: 'quarantined',
        },
        'order row refused by the adapter; left in order_sync_pending',
      );
    }
  }
}

/** 没接 quarantine 的流水线收到坏行：任务失败，水位不动，不把行丢掉。 */
export async function quarantineRejected(
  pipeline: OrderPipelinePort,
  rows: readonly RejectedOrderRow[],
  ctx: OrderPipelineContext,
): Promise<void> {
  if (pipeline.quarantine === undefined) throw new Error('order_row_quarantine_unwired');
  await pipeline.quarantine(rows, ctx);
}

/** 在流水线的事务里解决同 (app, platform, 子订单) 的 open 记录；抛错整事务回滚，好行一起撤。 */
export async function resolveRowInvalid(
  trx: Transaction<DB>,
  clock: Clock,
  order: UnionOrder & { readonly sub_order_id: string },
  ctx: OrderPipelineContext,
): Promise<void> {
  const source = ctx.source ?? 'increment';
  await resolveOpenPending(
    trx,
    {
      app_id: ctx.app_id,
      platform: ctx.platform,
      sub_order_id: order.sub_order_id,
      reason: ORDER_ROW_INVALID,
    },
    {
      resolved_at: clock.now(),
      resolution_note: `auto: good row from ${source}, raw_payload_id ${order.raw_payload_id ?? 'none'}`,
    },
  );
}
