// D10-741 ①③：worker 装配。taobao.csv 在装配时与京东 / 拼多多一样读一次并缓存（须先于调度值落地）；worker
// 把适配器报的 orderSources 装给增量调度器：真实淘宝适配器（假传输）注入了订单源与推广位读取器时，第一轮照常
// 发 20 分钟窗；未注入推广位读取器（未登记 PID）时，同一轮淘宝不发窗、不碰水位、不出 warn / error，京东照旧。
// 数据库只回答、不连接，不联网、不监听端口；每个平台恰一个 union_accounts 行，可查账号不靠桩。
import { afterEach, expect, it, vi } from 'vitest';
import { loadStatusMap } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { createOrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { onePage, setup } from '../../union/taobao-orders/kit.ts';
import {
  HOUR_MS,
  JD_CAP_MS,
  NOW_MS,
  TAOBAO_CAP_MS,
  incrementWindow,
  iso,
  requiredTaobaoCsv,
} from './taobao-sync-kit.ts';
import { workerDeps } from './taobao-sync-worker-kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const FROM_MS = NOW_MS - 3 * HOUR_MS;
/** Older than the 90-day look-back: a round that passes the gate would move it (rewind). */
const STALE = new Date('2026-01-01T00:00:00.000Z');

/** The windows payloads carry, without the fixture's app and account ids. */
function bounds(payloads: readonly Record<string, unknown>[]) {
  return payloads.map((p) => [p['window_start'], p['window_end']]);
}

/** Starts the runtime, lets the first round (60 s default interval) run, then stops it. */
async function oneRound(taobao: UnionAdapter, taobaoCursor: Date) {
  vi.useFakeTimers();
  const w = workerDeps(taobao, { taobao: taobaoCursor, jd: new Date(FROM_MS) });
  const running = createOrderSyncRuntime(w.deps).start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await running.stop();
  expect(vi.getTimerCount()).toBe(0);
  return w;
}

it('[AC-B1-04zzb#23] worker 装配读 taobao.csv 并缓存：statusMaps(taobao) 与真实文件一致、同一实例', () => {
  const csv = requiredTaobaoCsv();
  const r = createOrderSyncRuntime(workerDeps(setup().adapter).deps);
  expect(() => r.statusMaps('taobao')).not.toThrow();
  expect([...r.statusMaps('taobao').entries]).toEqual([...loadStatusMap('taobao', csv).entries]);
  expect(r.statusMaps('taobao')).toBe(r.statusMaps('taobao'));
});

it('[AC-B1-04zzb#24] worker 一轮调度：淘宝有订单源照发 20 分钟窗；未登记 PID（无推广位读取器）本轮不发、不碰水位、不告警，京东照旧', async () => {
  const sourced = setup(onePage([]));
  const on = await oneRound(sourced.adapter, new Date(FROM_MS));
  const expected = incrementWindow('taobao', FROM_MS, TAOBAO_CAP_MS);
  expect(bounds(on.windows('taobao'))).toEqual([[expected.window_start, expected.window_end]]);
  expect(bounds(on.windows('jd'))).toEqual([[iso(FROM_MS), iso(FROM_MS + JD_CAP_MS)]]);
  // 调度只投递、不取数。
  expect(sourced.transport).not.toHaveBeenCalled();

  const bare = setup(onePage([]), { slots: null });
  const off = await oneRound(bare.adapter, STALE);
  expect(off.windows('taobao')).toEqual([]);
  expect(bounds(off.windows('jd'))).toEqual([[iso(FROM_MS), iso(FROM_MS + JD_CAP_MS)]]);
  const cursorWrites = off.queries.filter(
    (sql) => /sync_cursors/.test(sql) && !/^\s*select\b/i.test(sql),
  );
  expect(cursorWrites).toEqual([]);
  const taobaoLines = off.lines().filter((line) => line.platform === 'taobao');
  expect(taobaoLines.filter((line) => line.level >= 40)).toEqual([]);
  expect(taobaoLines.length).toBeLessThanOrEqual(1);
  expect(bare.transport).not.toHaveBeenCalled();
  expect(bare.dataokeCredentials).not.toHaveBeenCalled();
});
