// B2-04zza (D10-781 P3): the same order sync raises refunded_quantity and carries the union's new
// settlement record while the order's rights success waits for the union (WAIT_COMMISSION). The
// record answers the waiting rights record (BR-FUND-06「入账后新结算记录回应待佣金维权见 BR-FUND-08
// 细则 D10-474 ②，按 R10 SETTLE_ADJUST 处理」): R10 SETTLE_ADJUST keyed `…:ADJ:{seq}`, rebate
// history SETTLE_NEGATIVE_DIFF — not an R9 CLAWBACK (no `…:CLAWBACK:…` key, no PART_REFUND
// diff_reason_code, no order.clawed_back event). Here with an obligation kept (self held at credit,
// still frozen), the path this task opens.
//
// Credit: self held (pending 425), direct 85, indirect 42, platform 448, UNION_RECEIVABLE 575.
// Record 600 (seq 3) → direct −34, indirect −17, platform −179; pending 425 → 255; 575 → 345.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, people, receivable } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zza#17] 同一次同步里退款数量 0 → 1 且带来联盟新结算记录 600，订单有等佣金的维权（本人入账时冻结、仍冻结）→ 走 R10 而非 R9：只写 ADJ:3 调整（直推 −34、间推 −17、平台 −179），无 CLAWBACK 凭证、不写 PART_REFUND、不发 order.clawed_back，历史为 SETTLE_NEGATIVE_DIFF；义务保持、待补记 255（应收 345），维权记录同事务关闭',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting({
      people: people({ self: 'frozen' }),
      patch: { quantity: 3 },
    });
    const before = await h.read(o);
    expect(before.refunded_quantity).toBe(0);
    const obligations = await h.orderObligations(o);
    const keys = await h.orderVoucherKeys(o);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, {
      settleAfter: 600n,
      newSeq: 3,
      refundedQuantityAfter: 1,
    });

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: 179n });
    expect(await h.clawbackKeys(o)).toEqual([]);
    const after = await h.read(o);
    expect(after.refunded_quantity).toBe(1);
    expect(after.diff_reason_code).toBe(before.diff_reason_code);
    expect(after.reason).toBe(before.reason);
    expect((await h.published()).filter((e) => e.name === 'order.clawed_back')).toEqual([]);
    expect(await h.orderObligations(o)).toEqual(obligations);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(345n);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);
    expect(h.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);
