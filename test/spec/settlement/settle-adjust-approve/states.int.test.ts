// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): the beneficiary's state at approval
// decides where its positive difference goes (08 BR-CALC-09 受益人状态规则 (08 first): status=forfeited
// 的受益人新应得恒为 0、不生成任何调整；封禁 → 正向差额归平台；已注销（deletion_status ∈ {processing, done}）→
// 正向差额同样归平台；frozen / appealing → 正向差额延后；已识别未满 18 周岁：推广份额的正向差额归平台，自购份额不受
// 影响; D10-770 ②: 冻结受益人照常生成候选，批准时其正差转为待补记义务（BR-FUND-04 ⑫ 受益人补记项）).
// Every state is set after the candidates were generated (B2-09zb wrote a row for each member):
// approval reads the states again under its locks.
// Example (reserve 0, self 5000 bp, direct 1000 bp): credited at 1234 (617 / 123 / 494); settlement
// 1300 (650 / 130 / 520) → +33 / +7 / +26. A share given to the platform is added to the platform's
// +26; a deferred share is neither credited nor given to the platform.
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  approveHarness,
  approveSuite,
  expectApproved,
  ordered,
  platformIncrease,
  result,
  userIncrease,
  withAdmin,
  type ApproveHarness,
} from './kit.ts';

const s = approveSuite();

/** Credited at 1234, raised to 1300 and generated: rows +33 / +7 / +26 of one batch. */
async function seeded(h: ApproveHarness) {
  const { o, seq } = await h.raised(EXAMPLE, 1300n);
  const batchId = await h.generate();
  expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen])).toEqual([
    ['self', 33n],
    ['direct', 7n],
    [null, 26n],
  ]);
  return { o, seq, batchId };
}

it.each(['frozen', 'appealing'] as const)(
  '[AC-B2-09zc#3] 批准时本人 %s：不补给 available、不写他的凭证，转一条未完成的待补记义务（deferred，来源 SETTLE_ADJUST / SETTLE_DIFF）；直推 +7、平台 +26 照常（他的 +33 不归平台），credited_fen 7，候选都已批准',
  async (state) => {
    const h = await approveHarness(s);
    const { o, seq, batchId } = await seeded(h);
    await h.risk(o.user('self'), state);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 7)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(617n);
      expect(await h.netOf(o, 'self')).toBe(617n);
      expect(await h.balance(o.user('direct'))).toBe(130n);
      // UNION_RECEIVABLE = N − the deferred 33.
      expect(await h.receivableOf(o)).toBe(1267n);
      const obligations = await h.orderObligations(o);
      expect(obligations).toHaveLength(1);
      expect(obligations[0]).toMatchObject({
        user_id: o.user('self'),
        role: 'self',
        kind: 'deferred',
        status: 'open',
        origin_ledger_type: 'SETTLE_ADJUST',
        origin_sub_type: 'SETTLE_DIFF',
      });
      expect(['R10', 'R13']).toContain(obligations[0]!.opened_by);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
      expect((await h.rowsOf(o)).map((r) => r.status)).toEqual([
        'approved',
        'approved',
        'approved',
      ]);
    });
  },
  TIMEOUT,
);

const GONE = [
  { label: '封禁', state: 'banned' },
  { label: '注销处理中', state: 'deleting' },
  { label: '已注销', state: 'deleted' },
] as const;

it.each(GONE)(
  '[AC-B2-09zc#3] 批准时本人$label：他的 +33 归平台（平台 +59），不写他的凭证、余额 617 不变、不开义务；直推 +7 照常，credited_fen 7，应收 1300',
  async ({ state }) => {
    const h = await approveHarness(s);
    const { o, seq, batchId } = await seeded(h);
    if (state === 'banned') await h.risk(o.user('self'), 'banned');
    else if (state === 'deleting') await h.markDeleting(o.user('self'));
    else await h.markDeleted(o.user('self'));
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 7)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 59n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(617n);
      expect(await h.netOf(o, 'self')).toBe(617n);
      expect(await h.receivableOf(o)).toBe(1300n);
      expect(await h.orderObligations(o)).toEqual([]);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#3] 批准时直推已识别未成年（BR-ID-26 (b)，推广份额）：直推 +7 归平台（平台 +33），不写直推凭证；本人 +33 照常，credited_fen 33',
  async () => {
    const h = await approveHarness(s);
    const { o, seq, batchId } = await seeded(h);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await a.markMinor(o.user('direct'));
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 33)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...platformIncrease(o, 33n, seq),
      ]);
      expect(await h.balance(o.user('direct'))).toBe(123n);
      expect(await h.balance(o.user('self'))).toBe(650n);
      expect(await h.receivableOf(o)).toBe(1300n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#3] 批准时本人已识别未成年：自购份额不受影响，本人 +33、直推 +7、平台 +26 照常，credited_fen 40',
  async () => {
    const h = await approveHarness(s);
    const { o, seq, batchId } = await seeded(h);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await a.markMinor(o.user('self'));
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 40)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(650n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#3] 生成后直推份额 forfeited（commission 的受益人事件）：新应得恒为 0、不生成任何调整（不扣回已入账的 123），他的 +7 归平台（平台 +33）；本人 +33，credited_fen 33',
  async () => {
    const h = await approveHarness(s);
    const { o, seq, batchId } = await seeded(h);
    h.clock.advanceMs(60_000);
    await h.forfeitShare(o, 'direct');
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 33)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...platformIncrease(o, 33n, seq),
      ]);
      expect(await h.balance(o.user('direct'))).toBe(123n);
      expect(await h.netOf(o, 'direct')).toBe(123n);
      expect(await h.receivableOf(o)).toBe(1300n);
    });
  },
  TIMEOUT,
);
