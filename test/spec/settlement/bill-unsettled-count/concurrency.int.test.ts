// B2-18a：同一账单各平台的账单日任务在账单行上串行、按平台累加（BR-FUND-04 ③⑤；D10-2415）。账单行已存在且
// 三个计数都非零时，两个尚未出账的平台各用一条独立连接并发：先到的任务拿到账单行锁后在库层屏障停住（锁已拿、
// 事务未提交），在服务端观察到后到的任务确实在等它的锁（pg_blocking_pids）才放行；两种先后都测。累加必须在行锁
// 内读原值——在拿锁前另读一次旧值再加的实现，后提交的一方会把先提交的那份覆盖掉。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { fixture, order, settlement, snapshot, state, RUN, TIMEOUT } from '../bill/kit.ts';
import { backendPid, billCounts, pauseAtBillLock, poolsFixture, waitBlocked } from './kit.ts';

const pools = poolsFixture(createTestDatabase, TIMEOUT);

it.each([
  { first: 'taobao', second: 'jd' },
  { first: 'jd', second: 'taobao' },
])(
  '[AC-B2-18a#19] 账单行已存在（pdd 已出账：error 1、held 1、unsettled 2），$first 持账单行锁时 $second 在锁上等待，放行后两平台都出账：unsettled_count 6、error_count 3、held_count 4（原值加两平台各自的数，三列都不丢），批次与差错单各平台各一份',
  async ({ first, second }) => {
    const h = fixture(pools.db);
    await snapshot(h);
    // 已出账的 pdd（入账开关未设，缺省 off，只记校验结果）：2 单应结未结、1 单 hold、1 单 VOID 对上联盟结算。
    await order(h, {}, 'pdd');
    await order(h, {}, 'pdd');
    await order(h, { hold: true }, 'pdd');
    const pddVoided = await order(h, { rebateStatus: 'VOID' }, 'pdd');
    await settlement(h, pddVoided);
    expect((await h.run('pdd')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 1,
      held_count: 1,
      unsettled_count: 2,
      amount_mismatch_count: null,
    });

    // 淘宝：1 单候选、1 单应结未结、1 单金额不一致、1 单维权中 → error 1、held 1、unsettled 1。
    const taobaoGood = await order(h);
    await settlement(h, taobaoGood);
    await order(h);
    const taobaoBad = await order(h);
    await settlement(h, taobaoBad, { settle_commission_fen: 9000n });
    await order(h, { rightsPending: true });
    // 京东：1 单候选、3 单应结未结、1 单 VOID 对上联盟结算、2 单 hold → error 1、held 2、unsettled 3。
    const jdGood = await order(h, {}, 'jd');
    await settlement(h, jdGood);
    for (let i = 0; i < 3; i += 1) await order(h, {}, 'jd');
    const jdVoided = await order(h, { rebateStatus: 'VOID' }, 'jd');
    await settlement(h, jdVoided);
    await order(h, { hold: true }, 'jd');
    await order(h, { hold: true }, 'jd');

    const leftPid = await backendPid(pools.left);
    const rightPid = await backendPid(pools.right);
    const barrier = pauseAtBillLock(pools.left);
    const input = (platform: string) => ({ appId: h.appId, platform, runAt: new Date(RUN) });
    const holder = h.job.run(barrier.db, input(first));
    let waiter: ReturnType<typeof h.job.run> | undefined;
    try {
      // 先到的任务必须停在账单行锁上；没取锁就跑完的实现在这里红，不挂到超时。
      const finished = holder.then(
        () => 'finished' as const,
        () => 'finished' as const,
      );
      const paused = barrier.reached.then(() => 'paused' as const);
      expect(await Promise.race([paused, finished])).toBe('paused');
      waiter = h.job.run(pools.right, input(second));
      await waitBlocked(pools.control, rightPid, leftPid);
      barrier.release();
      expect((await holder).outcome).toBe('generated');
      expect((await waiter).outcome).toBe('generated');
    } finally {
      barrier.release();
      await holder.catch(() => undefined);
      await waiter?.catch(() => undefined);
    }

    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 3,
      held_count: 4,
      unsettled_count: 6,
      amount_mismatch_count: null,
    });
    const s = await state(h);
    expect(s.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { pdd: 0, taobao: 1, jd: 1 },
        platform_settle_commission_totals: { pdd: '0', taobao: '1000', jd: '1000' },
        beneficiary_total_fen: 1104n,
        platform_retained_fen: 596n,
        error_count: 3,
        held_count: 4,
      }),
    ]);
    expect(s.batches.map((b) => [b.platform, b.kind, b.status, b.order_count]).sort()).toEqual([
      ['jd', 'main', 'DRAFT', 1],
      ['taobao', 'main', 'DRAFT', 1],
    ]);
    expect(s.items.map((i) => i.order_id).sort()).toEqual([jdGood.id, taobaoGood.id].sort());
    expect(s.diffs.map((d) => [d.type, d.ref_id]).sort()).toEqual(
      [
        ['settle_amount_mismatch', taobaoBad.key],
        ['union_mismatch', jdVoided.key],
        ['union_mismatch', pddVoided.key],
      ].sort(),
    );
    expect(s.jobs.map((j) => [j.platform, j.status]).sort()).toEqual([
      ['jd', 'done'],
      ['pdd', 'done'],
      ['taobao', 'done'],
    ]);
    const types = h.registerDiff.mock.calls.map((call) => call[1].type);
    expect(types).not.toContain('settle_missing');
  },
  TIMEOUT,
);
