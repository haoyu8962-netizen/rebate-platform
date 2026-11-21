// B2-02ze (claude-independent, SPEC_REF d49d8aa5): the sms-tier step-up token of
// recalcBalanceAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc: fund.recon,
// operation fund.recon.balance_recalc, no Idempotency-Key) when the outcome of the COMMIT is unknown
// (task brief §9.2 #5–#7; 08 BR-ID-34 二次验证, BR-FUND-19 「差异以分录为准修正」). Controls in the
// same case: a failure inside the transaction (rolled back) and a business refusal give the token
// back; a success consumes it. Two more unknown outcomes the client cannot tell apart from a lost
// COMMIT acknowledgement: the connection drops before the COMMIT reaches the database (nothing
// committed, no audit row to find afterwards), and the driver's bare Error without SQLSTATE while the
// COMMIT awaits its acknowledgement. Seeds and contract checks from
// ../../ledger/admin-recon-balance-recalc/kit.ts; the entry from ./kit.ts on the faulty handle.
// Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  RECALC_ACTION,
  RECON,
  audits,
  cacheOf,
  expectRecalculated,
  fixture,
  notApplicable,
  plainMember,
  recalcPath,
  seedMismatch,
  stepUpRequired,
  suite,
  tamper,
  written,
} from '../../ledger/admin-recon-balance-recalc/kit.ts';
import { expectFailed, withEntry } from './kit.ts';

const s = suite();

const REASON = '分录与订单、提现单据核对无误，按分录重算余额缓存';

it('[AC-B2-02ze#8] 短信档（余额重算，无幂等键）：业务提交时连接中断、结果未知 → 应答为错误，用同一令牌重试 → 10003，重算没有第二次执行（余额行只改一次、审计只有一条）；对照：事务回调内失败已回滚 → 同一令牌重试照常成功、成功后该令牌再用 → 10003；业务正常返回拒绝（20001）→ 令牌照旧可用', async () => {
  const f = fixture(s);
  await withEntry(f, async (h) => {
    const recon = await h.caller([RECON]);
    const recalc = (reconDiffId: string, token: string) =>
      h.post(
        recalcPath(reconDiffId),
        { reason: REASON },
        { caller: recon, stepUp: token, key: null },
      );

    // Control (#6): the audit INSERT fails inside the callback; the transaction rolls back.
    const first = await plainMember(f, 4900n);
    const firstBefore = await tamper(f, first, {
      available: 5000n,
      frozen: 0n,
      negativeSince: null,
    });
    const firstDiff = await seedMismatch(f, first);
    const rolledBack = await h.stepUp(recon, 'sms');
    h.fault.arm('statement', RECALC_ACTION);
    expectFailed(await recalc(firstDiff.id, rolledBack));
    expect(h.fault.tripped, '回调内的失败已注入').toBe(1);
    expect(await cacheOf(f, first), '已回滚：余额行不变').toEqual(firstBefore);
    expect(await audits(f, RECALC_ACTION), '已回滚：没有审计').toEqual([]);
    await expectRecalculated(f, await recalc(firstDiff.id, rolledBack), {
      m: first,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, first)).toEqual(
      written(firstBefore, { available: 4900n, frozen: 0n, negativeSince: null }),
    );
    // Control (#7): a success consumed it.
    await stepUpRequired(await recalc(firstDiff.id, rolledBack));
    expect(await audits(f, RECALC_ACTION)).toHaveLength(1);

    // Control (#6): a refusal answered by the business gives the token back.
    const token = await h.stepUp(recon, 'sms');
    await notApplicable(await recalc(randomUUID(), token));

    // #5: the COMMIT goes through, the caller sees a dropped connection.
    const second = await plainMember(f, 3000n);
    const secondBefore = await tamper(f, second, {
      available: 3600n,
      frozen: 0n,
      negativeSince: null,
    });
    const secondDiff = await seedMismatch(f, second);
    h.fault.arm('commit_lost', RECALC_ACTION);
    expectFailed(await recalc(secondDiff.id, token));
    expect(h.fault.tripped, '提交时的连接中断已注入').toBe(2);
    const committed = written(secondBefore, { available: 3000n, frozen: 0n, negativeSince: null });
    expect(await cacheOf(f, second), 'COMMIT 实际已生效').toEqual(committed);
    const once = await audits(f, RECALC_ACTION);
    expect(once, '这次重算的审计已提交').toHaveLength(2);

    await stepUpRequired(await recalc(secondDiff.id, token));
    expect(await cacheOf(f, second), '重算没有第二次执行').toEqual(committed);
    expect(await audits(f, RECALC_ACTION), '审计只有一条').toEqual(once);
  });
});

it('[AC-B2-02ze#10] 短信档（余额重算）：连接在 COMMIT 抵达数据库之前断开（库里没有提交），调用方同样只见连接中断 → 应答为错误，重算没有生效、没有审计；结果未知就不释放（不能以「错误后查得到审计行」判定）：用同一令牌重试 → 10003，库里仍没有重算、没有审计；对照：重新验证拿到的新令牌照常完成重算', async () => {
  const f = fixture(s);
  await withEntry(f, async (h) => {
    const recon = await h.caller([RECON]);
    const recalc = (reconDiffId: string, token: string) =>
      h.post(
        recalcPath(reconDiffId),
        { reason: REASON },
        { caller: recon, stepUp: token, key: null },
      );

    const m = await plainMember(f, 2500n);
    const before = await tamper(f, m, { available: 2800n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const token = await h.stepUp(recon, 'sms');
    h.fault.arm('commit_unsent', RECALC_ACTION);
    expectFailed(await recalc(diff.id, token));
    expect(h.fault.tripped, 'COMMIT 之前的连接中断已注入').toBe(1);
    expect(await cacheOf(f, m), '没有提交：余额行不变').toEqual(before);
    expect(await audits(f, RECALC_ACTION), '没有提交：没有审计').toEqual([]);

    await stepUpRequired(await recalc(diff.id, token));
    expect(await cacheOf(f, m), '同一令牌重试没有执行重算').toEqual(before);
    expect(await audits(f, RECALC_ACTION), '同一令牌重试没有审计').toEqual([]);

    // Control: only the token is held back; a fresh step-up completes the recalculation.
    const fresh = await h.stepUp(recon, 'sms');
    await expectRecalculated(f, await recalc(diff.id, fresh), {
      m,
      before: { available: 2800n, frozen: 0n },
      after: { available: 2500n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(before, { available: 2500n, frozen: 0n, negativeSince: null }),
    );
    expect(await audits(f, RECALC_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-02ze#11] 短信档（余额重算）：COMMIT 已执行、等待确认时驱动抛出不带 SQLSTATE 的 Error(「Connection terminated unexpectedly」) → 应答为错误；用同一令牌重试 → 10003，重算只执行一次（余额行只改一次）、审计只有一条', async () => {
  const f = fixture(s);
  await withEntry(f, async (h) => {
    const recon = await h.caller([RECON]);
    const recalc = (reconDiffId: string, token: string) =>
      h.post(
        recalcPath(reconDiffId),
        { reason: REASON },
        { caller: recon, stepUp: token, key: null },
      );

    const m = await plainMember(f, 4000n);
    const before = await tamper(f, m, { available: 4100n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const token = await h.stepUp(recon, 'sms');
    h.fault.arm('commit_lost_bare', RECALC_ACTION);
    expectFailed(await recalc(diff.id, token));
    expect(h.fault.tripped, '提交确认时的连接中断（无 SQLSTATE）已注入').toBe(1);
    const committed = written(before, { available: 4000n, frozen: 0n, negativeSince: null });
    expect(await cacheOf(f, m), 'COMMIT 实际已生效').toEqual(committed);
    const once = await audits(f, RECALC_ACTION);
    expect(once, '这次重算的审计已提交').toHaveLength(1);

    await stepUpRequired(await recalc(diff.id, token));
    expect(await cacheOf(f, m), '重算没有第二次执行').toEqual(committed);
    expect(await audits(f, RECALC_ACTION), '审计只有一条').toEqual(once);
  });
});
