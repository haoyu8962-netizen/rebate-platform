import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { tracing } from '../credit/kit.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  capture,
  credited,
  databaseFixture,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zi#31] R10同步沿用订单键→users行→余额行的加锁顺序',
  async () => {
    const trace = tracing(p.db);
    await withSync(trace.db, async (w) => {
      const { o, read } = await credited(trace.db, w);
      trace.queries.length = 0;
      await o.sync(settled(800n, touched(1)));
      const queries = [...trace.queries];
      await read.adjustment(2, 100n, 100n);
      const orderLock = queries.findIndex(
        (q) =>
          q.sql.includes('pg_advisory_xact_lock') &&
          q.parameters.some((v) => typeof v === 'string' && v.includes(o.subOrderId)),
      );
      const userLock = queries.findIndex(
        (q) => /"users"/.test(q.sql) && /for (no key )?update/i.test(q.sql),
      );
      const balanceLock = queries.findIndex(
        (q) => /"account_balances"/.test(q.sql) && /for update/i.test(q.sql),
      );
      expect(orderLock).toBeGreaterThanOrEqual(0);
      expect(userLock).toBeGreaterThan(orderLock);
      expect(balanceLock).toBeGreaterThan(userLock);
    });
  },
  TIMEOUT,
);

for (const sample of [
  { ac: 28, start: '2026-11-30T15:58:59.999Z', at: '2026-11-30T15:59:59.999Z', day: '2026-11-30' },
  { ac: 29, start: '2026-11-30T15:59:00.000Z', at: '2026-11-30T16:00:00.000Z', day: '2026-12-01' },
  { ac: 30, start: '2026-11-30T23:58:59.999Z', at: '2026-11-30T23:59:59.999Z', day: '2026-12-01' },
] as const) {
  it(
    `[AC-B2-04zi#${sample.ac}] R10在${sample.at}按注入Clock记账，历史联盟结算时刻不能改变会计日`,
    async () => {
      await withSync(p.db, async (w) => {
        const { o, read } = await credited(p.db, w);
        w.clock.set(sample.start); // Existing report fixture advances exactly one minute.
        await o.sync(settled(800n, touched(1)));
        await read.adjustment(2, 100n, 100n);
        expect(
          (await read.vouchers())
            .filter((v) => v.uniq_key.endsWith(':ADJ:2'))
            .map((v) => v.accounting_day),
        ).toEqual([sample.day, sample.day]);
        expect(await read.history()).toMatchObject([
          { event: 'SETTLE_NEGATIVE_DIFF', at: new Date(sample.at) },
        ]);
        expect(
          (await read.lines()).filter((l) => l.uniq_key.endsWith(':ADJ:2')).map((l) => l.booked_at),
        ).toEqual(Array.from({ length: 4 }, () => new Date(sample.at)));
        expect(await o.row()).toMatchObject({ settle_period: '2026-10' });
      });
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-04zi#9] B相等且大于0：N5→4、预留50%，B始终2，只调平台1分',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w, { n: 5n, reserveBp: 5000 });
      expect(await o.row()).toMatchObject({ booked_base_fen: 2n, booked_n_fen: 5n });
      await o.sync(settled(4n, touched(1)));
      await read.adjustment(2, 0n, 1n);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 2n,
        booked_n_fen: 4n,
      });
      expect(await read.balance()).toEqual({ available_fen: 1n, frozen_fen: 0n });
      expect(await read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#10] B新旧都是0而N2→1仍为正，只调平台1分并保持CREDITED',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w, { n: 2n, reserveBp: 7500 });
      expect(await o.row()).toMatchObject({ booked_base_fen: 0n, booked_n_fen: 2n });
      await o.sync(settled(1n, touched(1)));
      await read.adjustment(2, 0n, 1n);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 0n,
        booked_n_fen: 1n,
      });
      expect(await read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
    });
  },
  TIMEOUT,
);

// Each generated case is independently red on the ordinary credited sync path.
for (const sample of [
  { ac: 11, old: 1000n, next: 0n, reserve: 0, platformDebit: 500n, userDebit: 500n },
  { ac: 12, old: 1000n, next: -7n, reserve: 0, platformDebit: 500n, userDebit: 500n },
  { ac: 13, old: 4n, next: 3n, reserve: 7500, platformDebit: 1n, userDebit: 0n },
  { ac: 14, old: 2n, next: 0n, reserve: 7500, platformDebit: 2n, userDebit: 0n },
  { ac: 15, old: 2n, next: -1n, reserve: 7500, platformDebit: 2n, userDebit: 0n },
] as const) {
  it(
    `[AC-B2-04zi#${sample.ac}] N${sample.old}→${sample.next}、reserve=${sample.reserve}：正数部分或原正基数归零走R8`,
    async () => {
      await withSync(p.db, async (w) => {
        const { app, o, read } = await credited(p.db, w, {
          n: sample.old,
          reserveBp: sample.reserve,
        });
        await o.sync(settled(sample.next, touched(1)));
        const row = await o.row();
        expect(row).toMatchObject({
          rebate_status: 'CLAWED_BACK',
          reason: 'COMMISSION_ZERO',
          booked_base_fen: 0n,
          booked_n_fen: sample.next > 0n ? sample.next : 0n,
        });
        const lines = (await read.lines()).filter((l) => l.ledger_type === 'CLAWBACK');
        const expected: string[] = [];
        for (const [part, subject, amount] of [
          [`${app.userId}:${MEMBER_ROLE}`, 'USER_BALANCE', sample.userDebit],
          ['PLATFORM', 'COMMISSION_REVENUE', sample.platformDebit],
        ] as const) {
          if (amount === 0n) continue;
          const ref = `${read.orderRef}:${part}:CLAWBACK:C${row.commission_version}`;
          expected.push(`${ref}|${subject}|${amount}`, `${ref}|UNION_RECEIVABLE:pdd|${-amount}`);
        }
        expect(lines.map((l) => `${l.uniq_key}|${l.subject}|${l.amount_fen}`).sort()).toEqual(
          expected.sort(),
        );
        expect((await read.lines()).filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
        expect(await read.history()).toHaveLength(1);
        await read.balanced();
        const before = await read.money();
        await o.sync(settled(sample.next, touched(2)));
        expect(await read.money()).toEqual(before);
      });
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-04zi#16] 下游发布失败时结算记录、金额版本、booked、凭证、余额与history一起回滚，重投只写一次',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w);
      const moneyBefore = await read.money();
      const rowBefore = await o.row();
      const totalsBefore = await o.totals();
      const recordsBefore = await o.records();
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic downstream failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.updated') throw failure;
        return publish(trx, event);
      });
      try {
        expect(await capture(() => o.report(settled(800n, touched(1))))).toEqual({
          ok: false,
          error: failure,
        });
        expect(await read.money()).toEqual(moneyBefore);
        expect(await o.row()).toEqual(rowBefore);
        expect(await o.totals()).toEqual(totalsBefore);
        expect(await o.records()).toEqual(recordsBefore);
      } finally {
        bus.mockRestore();
      }
      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 100n, 100n);
      expect(await read.history()).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#17] 并发同报文只生成seq2及两张调整凭证，另一app的账与义务完全不变',
  async () => {
    await withSync(p.db, async (w) => {
      const a = await credited(p.db, w);
      const b = await credited(p.db, w);
      const otherBefore = await b.read.money();
      const report = settled(800n, touched(1));
      expect(
        await Promise.all([capture(() => a.o.report(report)), capture(() => a.o.report(report))]),
      ).toMatchObject([{ ok: true }, { ok: true }]);
      await a.read.adjustment(2, 100n, 100n);
      expect((await a.o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await a.read.history()).toHaveLength(1);
      expect(await b.read.money()).toEqual(otherBefore);
      expect((await a.read.vouchers()).every((v) => v.app_id === a.app.appId)).toBe(true);
      expect((await b.o.records()).map((r) => r.seq)).toEqual([1]);
      await b.read.balanced();
    });
  },
  TIMEOUT,
);
