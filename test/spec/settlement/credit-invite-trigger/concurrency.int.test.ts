// B2-04zzc (编排 D10-805 ②; 08 BR-INV-24 ②「以被邀请人为幂等键，每个被邀请人只触发一次」, 细则
// 「判定顺序」按被邀请人加锁; settlement AGENTS.md 硬规则 3 加锁顺序): concurrent credits of one
// invitee record exactly one trigger, the first committed one; a credit running against the
// invitee's payout and expiry neither deadlocks nor ends differently from running them one after
// the other. The overlap is real: the first credit holds its users locks (identity's port paused
// after locking) until the others are seen waiting on a lock in pg_stat_activity.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { NOW, databaseFixture, fixture } from '../batch-executor/kit.ts';
import {
  TIMEOUT,
  budgetsOf,
  creditedRows,
  execute,
  inviteeOrder,
  pair,
  pausingLock,
  productionTrigger,
  qualify,
  rewardOf,
  rewardSide,
  rewardVoucherKeys,
  triggerOf,
  waitLockWaiters,
  withWorker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CREDITED_AT = new Date(NOW).toISOString();

it(
  '[AC-B2-04zzc#7] 同一被邀请人的两笔自购单在两个批次里并发入账：先提交的一笔（订单 id 较大的那笔，排除按 id 取单）记为触发，后一笔只入账不改触发；两笔都 CREDITED 各一次，资格 row_version 为 1',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const one = await inviteeOrder(f, pr);
    const two = await inviteeOrder(f, pr);
    const [first, second] = one.orderId > two.orderId ? [one, two] : [two, one];
    const firstBatch = await f.batch([first]);
    const secondBatch = await f.batch([second]);
    const pause = pausingLock(f.h.identityLock, pr.invitee);

    await withWorker(
      f,
      { trigger: await productionTrigger(), lockUsers: pause.lockUsers },
      async (handler) => {
        const runFirst = execute(handler, f, firstBatch);
        await pause.entered;
        const runSecond = execute(handler, f, secondBatch);
        await waitLockWaiters(f.db, 1);
        pause.release();
        const settled = await Promise.allSettled([runFirst, runSecond]);
        expect(settled.map((s) => s.status)).toStrictEqual(['fulfilled', 'fulfilled']);
      },
    );

    for (const o of [first, second]) {
      expect(await f.rebateOf(o)).toBe('CREDITED');
      expect(await creditedRows(f, o)).toBe(1);
    }
    expect(await triggerOf(f, pr.invitee)).toStrictEqual({
      status: 'qualified',
      trigger_order_id: first.orderId,
      triggered_at: CREDITED_AT,
    });
    expect((await rewardOf(f, pr.invitee)).row_version).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#11] 被邀请人的入账与他的发放、过期任务并发（入账先持有用户行锁，发放与过期都在锁上等待）：三者都完成、无死锁；结果与「入账 → 发放 → 过期」依次执行一致——触发为该单，发放 processed（两方 granted、两张 INVITE_REWARD 凭证、总预算占用 2000 转为已发放），订单只入账一次',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);
    const batch = await f.batch([o]);
    const side = rewardSide(f, p.pool('cit-reward-side'));
    const pause = pausingLock(f.h.identityLock, pr.invitee);

    await withWorker(
      f,
      { trigger: await productionTrigger(), lockUsers: pause.lockUsers },
      async (handler) => {
        const credit = execute(handler, f, batch);
        await pause.entered;
        const payout = side.payout.process(f.appId, pr.invitee);
        const expiry = side.expiry.expireIfDue(f.appId, pr.invitee);
        await waitLockWaiters(f.db, 2);
        pause.release();
        const settled = await Promise.allSettled([credit, payout, expiry]);
        expect(settled.map((s) => s.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled']);
        expect(settled[1]).toStrictEqual({ status: 'fulfilled', value: 'processed' });
      },
    );

    expect(await f.rebateOf(o)).toBe('CREDITED');
    expect(await creditedRows(f, o)).toBe(1);
    expect(await rewardOf(f, pr.invitee)).toMatchObject({
      status: 'processed',
      trigger_order_id: o.orderId,
      inviter_result: 'granted',
      invitee_result: 'granted',
    });
    expect((await rewardOf(f, pr.invitee)).triggered_at?.toISOString()).toBe(CREDITED_AT);
    expect(await rewardVoucherKeys(f)).toStrictEqual(
      [`INVITE_REWARD:${pr.invitee}:invitee`, `INVITE_REWARD:${pr.invitee}:inviter`].sort(),
    );
    expect(await budgetsOf(f)).toStrictEqual([
      { period: '2032-07-24', reserved_fen: 0n, granted_fen: 2000n },
      { period: 'total', reserved_fen: 0n, granted_fen: 2000n },
    ]);
  },
  TIMEOUT,
);
