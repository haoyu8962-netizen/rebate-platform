// B2-09m per-item rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-33 ⑧. An item that cannot be recorded never fails the others:
// not_found (unknown, another app's, not a UUID: never reaches the database, never a 5xx), not_approved
// (W8 starts only at APPROVED), channel_not_allowed (wechat), amount_mismatch (paid_fen must be exactly
// net_fen), paid_at_invalid (at most 5 minutes after the injected Clock, not before created_at). Each case
// has another item in the same request that is paid. Requests go through the real admin entry
// (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  MINUTE,
  NET,
  approved,
  asPaidManual,
  audits,
  ACTION,
  balanceOf,
  entryOf,
  expectItems,
  fixture,
  ofNet,
  otherApp,
  paid,
  payee,
  reviewing,
  rowOf,
  setSwitch,
  skipped,
  suite,
  voucherOf,
  withOffset,
  withManualAdmin,
  type WithdrawalRow,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#16] not_found：未知 id、别的 app 的 id、各种非 UUID（不进库、不得 500），回的是发送时的写法；别的 app 的单不动，同请求可补的照常 paid', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withManualAdmin(f, async (h) => {
    const outsider = await approved(other, h, await payee(other, h));
    const free = await approved(f, h, await payee(f, h));
    const strays = [
      randomUUID(),
      outsider.id,
      'not-a-uuid',
      '12345',
      'g'.repeat(36),
      '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fc00',
      "' OR 1=1 --",
      'x'.repeat(64),
    ];
    const freeEntry = entryOf(f, free);

    await expectItems(
      await h.manualPaid([...strays.map((id) => entryOf(f, { id, net_fen: NET })), freeEntry]),
      [...strays.map((id) => skipped(id, 'not_found')), paid(free.id)],
    );

    expect(await rowOf(other, outsider)).toEqual(outsider);
    expect(await voucherOf(f.db, other.appId, `wd:${outsider.id}:PAID`)).toEqual([]);
    expect(await rowOf(f, free)).toEqual(asPaidManual(f, free, freeEntry, h.entry.id));
  });
});

it('[AC-B2-09m#17] not_approved：PENDING_REVIEW、PAYING、PAID_API、PAID_MANUAL、REJECTED、FAILED 各一，金额都对也不动；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const others = [
      await reviewing(f, h, who),
      await reviewing(f, h, who, { status: 'PAYING', execute_seq: 1 }),
      await reviewing(f, h, who, { status: 'PAID_API' }),
      await reviewing(f, h, who, { status: 'PAID_MANUAL' }),
      await reviewing(f, h, who, { status: 'REJECTED' }),
      await reviewing(f, h, who, { status: 'FAILED', fail_code: 'SEED_FAIL' }),
    ];
    const free = await approved(f, h, who);
    const freeEntry = entryOf(f, free);

    await expectItems(await h.manualPaid([...others.map((row) => entryOf(f, row)), freeEntry]), [
      ...others.map((row) => skipped(row.id, 'not_approved')),
      paid(free.id),
    ]);

    for (const row of others) {
      expect(await rowOf(f, row), row.status).toEqual(row);
      expect(await voucherOf(f.db, f.appId, `wd:${row.id}:PAID`), row.status).toEqual([]);
    }
    expect(await rowOf(f, free)).toEqual(asPaidManual(f, free, freeEntry, h.entry.id));
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09m#18] channel_not_allowed：微信单不开放 W8（BR-WDR-33 ⑧），微信通道开着也一样；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const who = await payee(f, h);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    const free = await approved(f, h, who);

    await expectItems(await h.manualPaid([entryOf(f, wechat), entryOf(f, free)]), [
      skipped(wechat.id, 'channel_not_allowed'),
      paid(free.id),
    ]);

    expect(await rowOf(f, wechat)).toEqual(wechat);
    expect(await voucherOf(f.db, f.appId, `wd:${wechat.id}:PAID`)).toEqual([]);
  });
});

it('[AC-B2-09m#19] amount_mismatch：实付比 net 多 1 分、少 1 分、0、负数、等于 amount（12,560）、最大安全整数都拒绝，整数都走到逐项判断、不是 5xx；同请求金额对的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const wrong = [12_348, 12_346, 0, -1, -12_347, 12_560, Number.MAX_SAFE_INTEGER];
    const rows: WithdrawalRow[] = [];
    for (let i = 0; i < wrong.length; i += 1) rows.push(await approved(f, h, who));
    const free = await approved(f, h, who);
    const before = await balanceOf(f.db, f.ledger, f.appId, who.userId);

    await expectItems(
      await h.manualPaid([
        ...rows.map((row, index) => entryOf(f, row, { paid_fen: wrong[index]! })),
        entryOf(f, free),
      ]),
      [...rows.map((row) => skipped(row.id, 'amount_mismatch')), paid(free.id)],
    );

    for (const row of rows) expect(await rowOf(f, row)).toEqual(row);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: before.available_fen,
      frozen_fen: before.frozen_fen - 12_560n,
    });
  });
});

it('[AC-B2-09m#20] BR-WDR-16 的例子：net_fen=9800 录 ¥100.00（10000）→ 拒绝；同一单改录 ¥98.00（9800）→ paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who, ofNet(9_800n));
    const right = entryOf(f, w);
    expect(right.paid_fen).toBe(9_800);

    await expectItems(await h.manualPaid([{ ...right, paid_fen: 10_000 }]), [
      skipped(w.id, 'amount_mismatch'),
    ]);
    expect(await rowOf(f, w)).toEqual(w);

    await expectItems(await h.manualPaid([right]), [paid(w.id)]);
    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, right, h.entry.id));
  });
});

it('[AC-B2-09m#21] paid_at_invalid：时钟 + 5 分钟可以，多 1 毫秒拒绝；恰好等于 created_at 可以，早 1 毫秒拒绝', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const limit = f.clock.now().getTime() + 5 * MINUTE;
    const atLimit = await approved(f, h, who);
    const pastLimit = await approved(f, h, who);
    const atCreated = await approved(f, h, who);
    const beforeCreated = await approved(f, h, who);
    const atLimitEntry = entryOf(f, atLimit, { paid_at: withOffset(new Date(limit)) });
    const atCreatedEntry = entryOf(f, atCreated, { paid_at: withOffset(atCreated.created_at) });

    await expectItems(
      await h.manualPaid([
        atLimitEntry,
        entryOf(f, pastLimit, { paid_at: withOffset(new Date(limit + 1)) }),
        atCreatedEntry,
        entryOf(f, beforeCreated, {
          paid_at: withOffset(new Date(beforeCreated.created_at.getTime() - 1)),
        }),
      ]),
      [
        paid(atLimit.id),
        skipped(pastLimit.id, 'paid_at_invalid'),
        paid(atCreated.id),
        skipped(beforeCreated.id, 'paid_at_invalid'),
      ],
    );

    expect(await rowOf(f, atLimit)).toEqual(asPaidManual(f, atLimit, atLimitEntry, h.entry.id));
    expect(await rowOf(f, atCreated)).toEqual(
      asPaidManual(f, atCreated, atCreatedEntry, h.entry.id),
    );
    expect(await rowOf(f, pastLimit)).toEqual(pastLimit);
    expect(await rowOf(f, beforeCreated)).toEqual(beforeCreated);
  });
});
