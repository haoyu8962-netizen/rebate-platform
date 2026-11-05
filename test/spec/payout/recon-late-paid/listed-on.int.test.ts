// BR-WDR-23: daily R2 regression, independent of late_paid_check dispatch.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  BILL_DATE,
  NEAR_DAY_END,
  NEXT_BILL_DATE,
  NEXT_RUN,
  channelOrderId,
  diffs,
  diffsOf,
  expectReconHold,
  holdsOf,
  lineOf,
} from '../recon-channel/kit.ts';
import { suite } from './late-paid-harness.ts';

const s = suite();

it('[AC-B2-09t#22] 先跑 D 的未知流水，再补日界 PAID_MANUAL，D+1 不误报；不同流水仍报差错 [AC-B2-09t#23]', async () => {
  const observations = [];
  // Run the negative control too, before the currently-red matching case is asserted.
  for (const matches of [false, true]) {
    const f = await s.setup();
    const order = channelOrderId();
    f.setBill(BILL_DATE, [
      lineOf({ outBizNo: 'unused', net: 1000n }, { outBizNo: null, channelOrderId: order }),
    ]);
    await f.runDay();
    const unknown = await diffs(f);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.resolution).toMatchObject({ case: 'unknown_line' });
    // Required order: the withdrawal exists only AFTER D was stored as unknown_line.
    const w = await f.seedManual(NEAR_DAY_END);
    if (matches)
      await sql`UPDATE app.withdrawals SET channel_order_id = ${order}
      WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(f.h.db);
    f.clock.set(NEXT_RUN);
    f.setBill(NEXT_BILL_DATE, []);
    await f.runDay(NEXT_BILL_DATE);
    const found = await diffsOf(f, [w.id]);
    const holds = await holdsOf(f, w.userId);
    observations.push({ matches, missing: found.length, holds: holds.length });
    expect((await diffs(f)).find((d) => d.id === unknown[0]!.id)).toEqual(unknown[0]);
    if (!matches) {
      expect(found[0]?.resolution).toMatchObject({ case: 'paid_not_in_bill' });
      await expectReconHold(f, w.userId, found[0]);
    }
  }
  expect(observations).toEqual([
    { matches: false, missing: 1, holds: 1 },
    { matches: true, missing: 0, holds: 0 },
  ]);
}, 60_000);

it('[AC-B2-09t#24] 相邻日仅业务单号命中不同流水，PAID_MANUAL 不算列出；PAID_API 保持能列出', async () => {
  const observations = [];
  for (const manual of [false, true]) {
    const f = await s.setup();
    const w = await f.seedPaid(NEAR_DAY_END);
    f.setBill(BILL_DATE, [lineOf(w, { channelOrderId: channelOrderId() })]);
    await f.runDay();
    expect(await diffsOf(f, [w.id])).toEqual([]);
    if (manual)
      await sql`UPDATE app.withdrawals SET status = 'PAID_MANUAL',
      manual_entry_by = ${randomUUID()}, manual_confirm_by = ${randomUUID()}
      WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(f.h.db);
    f.clock.set(NEXT_RUN);
    f.setBill(NEXT_BILL_DATE, []);
    await f.runDay(NEXT_BILL_DATE);
    const found = await diffsOf(f, [w.id]);
    observations.push({
      manual,
      missing: found.length,
      holds: (await holdsOf(f, w.userId)).length,
    });
    if (found.length > 0) expect(found[0]?.resolution).toMatchObject({ case: 'paid_not_in_bill' });
  }
  expect(observations).toEqual([
    { manual: false, missing: 0, holds: 0 },
    { manual: true, missing: 1, holds: 1 },
  ]);
}, 60_000);
