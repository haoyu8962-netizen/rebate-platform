import { orderKey } from '@couli/domain';
import type { BillSourceRow } from '../job.ts';

// B2-04rd（BR-FUND-04 ④⑦⑧⑫，编排 D10-2679）：补充入批对初判为候选的订单先取订单键锁、锁后经同一来源
// 读口重读，再按重读结果定类别。没取锁的订单在重读里才变成候选的、或只在重读里出现的订单本轮不入批
// （没有锁保护的候选正是本单要消灭的）；B2-04re r2 起没取锁、重读后仍不是候选的订单按平台锁之后的重读定类别。
// 资金评审 r1 S1：候选按订单键升序分块，每块包在一个保存点里——取锁、重读，记下结论后回滚到保存点（PG 随之
// 放掉这块的事务级咨询锁），同一时刻持有的订单键锁不超过一块。保存点内只取锁与读，不写。
// B2-04re：调用方在调用之前已取平台结算互斥锁排他模式（保存点之外、持有到提交），放锁之后同平台的入账明细
// 事务提交不了，所以这里不再查「仍在未执行批次里」，只返回要逐单校验的行。

/**
 * 每块最多同时持有的订单键锁数。技术常量、不是业务取值（不读配置）：远低于 PG 默认共享锁表容量
 * （max_locks_per_transaction 64 × max_connections 100 ≈ 6,400 个槽，与其他会话共用），又让每块一次
 * 全量来源读的次数保持在「候选数 / 500」量级。
 */
export const LOCK_CHUNK = 500;

export interface LockedRecheckPorts {
  /** 取一张订单的订单键锁（事务级咨询锁，普通等待），入参是来源行的订单键。 */
  lock(orderKey: string): Promise<void>;
  /** 再调一次来源读口（同一 selection，截点不变）。 */
  reread(): Promise<readonly BillSourceRow[]>;
  /** 开一块的保存点。 */
  savepoint(): Promise<void>;
  /** 回滚到这块的保存点（放掉这块的锁）并释放该保存点。 */
  rollbackToSavepoint(): Promise<void>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 对 `isCandidate` 为真的行去重、按订单键升序分块（每块 `chunkSize` 个键）。逐块：保存点 → 块内升序逐个取锁 →
 * 重读一次 → 回滚到保存点（含末块：重读完成之后、函数返回之前）。全部块完成后返回要逐单校验的行（顺序同第一次读）：
 * - 已上锁的单换成所在块锁内重读到的行（重读里已不在的，本轮不记结果、不入批）；
 * - 没上锁的单（第一次读里不是候选）：B2-04re r2（BR-FUND-04 ⑫）按取到平台排他锁之后的状态来——用最后一次块内
 *   重读（一定在调用方取到平台排他锁之后）里同键的行替换，但只在替换后它仍不是候选时才替换；替换后会变成候选的、
 *   或重读里已没有这张单的，沿用第一次读的行（没上订单键锁的单绝不能写成首次入账明细）。
 * 没有候选时不开保存点、不取锁，经 `reread` 补做一次来源读（调用方已取到平台排他锁），按同一规则替换。
 * 重读里新出现、第一次读里没有的单一律不理会。
 */
export async function lockAndReread(
  first: readonly BillSourceRow[],
  isCandidate: (row: BillSourceRow) => boolean,
  ports: LockedRecheckPorts,
  chunkSize: number = LOCK_CHUNK,
): Promise<BillSourceRow[]> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('settlement supplement: lock chunk size must be a positive integer');
  }
  const keys = [...new Set(first.filter(isCandidate).map((row) => row.orderKey))].sort(compareText);

  const latest = new Map<string, BillSourceRow>();
  let lastRead: readonly BillSourceRow[];
  if (keys.length === 0) {
    lastRead = await ports.reread();
  } else {
    lastRead = [];
    for (let at = 0; at < keys.length; at += chunkSize) {
      const chunk = keys.slice(at, at + chunkSize);
      const inChunk = new Set(chunk);
      await ports.savepoint();
      for (const key of chunk) await ports.lock(key);
      const second = await ports.reread();
      for (const row of second) {
        if (inChunk.has(row.orderKey) && !latest.has(row.orderKey)) latest.set(row.orderKey, row);
      }
      lastRead = second;
      // 重读已在本块订单键锁内做完，才回滚到保存点放锁；每一块（含最后一块）都回滚。
      await ports.rollbackToSavepoint();
    }
  }

  const afterGate = new Map<string, BillSourceRow>();
  for (const row of lastRead) {
    if (!afterGate.has(row.orderKey)) afterGate.set(row.orderKey, row);
  }
  const locked = new Set(keys);
  const rows: BillSourceRow[] = [];
  for (const row of first) {
    if (!locked.has(row.orderKey)) {
      const again = afterGate.get(row.orderKey);
      rows.push(again !== undefined && !isCandidate(again) ? again : row);
      continue;
    }
    const again = latest.get(row.orderKey);
    if (again !== undefined) rows.push(again);
  }
  return rows;
}

/**
 * 来源行的订单键 = orderKey(platform, sub_order_id)（来源读口按本次的 platform 读）：拆回子订单号，供
 * orders 的 lockOrderKey 用，不读库。拆不回同一个键（平台不符、格式不对）时抛错，不跳过取锁。
 */
export function subOrderIdOf(platform: string, key: string): string {
  const prefix = `${platform}:`;
  if (key.startsWith(prefix)) {
    const subOrderId = key.slice(prefix.length);
    if (subOrderId !== '' && !subOrderId.includes(':') && orderKey(platform, subOrderId) === key) {
      return subOrderId;
    }
  }
  throw new Error('settlement supplement: source order key does not belong to the platform');
}
