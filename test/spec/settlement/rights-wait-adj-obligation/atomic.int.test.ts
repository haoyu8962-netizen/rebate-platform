// B2-04zza: the R10 SETTLE_ADJUST vouchers, the obligation disposal (forfeited + forfeited event)
// and the closing of the waiting rights record (with rights_pending and the CLAWBACK_NO_COMMISSION
// pending row) share the order sync transaction (BR-FUND-06, BR-FUND-04 ⑫「同一事务关闭该义务」,
// D10-474 ②). A later failure on that transaction rolls all of it back; the redelivered sync posts
// exactly once, and a replay of the same change changes nothing (uniq_key `…:ADJ:{seq}`, BR-FUND-09).
//
// Same money as forfeit.int.test.ts: self held then banned; record 600 (seq 3) → direct −34,
// indirect −17, platform +76, self's 255 to the platform, obligation forfeited.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, people, receivable } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zza#13] 封禁受益人义务没收 + R10 记账 + 关闭维权记录同一事务：同步事务后续失败 → 凭证、余额、booked、义务、forfeited 事件、维权记录、rights_pending、待处理行全部回滚；重投这次同步只处置一次（ADJ:3 一组、义务 forfeited 一次、forfeited 事件一条），再重放同一变更什么都不变',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting({ people: people({ self: 'frozen' }) }, (seeded) =>
      h.setState(seeded, 'self', 'banned'),
    );
    const keys = await h.orderVoucherKeys(o);
    const events = await h.newBeneficiaryEvents(o);
    const before = await h.everything();

    h.clock.set(LATER);
    const failure = new Error('synthetic downstream failure');
    await expect(
      h.arrive(o, {
        settleAfter: 600n,
        newSeq: 3,
        after: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(await h.everything()).toEqual(before);
    expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'WAIT_COMMISSION' });

    const arrival = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });
    expect(arrival.result).toMatchObject({ outcome: 'settle_adjusted', transition: 'R10' });
    await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: -76n });
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.orderObligations(o)).toEqual([
      expect.objectContaining({ status: 'forfeited', closed_by: 'R10' }),
    ]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([
      ...events,
      expect.objectContaining({ user_id: o.user('self'), status: 'forfeited', reason: 'banned' }),
    ]);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);

    const settled = await h.everything();
    await h.deliver(arrival.change, arrival.source);
    expect(await h.everything()).toEqual(settled);
  },
  TIMEOUT,
);
