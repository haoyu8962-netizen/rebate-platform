// B2-04zzc, rule tests round 3 (task brief §11, Codex money r1 S1): the「B > 0」of BR-INV-24 ② is the
// booked base on every path that can trigger (D10-810), the daily expiry's late trigger included.
// growth's expiry runs through the scanner app.module assembles on the worker entry; its late trigger
// reads the in-window self orders through orders' fact port as app.module wires it.
// - #18 an order estimated 320 but booked 0 neither triggers at credit nor later: once the window
//   has ended the production expiry scan treats the qualification as having no triggering order in
//   its window (expired, both parties' reservation released; 08 BR-INV-24 细则「有效期」, the
//   counterpart of growth's [AC-B1-35#32] { base_fen: 0 }), never as a late trigger;
// - #19 the counterpart: orders booked 1000 that were credited without a trigger (credited by a
//   worker that had no trigger port, as before this task shipped) are still late-triggered by the
//   same scan, whatever their estimate (320, and 0): the read is fixed, the late trigger is kept.
// Orders as in trigger.int.test.ts: placed 2032-06-20 10:00 +08:00, paid 4990 (min_paid_fen unset =
// 0); qualified 2032-06-15 10:00 +08:00 for 60 days → the window ends 2032-08-14 10:00 +08:00.
// Credit clock 2032-07-24 10:00 +08:00; the scan runs 2032-08-15 10:00 +08:00.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, fixture } from '../batch-executor/kit.ts';
import {
  ELIGIBILITY_DAYS,
  QUALIFIED_AT,
  TIMEOUT,
  UNTRIGGERED,
  budgetsOf,
  creditInBatch,
  inviteeOrder,
  pair,
  productionTrigger,
  qualify,
  rewardOf,
  rewardVoucherKeys,
  triggerOf,
} from './kit.ts';
import { withProductionScanner } from './scanner-kit.ts';

const p = databaseFixture(createTestDatabase);

const DAY_MS = 24 * 60 * 60 * 1000;
/** One day after the window of the qualification ended. */
const SCAN_AT = '2032-08-15T10:00:00+08:00';
const SCANNED_AT = new Date(SCAN_AT).toISOString();

it(
  '[AC-B2-04zzc#18] 过期扫描的迟到触发同样取入账基数（D10-810，money r1 S1）：有效期内只有一笔自购单，预估 orders.base_fen = 320、入账 booked_base_fen = 0、实付 4990 达标 → 入账时不触发；时钟推进到有效期结束（08-14）之后，跑一轮 worker 入口生产装配的邀请奖励扫描 → 不写 trigger_order_id / triggered_at、不发放（无 INVITE_REWARD 凭证），资格按「期内无合格单」转 expired，释放总预算占用 2000',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr, { reserveBp: 10000, patch: { base_fen: 320n } });

    await creditInBatch(f, [o], { trigger: await productionTrigger() });
    const credited = await f.h.read(o);
    expect(credited.rebate_status).toBe('CREDITED');
    expect(credited.base_fen).toBe(320n);
    expect(credited.booked_base_fen).toBe(0n);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual(UNTRIGGERED);

    // The scan runs after the window ended (the order was placed inside it).
    const windowEnd = new Date(QUALIFIED_AT).getTime() + ELIGIBILITY_DAYS * DAY_MS;
    expect(o.attrAt.getTime()).toBeLessThan(windowEnd);
    expect(windowEnd).toBeLessThan(new Date(SCAN_AT).getTime());
    f.h.clock.set(SCAN_AT);
    await withProductionScanner(f, (scanner) => scanner.tick());

    expect(await triggerOf(f, pr.invitee)).toStrictEqual({
      status: 'expired',
      trigger_order_id: null,
      triggered_at: null,
    });
    expect(await rewardOf(f, pr.invitee)).toMatchObject({
      inviter_result: null,
      invitee_result: null,
      granted_at: null,
      row_version: 1,
    });
    expect(await rewardVoucherKeys(f)).toStrictEqual([]);
    expect(await budgetsOf(f)).toStrictEqual([
      { period: 'total', reserved_fen: 0n, granted_fen: 0n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#19] 对照（修的是读口径，不是关掉迟到触发）：两名被邀请人各一笔有效期内的自购单，入账 booked_base_fen 都是 1000、预估分别为 320 与 0，入账时 worker 未接触发端口而没有触发；有效期结束后同一生产装配的扫描对两人都按入账基数迟到触发（trigger_order_id 为各自的单、triggered_at 为扫描时刻），资格不过期、总预算占用不释放',
  async () => {
    const f = await fixture(p.db);
    const estimated = await pair(f);
    const unestimated = await pair(f);
    await qualify(f, estimated);
    await qualify(f, unestimated);
    const a = await inviteeOrder(f, estimated, { patch: { base_fen: 320n } });
    const b = await inviteeOrder(f, unestimated, { patch: { base_fen: 0n } });

    await creditInBatch(f, [a, b], { trigger: undefined });
    for (const [o, estimate] of [
      [a, 320n],
      [b, 0n],
    ] as const) {
      const credited = await f.h.read(o);
      expect(credited.rebate_status).toBe('CREDITED');
      expect(credited.base_fen).toBe(estimate);
      expect(credited.booked_base_fen).toBe(1000n);
    }
    expect(await triggerOf(f, estimated.invitee)).toStrictEqual(UNTRIGGERED);
    expect(await triggerOf(f, unestimated.invitee)).toStrictEqual(UNTRIGGERED);

    f.h.clock.set(SCAN_AT);
    await withProductionScanner(f, (scanner) => scanner.tick());

    for (const [pr, o] of [
      [estimated, a],
      [unestimated, b],
    ] as const) {
      const row = await rewardOf(f, pr.invitee);
      expect(
        { trigger_order_id: row.trigger_order_id, triggered_at: row.triggered_at?.toISOString() },
        pr.invitee,
      ).toStrictEqual({ trigger_order_id: o.orderId, triggered_at: SCANNED_AT });
      // Triggered: waiting for, or done with, the payout; never expired or voided.
      expect(['qualified', 'deferred', 'processed'], pr.invitee).toContain(row.status);
    }
    // Nothing was released: both reservations are still reserved or were paid.
    const total = (await budgetsOf(f)).find((row) => row.period === 'total');
    expect(total === undefined ? null : total.reserved_fen + total.granted_fen).toBe(4000n);
  },
  TIMEOUT,
);
