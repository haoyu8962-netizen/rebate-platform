// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): hold_reason and held_count
// (contracts/openapi.yaml listAdminPayoutBatches / getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12,
// BR-WDR-13, BR-WDR-17; ruling D10-2017 ②). A member's hold_reason is the withdrawals column only
// while the status is APPROVED (an old reason left on a re-executed or rejected withdrawal is not
// shown); held_count counts the members still on this batch (withdrawals.batch_id is this batch), in
// APPROVED and with a hold_reason — a member moved to another batch is not held here even when it is
// held there, and EXECUTE does not clear the column. The held filter of the list follows held_count.
// Rows are seeded as EXECUTE (items, moves), the payout process and W9 / W3 leave them. Expected
// values are written by hand (instants as epoch milliseconds). Top-level it() only.
import { expect, it } from 'vitest';
import {
  MINUTE,
  ago,
  batchIds,
  detailOf,
  fixture,
  heldOn,
  member,
  memberView,
  pageOf,
  payingOn,
  plus,
  seedAttempt,
  seedBatch,
  seedItem,
  seedWithdrawal,
  suite,
  summaryView,
  withBatches,
  type BatchRow,
  type BatchesAdmin,
  type Fixture,
  type Member,
  type WithdrawalRow,
} from './kit.ts';

const s = suite();

interface Scene {
  readonly c: BatchRow;
  readonly d: BatchRow;
  readonly e: BatchRow;
  readonly m1: WithdrawalRow;
  readonly m2: WithdrawalRow;
  readonly m3: WithdrawalRow;
  readonly m5: WithdrawalRow;
  readonly m6: WithdrawalRow;
  readonly m7: WithdrawalRow;
  readonly m8: WithdrawalRow;
  readonly m5Transfer: Date;
  readonly m6Transfer: Date;
  readonly m8Transfer: Date;
}

/**
 * Batch C (manual, executed 120 minutes ago): m1 queue_paused and m2 member_blocked held on it;
 * m3 left APPROVED by ② (blocked item, no hold_reason); m5 and m7 held with queue_paused, then
 * re-executed into batch D 60 minutes ago (C keeps moved_out) — m5 is PAYING there with the old
 * reason still in the column, m7 went back to APPROVED with channel_disabled on D; m6 rejected (W3)
 * after a payer-side transfer, the reason left in the column. Batch E (30 minutes ago): m8 PAYING
 * without any hold.
 */
async function scene(f: Fixture, h: BatchesAdmin, who: Member): Promise<Scene> {
  const cAt = ago(f, 120);
  const dAt = ago(f, 60);
  const c = await seedBatch(f, { kind: 'manual', created_at: cAt, by: h.executor.id });
  const d = await seedBatch(f, { kind: 'manual', created_at: dAt, by: h.executor.id });
  const m1 = await heldOn(f, h, who, c, {
    reason: 'queue_paused',
    executedAt: cAt,
    itemAt: cAt,
    heldAt: plus(cAt, 30_000),
  });
  const m2 = await heldOn(f, h, who, c, {
    reason: 'member_blocked',
    executedAt: cAt,
    itemAt: plus(cAt, 1),
    heldAt: plus(cAt, 30_000),
  });
  const m3 = await seedWithdrawal(f, h, who, {
    status: 'APPROVED',
    review_mode: 'manual',
    batch_id: c.id,
    created_at: ago(f, 180),
  });
  await seedItem(f, m3, c, { result: 'blocked', reason: 'member_blocked', at: plus(cAt, 2) });

  // m5: held on C, then re-executed by D (moved, PAYING, execute_seq 2, the old reason kept).
  const m5Transfer = ago(f, 59);
  const m5 = await seedWithdrawal(f, h, who, {
    status: 'PAYING',
    review_mode: 'manual',
    execute_seq: 2,
    batch_id: d.id,
    executor_id: h.executor.id,
    executed_at: dAt,
    hold_reason: 'queue_paused',
    hold_at: plus(cAt, 30_000),
    created_at: ago(f, 180),
    row_version: 6,
  });
  await seedItem(f, m5, c, { result: 'paying', at: plus(cAt, 3) });
  await seedItem(f, m5, c, { result: 'moved_out', at: dAt, movedTo: d });
  await seedItem(f, m5, d, { result: 'paying', at: dAt });
  await seedAttempt(f, m5, { kind: 'transfer', result: 'unknown', at: m5Transfer });

  // m6: payer-side transfer on C, W9 payer_side_after_transfer, then W3 (REJECTED).
  const m6Transfer = plus(cAt, 10_000);
  const m6 = await seedWithdrawal(f, h, who, {
    status: 'REJECTED',
    review_mode: 'manual',
    execute_seq: 1,
    batch_id: c.id,
    executor_id: h.executor.id,
    executed_at: cAt,
    hold_reason: 'payer_side_after_transfer',
    hold_at: plus(cAt, 11_000),
    created_at: ago(f, 180),
    row_version: 5,
  });
  await seedItem(f, m6, c, { result: 'paying', at: plus(cAt, 4) });
  await seedAttempt(f, m6, { kind: 'transfer', result: 'fail', at: m6Transfer });

  // m7: held on C, re-executed by D, held again on D (channel_disabled), no transfer.
  const m7 = await seedWithdrawal(f, h, who, {
    status: 'APPROVED',
    review_mode: 'manual',
    execute_seq: 2,
    batch_id: d.id,
    executor_id: h.executor.id,
    executed_at: dAt,
    hold_reason: 'channel_disabled',
    hold_at: ago(f, 58),
    created_at: ago(f, 180),
    row_version: 7,
  });
  await seedItem(f, m7, c, { result: 'paying', at: plus(cAt, 5) });
  await seedItem(f, m7, c, { result: 'moved_out', at: dAt, movedTo: d });
  await seedItem(f, m7, d, { result: 'paying', at: plus(dAt, 1) });

  const eAt = ago(f, 30);
  const e = await seedBatch(f, { kind: 'manual', created_at: eAt, by: h.executor.id });
  const m8Transfer = ago(f, 29);
  const m8 = await payingOn(f, h, who, e, {
    executedAt: eAt,
    itemAt: eAt,
    transferAt: m8Transfer,
  });
  return { c, d, e, m1, m2, m3, m5, m6, m7, m8, m5Transfer, m6Transfer, m8Transfer };
}

it('[AC-B2-07g#6] 原批次 C：hold_reason 只在 APPROVED 时给出（REJECTED 列上残留的 payer_side_after_transfer 不显示）；held_count 只数仍挂在 C、APPROVED 且有 hold_reason 的成员 = 2（改挂到 D 的成员即使在 D 上被挂起也不计入 C）', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const x: Scene = await scene(f, h, who);
    const detail = await detailOf(await h.detail(x.c.id));
    expect(detail).toEqual({
      ...summaryView(x.c, {
        executed_at: x.c.created_at.getTime(),
        member_count: 6,
        result_counts: { paying: 3, blocked: 1, moved_out: 2 },
        held_count: 2,
      }),
      members: [
        memberView(x.m1, {
          result: 'paying',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
        memberView(x.m2, {
          result: 'paying',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
        memberView(x.m3, {
          result: 'blocked',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
        memberView(x.m5, {
          result: 'moved_out',
          last_attempt: { kind: 'transfer', result: 'unknown', at: x.m5Transfer.getTime() },
          next_query_at: x.m5Transfer.getTime() + 120 * MINUTE,
          has_transfer_attempt: true,
        }),
        memberView(x.m6, {
          result: 'paying',
          last_attempt: { kind: 'transfer', result: 'fail', at: x.m6Transfer.getTime() },
          next_query_at: null,
          has_transfer_attempt: true,
        }),
        memberView(x.m7, {
          result: 'moved_out',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
      ],
    });
    // The two hold_reason columns the view must hide.
    const members = detail['members'] as Record<string, unknown>[];
    expect(members.map((m) => m['hold_reason'])).toEqual([
      'queue_paused',
      'member_blocked',
      null,
      null,
      null,
      'channel_disabled',
    ]);
  });
});

it('[AC-B2-07g#6] 新批次 D：重新执行后 PAYING、列上残留旧 queue_paused 的成员 hold_reason=null 且不计 held；在 D 上又被 W9（channel_disabled）的成员计入 → held_count=1', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const x: Scene = await scene(f, h, who);
    expect(await detailOf(await h.detail(x.d.id))).toEqual({
      ...summaryView(x.d, {
        executed_at: x.d.created_at.getTime(),
        member_count: 2,
        result_counts: { paying: 2 },
        held_count: 1,
      }),
      members: [
        memberView(x.m5, {
          result: 'paying',
          last_attempt: { kind: 'transfer', result: 'unknown', at: x.m5Transfer.getTime() },
          next_query_at: x.m5Transfer.getTime() + 120 * MINUTE,
          has_transfer_attempt: true,
        }),
        memberView(x.m7, {
          result: 'paying',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
      ],
    });
  });
});

it('[AC-B2-07g#6] 列表的 held 过滤按 held_count：held=true → [D, C]（新的在前），held=false → [E]；列表行的 held_count 与详情一致（C 2、D 1、E 0）', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const x: Scene = await scene(f, h, who);
    expect(await batchIds(await h.list({ held: 'true' }))).toEqual([x.d.id, x.c.id]);
    expect(await batchIds(await h.list({ held: 'false' }))).toEqual([x.e.id]);
    const page = await pageOf(await h.list());
    expect(page.items).toEqual([
      summaryView(x.e, {
        executed_at: x.e.created_at.getTime(),
        member_count: 1,
        result_counts: { paying: 1 },
        held_count: 0,
      }),
      summaryView(x.d, {
        executed_at: x.d.created_at.getTime(),
        member_count: 2,
        result_counts: { paying: 2 },
        held_count: 1,
      }),
      summaryView(x.c, {
        executed_at: x.c.created_at.getTime(),
        member_count: 6,
        result_counts: { paying: 3, blocked: 1, moved_out: 2 },
        held_count: 2,
      }),
    ]);
    const e = await detailOf(await h.detail(x.e.id));
    expect(e['members']).toEqual([
      memberView(x.m8, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'unknown', at: x.m8Transfer.getTime() },
        next_query_at: x.m8Transfer.getTime() + 30 * MINUTE,
        has_transfer_attempt: true,
      }),
    ]);
  });
});
