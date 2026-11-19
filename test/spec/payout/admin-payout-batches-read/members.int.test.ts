// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): the members of a batch as
// getAdminPayoutBatch reads them (contracts/openapi.yaml CT-24zzo; 08 BR-WDR-14, BR-WDR-17 细则例;
// ruling D10-2017 ②). The BR-WDR-17 example of a 20-withdrawal batch stopped by a payer-side code at
// the 8th: 1–7 PAYING with an unknown transfer (has_transfer_attempt, next_query_at by
// payout.query_schedule), 8 APPROVED payer_side_after_transfer with its transfer (never re-executed,
// next_query_at null), 9–20 APPROVED queue_paused without a transfer (re-executable); held_count 13.
// The switches do not pause queries (BR-WDR-17: a PAYING withdrawal whose transfer went out keeps
// being queried): with payout.queue_paused=true and / or payout.enabled=off the same batch reads the
// same, field for field.
// next_query_at reads the app's payout.query_schedule (a changed configuration changes it) with T
// the transfer attempt's `at` (not the newest query), and is null for needs_manual, the WeChat
// confirmation stage (wait_user_confirm / canceling) and anything not PAYING; processing and a null
// channel_state are computed. Rows are seeded as EXECUTE, the payout process and W9 leave them.
// Expected values are written by hand (instants as epoch milliseconds). Top-level it() only.
import { expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  SECOND,
  ago,
  detailOf,
  fixture,
  heldOn,
  member,
  memberOf,
  memberView,
  pageOf,
  payingOn,
  plus,
  seedAttempt,
  seedBatch,
  setSchedule,
  setSwitch,
  suite,
  summaryView,
  withBatches,
  type BatchRow,
  type BatchesAdmin,
  type Fixture,
  type LastAttempt,
  type WithdrawalRow,
} from './kit.ts';

const s = suite();

/**
 * The batch of the BR-WDR-17 example (20 members, the 8th stopped by a payer-side code) and what a
 * read must show for it at the fixture's clock: the batch row and its members in order.
 */
async function seedExample(
  f: Fixture,
  h: BatchesAdmin,
): Promise<{
  readonly batch: BatchRow;
  readonly summary: Record<string, unknown>;
  readonly members: Record<string, unknown>[];
}> {
  const who = await member(f, h);
  const now = f.clock.now().getTime();
  const executedAt = ago(f, 40);
  const batch = await seedBatch(f, {
    kind: 'manual',
    created_at: executedAt,
    by: h.executor.id,
  });
  // Members 1–7: how long before the clock the transfer went out, and the next point after T
  // (default points T+1, +5, +30, +120 minutes, then every 120 minutes).
  const sent = [
    { before: 40 * MINUTE - 2 * SECOND, next: 120 * MINUTE },
    { before: 30 * MINUTE, next: 120 * MINUTE },
    { before: 30 * MINUTE - 1, next: 30 * MINUTE },
    { before: 5 * MINUTE, next: 30 * MINUTE },
    { before: 4 * MINUTE, next: 5 * MINUTE },
    { before: 1 * MINUTE, next: 5 * MINUTE },
    { before: 20 * SECOND, next: 1 * MINUTE },
  ];
  const members: Record<string, unknown>[] = [];
  for (const [index, spec] of sent.entries()) {
    const t = now - spec.before;
    const row = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, index),
      transferAt: new Date(t),
    });
    // The queries the payout process already made (result unknown), each on its point.
    let last: LastAttempt = { kind: 'transfer', result: 'unknown', at: t };
    for (const point of [1, 5, 30]) {
      if (point * MINUTE > spec.before) continue;
      const queryAt = t + point * MINUTE;
      await seedAttempt(f, row, { kind: 'query', result: 'unknown', at: new Date(queryAt) });
      last = { kind: 'query', result: 'unknown', at: queryAt };
    }
    members.push(
      memberView(row, {
        result: 'paying',
        last_attempt: last,
        next_query_at: t + spec.next,
        has_transfer_attempt: true,
      }),
    );
  }
  // Member 8: the transfer answered a payer-side code → W9 payer_side_after_transfer.
  const eighth = await heldOn(f, h, who, batch, {
    reason: 'payer_side_after_transfer',
    executedAt,
    itemAt: plus(executedAt, 7),
    heldAt: plus(executedAt, 4 * SECOND),
  });
  const eighthTransfer = plus(executedAt, 3 * SECOND);
  await seedAttempt(f, eighth, { kind: 'transfer', result: 'fail', at: eighthTransfer });
  members.push(
    memberView(eighth, {
      result: 'paying',
      last_attempt: { kind: 'transfer', result: 'fail', at: eighthTransfer.getTime() },
      next_query_at: null,
      has_transfer_attempt: true,
    }),
  );
  // Members 9–20: their review saw queue_paused → W9 queue_paused, no transfer.
  for (let index = 8; index < 20; index += 1) {
    const row = await heldOn(f, h, who, batch, {
      reason: 'queue_paused',
      executedAt,
      itemAt: plus(executedAt, index),
      heldAt: plus(executedAt, 5 * SECOND),
    });
    members.push(
      memberView(row, {
        result: 'paying',
        last_attempt: null,
        next_query_at: null,
        has_transfer_attempt: false,
      }),
    );
  }
  const summary = summaryView(batch, {
    executed_at: executedAt.getTime(),
    member_count: 20,
    result_counts: { paying: 20 },
    held_count: 13,
  });
  return { batch, summary, members };
}

it('[AC-B2-07g#3] BR-WDR-17 例：20 单批次第 8 单付款方失败——第 1–7 单 PAYING、转账结果未知 → has_transfer_attempt=true、next_query_at = T + 第一个晚于 Clock 的查询点；第 8 单 APPROVED payer_side_after_transfer、有转账 → true / null；第 9–20 单 APPROVED queue_paused、无转账 → false / null；held_count=13，result_counts 四项相加等于 member_count=20，列表行与详情一致', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const { batch, summary, members: expected } = await seedExample(f, h);
    const detail = await detailOf(await h.detail(batch.id));
    expect(detail).toEqual({ ...summary, members: expected });
    const counts = detail['result_counts'] as Record<string, number>;
    expect(counts['paying']! + counts['skipped']! + counts['blocked']! + counts['moved_out']!).toBe(
      detail['member_count'],
    );
    expect((await pageOf(await h.list())).items).toEqual([summary]);
  });
});

it('[AC-B2-07g#3] BR-WDR-17：已发出转账的 PAYING 单继续查询，查询不因开关暂停——同一 BR-WDR-17 例在 payout.queue_paused=true、payout.enabled=off、两者同时成立时，第 1–7 单 next_query_at 照算，详情与列表行与开关为默认时逐字段相同（held_count=13 不变）', async () => {
  // Each setting on a fresh app and entry, the switches written before the first read (no cached
  // configuration can stand in for them); the expected reads are the hand-written defaults ones.
  const settings = [
    { label: 'payout.queue_paused=true', queuePaused: true, enabled: true },
    { label: 'payout.enabled=off', queuePaused: false, enabled: false },
    { label: 'payout.queue_paused=true, payout.enabled=off', queuePaused: true, enabled: false },
  ];
  for (const setting of settings) {
    const f = fixture(s);
    await withBatches(f, async (h) => {
      const { batch, summary, members: expected } = await seedExample(f, h);
      await setSwitch(f, 'payout.queue_paused', setting.queuePaused);
      await setSwitch(f, 'payout.enabled', setting.enabled);

      const detail = await detailOf(await h.detail(batch.id));
      expect(
        (detail['members'] as Record<string, unknown>[]).slice(0, 7).map((m) => m['next_query_at']),
        `members 1–7 next_query_at, ${setting.label}`,
      ).toEqual(expected.slice(0, 7).map((m) => m['next_query_at']));
      expect(detail, setting.label).toEqual({ ...summary, members: expected });
      expect((await pageOf(await h.list())).items, setting.label).toEqual([summary]);
    });
  }
}, 300_000);

it('[AC-B2-07g#4] next_query_at 照读本 app 的 payout.query_schedule：默认节奏下已过 11 分 → T+30 分；改为 points [2, 10]、interval 60、manual_after 300 后同一时刻读出 T+70 分（不另写一份常量）；恰在点上（已过 5 分）默认 → T+30 分、改后 → T+10 分；T 取转账尝试的 at，不取更晚的查询', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 12);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const elevenAgo = ago(f, 11);
    const fiveAgo = ago(f, 5);
    const slow = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: executedAt,
      transferAt: elevenAgo,
    });
    const queryAt = plus(elevenAgo, 1 * MINUTE);
    await seedAttempt(f, slow, { kind: 'query', result: 'unknown', at: queryAt });
    const onPoint = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 1),
      transferAt: fiveAgo,
    });
    const views = (next: { slow: number; onPoint: number }) => [
      memberView(slow, {
        result: 'paying',
        last_attempt: { kind: 'query', result: 'unknown', at: queryAt.getTime() },
        next_query_at: elevenAgo.getTime() + next.slow,
        has_transfer_attempt: true,
      }),
      memberView(onPoint, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'unknown', at: fiveAgo.getTime() },
        next_query_at: fiveAgo.getTime() + next.onPoint,
        has_transfer_attempt: true,
      }),
    ];

    const before = await detailOf(await h.detail(batch.id));
    expect(before['members']).toEqual(views({ slow: 30 * MINUTE, onPoint: 30 * MINUTE }));

    await setSchedule(f, { points_min: [2, 10], interval_min: 60, manual_after_min: 300 });
    const after = await detailOf(await h.detail(batch.id));
    expect(after['members']).toEqual(views({ slow: 70 * MINUTE, onPoint: 10 * MINUTE }));
  });
});

it('[AC-B2-07g#4] next_query_at 上限截到 T + manual_after：needs_manual 还没置位而已过 25 小时 → T+24 小时（默认）；改 manual_after 为 300 分 → T+300 分；needs_manual=true 的同样情形 → null', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 26 * 60);
    const batch = await seedBatch(f, { kind: 'auto', created_at: executedAt });
    const t = ago(f, 25 * 60);
    const late = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: executedAt,
      transferAt: t,
      seed: { review_mode: 'auto', executor_id: null },
    });
    const manual = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 1),
      transferAt: t,
      seed: { review_mode: 'auto', executor_id: null, needs_manual: true },
    });
    const views = (lateNext: number) => [
      memberView(late, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'unknown', at: t.getTime() },
        next_query_at: t.getTime() + lateNext,
        has_transfer_attempt: true,
      }),
      memberView(manual, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'unknown', at: t.getTime() },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
    ];
    expect((await detailOf(await h.detail(batch.id)))['members']).toEqual(views(24 * HOUR));
    await setSchedule(f, { points_min: [1, 5, 30, 120], interval_min: 120, manual_after_min: 300 });
    expect((await detailOf(await h.detail(batch.id)))['members']).toEqual(views(300 * MINUTE));
  });
});

it('[AC-B2-07g#4] 微信零钱单：channel_state processing 照算（已过 3 分 → T+5 分）；wait_user_confirm、canceling 为 null（BR-WDR-33 ⑥，不按 BR-WDR-14 计时），has_transfer_attempt 仍为 true', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 4);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const t = ago(f, 3);
    const states = ['processing', 'wait_user_confirm', 'canceling'] as const;
    const rows: WithdrawalRow[] = [];
    for (const [index, state] of states.entries()) {
      rows.push(
        await payingOn(f, h, who, batch, {
          executedAt,
          itemAt: plus(executedAt, index),
          transferAt: t,
          seed: {
            method: 'wechat',
            channel_state: state,
            confirm_deadline: state === 'processing' ? null : plus(t, 24 * HOUR),
          },
        }),
      );
    }
    const detail = await detailOf(await h.detail(batch.id));
    const nexts: readonly (number | null)[] = [t.getTime() + 5 * MINUTE, null, null];
    rows.forEach((row, index) => {
      expect(memberOf(detail, row), states[index]).toEqual(
        memberView(row, {
          result: 'paying',
          last_attempt: { kind: 'transfer', result: 'unknown', at: t.getTime() },
          next_query_at: nexts[index] ?? null,
          has_transfer_attempt: true,
        }),
      );
    });
  });
});

it('[AC-B2-07g#4] PAYING 而还没有转账尝试（任务在队列里）→ has_transfer_attempt=false、last_attempt=null、next_query_at=null；终态（PAID_API、FAILED）有转账尝试也为 null', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 20);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const queued = await payingOn(f, h, who, batch, { executedAt, itemAt: executedAt });
    const t = ago(f, 19);
    const paid = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 1),
      transferAt: t,
      transferResult: 'success',
      seed: { status: 'PAID_API', paid_at: plus(t, 2 * SECOND), channel_order_id: 'CH0001' },
    });
    const failed = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 2),
      transferAt: t,
      transferResult: 'fail',
      seed: { status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' },
    });
    const detail = await detailOf(await h.detail(batch.id));
    expect(detail['members']).toEqual([
      memberView(queued, {
        result: 'paying',
        last_attempt: null,
        next_query_at: null,
        has_transfer_attempt: false,
      }),
      memberView(paid, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'success', at: t.getTime() },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
      memberView(failed, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'fail', at: t.getTime() },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
    ]);
  });
});
