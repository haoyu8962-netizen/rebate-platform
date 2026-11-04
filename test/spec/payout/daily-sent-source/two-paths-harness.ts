// B2-09o harness (claude-independent, SPEC_REF 6f50a051; D10-602 (a), 08 BR-WDR-13 ③): the two copies
// of "today's sent amount" on one database, one app and one injected clock.
//   Overview: GET /admin/v1/payout-overview through the real admin entry (withBatchAdmin of
//   ../admin-payout-batch/batch-harness.ts), its daily_sent_fen read back as S.
//   Review: the real jobs/transfer-job.ts with the worker's review turn and the release
//   (f.job of ../process/kit.ts), judging a withdrawal of net n under payout.daily_cap_fen.
// Everything is built from those two kits: the process fixture owns the database, the app id and the
// FixedClock, and the admin entry is started on exactly those. Neither query is repeated here, and
// the comparison uses S as the overview answered it, so one side changing alone turns it red.
// Only *.int.test.ts files import this harness (it creates the database).
import { afterAll, beforeAll, expect } from 'vitest';
import {
  viewOf,
  withBatchAdmin,
  type BatchAdmin,
  type ReviewFixture,
} from '../admin-payout-batch/batch-harness.ts';
import {
  TIMEOUT,
  attempts,
  close,
  open,
  scripted,
  setup,
  withdrawal,
  type Channel,
  type Harness,
  type ProcessFixture,
} from '../process/kit.ts';

/**
 * The clock of every test: 2026-10-20 04:00 +08:00, which is still 2026-10-19 in UTC, so a day taken
 * from the UTC date or bounded in UTC disagrees with the +08:00 day on the rows around its start.
 */
export const CLOCK_AT = '2026-10-19T20:00:00.000Z';
/** Today (+08:00) of the clock starts here: 2026-10-20 00:00:00 +08:00. */
export const TODAY_START = new Date('2026-10-19T16:00:00.000Z');
/** The instant before it: 2026-10-19 23:59:59.999 +08:00. */
export const YESTERDAY_END = new Date('2026-10-19T15:59:59.999Z');
/** Today's end, exclusive: 2026-10-21 00:00:00 +08:00. */
export const TOMORROW_START = new Date('2026-10-20T16:00:00.000Z');
/** Inside today: 2026-10-20 03:00 +08:00. */
export const THIS_MORNING = new Date('2026-10-19T19:00:00.000Z');

/** A seeded row's fee and tax: never zero, so amount_fen differs from net_fen on every row. */
export const FEE = 211n;
export const TAX = 89n;

export interface SentSeed {
  readonly net: bigint;
  readonly result: 'pending' | 'success' | 'fail' | 'unknown';
  readonly at?: Date;
  readonly kind?: 'transfer' | 'query';
  readonly channel?: Channel;
  readonly fee?: bigint;
  readonly tax?: bigint;
}

/** The withdrawal the review judges; n of the task is its net. */
export interface WaitingSeed {
  readonly net: bigint;
  readonly fee: bigint;
  readonly tax: bigint;
  readonly channel?: Channel;
}

export interface TwoPaths {
  readonly f: ProcessFixture;
  readonly admin: BatchAdmin;
}

interface Testing {
  readonly createTestDatabase: Parameters<typeof open>[0];
  acquireTestRedis(): Promise<{ readonly url: string; stop(): Promise<void> }>;
}

export function twoPathsSuite() {
  let harness: Harness | undefined;
  let redis: { readonly url: string; stop(): Promise<void> } | undefined;
  beforeAll(async () => {
    // By URL, like ../admin-withdrawals/kit.ts: only *.int.test.ts may depend on @couli/db/testing.
    const testing = (await import(
      new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
    )) as Testing;
    harness = await open(testing.createTestDatabase);
    redis = await testing.acquireTestRedis();
  }, 180_000);
  afterAll(async () => {
    try {
      await close(harness);
    } finally {
      await redis?.stop();
    }
  }, TIMEOUT);
  return {
    harness(): Harness {
      expect(harness, 'test database').toBeDefined();
      return harness!;
    },
    redisUrl(): string {
      expect(redis, 'test redis').toBeDefined();
      return redis!.url;
    },
  };
}
export type TwoPathsSuite = ReturnType<typeof twoPathsSuite>;

/** A fresh app with the process fixture, and the admin entry started on its database and clock. */
export async function withTwoPaths(
  s: TwoPathsSuite,
  run: (t: TwoPaths) => Promise<void>,
): Promise<void> {
  const h = s.harness();
  const f = await setup(h);
  f.clock.set(CLOCK_AT);
  const onSameWorld: ReviewFixture = {
    s: {
      db: () => h.db,
      holder: () => h.observer,
      payout: () => h.payout,
      redisUrl: () => s.redisUrl(),
    },
    db: h.db,
    payout: h.payout,
    clock: f.clock,
    ledger: f.ledger,
    appId: f.appId,
  };
  await withBatchAdmin(onSameWorld, (admin) => run({ f, admin }));
}

/** An attempt row of another withdrawal of the app, with non-zero fee and tax. */
export async function seedDay(t: TwoPaths, seed: SentSeed): Promise<void> {
  await t.f.seedSent({
    net: seed.net,
    fee: seed.fee ?? FEE,
    tax: seed.tax ?? TAX,
    result: seed.result,
    at: seed.at ?? THIS_MORNING,
    kind: seed.kind ?? 'transfer',
    channel: seed.channel ?? 'alipay',
  });
}

/** Today's transfer of the same size in another app on the same database, at the same instant. */
export async function seedOtherApp(t: TwoPaths, net: bigint): Promise<void> {
  const other = `process_other_${t.f.appId}`;
  const stranger = await t.f.newUser(1_000_000n, other);
  await t.f.seedSent({
    net,
    fee: FEE,
    tax: TAX,
    result: 'success',
    at: THIS_MORNING,
    appId: other,
    userId: stranger,
  });
}

/** S: daily_sent_fen of the overview, answered on the clock of the fixture. */
export async function overviewSent(t: TwoPaths): Promise<number> {
  const view = await viewOf(await t.admin.overview());
  expect(Date.parse(view.as_of)).toBe(t.f.clock.now().getTime());
  return view.daily_sent_fen;
}

/**
 * The comparison. With S as the overview answers it and n = the waiting withdrawal's net:
 * payout.daily_cap_fen = S + n − 1 → the review holds a withdrawal of net n (W9 daily_cap, no attempt,
 * no transfer, S unchanged); = S + n → the review passes another of net n, its transfer attempt is
 * written, and the overview counts it (S + n). Returns S for the caller's hand-written expectation.
 */
export async function expectReviewAgrees(t: TwoPaths, waiting: WaitingSeed): Promise<number> {
  const { f } = t;
  const sent = await overviewSent(t);
  const net = Number(waiting.net);
  const seed = {
    net: waiting.net,
    fee: waiting.fee,
    tax: waiting.tax,
    channel: waiting.channel ?? 'alipay',
  };
  const channel = scripted({});
  const review = f.job(channel.channel);

  await f.set('payout.daily_cap_fen', sent + net - 1);
  const short = await f.seedWithdrawal(seed);
  await review(f.jobOf(short));
  expect(
    await withdrawal(f, short.id),
    `cap = S + n − 1 with S = ${sent}, n = ${net}: the review must hold`,
  ).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'daily_cap',
    hold_at: f.clock.now(),
  });
  expect(channel.transfers()).toEqual([]);
  expect(await attempts(f, short.id)).toEqual([]);
  expect(await overviewSent(t)).toBe(sent);

  await f.set('payout.daily_cap_fen', sent + net);
  const exact = await f.seedWithdrawal(seed);
  await review(f.jobOf(exact));
  expect(
    (await withdrawal(f, exact.id)).hold_reason,
    `cap = S + n with S = ${sent}, n = ${net}: the review must pass`,
  ).toBeNull();
  expect(channel.transfers().map((request) => request.outBizNo)).toEqual([exact.outBizNo]);
  expect(await attempts(f, exact.id)).toEqual([
    expect.objectContaining({ kind: 'transfer', at: f.clock.now() }),
  ]);
  expect(await overviewSent(t)).toBe(sent + net);
  return sent;
}
