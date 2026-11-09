// B2-04zzs rule tests (claude-independent): a refund that leaves no quantity (整单退款) on a credited order is
// the BR-FUND-08 细则「sub_type 与订单原因码」row「平台失效、结算后失效或整单退款」: R8, sub_type FULL, order
// reason REFUND — not COMMISSION_ZERO (08 BR-CALC-15「剩余数量为 0 … 按整单失效」; 编排 D10-1126 ①). 「退一部分、
// 佣金降到 0」stays on the COMMISSION_ZERO row (D10-1126: 不是整单退款). Only the reason (and the reason the
// order.clawed_back event carries) differs between the two: amounts, sub_type FULL, uniq_keys
// C{commission_version}, the R8 history event and restore eligibility are the same and pinned here.
// Path: the real B2-04s clawback orchestration's onUpdated on the orders sync transaction, after the
// union's new settlement record of 0 written through settlement's record port (refund-r9-baseline
// syncWithRecord). Order: taobao, quantity 2, refunded 0 at credit, an API settlement record of 1000,
// reserve 1500 → B 850, credited 425 / 85 / 42, platform 448.
// Task-local AC labels ([AC-B2-04zzs#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  harness,
  type Harness,
  type SeededOrder,
} from '../clawback/kit.ts';
import { creditedApiOnly, syncWithRecord } from '../refund-r9-baseline/kit.ts';
import { eventsOf, expectFullClawback, expectRestorable } from './pipeline.ts';

const p = databaseFixture(createTestDatabase);

/** The union's new settlement 0 with `refundedAfter` of 2 refunded, on one sync transaction. */
async function zeroAfterRefund(h: Harness, o: SeededOrder, refundedAfter: number) {
  const result = await syncWithRecord(p.db, h, o, { refundedAfter, settleFen: 0n });
  expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
  const row = await h.read(o);
  const eventId = `C${String(row.commission_version)}`;
  await expectFullClawback(h, o, eventId, 'FULL');
  expect(await h.rebateHistoryAfterCredit(o)).toEqual([
    expect.objectContaining({
      from_status: 'CREDITED',
      to_status: 'CLAWED_BACK',
      event: 'COMMISSION_POSITIVE_ZERO',
    }),
  ]);
  return { row, eventId };
}

it(
  '[AC-B2-04zzs#5] [AC-B2-04zzs#7] 入账后退到剩余数量 0（2 件全退）且联盟新结算 0：R8 整单扣回（sub_type FULL，键 C{commission_version}，425 / 85 / 42、平台 448，booked 0 / 0），reason = REFUND（不是 COMMISSION_ZERO），order.clawed_back 带 REFUND；对照：只退 1 件、结算同样降到 0 → 金额、sub_type、迁移都相同，reason 仍 COMMISSION_ZERO（「联系客服」那条照旧）；两单都仍可按 BR-FUND-22 恢复',
  async () => {
    const h = await harness(p.db);

    const whole = await creditedApiOnly(p.db, h, { quantity: 2, refunded: 0 });
    const wholeOut = await zeroAfterRefund(h, whole, 2);
    expect(wholeOut.row).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      refunded_quantity: 2,
      reason: 'REFUND',
    });
    const wholeEvents = eventsOf(h, 'order.clawed_back', whole.orderId);
    expect(wholeEvents).toHaveLength(1);
    expect(wholeEvents[0]).toMatchObject({
      rights_event_id: wholeOut.eventId,
      transition: 'R8',
      reason: 'REFUND',
    });
    await expectRestorable(h, whole);

    const part = await creditedApiOnly(p.db, h, { quantity: 2, refunded: 0 });
    const partOut = await zeroAfterRefund(h, part, 1);
    expect(partOut.row).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      refunded_quantity: 1,
      reason: 'COMMISSION_ZERO',
      reason_sub: null,
    });
    const partEvents = eventsOf(h, 'order.clawed_back', part.orderId);
    expect(partEvents).toHaveLength(1);
    expect(partEvents[0]).toMatchObject({
      rights_event_id: partOut.eventId,
      transition: 'R8',
      reason: 'COMMISSION_ZERO',
    });
    await expectRestorable(h, part);
  },
  TIMEOUT,
);
