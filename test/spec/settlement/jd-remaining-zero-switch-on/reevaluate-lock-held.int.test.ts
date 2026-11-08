// B2-04zzk 收紧 B2-04zzh 的一次性重评（FU-B204ZZH-LOCK-TEST，D10-956 / D10-972；任务书 §9.2）：apply 逐单独立事务里
// 锁内重读候选时，订单键锁（orders lockOrderKey：pg_advisory_xact_lock(hashtextextended(orderLockKeyText('jd',
// sub_order_id), 0))）确实被该事务持有。#12 的并发改动发生在候选读出之后、逐单事务之前，「事务内重读但不取锁」也能过；
// 本用例在逐单事务里重读该单 orders 行的查询返回之后，经另一条连接（control 池的单连接，不在事务里）
// pg_try_advisory_xact_lock 同一键：持锁时得 false；去掉 lockOrderKey（或先读后锁）则得 true，用例变红。
// 另一会话上的 xact 锁随该语句的隐式事务结束释放，探测不会留下锁；同一会话重入会得 true，故 false 也证明是另一会话持锁。
// Task-local AC labels ([AC-B2-04zzk#n]) identify this task's acceptance points, not business rules.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin, type QueryId } from 'kysely';
import { expect, it } from 'vitest';
import { orderLockKeyText } from '../../../../apps/api/src/modules/orders/index.ts';
import { SWITCH, TIMEOUT, databaseFixture, withWorker, type App, type Worker } from './kit.ts';
import { candidates, passCaches, reevaluationOn, type Candidate } from './reevaluate-kit.ts';

const p = databaseFixture(createTestDatabase);

/** A statement that reads the orders table (its own FROM, not a table whose name starts so). */
const ORDERS_READ = /^\s*(?:select|with)\b[\s\S]*\bfrom\s+(?:"?\w+"?\.)?"?orders"?(?=[\s,)]|$)/i;

interface Probe {
  readonly orderId: string;
  readonly got: boolean;
}

/** Whether `other` (a connection outside any explicit transaction) could take the order key now. */
async function tryOrderLock(other: Kysely<DB>, subOrderId: string): Promise<boolean> {
  const lockText = orderLockKeyText('jd', subOrderId);
  const { rows } = await sql<{
    got: boolean;
  }>`select pg_try_advisory_xact_lock(hashtextextended(${lockText}, 0)) as got`.execute(other);
  expect(rows, 'the probe returns one row').toHaveLength(1);
  return rows[0]!.got;
}

/**
 * On the service's handle: a statement reading orders whose parameters carry one candidate's order_id
 * (the per-order re-read; apply's candidate list filters by app and platform, never by order_id) is
 * marked; once it returns that one row, `other` probes the candidate's order key. Once per candidate.
 */
function lockProbe(
  plain: Kysely<DB>,
  other: Kysely<DB>,
  subOrderIds: ReadonlyMap<string, string>,
): { readonly plugin: KyselyPlugin; readonly probes: Probe[] } {
  const reads = new Map<QueryId, string>();
  const probes: Probe[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const compiled = plain.getExecutor().compileQuery(node, queryId);
      if (ORDERS_READ.test(compiled.sql)) {
        const orderId = [...subOrderIds.keys()].find((id) => compiled.parameters.includes(id));
        if (orderId !== undefined) reads.set(queryId, orderId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      const orderId = reads.get(queryId);
      reads.delete(queryId);
      if (orderId === undefined || probes.some((probe) => probe.orderId === orderId)) return result;
      const rows = result.rows as readonly { readonly order_id?: unknown }[];
      if (rows.length !== 1 || rows[0]!.order_id !== orderId) return result;
      const subOrderId = subOrderIds.get(orderId)!;
      probes.push({ orderId, got: await tryOrderLock(other, subOrderId) });
      return result;
    },
  };
  return { plugin, probes };
}

/** #8's void of one candidate: VOID, reason REFUND, one order.invalidated, one audit_logs row. */
async function expectVoided(w: Worker, app: App, { order, from }: Candidate): Promise<void> {
  const row = await order.row();
  expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
  const voids = await order.voids();
  expect(voids).toHaveLength(1);
  expect(voids[0]).toMatchObject({
    from_status: from,
    event: 'PLATFORM_INVALID',
    to_status: 'VOID',
  });
  const events = await order.invalidated();
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({ order_id: row.order_id, reason: 'REFUND' });
  const own = (await w.auditsOf(app)).filter((a) => a.target === `orders:${row.order_id}`);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({ admin_id: app.adminId });
}

it(
  '[AC-B2-04zzk#1] 开关开、3 张候选 apply：逐单事务里重读该单 orders 行返回之后，另一条连接 pg_try_advisory_xact_lock 同一订单键（orderLockKeyText(jd, sub_order_id)）每张都得 false（锁被持有），共探 3 次；返回 { candidates: 3, voided: 3, skipped: 0 }，三张都 VOID（PLATFORM_INVALID、reason REFUND）各一条 order.invalidated 与一条 audit_logs',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const set = await candidates(w, app);
      await w.setConfig(app, SWITCH, true);
      const subOrderIds = new Map<string, string>();
      for (const { order } of set.all)
        subOrderIds.set((await order.row()).order_id, order.subOrderId);
      expect(subOrderIds.size).toBe(3);
      for (const subOrderId of subOrderIds.values()) {
        expect(await tryOrderLock(p.control, subOrderId), 'the order key is free before').toBe(
          true,
        );
      }
      const probe = lockProbe(p.db, p.control, subOrderIds);
      const service = await reevaluationOn(w, p.db, p.db.withPlugin(probe.plugin));
      passCaches(w);

      const summary = await service.apply({ appId: app.appId, actor: app.adminId });

      expect(probe.probes, 'one probe after each candidate re-read').toHaveLength(3);
      expect(probe.probes.map((x) => x.orderId).sort()).toEqual([...subOrderIds.keys()].sort());
      for (const { orderId, got } of probe.probes) {
        expect(got, `order key of ${orderId} held during its re-read`).toBe(false);
      }
      expect(summary).toEqual({ candidates: 3, voided: 3, skipped: 0 });
      for (const c of set.all) await expectVoided(w, app, c);
      expect(await w.auditsOf(app)).toHaveLength(3);
      for (const subOrderId of subOrderIds.values()) {
        expect(await tryOrderLock(p.control, subOrderId), 'released after commit').toBe(true);
      }
    });
  },
  TIMEOUT,
);
