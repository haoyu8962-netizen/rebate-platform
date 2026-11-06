// B2-12f：候选生成（BR-FUND-12「每日 R3 后…当前会计日 − negative_since ≥ ledger.bad_debt_days 且
// |available_fen| ≥ ledger.bad_debt_min_fen 时生成核销候选单；同一账户同时最多 1 张 PENDING 候选单，已存在则不再
// 生成…本条只适用于未注销用户」，状态机 BD1：记生成时金额与 negative_since，发起人为空），走真实 worker 入口的
// 调度（kit.ts 头注释的约定：R3 完成记录、首次 tick 不晚于约 15 秒、之后不晚于约 60 秒）。
// 天数按例手算：negative_since 2026-11-20，2027-02-17 是第 89 天，2027-02-18 是第 90 天；2027-01-19 起到
// 2027-02-18 是 30 天、到 2027-02-17 是 29 天；2027-01-20 起到 2027-02-18 是 29 天。
// 每个用例都含一个骨架上必然落空的「应生成」断言。用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
// 第 2 轮（评审 r1 第 2 条）：#33 落在北京时间 00:00 前后、UTC 日期与北京日期不同的时刻，期望的会计日手写。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DAYS_KEY,
  DAY_89,
  DAY_90,
  DAY_91,
  MIN_FEN_KEY,
  SINCE,
  TIMEOUT,
  candidates,
  configure,
  credit,
  debit,
  generatedFor,
  inWorkerTime,
  ledgerState,
  moneyOf,
  negativeMember,
  noon,
  plainMember,
  r3Done,
  seedCandidate,
  workerFixture,
  type AdjustFixture,
  type Member,
} from './kit.ts';

/** Expected candidates in the kit's order (account_id). */
function byAccount(
  rows: readonly { readonly m: Member; readonly row: Record<string, unknown> }[],
): Record<string, unknown>[] {
  return [...rows]
    .sort((a, b) => (a.m.accountId < b.m.accountId ? -1 : a.m.accountId > b.m.accountId ? 1 : 0))
    .map((entry) => entry.row);
}

async function count(f: AdjustFixture): Promise<number> {
  return (await candidates(f)).length;
}

async function hasCandidate(f: AdjustFixture, m: Member): Promise<boolean> {
  return (await candidates(f, m.appId)).some((row) => row.account_id === m.accountId);
}

it(
  '[AC-B2-12f#4] 默认阈值（没有配置行：90 天、0 分）：负余额第 89 天不生成；第 90 天 R3 完成后生成 PENDING 候选单，candidate_fen = −available、negative_since 取余额的、发起人与批准字段为空、created_at 取时钟；−1 分也生成；生成不写凭证、不动余额',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_89));
      const a = await negativeMember(f, { available: -800n, since: SINCE });
      const b = await negativeMember(f, { available: -1n, since: SINCE });
      await r3Done(f, '2027-02-16');
      const before = await ledgerState(f);
      await withWorker({ clock: f.clock }, async (worker) => {
        await worker.quiet();
        expect(await candidates(f), '第 89 天不生成').toEqual([]);

        f.clock.set(noon(DAY_90));
        await r3Done(f, DAY_89);
        expect(
          await worker.tickUntil(async () => (await count(f)) >= 2),
          '第 90 天 R3 之后应为两个负余额账户各生成一张候选单',
        ).toBe(true);
        await worker.quiet();
      });
      expect(await candidates(f)).toEqual(
        byAccount([
          { m: a, row: generatedFor(a, { fen: 800n, since: SINCE, at: noon(DAY_90) }) },
          { m: b, row: generatedFor(b, { fen: 1n, since: SINCE, at: noon(DAY_90) }) },
        ]),
      );
      expect(await ledgerState(f), '生成不写凭证、不动余额').toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#5] 按配置值：ledger.bad_debt_days=30、ledger.bad_debt_min_fen=500 → 第 29 天不生成；第 30 天 |available| 正好 500 生成，差 1 分（499）不生成，只负了 29 天的 2000 也不生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_89));
      await configure(f, DAYS_KEY, 30);
      await configure(f, MIN_FEN_KEY, 500);
      const exact = await negativeMember(f, { available: -500n, since: '2027-01-19' });
      const short = await negativeMember(f, { available: -499n, since: '2027-01-19' });
      const young = await negativeMember(f, { available: -2000n, since: '2027-01-20' });
      await r3Done(f, '2027-02-16');
      await withWorker({ clock: f.clock }, async (worker) => {
        await worker.quiet();
        expect(await candidates(f), '第 29 天不生成').toEqual([]);

        f.clock.set(noon(DAY_90));
        await r3Done(f, DAY_89);
        expect(
          await worker.tickUntil(() => hasCandidate(f, exact)),
          '第 30 天、金额正好等于阈值应生成',
        ).toBe(true);
        await worker.quiet();
      });
      expect(await candidates(f)).toEqual([
        generatedFor(exact, { fen: 500n, since: '2027-01-19', at: noon(DAY_90) }),
      ]);
      expect(await hasCandidate(f, short), '差 1 分').toBe(false);
      expect(await hasCandidate(f, young), '只负了 29 天').toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#6] 每日 R3 后：第 90 天只有前天（02-16）或别的 app 的 R3 完成记录时不生成；当天要等的那一次（02-17）记下后才生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_90));
      const other = workerFixture(db, f.clock);
      const m = await negativeMember(f, { available: -800n, since: SINCE });
      await plainMember(other);
      await r3Done(f, '2027-02-16');
      await r3Done(other, DAY_89);
      await withWorker({ clock: f.clock }, async (worker) => {
        await worker.quiet();
        expect(await candidates(f), 'R3（02-17）尚未完成').toEqual([]);

        await r3Done(f, DAY_89);
        expect(await worker.tickUntil(() => hasCandidate(f, m)), 'R3 完成后的 tick 应生成').toBe(
          true,
        );
      });
      expect(await candidates(f)).toEqual([
        generatedFor(m, { fen: 800n, since: SINCE, at: noon(DAY_90) }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#7] 同一账户已有 PENDING 不再生成：同一天反复 tick、次日再跑都不重复（原单 id 与 created_at 不变）；次日满 90 天的另一个账户照常生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_90));
      const first = await negativeMember(f, { available: -800n, since: SINCE });
      const later = await negativeMember(f, { available: -300n, since: '2026-11-21' });
      await r3Done(f, DAY_89);
      await withWorker({ clock: f.clock }, async (worker) => {
        expect(await worker.tickUntil(() => hasCandidate(f, first)), '第 90 天生成').toBe(true);
        await worker.quiet();
        const once = await candidates(f);
        expect(once, '同一天不重复，另一个账户只负了 89 天').toEqual([
          generatedFor(first, { fen: 800n, since: SINCE, at: noon(DAY_90) }),
        ]);

        f.clock.set(noon(DAY_91));
        await r3Done(f, DAY_90);
        expect(
          await worker.tickUntil(() => hasCandidate(f, later)),
          '次日另一个账户满 90 天应生成',
        ).toBe(true);
        await worker.quiet();
        expect(await candidates(f)).toEqual(
          byAccount([
            { m: first, row: once[0]! as unknown as Record<string, unknown> },
            {
              m: later,
              row: generatedFor(later, { fen: 300n, since: '2026-11-21', at: noon(DAY_91) }),
            },
          ]),
        );
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#8] 只有 PENDING 挡住再生成：同一账户早先的 APPROVED（已核销）与 CANCELLED 候选单不影响；再次负满 90 天时生成新的 PENDING，记新的 negative_since 与当前金额',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_90));
      const m = await negativeMember(f, { available: -200n, since: '2026-06-01' });
      const cancelled = await seedCandidate(f, m, {
        status: 'CANCELLED',
        createdAt: new Date('2026-08-30T18:00:00.000Z'),
      });
      const approved = await seedCandidate(f, m, {
        status: 'APPROVED',
        createdAt: new Date('2026-08-31T18:00:00.000Z'),
      });
      expect(await moneyOf(f, m), '早先的核销已使 available 回到 0').toMatchObject({
        available: 0n,
        negativeSince: null,
      });
      await debit(f, m, 800n, SINCE);
      await r3Done(f, DAY_89);
      await withWorker({ clock: f.clock }, async (worker) => {
        expect(
          await worker.tickUntil(async () => (await count(f)) >= 3),
          '应生成新的 PENDING',
        ).toBe(true);
        await worker.quiet();
      });
      const rows = await candidates(f);
      expect(rows).toHaveLength(3);
      expect(rows).toContainEqual(cancelled);
      expect(rows).toContainEqual(approved);
      expect(rows).toContainEqual(generatedFor(m, { fen: 800n, since: SINCE, at: noon(DAY_90) }));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#9] 只适用于未注销用户、只看负余额：注销中（deleting）与已注销（deleted）的负余额会员不生成；负过但已入账抵平（negative_since 已清空）的、从未为负的不生成；同 app 的正常负余额会员照常生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, noon(DAY_90));
      const normal = await negativeMember(f, { available: -800n, since: SINCE });
      const deleting = await negativeMember(f, {
        available: -800n,
        since: SINCE,
        status: 'deleting',
      });
      const deleted = await negativeMember(f, {
        available: -800n,
        since: SINCE,
        status: 'deleted',
      });
      const recovered = await negativeMember(f, { available: -800n, since: '2026-10-01' });
      await credit(f, recovered, 800n, '2026-12-01');
      expect(await moneyOf(f, recovered), '抵平后 negative_since 清空').toEqual({
        available: 0n,
        frozen: 0n,
        negativeSince: null,
      });
      const positive = await plainMember(f, 5000n);
      await r3Done(f, DAY_89);
      await withWorker({ clock: f.clock }, async (worker) => {
        expect(await worker.tickUntil(() => hasCandidate(f, normal)), '正常会员应生成').toBe(true);
        await worker.quiet();
      });
      expect(await candidates(f)).toEqual([
        generatedFor(normal, { fen: 800n, since: SINCE, at: noon(DAY_90) }),
      ]);
      for (const [name, m] of [
        ['deleting', deleting],
        ['deleted', deleted],
        ['recovered', recovered],
        ['positive', positive],
      ] as const) {
        expect(await hasCandidate(f, m), name).toBe(false);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#10] 各 app 互不影响：同一 tick 里 A、C（默认 90 天）各自生成、候选单只落在本 app；B 配置 ledger.bad_debt_days=120，同样负了 90 天不生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const a = workerFixture(db, noon(DAY_90));
      const b = workerFixture(db, a.clock);
      const c = workerFixture(db, a.clock);
      await configure(b, DAYS_KEY, 120);
      const ma = await negativeMember(a, { available: -800n, since: SINCE });
      const mb = await negativeMember(b, { available: -800n, since: SINCE });
      const mc = await negativeMember(c, { available: -600n, since: SINCE });
      for (const f of [a, b, c]) await r3Done(f, DAY_89);
      await withWorker({ clock: a.clock }, async (worker) => {
        expect(
          await worker.tickUntil(
            async () => (await hasCandidate(a, ma)) && (await hasCandidate(c, mc)),
          ),
          'A、C 应各自生成',
        ).toBe(true);
        await worker.quiet();
      });
      expect(await candidates(a)).toEqual([
        generatedFor(ma, { fen: 800n, since: SINCE, at: noon(DAY_90) }),
      ]);
      expect(await candidates(c)).toEqual([
        generatedFor(mc, { fen: 600n, since: SINCE, at: noon(DAY_90) }),
      ]);
      expect(await candidates(b), 'B 要 120 天').toEqual([]);
      expect(await hasCandidate(b, mb)).toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12f#33] 会计日按北京时间 00:00 日切（UTC 日期与北京日期不同的时刻）：北京 2026-11-20 00:30（UTC 11-19 16:30）变负的会员 negative_since 2026-11-20；2027-02-17T15:59Z（北京 02-17 23:59，第 89 天）不生成；2027-02-17T16:01Z（北京 02-18 00:01，UTC 仍是 02-17）R3（02-17）完成后生成，created_at 取该时刻；北京 2026-11-21 00:30（UTC 11-20 16:30）变负的只有 89 天，不生成',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = workerFixture(db, '2027-02-17T15:59:00.000Z');
      const early = await negativeMember(f, {
        available: -800n,
        since: '2026-11-20',
        at: '2026-11-19T16:30:00.000Z',
      });
      const late = await negativeMember(f, {
        available: -600n,
        since: '2026-11-21',
        at: '2026-11-20T16:30:00.000Z',
      });
      expect((await moneyOf(f, early)).negativeSince, '北京 11-20 00:30 变负').toBe('2026-11-20');
      expect((await moneyOf(f, late)).negativeSince, '北京 11-21 00:30 变负').toBe('2026-11-21');
      await r3Done(f, '2027-02-16');
      await withWorker({ clock: f.clock }, async (worker) => {
        await worker.quiet();
        expect(await candidates(f), '北京 02-17 23:59 仍是第 89 天').toEqual([]);

        f.clock.set('2027-02-17T16:01:00.000Z');
        await r3Done(f, '2027-02-17');
        expect(
          await worker.tickUntil(() => hasCandidate(f, early)),
          '北京 02-18 00:01 是第 90 天，应生成',
        ).toBe(true);
        await worker.quiet();
      });
      expect(await candidates(f)).toEqual([
        generatedFor(early, { fen: 800n, since: '2026-11-20', at: '2027-02-17T16:01:00.000Z' }),
      ]);
      expect(await hasCandidate(f, late), '只负了 89 天').toBe(false);
    });
  },
  TIMEOUT,
);
