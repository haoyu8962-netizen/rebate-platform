// B2-04zzs rule tests, second round (claude-independent; D10-1169 ③): the whole-order refund (refunded to a
// remaining quantity of 0, BR-CALC-15「剩余数量为 0 … 按整单失效」) carries the order reason REFUND and writes
// no sub-reason — orders.reason_sub stays null (BR-TEXT-05 ①'s AFTER_SETTLE / IN_SALE are for Taobao rights
// only). Added beside remaining-zero.int.test.ts (frozen at spec_commit) instead of editing it.
// Unchanged and pinned with it: R8 with sub_type FULL and uniq_keys C{commission_version}, 425 / 85 / 42,
// platform 448, booked 0 / 0, the history event COMMISSION_POSITIVE_ZERO, one order.clawed_back event
// carrying REFUND, BR-FUND-22 restore eligibility.
// Path: as remaining-zero.int.test.ts — the real B2-04s clawback orchestration's onUpdated on the orders
// sync transaction after the union's new settlement record of 0 (refund-r9-baseline syncWithRecord);
// taobao, quantity 2, refunded 0 at credit, API settlement record 1000, reserve 1500 → B 850.
// Task-local AC labels ([AC-B2-04zzs#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness } from '../clawback/kit.ts';
import { creditedApiOnly, syncWithRecord } from '../refund-r9-baseline/kit.ts';
import { eventsOf, expectFullClawback, expectRestorable } from './pipeline.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzs#5] [AC-B2-04zzs#7] 入账后 2 件全退（剩余数量 0）且联盟新结算 0：R8 整单扣回（sub_type FULL，键 C{commission_version}，425 / 85 / 42、平台 448，booked 0 / 0，迁移事件 COMMISSION_POSITIVE_ZERO），reason = REFUND 且不写子原因（reason_sub 为 null，D10-1169 ③），order.clawed_back 带 REFUND；仍可按 BR-FUND-22 恢复',
  async () => {
    const h = await harness(p.db);
    const o = await creditedApiOnly(p.db, h, { quantity: 2, refunded: 0 });

    const result = await syncWithRecord(p.db, h, o, { refundedAfter: 2, settleFen: 0n });
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });

    const row = await h.read(o);
    expect(row).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      refunded_quantity: 2,
      reason: 'REFUND',
      reason_sub: null,
    });

    const eventId = `C${String(row.commission_version)}`;
    await expectFullClawback(h, o, eventId, 'FULL');
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'COMMISSION_POSITIVE_ZERO',
      }),
    ]);

    const events = eventsOf(h, 'order.clawed_back', o.orderId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rights_event_id: eventId,
      transition: 'R8',
      reason: 'REFUND',
    });

    await expectRestorable(h, o);
  },
  TIMEOUT,
);
