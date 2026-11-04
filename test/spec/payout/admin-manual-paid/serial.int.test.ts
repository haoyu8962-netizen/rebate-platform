// B2-09m serial number and identity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-20. channel_order_id_taken: (app_id, channel_order_id) is
// already on a withdrawal, whichever way it was paid, or on an earlier item of this request; compared
// exactly, case included; unique per app. identity_missing: no verified real name, so tax_ytd cannot be
// updated: nothing is written, the request is still 200. Both are found halfway through an item's writes
// and leave nothing behind. Requests go through the real admin entry (manual-paid-harness.ts). Top-level
// it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AFTER_FREEZE,
  AMOUNT,
  RICH,
  approved,
  asPaidManual,
  audits,
  ACTION,
  balanceOf,
  changes,
  entries,
  entryOf,
  expectItems,
  expectNothingWritten,
  fixture,
  member,
  otherApp,
  paid,
  payee,
  reviewing,
  rowOf,
  serial,
  skipped,
  state,
  suite,
  taxOf,
  voucherOf,
  withManualAdmin,
} from './manual-paid-harness.ts';
import { randomHmac, seedRealname } from '../tax-ytd/kit.ts';

const s = suite();

it('[AC-B2-09m#36] channel_order_id_taken：别的单已用（PAID_API、PAID_MANUAL 的都算）：状态、凭证、tax_ytd、事件、审计都不写；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const byChannel = serial();
    const byHand = serial();
    await reviewing(f, h, who, { status: 'PAID_API', channel_order_id: byChannel });
    await reviewing(f, h, who, { status: 'PAID_MANUAL', channel_order_id: byHand });
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const before = await state(f);

    await expectItems(
      await h.manualPaid([
        entryOf(f, first, { channel_order_id: byChannel }),
        entryOf(f, second, { channel_order_id: byHand }),
      ]),
      [skipped(first.id, 'channel_order_id_taken'), skipped(second.id, 'channel_order_id_taken')],
    );
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, who);
    const freeEntry = entryOf(f, free);
    await expectItems(
      await h.manualPaid([entryOf(f, first, { channel_order_id: byChannel }), freeEntry]),
      [skipped(first.id, 'channel_order_id_taken'), paid(free.id)],
    );
    expect(await rowOf(f, first)).toEqual(first);
    expect(await rowOf(f, free)).toEqual(asPaidManual(f, free, freeEntry, h.entry.id));
  });
});

it('[AC-B2-09m#37] 同一请求两项用同一流水号：前一项 paid，后一项 channel_order_id_taken 且什么都不写，再后一项照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const loserMember = await payee(f, h);
    const winner = await approved(f, h, who);
    const loser = await approved(f, h, loserMember);
    const next = await approved(f, h, who);
    const number = serial();
    const winnerEntry = entryOf(f, winner, { channel_order_id: number });

    await expectItems(
      await h.manualPaid([
        winnerEntry,
        entryOf(f, loser, { channel_order_id: number }),
        entryOf(f, next),
      ]),
      [paid(winner.id), skipped(loser.id, 'channel_order_id_taken'), paid(next.id)],
    );

    expect(await rowOf(f, winner)).toEqual(asPaidManual(f, winner, winnerEntry, h.entry.id));
    expect(await rowOf(f, loser)).toEqual(loser);
    expect(await voucherOf(f.db, f.appId, `wd:${loser.id}:PAID`)).toEqual([]);
    expect(await taxOf(f, loserMember)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, loserMember.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
    expect((await changes(f.db, f.appId)).map((data) => data['withdrawal_id']).sort()).toEqual(
      [winner.id, next.id].sort(),
    );
    expect(await audits(f, ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09m#38] 流水号大小写不同算不同号（compared exactly）：AbC123 与 abc123 都 paid、都按原样存', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const upper = await approved(f, h, who);
    const lower = await approved(f, h, who);

    await expectItems(
      await h.manualPaid([
        entryOf(f, upper, { channel_order_id: 'AbC123' }),
        entryOf(f, lower, { channel_order_id: 'abc123' }),
      ]),
      [paid(upper.id), paid(lower.id)],
    );

    expect((await rowOf(f, upper)).channel_order_id).toBe('AbC123');
    expect((await rowOf(f, lower)).channel_order_id).toBe('abc123');
  });
});

it('[AC-B2-09m#39] 跳过的项不占号：amount_mismatch 用过的流水号，别的单还能用', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const wrong = await approved(f, h, who);
    const right = await approved(f, h, who);
    const number = serial();

    await expectItems(
      await h.manualPaid([
        entryOf(f, wrong, { channel_order_id: number, paid_fen: 12_348 }),
        entryOf(f, right, { channel_order_id: number }),
      ]),
      [skipped(wrong.id, 'amount_mismatch'), paid(right.id)],
    );

    expect((await rowOf(f, wrong)).channel_order_id).toBeNull();
    expect((await rowOf(f, right)).channel_order_id).toBe(number);
  });
});

it('[AC-B2-09m#40] identity_missing：没有已核实名（没有实名行、实名 failed、实名已清除只留税务 hmac）：整个请求 200、不是 5xx，这一项状态、凭证、tax_ytd、事件、审计都不写；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const none = await member(f, h, RICH);
    const failed = await member(f, h, RICH);
    await seedRealname(f.db, failed.appId, failed.userId, { status: 'failed' });
    const cleared = await member(f, h, RICH);
    await seedRealname(f.db, cleared.appId, cleared.userId, {
      status: 'none',
      retainedHmac: randomHmac(),
    });
    const rows = [
      await approved(f, h, none),
      await approved(f, h, failed),
      await approved(f, h, cleared),
    ];
    const before = await state(f);

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => skipped(row.id, 'identity_missing')),
    );
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, await payee(f, h));
    await expectItems(await h.manualPaid([entryOf(f, rows[0]!), entryOf(f, free)]), [
      skipped(rows[0]!.id, 'identity_missing'),
      paid(free.id),
    ]);
    expect(await rowOf(f, rows[0]!)).toEqual(rows[0]);
  });
});

it('[AC-B2-09m#41] identity_missing 没留下半截：补上已核实名后用新键同一流水号再录 → paid，凭证恰一张（不是重放跳过的空账），钱只动一次', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await member(f, h, RICH);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);

    await expectItems(await h.manualPaid([entry]), [skipped(w.id, 'identity_missing')]);
    await seedRealname(f.db, who.appId, who.userId, { status: 'verified', hmac: randomHmac() });
    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await entries(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(6);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAID_MANUAL' },
    ]);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09m#42] 隔离：流水号唯一只在本 app 内：别的 app 用过同一流水号不算 taken，那一单不动', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withManualAdmin(f, async (h) => {
    const number = serial();
    const outsider = await reviewing(other, h, await payee(other, h), {
      status: 'PAID_API',
      channel_order_id: number,
    });
    const w = await approved(f, h, await payee(f, h));
    const entry = entryOf(f, w, { channel_order_id: number });
    const elsewhere = await state(f, other.appId);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await rowOf(other, outsider)).toEqual(outsider);
    expect(await state(f, other.appId)).toEqual(elsewhere);
  });
});
