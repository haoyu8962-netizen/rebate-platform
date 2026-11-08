// B2-15c settlement rollback rule tests, round 2 (claude-independent, SPEC_REF ec81e625): 08
// BR-PAY-04 (核对通过后在同一事务内 PO2（CAS）、写收款分录、入队开通任务) and 细则「通知应答」第 6 行
// (处理中出错或事务失败 → 回滚 → 不应答成功); BR-PAY-07 (每张支付单至多一张 PAY_RECEIPT); task §9.4.
// Rule-test review r1 S1 (query.int.test.ts is frozen at the spec commit, so this is a file of
// its own): the receipt posting fails once, as a database error would, and nothing of the
// settlement may stay behind. The query side wraps the handler's ledger port; the notification
// side replaces the api entry's process ledger (the LEDGER provider of LedgerModule) for the
// entry's test module. In both, the job queue and event bus are the entry's own, so jobs and
// events land in pgboss.job and event_log or not at all. Top-level it() only (规划/11 §4.3).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { fixture, payOrder, suite, type Fixture, type OrderRow } from '../orders/kit.ts';
import {
  AMOUNT,
  BIZ,
  CHANNELS,
  acked,
  attemptsOf,
  jobKit,
  nacked,
  notifications,
  paidEvents,
  paidNotification,
  payJobHandler,
  queuedByKey,
  receiptOf,
  returnedQuery,
  seedPending,
  specChannels,
  tradeNo,
  untouched,
  userTraces,
  vouchers,
  withNotify,
  type JobKit,
} from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
const s = suite();

const NO_USER_TRACES = { user_accounts: 0, balances: 0, user_entries: 0 };

interface Counts {
  /** Postings refused by the fault (only the first one). */
  readonly refused: number;
  /** Postings passed on to ledger. */
  readonly passed: number;
}

type Post = (trx: Transaction<DB>, voucher: unknown) => Promise<unknown>;

/** A posting function whose first call is refused before anything is written; later calls go on. */
function refusingFirst(post: Post): { post: Post; counts: () => Counts } {
  let refused = 0;
  let passed = 0;
  return {
    post: (trx, voucher) => {
      if (refused === 0) {
        refused += 1;
        return Promise.reject(new Error('spec: receipt posting refused once (injected fault)'));
      }
      passed += 1;
      return post(trx, voucher);
    },
    counts: () => ({ refused, passed }),
  };
}

/** The kit with its ledger port's first posting refused. */
function withRefusedPosting(kit: JobKit): { kit: JobKit; counts: () => Counts } {
  const real = kit.deps.ledger;
  const fault = refusingFirst((trx, voucher) => real.post(trx, voucher));
  return {
    kit: {
      ...kit,
      deps: {
        ...kit.deps,
        ledger: {
          post: fault.post,
          registerReconDiff: (trx, input) => real.registerReconDiff(trx, input),
        },
      },
    },
    counts: fault.counts,
  };
}

interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
}
interface Testing {
  createTestingModule(meta: { imports: unknown[] }): Builder;
}
interface LedgerRuntime {
  readonly LEDGER: symbol;
  createLedger(input: { readonly clock: FixedClock }): {
    post(trx: Transaction<DB>, voucher: unknown): Promise<unknown>;
  };
}

/**
 * For the api entries started while it is in place: the process ledger (LEDGER) is ledger's own
 * createLedger over the fixture clock, with its first posting refused; everything else is ledger's.
 */
async function refusingProcessLedger(
  f: Fixture,
): Promise<{ counts: () => Counts; restore: () => void }> {
  const ledger = (await import(
    new URL('apps/api/src/modules/ledger/index.ts', ROOT).href
  )) as LedgerRuntime;
  const { Test } = (await import(pathToFileURL(requireApi.resolve('@nestjs/testing')).href)) as {
    Test: Testing;
  };
  const real = ledger.createLedger({ clock: f.clock });
  const fault = refusingFirst((trx, voucher) => real.post(trx, voucher));
  const processLedger = new Proxy(real, {
    get(target, prop) {
      if (prop === 'post') return fault.post;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const original = Test.createTestingModule.bind(Test);
  const spy = vi
    .spyOn(Test, 'createTestingModule')
    .mockImplementation((meta) =>
      original(meta).overrideProvider(ledger.LEDGER).useValue(processLedger),
    );
  return { counts: fault.counts, restore: () => spy.mockRestore() };
}

/** Nothing of the settlement stayed: the order as seeded, no posting, job or paid event. */
async function rolledBack(f: Fixture, order: OrderRow) {
  expect(await payOrder(f, order.id)).toMatchObject(untouched(order));
  expect(await vouchers(f)).toEqual([]);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
  expect(await paidEvents(f)).toEqual([]);
  expect(await userTraces(f)).toEqual(NO_USER_TRACES);
}

/** The settlement done exactly once: PAID, one receipt, one fulfilment job, one paid event. */
async function settledOnce(f: Fixture, order: OrderRow, trade: string) {
  expect(await payOrder(f, order.id)).toMatchObject({
    ...untouched(order),
    status: 'PAID',
    paid_at: expect.any(Date),
    channel_trade_no: trade,
    closing: false,
  });
  expect(await vouchers(f)).toEqual([receiptOf(order)]);
  expect(
    (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).map((job) => [
      job.job,
      job.singleton_key,
    ]),
  ).toEqual([['biz.reconcile', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`]]);
  const events = await paidEvents(f);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ pay_order_id: order.id });
  expect(await userTraces(f)).toEqual(NO_USER_TRACES);
}

it.each(CHANNELS)(
  '[AC-B2-15c#31] %s 主动查询结果合格、结算中收款分录写入失败（ledger.post 拒绝一次）：整笔回滚——支付单仍 PENDING、没有凭证、没有开通任务与 pay_order.paid，查询尝试照记，任务以失败结束交队列重试；再查一次正常结算，只一张凭证',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    channels[channel].setTrade(
      order.out_trade_no,
      channels[channel].paid(identity[channel], AMOUNT, trade),
    );
    f.clock.advanceMs(20_000);
    await withNotify(f, channels, async (h) => {
      const { kit, counts } = withRefusedPosting(
        await jobKit(f, channels, { queue: h.queue, events: h.events }),
      );
      const handle = await payJobHandler(kit);
      await expect(handle(returnedQuery(order))).rejects.toThrow();
      expect(counts(), 'the settlement reached the receipt posting').toEqual({
        refused: 1,
        passed: 0,
      });
      expect(channels[channel].queried).toEqual([order.out_trade_no]);
      await rolledBack(f, order);
      expect(await attemptsOf(f, order.id)).toHaveLength(1);

      f.clock.advanceMs(20_000);
      await handle(returnedQuery(order));
      expect(counts()).toEqual({ refused: 1, passed: 1 });
      await settledOnce(f, order, trade);
      expect(await attemptsOf(f, order.id)).toHaveLength(2);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#32] %s 合格通知、结算中收款分录写入失败（进程的 LEDGER 拒绝一次 post）：回滚、不应答成功，不留迁移、凭证、开通任务、事件；渠道重发同一通知时正常结算并应答成功，只一张凭证、一份通知留存',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    f.clock.advanceMs(20_000);
    const fault = await refusingProcessLedger(f);
    try {
      await withNotify(f, channels, async (h) => {
        nacked(channel, await h.deliver(channel, built.raw));
        expect(fault.counts(), 'the settlement reached the receipt posting').toEqual({
          refused: 1,
          passed: 0,
        });
        await rolledBack(f, order);

        f.clock.advanceMs(30_000);
        acked(channel, await h.deliver(channel, built.raw));
        expect(fault.counts()).toEqual({ refused: 1, passed: 1 });
        await settledOnce(f, order, trade);
        expect((await notifications(f)).map((row) => row.notify_id)).toEqual([built.notifyId]);
      });
    } finally {
      fault.restore();
    }
  },
  60_000,
);
