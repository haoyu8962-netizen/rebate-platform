// B2-04zzh 入账时作废的原子性（BR-FUND-04 ⑦「每个子订单单独一个 PG 事务」、BR-FUND-07「同一事务内入队领域事件
// order.invalidated」、settlement/AGENTS.md 硬规则 4）：作废写下之后、同一入账事务里追加 order.invalidated 失败 →
// 整体回滚：订单仍 WAITING、原因与 row_version 不变、无作废历史、无事件、无分录，批次项仍未处理（不写成 skipped）。
// 恢复后重跑同一批次只作废一次、只入队一次，批次项 skipped，再投不重复。主干的入账不作废，也就不会追加
// order.invalidated：这一步的失败不会发生，订单被照常入账，所以红。
// Task-local AC labels ([AC-B2-04zzh#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { SKIP_REASON, SWITCH, TIMEOUT, databaseFixture, withWorker, zeroed } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzh#6] 开关开、退完的 WAITING 京东单入账时作废，order.invalidated 追加失败：整个入账事务回滚（WAITING、无历史、无事件、无分录、批次项未写）；恢复后重跑只作废一次、只入队一次，批次项 skipped，再投不重复',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const b = await w.batch(app, 'jd', [o]);
      const before = await o.row();
      const history = await o.history();
      const ledger = await w.ledgerOf(app);

      w.fault.armed = true;
      await w.execute(b);
      w.fault.armed = false;

      expect(w.fault.hits, 'the credit appended order.invalidated on its transaction').toBe(1);
      expect(await o.row()).toEqual(before);
      expect(await o.history()).toEqual(history);
      expect(await o.invalidated()).toEqual([]);
      expect(await o.creditedEvents()).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      expect(await w.itemOf(b, o)).toEqual({ result: null, skip_reason: null, amount_fen: null });

      await w.settle(b);

      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        quantity: 2,
        refunded_quantity: 2,
        commission_version: before.commission_version,
      });
      const voids = await o.voids();
      expect(voids).toHaveLength(1);
      expect(voids[0]).toMatchObject({
        from_status: 'WAITING',
        event: 'PLATFORM_INVALID',
        to_status: 'VOID',
      });
      expect((await o.invalidated()).map((e) => e.payload['reason'])).toEqual(['REFUND']);
      expect(await w.itemOf(b, o)).toEqual({
        result: 'skipped',
        skip_reason: SKIP_REASON,
        amount_fen: null,
      });
      expect((await w.batchOf(b)).status).toBe('DONE');
      expect(await w.ledgerOf(app)).toEqual(ledger);

      await w.settle(b);

      expect(await o.voids()).toHaveLength(1);
      expect(await o.invalidated()).toHaveLength(1);
      expect(await o.creditedEvents()).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);
