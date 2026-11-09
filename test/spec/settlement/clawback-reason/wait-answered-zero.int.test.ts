// B2-04zzs rule tests (claude-independent): a credited order's rights success that waits for the union
// commission (WAIT_COMMISSION, BR-FUND-08 ③), answered by the union's new settlement record of 0, is a
// full rights clawback (R8): its order reason follows the BR-FUND-08 细则「sub_type 与订单原因码」full-rights
// row — Taobao by 08 BR-TEXT-05 细则「写入来源」① (a credited Taobao order was settled when the rights
// happened) → REFUND / AFTER_SETTLE; every other platform keeps RIGHTS (编排 D10-1126 ①, D10-1133 ④). The
// clawback itself is unchanged: sub_type FULL, uniq_keys C{commission_version}, amounts, the R8 history
// event, the waiting record closed SUCCEEDED in the same transaction, restore eligibility.
// Path: the B2-04lb harness (real rights command, real credit, real clawback orchestration): the
// waiting record through rights.record, then the simulated orders sync writing the union's STATEMENT
// record and the commission columns on one transaction and calling the clawback's onUpdated.
// Default order per platform: N 1000, reserve 1500 → B 850, 425 / 85 / 42, platform 448.
// Task-local AC labels ([AC-B2-04zzs#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness } from '../rights-credit/kit.ts';
import { eventsOf, expectFullClawback, expectRestorable } from './pipeline.ts';

const p = databaseFixture(createTestDatabase);

it.each([
  { platform: 'taobao', reason: 'REFUND', reasonSub: 'AFTER_SETTLE' },
  { platform: 'jd', reason: 'RIGHTS', reasonSub: null },
  { platform: 'pdd', reason: 'RIGHTS', reasonSub: null },
] as const)(
  '[AC-B2-04zzs#6] [AC-B2-04zzs#7] $platform 入账后维权成功等联盟佣金（WAIT_COMMISSION），联盟新结算记录 0（seq 3）回应：R8 整单扣回（sub_type FULL，键 C{commission_version}，425 / 85 / 42、平台 448，booked 0 / 0），该维权记录关闭为 SUCCEEDED；reason = $reason、reason_sub = $reasonSub（不是 COMMISSION_ZERO），order.clawed_back 带同一 reason；仍可按 BR-FUND-22 恢复',
  async ({ platform, reason, reasonSub }) => {
    const h = await harness(p.db);
    const o = await h.credited({ platform });
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ type: 'RIGHTS', status: 'WAIT_COMMISSION' });
    expect(await h.clawbackKeys(o)).toEqual([]);

    h.clock.set(LATER);
    const outcome = await h.syncCredited(o, {
      event: 'PLATFORM_SETTLED',
      settleAfter: 0n,
      newSeq: 3,
    });

    const row = await h.read(o);
    const eventId = `C${String(row.commission_version)}`;
    expect(outcome.result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      rightsEventId: eventId,
    });
    await expectFullClawback(h, o, eventId, 'FULL');
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'COMMISSION_POSITIVE_ZERO',
      }),
    ]);
    expect(await h.onlyRights(o)).toMatchObject({ id: waiting.id, status: 'SUCCEEDED' });
    expect(row).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      rights_pending: false,
      reason,
      reason_sub: reasonSub,
      reason_sub_manual: false,
    });
    const events = eventsOf(h, 'order.clawed_back', o.orderId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rights_event_id: eventId, transition: 'R8', reason });
    await expectRestorable(h, o);
  },
  TIMEOUT,
);
