// B2-09m attempt and query rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-17, BR-WDR-08 W8, 决-08 A. A kind=transfer attempt with result
// pending, success or unknown: the money may be out → has_transfer_attempt, BR-WDR-15 ends it; a definite
// failure does not stop W8. While payout.proven_success_writeoff.enabled is on, hold_reason
// payer_side_after_transfer is checked against the latest query (at, then id, descending): none, pending
// or unknown → query_required; success → query_success (recording it too would pay twice, W11 ends it);
// only fail lets it through. With the switch off the check does not run. Requests go through the real
// admin entry (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PAYER_SIDE,
  SWITCH,
  ago,
  approved,
  asPaidManual,
  entryOf,
  expectItems,
  expectNothingWritten,
  fixture,
  lowAndHigh,
  paid,
  payee,
  returned,
  rowOf,
  seedAttempt,
  seedQueries,
  seedQueryWithId,
  setSwitch,
  skipped,
  state,
  suite,
  withManualAdmin,
  type WithdrawalRow,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#22] has_transfer_attempt：转账尝试 result 为 pending、success、unknown 各一条，都拒绝且什么都不写；同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const results = ['pending', 'success', 'unknown'] as const;
    const rows: WithdrawalRow[] = [];
    for (const result of results) {
      const row = await approved(f, h, who);
      await seedAttempt(f, row, { kind: 'transfer', result, at: ago(f, 10) });
      rows.push(row);
    }
    const before = await state(f);

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => skipped(row.id, 'has_transfer_attempt')),
    );
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, who);
    await expectItems(await h.manualPaid([entryOf(f, rows[0]!), entryOf(f, free)]), [
      skipped(rows[0]!.id, 'has_transfer_attempt'),
      paid(free.id),
    ]);
  });
});

it('[AC-B2-09m#23] 转账尝试 result=fail 且没有 hold 的可以补录，不用先查询；尝试记录不动（BR-WDR-16 例：明确失败回到 APPROVED）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedAttempt(f, w, { kind: 'transfer', result: 'fail', at: ago(f, 10) });
    const entry = entryOf(f, w);
    const { attempts } = await state(f);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect((await state(f)).attempts).toEqual(attempts);
  });
});

it('[AC-B2-09m#24] 只数 kind=transfer：只有 kind=query 的 pending、success、unknown 尝试、没有付款方侧 hold 的单不是 has_transfer_attempt，照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const rows: WithdrawalRow[] = [];
    for (const result of ['pending', 'success', 'unknown'] as const) {
      const row = await approved(f, h, who);
      await seedAttempt(f, row, { kind: 'query', result, at: ago(f, 10) });
      rows.push(row);
    }

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => paid(row.id)),
    );
  });
});

it('[AC-B2-09m#25] query_required：付款方侧 hold、转账 fail：没有查询（那条失败的转账不算查询）、最新查询 pending、最新查询 unknown；什么都不写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const none = await returned(f, h, who);
    const waitingOne = await returned(f, h, who);
    await seedQueries(f, waitingOne, [['pending', 5]]);
    const unknown = await returned(f, h, who);
    await seedQueries(f, unknown, [['unknown', 5]]);
    const rows = [none, waitingOne, unknown];
    const before = await state(f);

    await expectItems(
      await h.manualPaid(rows.map((row) => entryOf(f, row))),
      rows.map((row) => skipped(row.id, 'query_required')),
    );

    expectNothingWritten(before, await state(f));
  });
});

it('[AC-B2-09m#26] query_success：最新查询 success：通道已付，只能走 W11，再录线下打款就是重复打款；什么都不写，同请求可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await returned(f, h, who);
    await seedQueries(f, w, [['success', 5]]);
    const before = await state(f);

    await expectItems(await h.manualPaid([entryOf(f, w)]), [skipped(w.id, 'query_success')]);
    expectNothingWritten(before, await state(f));

    const free = await approved(f, h, who);
    await expectItems(await h.manualPaid([entryOf(f, w), entryOf(f, free)]), [
      skipped(w.id, 'query_success'),
      paid(free.id),
    ]);
  });
});

it('[AC-B2-09m#27] 最新查询 fail 可以补录：hold 清空，批次、execute_seq 和尝试记录都不动', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await returned(f, h, who);
    await seedQueries(f, w, [['fail', 5]]);
    const entry = entryOf(f, w);
    const { attempts } = await state(f);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    const now = await rowOf(f, w);
    expect(now).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(now.hold_reason).toBeNull();
    expect(now.hold_at).toBeNull();
    expect(now.batch_id).toBe(w.batch_id);
    expect((await state(f)).attempts).toEqual(attempts);
  });
});

it('[AC-B2-09m#28] 多条查询取最新（按 at）：先 success 后 fail 可以；先 fail 后 unknown、先 success 后 unknown 是 query_required；先 fail 后 success 是 query_success；先 unknown 后 fail 可以', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const successThenFail = await returned(f, h, who);
    await seedQueries(f, successThenFail, [
      ['success', 12],
      ['fail', 5],
    ]);
    const failThenUnknown = await returned(f, h, who);
    await seedQueries(f, failThenUnknown, [
      ['fail', 12],
      ['unknown', 5],
    ]);
    const successThenUnknown = await returned(f, h, who);
    await seedQueries(f, successThenUnknown, [
      ['success', 12],
      ['unknown', 5],
    ]);
    const failThenSuccess = await returned(f, h, who);
    await seedQueries(f, failThenSuccess, [
      ['fail', 12],
      ['success', 5],
    ]);
    const unknownThenFail = await returned(f, h, who);
    await seedQueries(f, unknownThenFail, [
      ['unknown', 12],
      ['fail', 5],
    ]);

    await expectItems(
      await h.manualPaid(
        [
          successThenFail,
          failThenUnknown,
          successThenUnknown,
          failThenSuccess,
          unknownThenFail,
        ].map((row) => entryOf(f, row)),
      ),
      [
        paid(successThenFail.id),
        skipped(failThenUnknown.id, 'query_required'),
        skipped(successThenUnknown.id, 'query_required'),
        skipped(failThenSuccess.id, 'query_success'),
        paid(unknownThenFail.id),
      ],
    );
  });
});

it('[AC-B2-09m#29] at 相同按 id 倒序：id 大的 fail 可以，id 大的 success 是 query_success；at 先于 id：时间晚而 id 小的 fail 压过时间早而 id 大的 success', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const tieFail = await returned(f, h, who);
    const first = lowAndHigh();
    await seedQueryWithId(f, tieFail, first.low, 'success', ago(f, 5));
    await seedQueryWithId(f, tieFail, first.high, 'fail', ago(f, 5));
    const tieSuccess = await returned(f, h, who);
    const second = lowAndHigh();
    await seedQueryWithId(f, tieSuccess, second.low, 'fail', ago(f, 5));
    await seedQueryWithId(f, tieSuccess, second.high, 'success', ago(f, 5));
    const atFirst = await returned(f, h, who);
    const third = lowAndHigh();
    await seedQueryWithId(f, atFirst, third.high, 'success', ago(f, 12));
    await seedQueryWithId(f, atFirst, third.low, 'fail', ago(f, 5));

    await expectItems(
      await h.manualPaid([tieFail, tieSuccess, atFirst].map((row) => entryOf(f, row))),
      [paid(tieFail.id), skipped(tieSuccess.id, 'query_success'), paid(atFirst.id)],
    );
  });
});

it('[AC-B2-09m#30] 开关 payout.proven_success_writeoff.enabled 显式关时不查：没有查询、最新查询 success 都照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    await setSwitch(f, SWITCH, false);
    const who = await payee(f, h);
    const none = await returned(f, h, who);
    const proven = await returned(f, h, who);
    await seedQueries(f, proven, [['success', 5]]);
    const noneEntry = entryOf(f, none);

    await expectItems(await h.manualPaid([noneEntry, entryOf(f, proven)]), [
      paid(none.id),
      paid(proven.id),
    ]);

    expect(await rowOf(f, none)).toEqual(asPaidManual(f, none, noneEntry, h.entry.id));
  });
});

it('[AC-B2-09m#31] 查询守卫只管付款方侧 hold：别的 hold（single_cap）、没有 hold 的单，转账 fail 且没有查询或最新查询 unknown 都照常 paid；付款方侧 hold 而开关默认（无配置行）时要查', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const otherHold = await approved(f, h, who, { hold_reason: 'single_cap' });
    await seedAttempt(f, otherHold, { kind: 'transfer', result: 'fail', at: ago(f, 15) });
    const noHold = await approved(f, h, who);
    await seedAttempt(f, noHold, { kind: 'transfer', result: 'fail', at: ago(f, 15) });
    await seedQueries(f, noHold, [['unknown', 5]]);
    const payerSide = await approved(f, h, who, { hold_reason: PAYER_SIDE });
    await seedAttempt(f, payerSide, { kind: 'transfer', result: 'fail', at: ago(f, 15) });

    await expectItems(
      await h.manualPaid([otherHold, noHold, payerSide].map((row) => entryOf(f, row))),
      [paid(otherHold.id), paid(noHold.id), skipped(payerSide.id, 'query_required')],
    );
  });
});
