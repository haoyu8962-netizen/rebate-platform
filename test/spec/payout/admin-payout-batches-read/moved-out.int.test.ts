// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): members moved to another batch
// (contracts/openapi.yaml getAdminPayoutBatch / listAdminPayoutBatches, CT-24zzo; 08 BR-WDR-12 细则
// 换批次例; ruling D10-2017 ②). The old batch still lists the member (its item moved_out stays),
// counts it in member_count and result_counts.moved_out, shows the withdrawal as it is now on the new
// batch, and never counts it as held; a member's result is its newest item of this batch (`at`, then
// the item id). The refused variant of the example (water too low) writes nothing: the withdrawal
// stays APPROVED on the automatic batch with its blocked item. Rows are seeded as EXECUTE and the
// payout process leave them. Expected values are written by hand (instants as epoch milliseconds).
// Top-level it() only.
import { expect, it } from 'vitest';
import {
  MINUTE,
  ago,
  batchIds,
  detailOf,
  fixture,
  member,
  memberView,
  orderedIds,
  plus,
  seedAttempt,
  seedBatch,
  seedItem,
  seedItemWithId,
  seedWithdrawal,
  suite,
  summaryView,
  withBatches,
} from './kit.ts';

const s = suite();

it('[AC-B2-07g#7] BR-WDR-12 换批次例：net 28000 自动批次 A 判通道未开通（blocked）→ 财务组人工批次 B 改挂并执行、转账 1 次 → A 仍列出该单（result=moved_out，成员字段是它现在在 B 上的样子：PAYING、next_query_at 照算），A 的 member_count=1、moved_out=1、held_count=0、executor_id=null、executed_at 为 A 的 blocked 时刻；B 的 paying=1、executor_id 为执行人', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const aAt = ago(f, 60);
    const bAt = ago(f, 10);
    const a = await seedBatch(f, { kind: 'auto', created_at: plus(aAt, -1000) });
    const b = await seedBatch(f, { kind: 'manual', created_at: bAt, by: h.executor.id });
    const t = ago(f, 9);
    const x = await seedWithdrawal(f, h, who, {
      amount_fen: 28_000n,
      status: 'PAYING',
      review_mode: 'auto',
      execute_seq: 1,
      batch_id: b.id,
      executor_id: h.executor.id,
      executed_at: bAt,
      created_at: ago(f, 61),
      row_version: 4,
    });
    await seedItem(f, x, a, { result: 'blocked', reason: 'channel_disabled', at: aAt });
    await seedItem(f, x, a, { result: 'moved_out', at: bAt, movedTo: b });
    await seedItem(f, x, b, { result: 'paying', at: bAt });
    await seedAttempt(f, x, { kind: 'transfer', result: 'unknown', at: t });

    const now = {
      result: 'moved_out',
      last_attempt: { kind: 'transfer', result: 'unknown', at: t.getTime() },
      next_query_at: t.getTime() + 30 * MINUTE,
      has_transfer_attempt: true,
    } as const;
    expect(Number(x.net_fen)).toBe(28_000);
    expect(await detailOf(await h.detail(a.id))).toEqual({
      ...summaryView(a, {
        executed_at: aAt.getTime(),
        member_count: 1,
        result_counts: { moved_out: 1 },
        held_count: 0,
      }),
      members: [memberView(x, now)],
    });
    expect(await detailOf(await h.detail(b.id))).toEqual({
      ...summaryView(b, {
        executed_at: bAt.getTime(),
        member_count: 1,
        result_counts: { paying: 1 },
        held_count: 0,
      }),
      members: [memberView(x, { ...now, result: 'paying' })],
    });
    expect(await batchIds(await h.list())).toEqual([b.id, a.id]);
  });
});

it('[AC-B2-07g#7] 换批次例的整批拒绝分支：水位不足什么都不写 → 单据留在 APPROVED、仍挂在自动批次上（result=blocked、hold_reason=null、不计 held、无转账）；之后改挂成功的另一单在原批次上即使在新批次被 W9 挂起也不计入原批次 held_count', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const aAt = ago(f, 90);
    const a = await seedBatch(f, { kind: 'auto', created_at: aAt });
    const stay = await seedWithdrawal(f, h, who, {
      amount_fen: 28_000n,
      status: 'APPROVED',
      review_mode: 'auto',
      batch_id: a.id,
      created_at: ago(f, 91),
      row_version: 2,
    });
    await seedItem(f, stay, a, { result: 'blocked', reason: 'channel_disabled', at: aAt });

    const a2At = ago(f, 80);
    const a2 = await seedBatch(f, { kind: 'auto', created_at: a2At });
    const bAt = ago(f, 20);
    const b = await seedBatch(f, { kind: 'manual', created_at: bAt, by: h.executor.id });
    const moved = await seedWithdrawal(f, h, who, {
      amount_fen: 28_000n,
      status: 'APPROVED',
      review_mode: 'auto',
      execute_seq: 1,
      batch_id: b.id,
      executor_id: h.executor.id,
      executed_at: bAt,
      hold_reason: 'queue_paused',
      hold_at: ago(f, 19),
      created_at: ago(f, 81),
      row_version: 5,
    });
    await seedItem(f, moved, a2, { result: 'blocked', reason: 'channel_disabled', at: a2At });
    await seedItem(f, moved, a2, { result: 'moved_out', at: bAt, movedTo: b });
    await seedItem(f, moved, b, { result: 'paying', at: bAt });

    expect(await detailOf(await h.detail(a.id))).toEqual({
      ...summaryView(a, {
        executed_at: aAt.getTime(),
        member_count: 1,
        result_counts: { blocked: 1 },
        held_count: 0,
      }),
      members: [
        memberView(stay, {
          result: 'blocked',
          last_attempt: null,
          next_query_at: null,
          has_transfer_attempt: false,
        }),
      ],
    });
    const view = {
      last_attempt: null,
      next_query_at: null,
      has_transfer_attempt: false,
    } as const;
    expect(await detailOf(await h.detail(a2.id))).toEqual({
      ...summaryView(a2, {
        executed_at: a2At.getTime(),
        member_count: 1,
        result_counts: { moved_out: 1 },
        held_count: 0,
      }),
      members: [memberView(moved, { ...view, result: 'moved_out' })],
    });
    expect(await detailOf(await h.detail(b.id))).toEqual({
      ...summaryView(b, {
        executed_at: bAt.getTime(),
        member_count: 1,
        result_counts: { paying: 1 },
        held_count: 1,
      }),
      members: [memberView(moved, { ...view, result: 'paying' })],
    });
  });
});

it('[AC-B2-07g#7] result 取该单在本批次最新一条 item：同一时刻按 item id 取较大的一条（moved_out 的 id 大 → moved_out；blocked 的 id 大 → blocked）；成员按本批次第一条 item 的时间排，executed_at 为最早的 paying / skipped / blocked', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const pAt = ago(f, 30);
    const qAt = ago(f, 20);
    const p = await seedBatch(f, { kind: 'manual', created_at: pAt, by: h.executor.id });
    const q = await seedBatch(f, { kind: 'manual', created_at: qAt, by: h.executor.id });
    const onQ = {
      status: 'PAYING',
      review_mode: 'manual',
      execute_seq: 1,
      batch_id: q.id,
      executor_id: h.executor.id,
      executed_at: qAt,
      created_at: ago(f, 40),
      row_version: 3,
    } as const;
    const u = await seedWithdrawal(f, h, who, onQ);
    const v = await seedWithdrawal(f, h, who, onQ);
    const [uLow, uHigh] = orderedIds();
    await seedItemWithId(f, u, p, {
      id: uLow,
      result: 'blocked',
      reason: 'member_blocked',
      at: pAt,
    });
    await seedItemWithId(f, u, p, { id: uHigh, result: 'moved_out', at: pAt, movedTo: q });
    const [vLow, vHigh] = orderedIds();
    await seedItemWithId(f, v, p, {
      id: vHigh,
      result: 'blocked',
      reason: 'member_blocked',
      at: plus(pAt, 1),
    });
    await seedItemWithId(f, v, p, { id: vLow, result: 'moved_out', at: plus(pAt, 1), movedTo: q });
    await seedItem(f, u, q, { result: 'paying', at: qAt });
    await seedItem(f, v, q, { result: 'paying', at: plus(qAt, 1) });

    const none = { last_attempt: null, next_query_at: null, has_transfer_attempt: false } as const;
    expect(await detailOf(await h.detail(p.id))).toEqual({
      ...summaryView(p, {
        executed_at: pAt.getTime(),
        member_count: 2,
        result_counts: { moved_out: 1, blocked: 1 },
        held_count: 0,
      }),
      members: [
        memberView(u, { ...none, result: 'moved_out' }),
        memberView(v, { ...none, result: 'blocked' }),
      ],
    });
  });
});
