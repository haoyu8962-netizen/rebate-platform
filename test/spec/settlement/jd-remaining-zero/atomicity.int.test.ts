// B2-04zzg（BR-FUND-07「同一事务内入队领域事件 order.invalidated」，settlement/AGENTS.md 硬规则 4）：剩余数量归 0 的
// 作废与同步写库同一事务。下游入队失败（order.invalidated 本身，或其后的 order.updated）→ 整条回滚：返利状态、原因、
// 件数、row_version 都不变，没有作废历史、没有 order.invalidated；恢复后重投只作废一次、只入队一次；同一报文重放
// 与之后的同步都不再写第二条。主干上入队 order.invalidated 不会发生（不失败、重投后也不作废）：每条都红。
// Task-local AC labels ([AC-B2-04zzg#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  SWITCH,
  TIMEOUT,
  capture,
  counts,
  databaseFixture,
  precredit,
  touched,
  withWorker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each(['order.invalidated', 'order.updated'] as const)(
  '[AC-B2-04zzg#15] 开关开、WAITING 京东单退完，%s 入队失败：订单行逐列不变、无作废历史、无 order.invalidated；恢复后重投作废一次，重放不再入队',
  async (failing) => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const before = await o.row();
      const history = await o.history();
      const ledger = await w.ledgerOf(app);
      const report = touched(5, counts(2, 2));

      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic downstream failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === failing) throw failure;
        return publish(trx, event);
      });
      try {
        expect(await capture(() => o.report(report))).toEqual({ ok: false, error: failure });
        expect(await o.row()).toEqual(before);
        expect(await o.history()).toEqual(history);
        expect(await o.invalidated()).toEqual([]);
        expect(await w.ledgerOf(app)).toEqual(ledger);
      } finally {
        bus.mockRestore();
      }

      await o.sync(report);
      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        refunded_quantity: 2,
        commission_version: before.commission_version,
      });
      expect(await o.voids()).toEqual([
        { from_status: 'WAITING', event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
      ]);
      expect((await o.invalidated()).map((e) => e.payload['reason'])).toEqual(['REFUND']);

      await o.sync(report);
      await o.sync(touched(6, counts(2, 2)));
      expect(await o.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await o.voids()).toHaveLength(1);
      expect(await o.invalidated()).toHaveLength(1);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);
