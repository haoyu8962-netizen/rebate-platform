import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { CommissionSnapshotCallInput } from '../domain/commission-snapshot.ts';
import {
  planSnapshotRetry,
  resolveRetryPaidAt,
  type SnapshotRetryPlan,
} from '../domain/snapshot-retry.ts';
import { readFirstPaidAt } from './pipeline-store.ts';

/** orders.buy_type 由首次入库写定（BR-ATTR-08，self / share）；别的值是数据损坏，不猜。 */
function orderBuyType(value: string | null): 'self' | 'share' {
  if (value === 'self' || value === 'share') return value;
  throw new Error('ORDER_BUY_TYPE_INVALID: orders.buy_type 不是 self / share');
}

/** 扫描只从持久化订单与状态历史恢复输入，不从夹具或当前报文恢复。
 * 服务费取订单当前列 orders.service_fee_fen（B1-08v，最近一次写库报文原样写入；规则表 serviceFeeDeducted 打开的
 * 平台，即拼多多与淘宝）：N 已是适配器算好的净额（B1-08zh / B1-04zz），这里不再扣；N 为空时该列为空 →
 * SERVICE_FEE_RATE_MISSING，否则 AMOUNT_PARSE_FAILED。platform_modified 缺首次迁移报文时同样 skip，由扫描器记 warn。
 * 佣金基数：结算收入非空取结算、否则预估（BR-CALC-02）；observed 的 paidAt 取状态历史首条到 PAID+ 的时刻。
 * 扫描路径没有推广位场景端口：淘宝单（可能是淘礼金）同样 skip，其余平台按非淘礼金。只读，不写库。
 */
export async function readSnapshotRetryInput(
  trx: Transaction<DB>,
  order: Selectable<DB['orders']>,
  clock: Clock,
): Promise<SnapshotRetryPlan> {
  if (order.user_id === null) {
    throw new Error('SNAPSHOT_RETRY_UNATTRIBUTED: 未归因订单不生成快照');
  }
  const source = order.paid_at_source;
  const firstPaidAt =
    source === 'observed' || source === null ? await readFirstPaidAt(trx, order) : null;
  const paid = resolveRetryPaidAt({
    paidAtSource: source,
    paidAt: order.paid_at,
    depositPaidAt: order.deposit_paid_at,
    firstPaidAt,
    now: clock.now(),
  });
  return planSnapshotRetry({
    order: {
      app_id: order.app_id,
      order_id: order.order_id,
      platform: order.platform as CommissionSnapshotCallInput['platform'],
      buy_type: orderBuyType(order.buy_type),
      activity_type: order.activity_type,
      est_commission_fen: order.est_commission_fen,
      settle_commission_fen: order.settle_commission_fen,
      subsidy_commission_fen: order.subsidy_commission_fen,
    },
    ownerUserId: order.user_id,
    paid,
    serviceFeeFen: order.service_fee_fen ?? 'unknown',
    pidScene: 'unknown',
  });
}
