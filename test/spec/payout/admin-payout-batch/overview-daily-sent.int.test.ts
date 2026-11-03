// B2-09l overview rule tests, daily_sent_fen (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetPayoutOverview, 08 BR-WDR-13 ③, BR-WDR-18 — today's (+08:00) Σ net_fen of kind=transfer attempts
// with result pending, success or unknown, across channels, as the pre-transfer review counts it
// (jobs/transfer-job.ts). The fixture's clock is 2026-11-03 10:00 +08:00: today starts at
// 2026-11-02T16:00:00Z, which a UTC day would call yesterday. Expected sums are by hand, of nets
// divisible neither by 3 nor by 7. Requests go through the real admin entry (batch-harness.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  HOUR,
  fixture,
  ofNet,
  otherApp,
  payee,
  seedReview,
  seedSent,
  suite,
  viewOf,
  withBatchAdmin,
  type AttemptResult,
  type BatchAdmin,
  type Member,
  type ReviewFixture,
} from './batch-harness.ts';

const s = suite();

const TODAY_START = new Date('2026-11-02T16:00:00.000Z');
const YESTERDAY_END = new Date('2026-11-02T15:59:59.000Z');
const THIS_MORNING = new Date('2026-11-03T01:00:00.000Z');

/** A PAYING withdrawal of this net with one attempt. */
async function sent(
  f: ReviewFixture,
  h: BatchAdmin,
  who: Member,
  input: {
    readonly net: bigint;
    readonly kind?: 'transfer' | 'query';
    readonly result?: AttemptResult;
    readonly at?: Date;
    readonly method?: 'alipay' | 'bank_card' | 'wechat';
  },
): Promise<void> {
  const row = await seedReview(f, h, who, {
    status: 'PAYING',
    execute_seq: 1,
    method: input.method ?? 'alipay',
    ...ofNet(input.net),
  });
  await seedSent(
    f,
    row,
    input.kind ?? 'transfer',
    input.result ?? 'success',
    input.at ?? THIS_MORNING,
  );
}

it('[AC-B2-09l#62] 今日合计：pending 12,347（alipay）+ success 30,011（wechat）+ unknown 7,013（bank_card）= 49,371，按 net_fen（不是 amount_fen），跨通道', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await sent(f, h, who, { net: 12_347n, result: 'pending' });
    await sent(f, h, who, { net: 30_011n, result: 'success', method: 'wechat' });
    await sent(f, h, who, { net: 7_013n, result: 'unknown', method: 'bank_card' });

    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(49_371);
  });
});

it('[AC-B2-09l#63] 不计：result=fail、kind=query（success 的查询也不算）；只有这些时是 0；再加一笔 success 11,003 就是 11,003', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await sent(f, h, who, { net: 99_991n, result: 'fail' });
    await sent(f, h, who, { net: 50_021n, kind: 'query', result: 'success' });

    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(0);

    await sent(f, h, who, { net: 11_003n });
    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(11_003);
  });
});

it('[AC-B2-09l#64] 日界按 +08:00：昨日 23:59:59 不计，今日 00:00:00 计（这个时刻按 UTC 还是昨天）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await sent(f, h, who, { net: 70_001n, at: YESTERDAY_END });
    await sent(f, h, who, { net: 20_011n, at: TODAY_START });

    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(20_011);
  });
});

it('[AC-B2-09l#65] 日切：时钟走到次日 00:00:00（+08:00），昨天的 20,011 不再计入今日', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await sent(f, h, await payee(f, h), { net: 20_011n, at: THIS_MORNING });
    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(20_011);

    f.clock.advanceMs(14 * HOUR);
    const fresh = await h.caller(['fund.view']);
    expect((await viewOf(await h.overview(fresh))).daily_sent_fen).toBe(0);
  });
});

it('[AC-B2-09l#66] 只算本 app：别的 app 今日 success 80,021 不计', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    await sent(other, h, await payee(other, h), { net: 80_021n });
    await sent(f, h, await payee(f, h), { net: 10_007n });

    expect((await viewOf(await h.overview())).daily_sent_fen).toBe(10_007);
  });
});
