// B2-06c ③ the watermark check of EXECUTE (规划/08 BR-WDR-18 ①②③, BR-WDR-12 ③, D10-223 水位表):
// W = the latest payout_watermarks row of (app, channel) by measured_at; stale when missing or older
// than 2 hours (exactly 2 hours passes); P = round_half_up(7-day total / 7) × 3 over the 7 complete
// natural days (+08:00) before today, REJECTED excluded; Σ batch + Σ PAYING + Σ paid after t_W must
// not exceed W × usable_bp / 10000 (equality passes). W and P are both per channel (D10-285,
// D10-288 Q2: P over that channel's payout_channel only). An executable set of one channel is refused
// as a whole, atomically; an executable set of ≥ 2 channels blocks only the failing channel's
// withdrawals (left / item blocked with the watermark reason, still APPROVED, no job) while the other
// channels go on to PAYING (D10-288 Q3, D10-290). Expected values are computed here by hand.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ExecuteBatchResult } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import {
  HOUR,
  MINUTE,
  NOW,
  TIMEOUT,
  batches,
  close,
  events,
  executed,
  expectJob,
  expectPaying,
  expectUntouched,
  items,
  jobs,
  open,
  setup,
  snapshot,
  sorted,
  withdrawal,
  type Channel,
  type ExecuteFixture,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const ago = (ms: number) => new Date(NOW.getTime() - ms);

type WatermarkReason = 'watermark_stale' | 'watermark_below_forecast' | 'watermark_usable_exceeded';
interface Left {
  id: string;
  reason: string;
}
const byId = (a: Left, b: Left) => a.id.localeCompare(b.id);
const itemKey = (row: { batch_id: string; withdrawal_id: string; result: string }) =>
  `${row.batch_id}${row.withdrawal_id}${row.result}`;

/** Finished withdrawals of the forecast window, all of one fresh member (paid a minute after creation). */
async function seedHistory(
  f: ExecuteFixture,
  rows: readonly {
    net: bigint;
    channel: Channel;
    status: 'PAID_API' | 'FAILED' | 'REJECTED';
    createdAt: string;
  }[],
) {
  const owner = await f.newUser();
  for (const row of rows) {
    const createdAt = new Date(row.createdAt);
    await f.seedWithdrawal({
      userId: owner,
      net: row.net,
      channel: row.channel,
      status: row.status,
      createdAt,
      paidAt: new Date(createdAt.getTime() + MINUTE),
    });
  }
}

/**
 * A mixed-channel batch split by the watermark (D10-288 Q3): one new manual batch; `paying` in
 * PAYING (seq 1, item paying, one job id:1, one event each); `blocked` still APPROVED, never
 * executed, on no batch, no job, item blocked with `reason`; `also` the ② leftovers with their items.
 * D10-609 (B2-09n): a withdrawal the watermark leaves behind is now on this batch, so the mixed-channel
 * tests list it under `also` and assert its batch_id, row_version and updated_at themselves; `blocked`
 * stays empty. This helper is left as it was: a change here would judge every test of the file as
 * changed in the red check.
 */
async function expectSplit(
  f: ExecuteFixture,
  result: ExecuteBatchResult,
  expected: {
    paying: readonly string[];
    blocked: readonly string[];
    reason: WatermarkReason;
    also?: readonly (Left & { result: 'skipped' | 'blocked' })[];
  },
) {
  const also = expected.also ?? [];
  const answer = executed(result);
  expect(sorted(answer.paying)).toEqual(sorted(expected.paying));
  expect([...answer.left].sort(byId)).toEqual(
    [
      ...expected.blocked.map((id) => ({ id, reason: expected.reason })),
      ...also.map(({ id, reason }) => ({ id, reason })),
    ].sort(byId),
  );
  expect(await batches(f)).toEqual([
    { id: answer.batchId, kind: 'manual', created_by: expect.any(String) },
  ]);
  for (const id of expected.paying) {
    await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  }
  for (const id of expected.blocked) {
    await expectUntouched(f, id, 'APPROVED');
    expect((await withdrawal(f, id)).batch_id).toBeNull();
  }
  const row = (withdrawalId: string, result: string, reason: string | null) => ({
    batch_id: answer.batchId,
    withdrawal_id: withdrawalId,
    result,
    reason,
    moved_to_batch_id: null,
  });
  expect(await items(f)).toEqual(
    [
      ...expected.paying.map((id) => row(id, 'paying', null)),
      ...expected.blocked.map((id) => row(id, 'blocked', expected.reason)),
      ...also.map((left) => row(left.id, left.result, left.reason)),
    ].sort((a, b) => itemKey(a).localeCompare(itemKey(b))),
  );
  const queued = await jobs(f);
  expect(queued).toHaveLength(expected.paying.length);
  for (const id of expected.paying) expectJob(f, queued, id, 1);
  const changed = await events(f);
  expect(changed).toHaveLength(expected.paying.length);
  expect(changed).toEqual(
    expect.arrayContaining(
      expected.paying.map((id) =>
        expect.objectContaining({
          payload: expect.objectContaining({
            data: expect.objectContaining({ withdrawal_id: id, status: 'PAYING' }),
          }),
        }),
      ),
    ),
  );
}

it('[AC-B2-06c#3] ③ 该通道没有水位记录：整批拒绝 watermark_stale，零迁移零明细零任务', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  const a = await f.seedWithdrawal();
  const b = await f.seedWithdrawal({ net: 50n });
  const before = await snapshot(f);
  expect(await f.run(service, [a, b])).toEqual({
    kind: 'rejected',
    reason: 'watermark_stale',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  ['恰好 2 小时', 2 * HOUR, 'executed'],
  ['2 小时又 1 毫秒', 2 * HOUR + 1, 'watermark_stale'],
] as const)('[AC-B2-06c#3] ③ t_W 距今%s → %s', async (_name, age, outcome) => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1_000_000n, ago(age), 'alipay');
  const id = await f.seedWithdrawal();
  const before = await snapshot(f);
  const result = await f.run(service, [id]);
  if (outcome === 'executed') {
    const answer = executed(result);
    expect(answer.paying).toEqual([id]);
    await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  } else {
    expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
    expect(await snapshot(f)).toEqual(before);
  }
});

it('[AC-B2-06c#3] ③ W 取该 app、该通道 measured_at 最新的一行（不看录入先后、别的通道与别的 app）', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(50n, ago(30 * MINUTE), 'alipay');
  // Entered later, measured earlier: not the latest reading.
  await f.watermark(1_000_000_000n, ago(HOUR), 'alipay');
  await f.watermark(1_000_000_000n, ago(MINUTE), 'bank_card');
  await f.watermark(1_000_000_000n, ago(MINUTE), 'alipay', `other_${f.appId}`);
  const id = await f.seedWithdrawal({ net: 100n });
  const before = await snapshot(f);
  // usable = 50 × 10000 / 10000 = 50 < 100.
  expect(await f.run(service, [id])).toEqual({
    kind: 'rejected',
    reason: 'watermark_usable_exceeded',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
});

it.each([
  [3003n, 'executed'],
  [3002n, 'watermark_below_forecast'],
] as const)(
  '[AC-B2-06c#3] ③ P = round_half_up(近 7 个完整自然日申请合计 7004 / 7) × 3 = 3003；W=%s → %s',
  async (w, outcome) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    const o = await f.newUser();
    const at = (iso: string) => new Date(iso);
    const plusMinute = (iso: string) => new Date(at(iso).getTime() + MINUTE);
    // Window [2026-10-12 00:00 +08:00, 2026-10-19 00:00 +08:00) = [10-11T16:00Z, 10-18T16:00Z).
    const inside = [
      { net: 4000n, status: 'PAID_API', createdAt: '2026-10-11T16:00:00.000Z' },
      { net: 3000n, status: 'FAILED', createdAt: '2026-10-15T03:00:00.000Z' },
      { net: 4n, status: 'PENDING_REVIEW', createdAt: '2026-10-18T15:59:59.999Z' },
    ] as const;
    const outside = [
      { net: 7000n, status: 'REJECTED', createdAt: '2026-10-14T03:00:00.000Z' },
      { net: 7000n, status: 'PAID_API', createdAt: '2026-10-11T15:59:59.999Z' },
      { net: 7000n, status: 'PAID_API', createdAt: '2026-10-18T16:00:00.000Z' },
    ] as const;
    for (const row of [...inside, ...outside]) {
      await f.seedWithdrawal({
        userId: o,
        net: row.net,
        status: row.status,
        createdAt: at(row.createdAt),
        paidAt: plusMinute(row.createdAt),
      });
    }
    const otherApp = `other_${f.appId}`;
    await f.seedWithdrawal({
      appId: otherApp,
      userId: await f.newUser(0n, otherApp),
      net: 7000n,
      status: 'APPROVED',
      createdAt: at('2026-10-15T03:00:00.000Z'),
    });
    await f.watermark(w, ago(10 * MINUTE), 'alipay');
    const id = await f.seedWithdrawal({ net: 100n });
    const before = await snapshot(f);
    const result = await f.run(service, [id]);
    if (outcome === 'executed') {
      expect(executed(result).paying).toEqual([id]);
    } else {
      expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
      expect(await snapshot(f)).toEqual(before);
    }
  },
);

it.each([
  [2500n, 'executed'],
  [2501n, 'watermark_usable_exceeded'],
] as const)(
  '[AC-B2-06c#3] ③ Σ 本批(3000+%s) + Σ PAYING(2000) + Σ t_W 后到账(1000+500) 对 W×9000/10000=9000 → %s',
  async (second, outcome) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    await f.set('payout.watermark_usable_bp', 9000);
    const tW = ago(HOUR);
    await f.watermark(10000n, tW, 'alipay');
    const o = await f.newUser();
    const earlier = ago(3 * HOUR);
    // Counted: PAYING, and PAID_API / PAID_MANUAL paid after t_W.
    await f.seedWithdrawal({ userId: o, net: 2000n, status: 'PAYING', createdAt: earlier });
    await f.seedWithdrawal({
      userId: o,
      net: 1000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(30 * MINUTE),
    });
    await f.seedWithdrawal({
      userId: o,
      net: 500n,
      status: 'PAID_MANUAL',
      createdAt: earlier,
      paidAt: ago(20 * MINUTE),
    });
    // Not counted: paid before t_W, other states, another app.
    await f.seedWithdrawal({
      userId: o,
      net: 50000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(2 * HOUR),
    });
    await f.seedWithdrawal({ userId: o, net: 7777n, status: 'APPROVED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'FAILED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'REJECTED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'PENDING_REVIEW', createdAt: earlier });
    const otherApp = `other_${f.appId}`;
    const stranger = await f.newUser(0n, otherApp);
    await f.seedWithdrawal({
      appId: otherApp,
      userId: stranger,
      net: 50000n,
      status: 'PAYING',
      createdAt: earlier,
    });
    await f.seedWithdrawal({
      appId: otherApp,
      userId: stranger,
      net: 50000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(10 * MINUTE),
    });
    const a = await f.seedWithdrawal({ net: 3000n });
    const b = await f.seedWithdrawal({ net: second });
    const before = await snapshot(f);
    const result = await f.run(service, [a, b]);
    if (outcome === 'executed') {
      expect(sorted(executed(result).paying)).toEqual(sorted([a, b]));
    } else {
      expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
      expect(await snapshot(f)).toEqual(before);
    }
  },
);

it.each([
  [1n, 1n, 'watermark_usable_exceeded'],
  [10001n, 9001n, 'watermark_usable_exceeded'],
  [10001n, 9000n, 'executed'],
] as const)(
  '[AC-B2-06c#3] ③ 可用上限按 Σ×10000 与 W×bp 精确比较、不取整：W=%s、bp=9000、Σ 本批=%s → %s',
  async (w, net, outcome) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    await f.set('payout.watermark_usable_bp', 9000);
    // No history: P = 0 ≤ W. 1 × 9000 / 10000 = 0.9; 10001 × 9000 / 10000 = 9000.9.
    await f.watermark(w, ago(10 * MINUTE), 'alipay');
    const id = await f.seedWithdrawal({ net });
    const before = await snapshot(f);
    const result = await f.run(service, [id]);
    if (outcome === 'executed') {
      const answer = executed(result);
      expect(answer.paying).toEqual([id]);
      await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
    } else {
      expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
      expect(await snapshot(f)).toEqual(before);
    }
  },
);

it('[AC-B2-06c#3] ③ 只对可执行集合求和：② 留下的单不计入本批合计', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1000n, ago(10 * MINUTE), 'alipay');
  const frozen = await f.newUser();
  f.risk.set(frozen, { state: 'frozen', frozen_until: null });
  const good = await f.seedWithdrawal({ net: 1000n });
  const blocked = await f.seedWithdrawal({ userId: frozen, net: 500n });
  const answer = executed(await f.run(service, [good, blocked]));
  expect(answer.paying).toEqual([good]);
  expect(answer.left).toEqual([{ id: blocked, reason: 'member_blocked' }]);
});

it('[AC-B2-06c#3] ③ 按通道分别计算：两个通道各自 W=100、各一单 100 都通过', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(100n, ago(10 * MINUTE), 'alipay');
  await f.watermark(100n, ago(10 * MINUTE), 'bank_card');
  const a = await f.seedWithdrawal({ net: 100n, channel: 'alipay' });
  const b = await f.seedWithdrawal({ net: 100n, channel: 'bank_card', userId: await f.newUser() });
  const answer = executed(await f.run(service, [a, b]));
  expect(sorted(answer.paying)).toEqual(sorted([a, b]));
  await expectPaying(f, a, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  await expectPaying(f, b, { batchId: answer.batchId, seq: 1, executor: f.adminId });
});

/**
 * Forecast window [10-11T16:00Z, 10-18T16:00Z): alipay total 4000 + 3000 = 7000 → P = 1000 × 3 =
 * 3000; bank_card total 700 (REJECTED 7000 excluded) → P = 100 × 3 = 300; one P over both channels
 * would be round_half_up(7700 / 7) × 3 = 3300.
 */
const HISTORY = [
  { net: 4000n, channel: 'alipay', status: 'PAID_API', createdAt: '2026-10-12T03:00:00.000Z' },
  { net: 3000n, channel: 'alipay', status: 'FAILED', createdAt: '2026-10-16T03:00:00.000Z' },
  { net: 700n, channel: 'bank_card', status: 'PAID_API', createdAt: '2026-10-14T03:00:00.000Z' },
  { net: 7000n, channel: 'bank_card', status: 'REJECTED', createdAt: '2026-10-15T03:00:00.000Z' },
] as const;

it.each([
  ['没有水位记录', null],
  ['t_W 距今 2 小时又 1 毫秒', 2 * HOUR + 1],
] as const)(
  '[AC-B2-06c#3] ③ 混通道批次、bank_card %s：只拦 bank_card 的单（blocked / watermark_stale、留 APPROVED、不入队），支付宝的单照常 PAYING，② 的原因照写明细',
  async (_name, age) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    await f.watermark(1_000_000_000n, ago(10 * MINUTE), 'alipay');
    if (age !== null) await f.watermark(1_000_000_000n, ago(age), 'bank_card');
    const a = await f.seedWithdrawal({ channel: 'alipay' });
    const b = await f.seedWithdrawal({ channel: 'bank_card', userId: await f.newUser() });
    const paying = await f.seedWithdrawal({ status: 'PAYING', userId: await f.newUser() });
    const seeded = await withdrawal(f, b);
    const result = await f.run(service, [a, b, paying]);
    await expectSplit(f, result, {
      paying: [a],
      blocked: [],
      reason: 'watermark_stale',
      also: [
        { id: b, reason: 'watermark_stale', result: 'blocked' },
        { id: paying, reason: 'not_approved', result: 'skipped' },
      ],
    });
    await expectUntouched(f, b, 'APPROVED');
    expect(await withdrawal(f, b)).toMatchObject({
      batch_id: executed(result).batchId,
      row_version: seeded.row_version + 1,
      updated_at: NOW,
    });
  },
);

it('[AC-B2-06c#3] ③ P 按通道拆：支付宝 W=2999 < 自己的 P=3000 被拦（watermark_below_forecast），bank_card W=300 ≥ 自己的 P=300 照常 PAYING', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await seedHistory(f, HISTORY);
  // 2999 ≥ bank_card's P (300) and 300 < alipay's P (3000) or a joint P (3300): only own P decides.
  await f.watermark(2999n, ago(10 * MINUTE), 'alipay');
  await f.watermark(300n, ago(10 * MINUTE), 'bank_card');
  const a = await f.seedWithdrawal({ net: 100n, channel: 'alipay' });
  const b = await f.seedWithdrawal({ net: 100n, channel: 'bank_card', userId: await f.newUser() });
  const seeded = await withdrawal(f, a);
  const result = await f.run(service, [a, b]);
  await expectSplit(f, result, {
    paying: [b],
    blocked: [],
    reason: 'watermark_below_forecast',
    also: [{ id: a, reason: 'watermark_below_forecast', result: 'blocked' }],
  });
  await expectUntouched(f, a, 'APPROVED');
  expect(await withdrawal(f, a)).toMatchObject({
    batch_id: executed(result).batchId,
    row_version: seeded.row_version + 1,
    updated_at: NOW,
  });
});

it('[AC-B2-06c#3] ③ 混通道批次、支付宝 Σ 超可用上限：支付宝两单（600、500 各自都够、合计 1100 > W=1000）都被拦（watermark_usable_exceeded），bank_card 一单 100 = W=100 照常 PAYING', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1000n, ago(10 * MINUTE), 'alipay');
  await f.watermark(100n, ago(10 * MINUTE), 'bank_card');
  const a1 = await f.seedWithdrawal({ net: 600n, channel: 'alipay' });
  const a2 = await f.seedWithdrawal({ net: 500n, channel: 'alipay' });
  const b = await f.seedWithdrawal({ net: 100n, channel: 'bank_card', userId: await f.newUser() });
  const seeded = await withdrawal(f, a1);
  const result = await f.run(service, [a1, b, a2]);
  await expectSplit(f, result, {
    paying: [b],
    blocked: [],
    reason: 'watermark_usable_exceeded',
    also: [
      { id: a1, reason: 'watermark_usable_exceeded', result: 'blocked' },
      { id: a2, reason: 'watermark_usable_exceeded', result: 'blocked' },
    ],
  });
  for (const id of [a1, a2]) {
    await expectUntouched(f, id, 'APPROVED');
    expect(await withdrawal(f, id)).toMatchObject({
      batch_id: executed(result).batchId,
      row_version: seeded.row_version + 1,
      updated_at: NOW,
    });
  }
});

it.each([
  { reason: 'watermark_stale', w: null, history: false, nets: [100n] },
  { reason: 'watermark_below_forecast', w: 2999n, history: true, nets: [100n] },
  { reason: 'watermark_usable_exceeded', w: 1000n, history: false, nets: [600n, 500n] },
] as const)(
  '[AC-B2-06c#3] ③ 对照：可执行集合只有一个通道（bank_card 的单已在 ② 留下）→ 照旧整批拒绝 $reason 并指明通道，零迁移零明细（② 的原因也不写）零任务',
  async ({ reason, w, history, nets }) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    if (history) await seedHistory(f, HISTORY);
    if (w !== null) await f.watermark(w, ago(10 * MINUTE), 'alipay');
    await f.watermark(1_000_000_000n, ago(10 * MINUTE), 'bank_card');
    await f.set('payout.channel_enabled.bank_card', false);
    const members: string[] = [];
    for (const net of nets) members.push(await f.seedWithdrawal({ net, channel: 'alipay' }));
    const bank = await f.seedWithdrawal({ channel: 'bank_card', userId: await f.newUser() });
    const before = await snapshot(f);
    expect(await f.run(service, [...members, bank])).toEqual({
      kind: 'rejected',
      reason,
      channel: 'alipay',
    });
    expect(await snapshot(f)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  },
);
