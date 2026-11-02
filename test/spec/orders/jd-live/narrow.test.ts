// B1-04zt ① (规划/02 §7.1、09 CAP-JD-07): a window over the interface's limit is halved and queried
// again inside one job, by all three window handlers. The fake adapters throw the error the real jd
// adapter raises (jdRefusal), so no test assumes how the flag gets onto a UnionError. Every outcome
// goes through capture: before the implementation the refusal escapes the handler, and that has to
// be an assertion failure here, not an uncaught UnionError.
import { expect, it, vi } from 'vitest';
import type { OrderSyncRequestProgress } from '../../../../apps/api/src/modules/orders/infra/order-sync-requests.ts';
import type { OrderSyncWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import {
  handleManualSyncJob,
  type ManualSyncHandlerDeps,
} from '../../../../apps/api/src/modules/orders/jobs/manual-sync.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import {
  handleOrderSyncWindow,
  type OrderSyncHandlerDeps,
} from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type TimeWindow,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { jdRefusal, type Flagged } from '../../union/jd-narrow/refusal.ts';
import {
  beijingMs,
  inner,
  num,
  reply,
  row,
  rowId,
  win as jdSampleWindow,
  wire,
} from '../../union/jd-orders/kit.ts';
import { capture } from '../attribution/kit.ts';
import {
  ACCOUNT,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW_MS,
  account,
  fixture,
  iso,
  job,
  logged,
  order,
  rescanWindow,
} from '../rescan/kit.ts';

type Fixture = ReturnType<typeof fixture>;
type Span = readonly [number, number];

const START_MS = NOW_MS - 3 * HOUR_MS;
const QUARTER_MS = 15 * MINUTE_MS;
const HALF_MS = 30 * MINUTE_MS;
/** The task brief's lower bound: a window this long or shorter is not cut any further. */
const SMALLEST_MS = 60_000;
const SYNC_ID = '20000000-0000-4000-8000-0000000000aa';

const spanOf = (range: TimeWindow): number => Date.parse(range.to) - Date.parse(range.from);
const rowOf = (startMs: number): string => `row-${startMs}`;

function incrementWindow(startMs: number, spanMs: number): OrderSyncWindow {
  return {
    app_id: account.app_id,
    platform: 'jd',
    union_account_id: ACCOUNT,
    query_kind: 'increment',
    scene: '-',
    window_start: iso(startMs),
    window_end: iso(startMs + spanMs),
  };
}

function runIncrement(
  f: Fixture,
  win: OrderSyncWindow,
  attempt = 1,
  overrides: Partial<OrderSyncHandlerDeps> = {},
) {
  const deps: OrderSyncHandlerDeps = {
    ...f.handler,
    cursors: f.ruleTableCaps.cursors,
    ...overrides,
  };
  return capture(() => handleOrderSyncWindow({ ...job(win, attempt), name: 'window' }, deps));
}

/** Upstream with a limit: longer windows are refused, a shorter one answers one row. */
function refuseOver(f: Fixture, limitMs: number, refusal: Error): void {
  f.listOrders.mockImplementation(async (range) => {
    if (spanOf(range) > limitMs) throw refusal;
    return { items: [order(rowOf(Date.parse(range.from)))], nextCursor: null };
  });
}

/** [from, to) of every listOrders call, in order. */
const called = (f: Fixture): Span[] =>
  f.listOrders.mock.calls.map(([range]): Span => [Date.parse(range.from), Date.parse(range.to)]);

const within = (f: Fixture, limitMs: number): Span[] =>
  called(f).filter(([from, to]) => to - from <= limitMs);

const processed = (f: Fixture): string[] => f.process.mock.calls.map(([item]) => item.order_id);

/** The spans cover [startMs, endMs) end to end: no gap, no overlap, none empty. */
function expectTiled(spans: readonly Span[], startMs: number, endMs: number): void {
  expect(spans[0]?.[0]).toBe(startMs);
  expect(spans.at(-1)?.[1]).toBe(endMs);
  for (const [index, [from, to]] of spans.entries()) {
    expect(to).toBeGreaterThan(from);
    if (index > 0) expect(from).toBe(spans[index - 1]![1]);
  }
}

function manualJob(startMs: number, spanMs: number): ReceivedJob {
  return {
    id: 'synthetic-manual-job',
    queue: 'order-sync',
    name: 'manual_window',
    payload: {
      ...incrementWindow(startMs, spanMs),
      sync_id: SYNC_ID,
      sync_seq: 0,
    },
    attempt: 1,
  };
}

function manualDeps(f: Fixture) {
  const finish = vi.fn<OrderSyncRequestProgress['finish']>().mockResolvedValue(undefined);
  const deps: ManualSyncHandlerDeps = {
    access: f.handler.access,
    registry: f.handler.registry,
    pipeline: f.handler.pipeline,
    requests: {
      status: vi.fn<OrderSyncRequestProgress['status']>().mockResolvedValue('running'),
      start: vi.fn<OrderSyncRequestProgress['start']>().mockResolvedValue(undefined),
      finish,
    },
    logger: f.logger,
  };
  return { deps, finish };
}

interface Outcome {
  readonly ok: boolean;
  readonly error?: unknown;
}

/** The handler threw this very error object, not one that reads the same. */
function expectThrown(outcome: Outcome, error: unknown): void {
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toBe(error);
}

interface Surface {
  readonly label: string;
  /** `finished` is what the handler recorded as done: its done log, or the manual write-back. */
  readonly run: (f: Fixture) => Promise<{
    readonly outcome: Outcome;
    readonly finished: readonly unknown[];
  }>;
}

/** The three window handlers, each on the hour from START_MS. */
const SURFACES: readonly Surface[] = [
  {
    label: '增量',
    run: async (f) => ({
      outcome: await runIncrement(f, incrementWindow(START_MS, HOUR_MS)),
      finished: logged(f.logger.info, 'order_sync_window_done'),
    }),
  },
  {
    label: '回扫',
    run: async (f) => ({
      outcome: await capture(() =>
        handleOrderRescanWindow(job(rescanWindow(iso(START_MS))), f.handler),
      ),
      finished: logged(f.logger.info, 'order_sync_rescan_window_done'),
    }),
  },
  {
    label: '手动窗口',
    run: async (f) => {
      const { deps, finish } = manualDeps(f);
      const outcome = await capture(() => handleManualSyncJob(manualJob(START_MS, HOUR_MS), deps));
      return { outcome, finished: finish.mock.calls };
    },
  },
];

const UNFLAGGED = [
  {
    label: '不带标记的 upstream_rejected',
    refusal: async (): Promise<Flagged> =>
      new UnionError('upstream_rejected', 'synthetic refusal', 'jd') as Flagged,
  },
  { label: '京东 2002453', refusal: () => jdRefusal('2002453') },
];

const UNFLAGGED_RUNS = SURFACES.flatMap((surface) =>
  UNFLAGGED.map((kind) => ({
    surface: surface.label,
    kind: kind.label,
    run: surface.run,
    refusal: kind.refusal,
  })),
);

/** A real 60-minute window halved down to the first span that is not cut again: 56.25 seconds. */
const HALVINGS_MS = [3_600_000, 1_800_000, 900_000, 450_000, 225_000, 112_500, 56_250];

/** Whole window refused; the first half answers 2 pages (3 rows), the second 1 page (1 row). */
function answerHalves(f: Fixture, refusal: Error): void {
  f.listOrders.mockImplementation(async (range, opt) => {
    if (spanOf(range) > HALF_MS) throw refusal;
    if (Date.parse(range.from) === START_MS && opt.cursor === undefined) {
      return { items: [order('a'), order('b')], nextCursor: 'next' };
    }
    return { items: [order(rowOf(Date.parse(range.from)))], nextCursor: null };
  });
}

it('[AC-B1-04zt#2] 增量：60 分钟窗被拒，依次查 [s, mid)、[mid, e)，行都进流水线，水位按原窗推进恰一次', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, HOUR_MS);
  const midMs = START_MS + HALF_MS;
  const endMs = START_MS + HOUR_MS;
  refuseOver(f, HALF_MS, await jdRefusal('2002452'));
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  expect(called(f)).toEqual([
    [START_MS, endMs],
    [START_MS, midMs],
    [midMs, endMs],
  ]);
  expect(processed(f)).toEqual([rowOf(START_MS), rowOf(midMs)]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
  expect(f.advance.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.process.mock.invocationCallOrder.at(-1)!,
  );
  for (const [, opt, call] of f.listOrders.mock.calls) {
    expect(opt).toEqual({ queryMode: 'increment' });
    expect(call).toMatchObject({ appId: win.app_id, purpose: 'order_sync' });
  }
});

it('[AC-B1-04zt#3] 多级切：只有不超过 15 分钟的窗能过，60 分钟切成首尾相接的 4 个 15 分钟窗', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, HOUR_MS);
  refuseOver(f, QUARTER_MS, await jdRefusal('2002452'));
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  const quarters = [0, 1, 2, 3].map((n): Span => [
    START_MS + n * QUARTER_MS,
    START_MS + (n + 1) * QUARTER_MS,
  ]);
  expect(within(f, QUARTER_MS)).toEqual(quarters);
  expect(processed(f)).toEqual(quarters.map(([from]) => rowOf(from)));
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it.each([
  { label: '奇数毫秒的跨度', startMs: START_MS, spanMs: 59 * MINUTE_MS + 1, limitMs: QUARTER_MS },
  { label: '起点带毫秒', startMs: START_MS + 123, spanMs: HOUR_MS - 123, limitMs: QUARTER_MS },
  { label: '一路切到 60 秒以内', startMs: START_MS, spanMs: HOUR_MS, limitMs: SMALLEST_MS },
])(
  '[AC-B1-04zt#3] $label：子窗覆盖原窗不重不漏，每级两半相差不过 1 毫秒',
  async ({ startMs, spanMs, limitMs }) => {
    const f = fixture();
    const win = incrementWindow(startMs, spanMs);
    refuseOver(f, limitMs, await jdRefusal('2002452'));
    const result = await runIncrement(f, win);
    expect(result).toMatchObject({ ok: true });
    const leaves = within(f, limitMs);
    expectTiled(leaves, startMs, startMs + spanMs);
    const spans = leaves.map(([from, to]) => to - from);
    expect(Math.max(...spans) - Math.min(...spans)).toBeLessThanOrEqual(1);
    expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
  },
);

it('[AC-B1-04zt#4] 第 3 页才被拒：该窗对半重查，不丢行，翻页游标不带进子窗，子窗翻页也不算游标重复', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, HOUR_MS);
  const midMs = START_MS + HALF_MS;
  const endMs = START_MS + HOUR_MS;
  const refusal = await jdRefusal('2002452');
  // The cursors spell the page, as the real adapter's do: a sub-window repeats the text of the
  // whole window's page 2, and that is no repeated cursor.
  f.listOrders.mockImplementation(async (range, opt) => {
    const page = Number(opt.cursor?.split(':')[1] ?? 1);
    if (spanOf(range) === HOUR_MS) {
      if (page === 3) throw refusal;
      return { items: [order(`whole-${page}`)], nextCursor: `jd-order:${page + 1}` };
    }
    const nextCursor = page === 1 ? 'jd-order:2' : null;
    return { items: [order(`${Date.parse(range.from)}-${page}`)], nextCursor };
  });
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  expect(
    f.listOrders.mock.calls.map(([range, opt]) => [
      Date.parse(range.from),
      Date.parse(range.to),
      opt.cursor ?? null,
    ]),
  ).toEqual([
    [START_MS, endMs, null],
    [START_MS, endMs, 'jd-order:2'],
    [START_MS, endMs, 'jd-order:3'],
    [START_MS, midMs, null],
    [START_MS, midMs, 'jd-order:2'],
    [midMs, endMs, null],
    [midMs, endMs, 'jd-order:2'],
  ]);
  expect(processed(f)).toEqual(
    expect.arrayContaining([`${START_MS}-1`, `${START_MS}-2`, `${midMs}-1`, `${midMs}-2`]),
  );
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zt#5] 跨度恰 60 秒被拒：不再切，带标记的错误抛给队列，水位不动', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, SMALLEST_MS);
  const refusal = await jdRefusal('2002452');
  f.listOrders.mockRejectedValue(refusal);
  const result = await runIncrement(f, win);
  expect(refusal.windowTooLarge).toBe(true);
  expectThrown(result, refusal);
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zt#5] 切到 60 秒还被拒：到此为止抛错，后半窗不再查，水位不动', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, 2 * SMALLEST_MS);
  const refusal = await jdRefusal('2002452');
  f.listOrders.mockRejectedValue(refusal);
  const result = await runIncrement(f, win);
  expect(called(f)).toEqual([
    [START_MS, START_MS + 2 * SMALLEST_MS],
    [START_MS, START_MS + SMALLEST_MS],
  ]);
  expectThrown(result, refusal);
  expect(f.advance).not.toHaveBeenCalled();
});

it.each(SURFACES)(
  '[AC-B1-04zt#5] $label：60 分钟窗一直被拒，依次 3600、1800、900、450、225、112.5、56.25 秒后停，抛原 2002452 错误，水位不动、不写完成',
  async ({ run }) => {
    const f = fixture();
    const refusal = await jdRefusal('2002452');
    f.listOrders.mockRejectedValue(refusal);
    const { outcome, finished } = await run(f);
    expect(refusal.windowTooLarge).toBe(true);
    expect(called(f)).toEqual(HALVINGS_MS.map((spanMs): Span => [START_MS, START_MS + spanMs]));
    expectThrown(outcome, refusal);
    expect(f.process).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
    expect(finished).toEqual([]);
  },
);

it.each([
  { label: '61 秒', spanMs: 61_000 },
  { label: '60 秒零 1 毫秒', spanMs: SMALLEST_MS + 1 },
])('[AC-B1-04zt#5] 跨度 $label 被拒：还切一次，两半都过就完成', async ({ spanMs }) => {
  const f = fixture();
  const win = incrementWindow(START_MS, spanMs);
  refuseOver(f, SMALLEST_MS, await jdRefusal('2002452'));
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  const halves = within(f, SMALLEST_MS);
  expect(halves).toHaveLength(2);
  expectTiled(halves, START_MS, START_MS + spanMs);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zt#5] 后半窗失败：错误抛出，水位不动；重跑还是原窗，完成后只推进一次', async () => {
  const win = incrementWindow(START_MS, HOUR_MS);
  const f = fixture({ cursor: win.window_start });
  const midMs = START_MS + HALF_MS;
  const endMs = START_MS + HOUR_MS;
  const refusal = await jdRefusal('2002452');
  const failure = new Error('synthetic later window failure');
  let failing = true;
  f.listOrders.mockImplementation(async (range) => {
    if (spanOf(range) > HALF_MS) throw refusal;
    if (failing && Date.parse(range.from) === midMs) {
      failing = false;
      throw failure;
    }
    return { items: [order(rowOf(Date.parse(range.from)))], nextCursor: null };
  });
  expectThrown(await runIncrement(f, win, 1), failure);
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.cursor()).toBe(win.window_start);
  expect(await runIncrement(f, win, 2)).toMatchObject({ ok: true });
  const attempt: Span[] = [
    [START_MS, endMs],
    [START_MS, midMs],
    [midMs, endMs],
  ];
  expect(called(f)).toEqual([...attempt, ...attempt]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
  expect(f.cursor()).toBe(win.window_end);
});

it.each(UNFLAGGED_RUNS)(
  '[AC-B1-04zt#6] $surface，$kind：不缩窗，只调一次，原样抛出，水位不动、不写完成',
  async ({ run, refusal }) => {
    const error = await refusal();
    expect(error.windowTooLarge).toBe(false);
    const f = fixture();
    f.listOrders.mockRejectedValue(error);
    const { outcome, finished } = await run(f);
    expectThrown(outcome, error);
    expect(f.listOrders).toHaveBeenCalledTimes(1);
    expect(f.advance).not.toHaveBeenCalled();
    expect(finished).toEqual([]);
  },
);

it('[AC-B1-04zt#7] 增量：order_sync_window_done 的 pages、count 是各子窗之和，被拒的整窗不算', async () => {
  const f = fixture();
  const win = incrementWindow(START_MS, HOUR_MS);
  answerHalves(f, await jdRefusal('2002452'));
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  expect(logged(f.logger.info, 'order_sync_window_done')).toEqual([
    expect.objectContaining({
      window_start: win.window_start,
      window_end: win.window_end,
      pages: 3,
      count: 4,
      advanced: true,
    }),
  ]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zt#7] 回扫：同样缩窗，完成与漏单日志的计数是各子窗之和，游标按原窗推进一次', async () => {
  const f = fixture();
  const win = rescanWindow(iso(START_MS));
  answerHalves(f, await jdRefusal('2002452'));
  f.process
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-a' })
    .mockResolvedValueOnce({ kind: 'unchanged' })
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-c' })
    .mockResolvedValueOnce({ kind: 'unchanged' });
  const result = await capture(() => handleOrderRescanWindow(job(win), f.handler));
  expect(result).toMatchObject({ ok: true });
  expect(called(f)).toEqual([
    [START_MS, START_MS + HOUR_MS],
    [START_MS, START_MS + HALF_MS],
    [START_MS, START_MS + HALF_MS],
    [START_MS + HALF_MS, START_MS + HOUR_MS],
  ]);
  const totals = {
    window_start: win.window_start,
    window_end: win.window_end,
    pages: 3,
    count: 4,
    inserted: 2,
  };
  expect(logged(f.logger.info, 'order_sync_rescan_window_done')).toEqual([
    expect.objectContaining(totals),
  ]);
  expect(logged(f.logger.warn, 'order_sync_rescan_found_missing')).toEqual([
    expect.objectContaining(totals),
  ]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
  expect(f.cursor()).toBe(win.window_end);
});

it.each([
  {
    label: '普通错误',
    later: async (): Promise<Error> => new Error('synthetic later window failure'),
  },
  { label: '切到下限还被拒', later: (): Promise<Error> => jdRefusal('2002452') },
])(
  '[AC-B1-04zt#7] 回扫：前半窗插入 1 行、后半窗失败（$label）：found_missing 仍带上这行，水位不动、不写完成',
  async ({ later }) => {
    const f = fixture();
    const win = rescanWindow(iso(START_MS));
    const refusal = await jdRefusal('2002452');
    const failure = await later();
    f.listOrders.mockImplementation(async (range) => {
      if (spanOf(range) > HALF_MS) throw refusal;
      if (Date.parse(range.from) !== START_MS) throw failure;
      return { items: [order('first-half')], nextCursor: null };
    });
    f.process.mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-a' });
    const result = await capture(() => handleOrderRescanWindow(job(win), f.handler));
    expectThrown(result, failure);
    expect(logged(f.logger.warn, 'order_sync_rescan_found_missing')).toEqual([
      expect.objectContaining({
        window_start: win.window_start,
        window_end: win.window_end,
        pages: 1,
        count: 1,
        inserted: 1,
      }),
    ]);
    expect(f.advance).not.toHaveBeenCalled();
    expect(logged(f.logger.info, 'order_sync_rescan_window_done')).toEqual([]);
  },
);

it('[AC-B1-04zt#7] 手动窗口：同样缩窗，回写的 fetched / stored 是各子窗之和，不碰水位', async () => {
  const f = fixture();
  const { deps, finish } = manualDeps(f);
  const refusal = await jdRefusal('2002452');
  f.listOrders.mockImplementation(async (range) => {
    if (spanOf(range) > HALF_MS) throw refusal;
    const startMs = Date.parse(range.from);
    return { items: [order(`${startMs}-a`), order(`${startMs}-b`)], nextCursor: null };
  });
  f.process
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-a' })
    .mockResolvedValueOnce({ kind: 'updated' })
    .mockResolvedValueOnce({ kind: 'unchanged' })
    .mockResolvedValueOnce({ kind: 'inserted', order_id: 'synthetic-internal-d' });
  const result = await capture(() => handleManualSyncJob(manualJob(START_MS, HOUR_MS), deps));
  expect(result).toMatchObject({ ok: true });
  expect(called(f)).toEqual([
    [START_MS, START_MS + HOUR_MS],
    [START_MS, START_MS + HALF_MS],
    [START_MS + HALF_MS, START_MS + HOUR_MS],
  ]);
  expect(finish).toHaveBeenCalledExactlyOnceWith(account.app_id, SYNC_ID, 0, {
    status: 'done',
    fetched: 4,
    stored: 3,
  });
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zt#8] 真实京东适配器 + 假传输：2002452 逐级缩到 15 分钟，子窗都过真实 jdOrderWindow，上游时间窗不留缝', async () => {
  const f = fixture();
  // Inside the 90 days of the adapter's own clock; the half second makes every bound round outward.
  const startMs = Date.parse(jdSampleWindow.from) + 500;
  const win = incrementWindow(startMs, HOUR_MS);
  const acceptedSpanMs = 16 * MINUTE_MS;
  const upstreamSpan = (body: Record<string, unknown>): number =>
    beijingMs(body.endTime) - beijingMs(body.startTime);
  let served = 0;
  const { adapter, requests } = wire((body) => {
    if (upstreamSpan(body) > acceptedSpanMs) return reply(inner([], false, num('2002452')));
    served += 1;
    return reply(inner([row({ id: rowId(2, served) })], false));
  });
  const result = await runIncrement(f, win, 1, { registry: { get: () => adapter } });
  expect(result).toMatchObject({ ok: true });
  const accepted = requests.filter((body) => upstreamSpan(body) <= acceptedSpanMs);
  expect(accepted).toHaveLength(4);
  expect(beijingMs(accepted[0]!.startTime)).toBeLessThanOrEqual(startMs);
  expect(beijingMs(accepted.at(-1)!.endTime)).toBeGreaterThanOrEqual(startMs + HOUR_MS);
  for (const [index, body] of accepted.entries()) {
    if (index === 0) continue;
    expect(beijingMs(body.startTime)).toBeLessThanOrEqual(beijingMs(accepted[index - 1]!.endTime));
  }
  expect(f.process).toHaveBeenCalledTimes(4);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zt#8] 从 90 天上限起的窗切到 60 秒以内：每个子窗都过真实 jdOrderWindow', async () => {
  const f = fixture();
  const startMs = NOW_MS - 90 * DAY_MS + HOUR_MS;
  const win = incrementWindow(startMs, HOUR_MS);
  const refusal = await jdRefusal('2002452');
  f.listOrders.mockImplementation(async (range) => {
    jdOrderWindow(range, f.clock.now());
    if (spanOf(range) > SMALLEST_MS) throw refusal;
    return { items: [order(rowOf(Date.parse(range.from)))], nextCursor: null };
  });
  const result = await runIncrement(f, win);
  expect(result).toMatchObject({ ok: true });
  expectTiled(within(f, SMALLEST_MS), startMs, startMs + HOUR_MS);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});
