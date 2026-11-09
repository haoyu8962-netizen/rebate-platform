// B1-03zn (BR-ID-36 细则「维持后再申诉」; 编排 21:27): the console registration of an order appeal
// takes the same transaction-level advisory lock as the app's submission (key
// `risk.appeals.order:<app_id>:<order_id>`, appeals.ts submitOrder) before it reads the order's
// appeals, so neither side can count before the other's appeal is committed and the cap of three
// holds under concurrency.
//
// Deterministic: a fixture transaction takes that lock (the user submission's key, letter for
// letter), writes the order's third appeal (already upheld: no processing row for a unique index to
// wait on) and waits. The requests are started meanwhile; PostgreSQL must show each of them waiting
// on a lock the fixture's backend holds, and none may finish before the fixture commits. After the
// commit every one of them counts three appeals and answers 30418: no fourth appeal, no audit, and
// the lock is free again (transaction-scoped).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import { auditsOf, at, DAY, member, refused, voidedOrder } from '../admin-appeals-write/kit.ts';
import { rejected } from '../appeals/http-kit.ts';
import {
  appUser,
  gate,
  holdOrderLock,
  insertClosedAppeal,
  orderLockFree,
  orderRows,
  registerBody,
  seedHistory,
  setup,
  tick,
  waitersOf,
  type Contender,
} from './kit.ts';

const h = useHarness();

const RACES: readonly { readonly label: string; readonly contenders: readonly Contender[] }[] = [
  { label: '后台代登记', contenders: ['admin'] },
  { label: '后台代登记与用户端提交并发', contenders: ['admin', 'user'] },
  { label: '两个后台代登记并发', contenders: ['admin', 'admin'] },
];

it.each(RACES)(
  '[AC-B1-03zn#6] $label：订单已有 2 条已结案，另一事务持 risk.appeals.order 锁写入第 3 条期间都等锁；提交后都 30418，订单总数仍为 3，不写审计，锁已释放',
  async ({ contenders }) => {
    const c = await setup(h);
    const user = await member(c);
    const o = await voidedOrder(c, user);
    await seedHistory(c, user, o, ['upheld', 'upheld']);
    const u = await appUser(c, user);
    tick(c);

    const ready = gate();
    const release = gate();
    let pid = 0;
    const writer = c.h.db.transaction().execute(async (trx) => {
      await holdOrderLock(trx, c.appId, o.order_id);
      await insertClosedAppeal(trx, c, user, o, 'upheld', at(-DAY));
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      pid = backend.rows[0]!.pid;
      ready.open();
      await release.wait();
    });
    // A setup failure of the writer must not leave the test waiting.
    void writer.catch(() => ready.open());
    await ready.wait();

    let finished = 0;
    const running: Promise<Response>[] = contenders.map((who, n) =>
      (who === 'admin'
        ? c.register(registerBody('order', o.order_id, `并发代登记 ${n + 1}`))
        : u.submit(o.order_id, `并发提交 ${n + 1}`)
      ).finally(() => {
        finished += 1;
      }),
    );
    try {
      await waitersOf(c.h.db, pid, contenders.length, () => finished > 0);
    } finally {
      release.open();
      await writer;
      await Promise.allSettled(running);
    }

    const answers = await Promise.all(running);
    for (const [n, who] of contenders.entries()) {
      if (who === 'admin') await refused(answers[n]!, 30418);
      else await rejected(answers[n]!, 422, 30418);
    }
    expect(await orderRows(c, o.order_id)).toHaveLength(3);
    expect(await auditsOf(c, 'appeal_register')).toEqual([]);
    expect(await orderLockFree(c, o.order_id)).toBe(true);
  },
);
