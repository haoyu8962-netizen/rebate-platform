// B1-04zzr (D10-798 ①④⑥): the 'rescan.window' job over Taobao's tiers. The payload's timeBasis goes
// to listOrders' OrderQueryOpt.timeBasis on every page (the Taobao adapter maps it; union is not
// changed); a payload without it is taken as update. The tier's own cursor moves once, by the
// window, as for the single tier.
import { expect, it } from 'vitest';
import type { OrderRescanWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import type { RescanQueryKind } from '../../../../apps/api/src/modules/orders/domain/platform-rules/rescan.ts';
import { handleOrderRescanWindow } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import { OrderSyncPayloadError } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import { capture } from '../attribution/kit.ts';
import { OTHER_ACCOUNT, job, order, rescanWindow } from '../rescan/kit.ts';
import {
  DAY_MS,
  HOUR_MS,
  NOW_MS,
  PROMO_WINDOW_MS,
  iso,
  tierFixture,
  tierStream,
  tierWindow,
} from './kit.ts';

type Fixture = ReturnType<typeof tierFixture>;

const PLATFORMS: readonly RegisteredPlatform[] = ['jd', 'pdd', 'taobao'];

function setup(cursors: Partial<Record<RescanQueryKind, string>> = {}) {
  const f = tierFixture({ cursors });
  return { f, deps: { ...f.handler, platforms: PLATFORMS } };
}

/** What each listOrders call asked for. */
function asked(f: Fixture) {
  return f.listOrders.mock.calls.map(([win, opt]) => ({
    win,
    cursor: opt.cursor ?? null,
    timeBasis: opt.timeBasis,
  }));
}

const TIERS = [
  { kind: 'rescan', basis: 'update', startMs: NOW_MS - 20 * DAY_MS },
  { kind: 'rescan_hour', basis: 'pay', startMs: NOW_MS - 2 * HOUR_MS },
  { kind: 'rescan_week', basis: 'pay', startMs: NOW_MS - 60 * DAY_MS },
] as const;

it.each(TIERS)(
  '[AC-B1-04zzr#23] $kind 载荷带 timeBasis=$basis：每页都按它取，取完全部页才推进本档游标一次',
  async ({ kind, basis, startMs }) => {
    const win = tierWindow(kind, startMs, PROMO_WINDOW_MS, basis);
    const cursors: Partial<Record<RescanQueryKind, string>> = {};
    cursors[kind] = win.window_start;
    const { f, deps } = setup(cursors);
    f.listOrders
      .mockResolvedValueOnce({ items: [order('synthetic-a')], nextCursor: 'opaque-next' })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const result = await capture(() => handleOrderRescanWindow(job(win), deps));
    expect(result).toMatchObject({ ok: true });
    expect(f.get).toHaveBeenCalledWith('taobao');
    const range = { from: win.window_start, to: win.window_end };
    expect(asked(f)).toEqual([
      { win: range, cursor: null, timeBasis: basis },
      { win: range, cursor: 'opaque-next', timeBasis: basis },
    ]);
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        ...tierStream(kind),
        window_start: win.window_start,
        window_end: win.window_end,
      }),
    );
    expect(f.cursorOf(kind)).toBe(win.window_end);
    for (const other of TIERS.filter((tier) => tier.kind !== kind)) {
      expect(f.cursorOf(other.kind)).toBeNull();
    }
  },
);

it('[AC-B1-04zzr#24] 旧载荷不带 timeBasis 按 update 取；小时档同一处理器按 pay 取；京东载荷用淘宝的档名校验失败', async () => {
  const startMs = NOW_MS - 20 * DAY_MS;
  const old: OrderRescanWindow = {
    ...tierStream('rescan'),
    window_start: iso(startMs),
    window_end: iso(startMs + PROMO_WINDOW_MS),
  };
  const { f, deps } = setup();
  await handleOrderRescanWindow(job(old), deps);
  expect(asked(f).map((call) => call.timeBasis ?? 'update')).toEqual(['update']);

  const hour = tierWindow('rescan_hour', NOW_MS - 2 * HOUR_MS, PROMO_WINDOW_MS, 'pay');
  const result = await capture(() => handleOrderRescanWindow(job(hour), deps));
  expect(result).toMatchObject({ ok: true });
  expect(asked(f).map((call) => call.timeBasis ?? 'update')).toEqual(['update', 'pay']);

  const jdHour = { ...rescanWindow(hour.window_start, PROMO_WINDOW_MS), query_kind: 'rescan_hour' };
  await expect(handleOrderRescanWindow(job(jdHour), deps)).rejects.toBeInstanceOf(
    OrderSyncPayloadError,
  );
  expect(f.listOrders).toHaveBeenCalledTimes(2);
});

it.each(['synthetic-basis', '', 'PAY', 2])(
  '[AC-B1-04zzr#25] timeBasis=%j 不是 pay / update：任务校验失败，不拉取、不推进',
  async (timeBasis) => {
    const win = tierWindow('rescan', NOW_MS - 20 * DAY_MS, PROMO_WINDOW_MS, 'update');
    const { f, deps } = setup();
    const payload = { ...win, timeBasis };
    await expect(handleOrderRescanWindow(job(payload), deps)).rejects.toBeInstanceOf(
      OrderSyncPayloadError,
    );
    expect(f.listOrders).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
  },
);

it.each([
  {
    label: '账号不是可查询账号',
    shut: (f: Fixture) => f.queryableAccount.mockResolvedValue(OTHER_ACCOUNT),
  },
  {
    label: '站长授权不可用',
    shut: (f: Fixture) => f.siteAuthAvailable.mockResolvedValue(false),
  },
])(
  '[AC-B1-04zzr#26] rescan_hour 窗：$label 时照单档的门正常结束，不拉取、不推进',
  async ({ shut }) => {
    const win = tierWindow('rescan_hour', NOW_MS - 2 * HOUR_MS, PROMO_WINDOW_MS, 'pay');
    const { f, deps } = setup();
    shut(f);
    const result = await capture(() => handleOrderRescanWindow(job(win), deps));
    expect(result).toMatchObject({ ok: true });
    expect(f.queryableAccount).toHaveBeenCalledWith('taobao');
    expect(f.listOrders).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.cursorOf('rescan_hour')).toBeNull();
  },
);
