// money r1 S2 ②（编排 D10-699 第 3 条）：60 天回扫的首窗慢于一跳（180 秒）时，水位不被反复挪动；任务做完后
// 回扫能接着推进。回扫水位的 CAS 照 infra/sync-cursors.ts（kit.ts 的假游标：advance 只在当前值 = 窗口起点时
// 推到窗口终点）。一遍回扫从近 60 天的开头起（[AC-B1-04zza#14] / #16），首窗投出后、做完前的每一跳，水位都
// 停在首窗起点、不投起点不同的窗（同一窗再投由队列 singletonKey 去重，可以）；首窗做完、水位推到首窗终点后，
// 下一跳从首窗终点接着投。
import { expect, it } from 'vitest';
import {
  scheduleRightsRescan,
  type RightsSyncWindow,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import {
  DAY_MS,
  HOUR_MS,
  INCREMENT,
  NOW_MS,
  RESCAN,
  RESCAN_DAYS,
  RESCAN_TICK_MS,
  fixture,
  iso,
  sameInstant,
} from './kit.ts';

/** 首窗做完前再走的跳数（每跳 180 秒）。 */
const SLOW_TICKS = 4;

it('[AC-B1-04zza#49] 回扫首窗慢于一跳：做完前每一跳水位都停在首窗起点、不投起点不同的窗；首窗做完推到终点后，下一跳从首窗终点接着投', async () => {
  // 回扫水位离 now 不足一窗：这一跳从近 60 天的开头再来一遍。
  const f = fixture({
    cursors: { [INCREMENT]: iso(NOW_MS - HOUR_MS), [RESCAN]: iso(NOW_MS - HOUR_MS) },
  });
  await scheduleRightsRescan(f.scheduler);
  const [first, ...rest] = f.rightsOf('rescan');
  expect(rest).toEqual([]);
  expect(first).toBeDefined();
  const head = String(first?.['window_start']);
  const headMs = Date.parse(head);
  expect(headMs).toBeGreaterThanOrEqual(NOW_MS - RESCAN_DAYS * DAY_MS);
  expect(headMs).toBeLessThan(NOW_MS - (RESCAN_DAYS - 1) * DAY_MS);
  const parked = f.rows.get(RESCAN);
  expect(parked).toBeDefined();

  for (let tick = 1; tick <= SLOW_TICKS; tick += 1) {
    f.clock.advanceMs(RESCAN_TICK_MS);
    await scheduleRightsRescan(f.scheduler);
    expect(f.rows.get(RESCAN)).toBe(parked);
    const starts = f.rightsOf('rescan').map((win) => String(win['window_start']));
    expect(starts.filter((start) => !sameInstant(start, head))).toEqual([]);
  }

  // 首窗的任务做完：处理器按 CAS 从首窗起点推到首窗终点。
  expect(await f.advance(first as RightsSyncWindow)).toBe(true);
  const end = String(first?.['window_end']);
  expect(f.rows.get(RESCAN)).toBe(end);

  const sentBefore = f.rightsOf('rescan').length;
  f.clock.advanceMs(RESCAN_TICK_MS);
  await scheduleRightsRescan(f.scheduler);
  const next = f.rightsOf('rescan').slice(sentBefore);
  expect(next).toHaveLength(1);
  expect(sameInstant(String(next[0]?.['window_start']), end)).toBe(true);
  expect(f.rows.get(RESCAN)).toBe(end);
});
