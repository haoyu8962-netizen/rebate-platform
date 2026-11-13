// Unit tests of the workbench daily row lag gauge's registration (B1-34q): no database.
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import {
  cacheDashboardDayLagCollector,
  daysBetween,
  newestDueDayAt,
  snapshotOf,
  type DashboardDayLagSnapshot,
} from './dashboard-day-lag.ts';
import { createMetricsRegistry } from './registry.ts';

const NAME = 'couli_admin_dashboard_day_lag_days';

function sampleLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${NAME}{`) || line.startsWith(`${NAME} `));
}

const at = (instant: string): Date => new FixedClock(instant).now();

describe('couli_admin_dashboard_day_lag_days', () => {
  it('[AC-B1-34q-UNIT#5] 最近到期日：D 在 D+1 00:10:00 +08:00 到期；天数差按 +08:00 日历算', () => {
    expect(newestDueDayAt(at('2032-06-15T16:09:59.999Z'))).toBe('2032-06-14');
    expect(newestDueDayAt(at('2032-06-15T16:10:00.000Z'))).toBe('2032-06-15');
    expect(daysBetween('2032-06-12', '2032-06-15')).toBe(3);
    expect(daysBetween('2032-02-28', '2032-03-01')).toBe(2);
    expect(daysBetween('2032-06-15', '2032-06-15')).toBe(0);
  });

  it('[AC-B1-34q-UNIT#6] snapshot 每个 app 一个键；registry 每个 app_id 一个样本、只有 app_id 标签', async () => {
    const snapshot = snapshotOf([
      { appId: 'couli', lagDays: 0 },
      { appId: 'couli-other', lagDays: 7 },
    ]);
    expect(snapshot).toEqual({ lagDays: { couli: 0, 'couli-other': 7 } });
    const registry = createMetricsRegistry({
      entry: 'worker',
      collectDashboardDayLag: async () => snapshot,
    });
    const text = await registry.render();
    expect(text).toContain(`# TYPE ${NAME} gauge\n`);
    expect(sampleLines(text)).toEqual([
      `${NAME}{app_id="couli"} 0`,
      `${NAME}{app_id="couli-other"} 7`,
    ]);
  });

  it('[AC-B1-34q-UNIT#7] 采集失败则 render() 拒绝，不编值；失败不缓存', async () => {
    let calls = 0;
    const clock = new FixedClock('2032-06-15T18:00:00.000Z');
    const collect = cacheDashboardDayLagCollector(async (): Promise<DashboardDayLagSnapshot> => {
      calls += 1;
      throw new Error('synthetic read failure');
    }, clock);
    const registry = createMetricsRegistry({ entry: 'worker', collectDashboardDayLag: collect });
    await expect(registry.render()).rejects.toThrow(/synthetic read failure/);
    await expect(registry.render()).rejects.toThrow(/synthetic read failure/);
    expect(calls).toBe(2);
  });

  it('[AC-B1-34q-UNIT#8] 只在 worker 上出现：api / admin 给了也不调用', async () => {
    let calls = 0;
    const collectDashboardDayLag = async (): Promise<DashboardDayLagSnapshot> => {
      calls += 1;
      return { lagDays: { couli: 1 } };
    };
    for (const entry of ['api', 'admin'] as const) {
      const text = await createMetricsRegistry({ entry, collectDashboardDayLag }).render();
      expect(text).not.toContain(NAME);
    }
    expect(calls).toBe(0);
  });
});
