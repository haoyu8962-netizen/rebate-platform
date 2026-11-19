// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): the batch row and the member order
// (contracts/openapi.yaml listAdminPayoutBatches / getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12,
// BR-WDR-30). executed_at is the earliest `at` of the batch's paying, skipped or blocked items (not
// created_at; null only for a batch without such an item); executor_id is payout_batches.created_by
// (null for an automatic batch); members are ordered by the time of their first item in this batch,
// then withdrawal_id ascending — not by execute_seq. A not_approved member (skipped) is a member even
// though it never joined the batch. The list row carries the same values as the detail. Expected
// values are written by hand (instants as epoch milliseconds). Top-level it() only.
import { expect, it } from 'vitest';
import {
  ago,
  detailOf,
  fixture,
  member,
  memberIds,
  memberView,
  orderedIds,
  pageOf,
  payingOn,
  plus,
  seedBatch,
  seedItem,
  seedWithdrawal,
  suite,
  summaryPart,
  summaryView,
  withBatches,
} from './kit.ts';

const s = suite();

it('[AC-B2-07g#8] 批次行字段与成员顺序：executed_at 取最早的 paying / skipped / blocked item（不是 created_at），executor_id = created_by；成员按本批次第一条 item 的时间、再按 withdrawal_id 升序（不按 execute_seq）；skipped（not_approved）计入成员与 skipped；列表行与详情一致', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const created = ago(f, 50);
    const t = ago(f, 49);
    const e = await seedBatch(f, { kind: 'manual', created_at: created, by: h.executor.id });
    const laterAt = ago(f, 5);
    const later = await seedBatch(f, { kind: 'manual', created_at: laterAt, by: h.executor.id });
    const paying = (seq: number, id?: string) =>
      seedWithdrawal(f, h, who, {
        ...(id === undefined ? {} : { id }),
        status: 'PAYING',
        review_mode: 'manual',
        execute_seq: seq,
        batch_id: e.id,
        executor_id: h.executor.id,
        executed_at: t,
        created_at: ago(f, 120),
        row_version: 2 * seq + 1,
      });
    // wB: earliest item, the highest execute_seq.
    const wB = await paying(3);
    await seedItem(f, wB, e, { result: 'paying', at: t });
    // wC / wA: same item time, wC with the lower id first though its execute_seq is higher.
    const [lowId, highId] = orderedIds();
    const wA = await paying(1, highId);
    const wC = await paying(2, lowId);
    await seedItem(f, wA, e, { result: 'paying', at: plus(t, 2) });
    await seedItem(f, wC, e, { result: 'paying', at: plus(t, 2) });
    // wD: blocked first (t + 1 ms), moved to `later` 5 minutes ago: placed by its first item.
    const wD = await seedWithdrawal(f, h, who, {
      status: 'PAYING',
      review_mode: 'manual',
      execute_seq: 1,
      batch_id: later.id,
      executor_id: h.executor.id,
      executed_at: laterAt,
      created_at: ago(f, 120),
      row_version: 4,
    });
    await seedItem(f, wD, e, { result: 'blocked', reason: 'member_blocked', at: plus(t, 1) });
    await seedItem(f, wD, e, { result: 'moved_out', at: laterAt, movedTo: later });
    await seedItem(f, wD, later, { result: 'paying', at: laterAt });
    // wE: no longer APPROVED when judged (rejected), skipped with not_approved, never joined.
    const wE = await seedWithdrawal(f, h, who, {
      status: 'REJECTED',
      review_mode: 'manual',
      created_at: ago(f, 120),
      row_version: 2,
    });
    await seedItem(f, wE, e, { result: 'skipped', reason: 'not_approved', at: plus(t, 3) });

    const none = { last_attempt: null, next_query_at: null, has_transfer_attempt: false } as const;
    const summary = summaryView(e, {
      executed_at: t.getTime(),
      member_count: 5,
      result_counts: { paying: 3, skipped: 1, moved_out: 1 },
      held_count: 0,
    });
    const detail = await detailOf(await h.detail(e.id));
    expect(memberIds(detail)).toEqual([wB.id, wD.id, wC.id, wA.id, wE.id]);
    expect(detail).toEqual({
      ...summary,
      members: [
        memberView(wB, { ...none, result: 'paying' }),
        memberView(wD, { ...none, result: 'moved_out' }),
        memberView(wC, { ...none, result: 'paying' }),
        memberView(wA, { ...none, result: 'paying' }),
        memberView(wE, { ...none, result: 'skipped' }),
      ],
    });
    expect(summary['executed_at']).not.toBe(summary['created_at']);
    const page = await pageOf(await h.list());
    expect(page.items.find((row) => row['batch_id'] === e.id)).toEqual(summaryPart(detail));
  });
});

it('[AC-B2-07g#8] 自动批次 executor_id=null（系统执行，BR-WDR-30）；没有 paying / skipped / blocked item 的批次 executed_at=null、member_count=0、result_counts 全 0、members=[]；列表行与详情一致', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const autoAt = ago(f, 40);
    const auto = await seedBatch(f, { kind: 'auto', created_at: autoAt });
    const row = await payingOn(f, h, who, auto, {
      executedAt: plus(autoAt, 1500),
      itemAt: plus(autoAt, 1500),
      seed: { review_mode: 'auto', executor_id: null },
    });
    const empty = await seedBatch(f, { kind: 'manual', created_at: ago(f, 45), by: h.executor.id });

    const autoDetail = await detailOf(await h.detail(auto.id));
    expect(autoDetail).toEqual({
      ...summaryView(auto, {
        executed_at: autoAt.getTime() + 1500,
        member_count: 1,
        result_counts: { paying: 1 },
        held_count: 0,
      }),
      members: [
        memberView(row, {
          result: 'paying',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
      ],
    });
    expect(autoDetail['executor_id']).toBeNull();
    const emptyDetail = await detailOf(await h.detail(empty.id));
    expect(emptyDetail).toEqual({
      ...summaryView(empty, {
        executed_at: null,
        member_count: 0,
        result_counts: {},
        held_count: 0,
      }),
      members: [],
    });
    expect((await pageOf(await h.list())).items).toEqual([
      summaryPart(autoDetail),
      summaryPart(emptyDetail),
    ]);
  });
});
