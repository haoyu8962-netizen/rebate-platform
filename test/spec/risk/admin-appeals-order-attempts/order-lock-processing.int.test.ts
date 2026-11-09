// B1-03zn (BR-ID-36「处理中再次提交返回原申诉单、不新建」与细则「维持后再申诉」; 编排 21:27; Codex
// spec-test r1 S1): the console registration takes the order's advisory lock before it looks for a
// processing appeal, not only before it counts.
//
// Deterministic: the order has two closed (upheld) appeals. A fixture transaction A takes the order
// lock (the user submission's key, letter for letter), inserts the third appeal as **processing**
// (as the app's submission or another console registration would) and waits uncommitted. The
// requests are started meanwhile; PostgreSQL must show each of them waiting on that very advisory
// lock held by A's backend (not on A's row under the processing unique index), and none may finish
// before A commits. After the commit every request returns A's appeal (same id, success shape of
// the contract): no 30418, no fourth appeal, and the lock is free again.
//
// An implementation that looks for the processing appeal before taking the lock sees nothing (A is
// uncommitted), then waits on the lock and counts three appeals: 30418 — red. One that never takes
// the lock waits on the unique index instead — red.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import { appealOf, member, voidedOrder } from '../admin-appeals-write/kit.ts';
import { accepted } from '../appeals/http-kit.ts';
import {
  appUser,
  gate,
  holdOrderLock,
  insertProcessingAppeal,
  orderLockFree,
  orderLockWaitersOf,
  orderRows,
  registerBody,
  seedHistory,
  setup,
  tick,
  type Contender,
} from './kit.ts';

const h = useHarness();

const RACES: readonly {
  readonly label: string;
  readonly holder: 'app' | 'admin';
  readonly contenders: readonly Contender[];
}[] = [
  { label: 'A 为用户端提交，后台代登记', holder: 'app', contenders: ['admin'] },
  { label: 'A 为后台代登记，后台再代登记', holder: 'admin', contenders: ['admin'] },
  { label: 'A 为用户端提交，两个后台代登记并发', holder: 'app', contenders: ['admin', 'admin'] },
  {
    label: 'A 为后台代登记，后台代登记与用户端提交并发',
    holder: 'admin',
    contenders: ['admin', 'user'],
  },
];

it.each(RACES)(
  '[AC-B1-03zn#7] $label：订单已有 2 条已结案，事务 A 持 risk.appeals.order 锁写入处理中的第 3 条期间都在这把咨询锁上等待；A 提交后都返回 A 的原申诉单（不是 30418），订单总数仍为 3，锁已释放',
  async ({ holder, contenders }) => {
    const c = await setup(h);
    const user = await member(c);
    const o = await voidedOrder(c, user);
    await seedHistory(c, user, o, ['upheld', 'upheld']);
    const u = await appUser(c, user);
    tick(c);

    const ready = gate();
    const release = gate();
    let pid = 0;
    let original = '';
    const writer = c.h.db.transaction().execute(async (trx) => {
      await holdOrderLock(trx, c.appId, o.order_id);
      original = await insertProcessingAppeal(trx, c, user, o, holder);
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      pid = backend.rows[0]!.pid;
      ready.open();
      await release.wait();
    });
    // A setup failure of the writer must not leave the test waiting.
    void writer.catch(() => ready.open());
    await ready.wait();
    expect(original, 'the fixture wrote the processing third appeal').not.toBe('');
    tick(c);

    let finished = 0;
    const running: Promise<Response>[] = contenders.map((who, n) =>
      (who === 'admin'
        ? c.register(registerBody('order', o.order_id, `锁内处理中时代登记 ${n + 1}`))
        : u.submit(o.order_id, `锁内处理中时提交 ${n + 1}`)
      ).finally(() => {
        finished += 1;
      }),
    );
    try {
      await orderLockWaitersOf(c, o.order_id, pid, contenders.length, () => finished > 0);
    } finally {
      release.open();
      await writer;
      await Promise.allSettled(running);
    }

    const answers = await Promise.all(running);
    for (const [n, who] of contenders.entries()) {
      if (who === 'admin') {
        expect(await appealOf(answers[n]!), `contender ${n + 1} (admin)`).toMatchObject({
          appeal_id: original,
          target_type: 'order',
          target_id: o.order_id,
          status: 'processing',
          source: holder,
        });
      } else {
        expect(await accepted(answers[n]!), `contender ${n + 1} (app)`).toMatchObject({
          appeal_id: original,
          target_type: 'order',
          target_id: o.order_id,
          status: 'processing',
          attempt_no: 3,
        });
      }
    }
    const rows = await orderRows(c, o.order_id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'processing').map((row) => row.id)).toEqual([
      original,
    ]);
    expect(await orderLockFree(c, o.order_id)).toBe(true);
  },
);
