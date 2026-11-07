// B2-04zza: three beneficiaries of one CREDITED order in different states (BR-CALC-09, BR-FUND-09
// 负差一路「同一路里逐受益人按 BR-CALC-09 的状态规则算差额，平台差额随所在一路记账」), the rights success
// waiting for the union (WAIT_COMMISSION), answered by the union's new record 600 (seq 3) as R10
// SETTLE_ADJUST on one transaction (BR-FUND-06 / D10-474 ②): the normal one is debited, the banned
// one's obligation is forfeited (its share to the platform, forfeited event), the frozen one's
// difference stays pending (obligation kept, or a new deferred one opened by R10).
// Record 600 → B 510 → re-split shares 255 / 51 / 25.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LATER,
  TIMEOUT,
  databaseFixture,
  harness,
  people,
  receivable,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function obligationOf(h: Harness, o: SeededOrder, role: 'direct' | 'indirect') {
  return (await h.orderObligations(o)).filter((r) => r.role === role);
}

// Credit: self 425; direct and indirect held (pending 85 / 42); platform 448; UNION_RECEIVABLE 873.
// Then direct banned, indirect still frozen. Record 600:
//   self 425 → 255 (−170); direct: net 0, share 51 → platform, obligation forfeited;
//   indirect: net 0, share 25 → pending 42 → 25, obligation kept;
//   platform new = 600 − (255 + 0 + 25) = 320, old 448 → −128;
//   UNION_RECEIVABLE Δ = −170 − 128 = −298 = −(1000 − 600) − (25 − 127); 873 → 575.
it(
  '[AC-B2-04zza#15] 同一单三位受益人：本人正常、直推入账时冻结后封禁、间推入账时冻结仍冻结；维权等佣金中联盟新结算记录 600 负差 → 同一事务 R10 记账（本人 −170、平台 −128，直推与间推不写凭证）：直推义务 forfeited / R10 并追加 forfeited 事件，间推义务保持未完成、待补记 42 → 25；维权记录关闭，应收 575、booked 510 / 600',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting(
      { people: people({ direct: 'frozen', indirect: 'frozen' }) },
      (seeded) => h.setState(seeded, 'direct', 'banned'),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(873n);
    const indirect = await obligationOf(h, o, 'indirect');
    expect(indirect).toEqual([expect.objectContaining({ kind: 'first_credit', status: 'open' })]);
    expect(await obligationOf(h, o, 'direct')).toEqual([
      expect.objectContaining({ kind: 'first_credit', status: 'open' }),
    ]);
    const keys = await h.orderVoucherKeys(o);
    const events = await h.newBeneficiaryEvents(o);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectAdjusted(o, keys, 3, { users: { self: 170n }, platform: 128n });
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(575n);
    expect(await obligationOf(h, o, 'direct')).toEqual([
      expect.objectContaining({
        status: 'forfeited',
        closed_by: 'R10',
        closed_at: new Date(LATER),
      }),
    ]);
    expect(await obligationOf(h, o, 'indirect')).toEqual(indirect);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      ...events,
      expect.objectContaining({
        user_id: o.user('direct'),
        role: 'direct',
        status: 'forfeited',
        reason: 'banned',
      }),
    ]);
    expect(await h.candidates(o)).toEqual([]);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);
    expect(h.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);

// Credit: self 425, direct held (pending 85), indirect 42; platform 448; UNION_RECEIVABLE 915.
// Then an earlier clawback moved indirect's 42 to the platform (net 0, platform 490), direct banned,
// indirect frozen (no obligation). Record 600:
//   self −170; direct: share 51 → platform, obligation forfeited;
//   indirect: net 0, share 25 → pending 25, new deferred obligation (R10);
//   platform new = 600 − (255 + 0 + 25) = 320, old 490 → −170;
//   UNION_RECEIVABLE Δ = −170 − 170 = −340 = −(1000 − 600) − (25 − 85); 915 → 575.
it(
  '[AC-B2-04zza#16] 同一单三位受益人：本人正常、直推有 first_credit 义务且封禁、间推净额已为 0 无义务且冻结；联盟新结算记录 600 负差回应等佣金维权 → R10 记账（本人 −170、平台 −170）：直推义务 forfeited 并追加事件，间推新开 deferred 义务（opened_by R10、待补记 25）；维权记录关闭，应收 575',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting(
      { people: people({ direct: 'frozen' }) },
      async (seeded) => {
        await h.pastVoucher(seeded, 'indirect', 42n, 'revenue');
        await h.setState(seeded, 'direct', 'banned');
        await h.setState(seeded, 'indirect', 'frozen');
      },
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(915n);
    expect(await obligationOf(h, o, 'indirect')).toEqual([]);
    const keys = await h.orderVoucherKeys(o);
    const events = await h.newBeneficiaryEvents(o);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    await h.expectAdjusted(o, keys, 3, { users: { self: 170n }, platform: 170n });
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(575n);
    expect(await obligationOf(h, o, 'direct')).toEqual([
      expect.objectContaining({ kind: 'first_credit', status: 'forfeited', closed_by: 'R10' }),
    ]);
    expect(await obligationOf(h, o, 'indirect')).toEqual([
      expect.objectContaining({
        user_id: o.user('indirect'),
        kind: 'deferred',
        status: 'open',
        opened_by: 'R10',
        origin_ledger_type: 'SETTLE_ADJUST',
        origin_sub_type: 'SETTLE_DIFF',
        opened_at: new Date(LATER),
      }),
    ]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      ...events,
      expect.objectContaining({ user_id: o.user('direct'), status: 'forfeited', reason: 'banned' }),
    ]);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);
    expect(h.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);
