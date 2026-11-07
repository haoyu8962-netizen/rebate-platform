// B2-04zzd (D10-816 ②, D10-817 ②): an R9 clawback's order.clawed_back carries the cause's reason —
// cause RIGHTS → 'RIGHTS', cause PARTIAL_REFUND → 'PART_REFUND' (the R9 sub_type column of the
// clawback-order.ts table; BR-TEXT-09 CLAWBACK sentences name {reason.title}). R8 keeps its reason.
// Each case asserts the R9 first, then the unchanged R8 of another order.
//
// B2-04lb harness (real rights command, real B2-04m credit, real B2-04s clawback; the bus is the
// harness spy). Default order credited at N 1000: 425 / 85 / 42, platform 448; deduction 400 or the
// union's new commission 600 → R9 clawback 170 / 34 / 17.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness, type Harness } from '../rights-credit/kit.ts';

const p = databaseFixture(createTestDatabase);

/** Payloads of the order.clawed_back publish calls after call index `from`. */
function clawedBack(h: Harness, from: number): Record<string, unknown>[] {
  return h.publish.mock.calls
    .slice(from)
    .filter(([, event]) => event.name === 'order.clawed_back')
    .map(([, event]) => event.payload as Record<string, unknown>);
}

it(
  '[AC-B2-04zzd#12] 入账后维权部分成功（应扣佣金 400）按 R9 扣回：order.clawed_back 带 reason RIGHTS；另一单维权全额成功（1200）按 R8 仍带 reason RIGHTS',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const from = h.publish.mock.calls.length;

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 600n });
    const id = `R${(await h.onlyRights(o)).id}`;
    const partial = clawedBack(h, from);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({
      order_id: o.orderId,
      order_key: o.orderKey,
      rights_event_id: id,
      transition: 'R9',
      reason: 'RIGHTS',
    });

    const full = await h.credited();
    const fromFull = h.publish.mock.calls.length;
    expect(await h.record(full, { deductionFen: 1200n, rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    const fullEvents = clawedBack(h, fromFull);
    expect(fullEvents).toHaveLength(1);
    expect(fullEvents[0]).toMatchObject({
      order_id: full.orderId,
      transition: 'R8',
      reason: 'RIGHTS',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#13] 维权 WAIT_COMMISSION 后联盟新佣金 600 经维权成功入口（cause RIGHTS，ref 该维权记录）按 R9 扣回：order.clawed_back 带 reason RIGHTS',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    const from = h.publish.mock.calls.length;

    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: waiting.id },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    const events = clawedBack(h, from);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      order_key: o.orderKey,
      rights_event_id: `R${waiting.id}`,
      transition: 'R9',
      reason: 'RIGHTS',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#14] 部分退款（cause PARTIAL_REFUND，新佣金 600，键 C5）按 R9 扣回：order.clawed_back 带 reason PART_REFUND；另一单新佣金 0 按 R8 仍带 reason COMMISSION_ZERO',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 5);
    const from = h.publish.mock.calls.length;

    expect(
      await h.apply(o, {
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'commission' },
        newCommissionFen: 600n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9', rightsEventId: 'C5' });
    const partial = clawedBack(h, from);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({
      order_id: o.orderId,
      order_key: o.orderKey,
      rights_event_id: 'C5',
      transition: 'R9',
      reason: 'PART_REFUND',
    });

    const zero = await h.credited();
    const fromZero = h.publish.mock.calls.length;
    expect(
      await h.apply(zero, {
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'commission' },
        newCommissionFen: 0n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    const zeroEvents = clawedBack(h, fromZero);
    expect(zeroEvents).toHaveLength(1);
    expect(zeroEvents[0]).toMatchObject({
      order_id: zero.orderId,
      transition: 'R8',
      reason: 'COMMISSION_ZERO',
    });
  },
  TIMEOUT,
);
