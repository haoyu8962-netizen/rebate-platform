// B2-04zzs rule tests (claude-independent): the order reason of a successful Taobao rights record
// follows 08 BR-TEXT-05 细则「写入来源」① (负责人 2026-11-07; 08 BR-FUND-08 细则「sub_type 与订单原因码」全额维权行,
// 编排 D10-1126 ①):
//   - 维权时订单已结算（earning_time 有值）→ REFUND / AFTER_SETTLE;
//   - 确认收货前 → REFUND / IN_SALE;
//   - 确认收货后、结算前（earning_time 为空）→ RIGHTS / AFTER_SALE.
// Only orders.reason / reason_sub (and the reason the order.clawed_back / order.invalidated events carry)
// follow it: amounts, CLAWBACK sub_type RIGHTS and uniq_keys R{order_rights.id}, the R6 / R8 / R9
// transitions and their history events, and restore eligibility (BR-FUND-22) are unchanged, and each
// test pins them alongside. A partial rights success (R9) keeps the order reason and claws back the
// partial amount only (never borrowed as a full cause that forces N_new = 0).
// Path: the real Taobao rights sync (see pipeline.ts), earning_time given by the adapter's test double.
// Task-local AC labels ([AC-B2-04zzs#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  harness,
  type Harness,
  type SeededOrder,
} from '../rights-credit/kit.ts';
import {
  EARNING_AT,
  eventsOf,
  expectApiRights,
  expectFullClawback,
  expectPartialClawback,
  expectRestorable,
  taobaoRightsSync,
} from './pipeline.ts';

const p = databaseFixture(createTestDatabase);

/** Rebate history rows of the order (field rebate), as event / from / to. */
async function rebateSteps(h: Harness, o: SeededOrder) {
  return (await h.history(o))
    .filter((r) => r.field === 'rebate')
    .map((r) => ({ event: r.event, from_status: r.from_status, to_status: r.to_status }));
}

/** A pre-credit VOID by R6 RIGHTS_FULL: no voucher, one order.invalidated carrying `reason`. */
async function expectPrecreditVoid(
  h: Harness,
  o: SeededOrder,
  from: 'ESTIMATED' | 'WAITING',
  reason: string,
  reasonSub: string | null,
): Promise<void> {
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'VOID',
    reason,
    reason_sub: reasonSub,
    reason_sub_manual: false,
    booked_base_fen: null,
    booked_n_fen: null,
    rights_pending: false,
  });
  expect((await rebateSteps(h, o)).at(-1)).toEqual({
    event: 'RIGHTS_FULL',
    from_status: from,
    to_status: 'VOID',
  });
  expect(await h.orderVoucherKeys(o)).toEqual([]);
  expect(eventsOf(h, 'order.clawed_back', o.orderId)).toEqual([]);
  const invalidated = eventsOf(h, 'order.invalidated', o.orderId);
  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]).toMatchObject({ order_id: o.orderId, reason });
  await expectRestorable(h, o);
}

it(
  '[AC-B2-04zzs#1] [AC-B2-04zzs#4] [AC-B2-04zzs#7] 淘宝维权全额成功（应扣 1000 = N）、维权时订单已结算（earning_time 有值）：已入账单按 R8 扣回（RIGHTS_FULL，sub_type RIGHTS，键 R{id}，425 / 85 / 42、平台 448，booked 0 / 0），reason = REFUND、reason_sub = AFTER_SETTLE，order.clawed_back 带 REFUND；入账前（WAITING）同样一单按 R6 RIGHTS_FULL 作废，REFUND / AFTER_SETTLE；对照：同样已结算的部分维权（应扣 400）按 R9 只扣 170 / 34 / 17、平台 179，reason 不写、diff_reason_code PART_REFUND；作废 / 扣回后仍可按 BR-FUND-22 恢复',
  async () => {
    const h = await harness(p.db);
    const sync = taobaoRightsSync(p.db, h);

    // Credited, full rights after the union's settlement.
    const full = await h.credited();
    expect(await sync.deliver(full, { fen: 1000n, earningAt: EARNING_AT })).toBe('applied');
    const fullRow = await expectApiRights(h, full, 1000n);
    const fullId = `R${fullRow.id}`;
    await expectFullClawback(h, full, fullId, 'RIGHTS');
    expect(await h.rebateHistoryAfterCredit(full)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'RIGHTS_FULL',
      }),
    ]);
    expect(await h.read(full)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      rights_pending: false,
      reason: 'REFUND',
      reason_sub: 'AFTER_SETTLE',
      reason_sub_manual: false,
    });
    const fullEvents = eventsOf(h, 'order.clawed_back', full.orderId);
    expect(fullEvents).toHaveLength(1);
    expect(fullEvents[0]).toMatchObject({
      order_key: full.orderKey,
      rights_event_id: fullId,
      transition: 'R8',
      reason: 'REFUND',
    });
    await expectRestorable(h, full);

    // Not yet credited (WAITING, platform SETTLED, settlement 1000): the same record voids it.
    const waiting = await h.order();
    expect(await sync.deliver(waiting, { fen: 1000n, earningAt: EARNING_AT })).toBe('applied');
    await expectApiRights(h, waiting, 1000n);
    await expectPrecreditVoid(h, waiting, 'WAITING', 'REFUND', 'AFTER_SETTLE');

    // Control (#4): a partial rights success after settlement stays R9 on its own deduction.
    const partial = await h.credited();
    expect(await sync.deliver(partial, { fen: 400n, earningAt: EARNING_AT })).toBe('applied');
    const partialRow = await expectApiRights(h, partial, 400n);
    const partialId = `R${partialRow.id}`;
    await expectPartialClawback(h, partial, partialId);
    expect(await h.rebateHistoryAfterCredit(partial)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    ]);
    expect(await h.rebateColumns(partial)).toEqual({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      reason: null,
      diff_reason_code: 'PART_REFUND',
      rights_pending: false,
      hold: false,
    });
    expect((await h.read(partial)).reason_sub).toBeNull();
    const partialEvents = eventsOf(h, 'order.clawed_back', partial.orderId);
    expect(partialEvents).toHaveLength(1);
    expect(partialEvents[0]).toMatchObject({
      rights_event_id: partialId,
      transition: 'R9',
      reason: 'RIGHTS',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzs#2] [AC-B2-04zzs#3] [AC-B2-04zzs#7] 淘宝维权全额成功、未入账：确认收货前（ESTIMATED，平台 PAID，未收货，earning_time 空）→ R6 RIGHTS_FULL 作废，reason = REFUND、reason_sub = IN_SALE，order.invalidated 带 REFUND；对照：确认收货后、结算前（WAITING，平台 RECEIVED，earning_time 空）→ 同样 R6 作废，reason = RIGHTS、reason_sub = AFTER_SALE；两单都不写分录、仍可按 BR-FUND-22 恢复',
  async () => {
    const h = await harness(p.db);
    const sync = taobaoRightsSync(p.db, h);

    // No settlement record: the effective union commission is the estimate (3222), below 5000.
    const unreceived = await h.order({
      seqs: [],
      patch: { rebate_status: 'ESTIMATED', platform_status: 'PAID', received_at: null },
    });
    expect(await sync.deliver(unreceived, { fen: 5000n, earningAt: null })).toBe('applied');
    await expectApiRights(h, unreceived, 5000n);
    await expectPrecreditVoid(h, unreceived, 'ESTIMATED', 'REFUND', null);

    // Received 2032-06-20, the rights record 2032-07-20, no settlement yet.
    const received = await h.order({
      seqs: [],
      patch: { rebate_status: 'WAITING', platform_status: 'RECEIVED' },
    });
    expect(await sync.deliver(received, { fen: 5000n, earningAt: null })).toBe('applied');
    await expectApiRights(h, received, 5000n);
    await expectPrecreditVoid(h, received, 'WAITING', 'RIGHTS', 'AFTER_SALE');
  },
  TIMEOUT,
);
