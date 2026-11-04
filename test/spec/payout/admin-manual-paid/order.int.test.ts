// B2-09m order of the item checks (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid "the first check that fails is its result": a withdrawal that hits several reasons
// gets the one earlier in the contract's list. Every case writes nothing. Requests go through the real
// admin entry (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { it } from 'vitest';
import {
  MINUTE,
  PAYER_SIDE,
  ago,
  approved,
  entryOf,
  expectItems,
  expectNothingWritten,
  fixture,
  member,
  payee,
  returned,
  reviewing,
  seedAttempt,
  seedQueries,
  seedRiskState,
  serial,
  skipped,
  state,
  suite,
  withOffset,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#43] 判断顺序：not_approved 先于 amount_mismatch（PAYING 且金额不对）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await reviewing(f, h, await payee(f, h), { status: 'PAYING', execute_seq: 1 });
    const before = await state(f);

    await expectItems(await h.manualPaid([entryOf(f, w, { paid_fen: 12_348 })]), [
      skipped(w.id, 'not_approved'),
    ]);

    expectNothingWritten(before, await state(f));
  });
});

it('[AC-B2-09m#44] 判断顺序：amount_mismatch 先于 has_transfer_attempt（金额不对且有 unknown 转账）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedAttempt(f, w, { kind: 'transfer', result: 'unknown', at: ago(f, 10) });
    const before = await state(f);

    await expectItems(await h.manualPaid([entryOf(f, w, { paid_fen: 12_346 })]), [
      skipped(w.id, 'amount_mismatch'),
    ]);

    expectNothingWritten(before, await state(f));
  });
});

it('[AC-B2-09m#45] 判断顺序：has_transfer_attempt 先于 member_blocked（风控冻结的会员且有 pending 转账）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedRiskState(f, who, 'frozen');
    const w = await approved(f, h, who);
    await seedAttempt(f, w, { kind: 'transfer', result: 'pending', at: ago(f, 10) });
    const before = await state(f);

    await expectItems(await h.manualPaid([entryOf(f, w)]), [skipped(w.id, 'has_transfer_attempt')]);

    expectNothingWritten(before, await state(f));
  });
});

it('[AC-B2-09m#46] 判断顺序（其余相邻各一对）：not_approved 先于 channel_not_allowed，channel_not_allowed 先于 amount_mismatch，amount_mismatch 先于 paid_at_invalid，paid_at_invalid 先于 has_transfer_attempt，has_transfer_attempt 先于 query_required，query_required 和 query_success 先于 member_blocked，member_blocked 先于 channel_order_id_taken，channel_order_id_taken 先于 identity_missing', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const tooLate = withOffset(new Date(f.clock.now().getTime() + 6 * MINUTE));
    const taken = serial();
    await reviewing(f, h, who, { status: 'PAID_API', channel_order_id: taken });

    const payingWechat = await reviewing(f, h, who, {
      status: 'PAYING',
      execute_seq: 1,
      method: 'wechat',
    });
    const wrongWechat = await approved(f, h, who, { method: 'wechat' });
    const wrongAndLate = await approved(f, h, who);
    const lateAndTried = await approved(f, h, who);
    await seedAttempt(f, lateAndTried, { kind: 'transfer', result: 'unknown', at: ago(f, 10) });
    const triedOnHold = await approved(f, h, who, { hold_reason: PAYER_SIDE });
    await seedAttempt(f, triedOnHold, { kind: 'transfer', result: 'unknown', at: ago(f, 10) });

    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const unqueriedFrozen = await returned(f, h, frozenMember);
    const provenFrozen = await returned(f, h, frozenMember);
    await seedQueries(f, provenFrozen, [['success', 5]]);
    const frozenTaken = await approved(f, h, frozenMember);

    const takenNoName = await approved(f, h, await member(f, h));
    const before = await state(f);

    await expectItems(
      await h.manualPaid([
        entryOf(f, payingWechat),
        entryOf(f, wrongWechat, { paid_fen: 1 }),
        entryOf(f, wrongAndLate, { paid_fen: 1, paid_at: tooLate }),
        entryOf(f, lateAndTried, { paid_at: tooLate }),
        entryOf(f, triedOnHold),
        entryOf(f, unqueriedFrozen),
        entryOf(f, provenFrozen),
        entryOf(f, frozenTaken, { channel_order_id: taken }),
        entryOf(f, takenNoName, { channel_order_id: taken }),
      ]),
      [
        skipped(payingWechat.id, 'not_approved'),
        skipped(wrongWechat.id, 'channel_not_allowed'),
        skipped(wrongAndLate.id, 'amount_mismatch'),
        skipped(lateAndTried.id, 'paid_at_invalid'),
        skipped(triedOnHold.id, 'has_transfer_attempt'),
        skipped(unqueriedFrozen.id, 'query_required'),
        skipped(provenFrozen.id, 'query_success'),
        skipped(frozenTaken.id, 'member_blocked'),
        skipped(takenNoName.id, 'channel_order_id_taken'),
      ],
    );

    expectNothingWritten(before, await state(f));
  });
});
