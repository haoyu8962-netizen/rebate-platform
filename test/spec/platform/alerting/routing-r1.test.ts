// B1-25a r1 review supplements only: full-night exemption, first delivery, exact grouping.
import { expect, it } from 'vitest';
import { alerts, configuration, effectiveRoutes, notifications, selected } from './kit.ts';

const NIGHT_TIMES = [22, 23, 0, 1, 2, 3, 4, 5, 6, 7].flatMap((hour) =>
  ['00', '30'].map((minute) => `${String(hour).padStart(2, '0')}:${minute}:00`),
);

// Compare durations, not their spelling: 30000ms and 0m30s are also thirty seconds.
function milliseconds(duration: string): number {
  expect(duration).toMatch(/^(?:\d+(?:ms|s|m|h|d|w|y))+$/);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };
  return [...duration.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)].reduce(
    (total, match) => total + Number(match[1]) * units[match[2]!]!,
    0,
  );
}

it.each(NIGHT_TIMES)('[AC-B1-25a#9] 资金告警覆盖整夜每整点与半点：+08:00 %s 双组均收到', (time) => {
  const config = configuration();
  const day = time >= '22:00:00' ? '05' : '06';
  for (const labels of alerts('fund')) {
    expect(notifications(config, labels, `2031-04-${day}T${time}+08:00`)).toEqual([
      'finance',
      'oncall',
    ]);
  }
});

it('[AC-B1-25a#10] 资金告警到 finance 和 oncall 的接收路由均没有静默或激活时段限制', () => {
  const config = configuration();
  for (const labels of alerts('fund')) {
    const routes = selected(config, labels);
    expect(routes.map((route) => route.receiver).sort()).toEqual(['finance', 'oncall']);
    for (const route of routes) {
      expect(route.mute, `${labels['alertname']} → ${route.receiver}`).toEqual([]);
      expect(route.active, `${labels['alertname']} → ${route.receiver}`).toEqual([]);
    }
  }
});

it('[AC-B1-25a#11] 根路由和资金接收路由的有效 group_wait 不超过 30 秒', () => {
  const config = configuration();
  const allRoutes = effectiveRoutes(config);
  expect(allRoutes.length).toBeGreaterThan(0);
  expect(milliseconds(allRoutes[0]!.groupWait), 'root group_wait').toBeLessThanOrEqual(30_000);
  for (const labels of alerts('fund')) {
    const routes = selected(config, labels);
    expect(routes.map((route) => route.receiver).sort()).toEqual(['finance', 'oncall']);
    for (const route of routes) {
      expect(
        milliseconds(route.groupWait),
        `${labels['alertname']} → ${route.receiver}: group_wait`,
      ).toBeLessThanOrEqual(30_000);
      expect(route.groupInterval).toBe('30m');
      // Carry the inherited/overridden repeat interval without inventing a business default.
      expect(route.repeatInterval).toEqual(expect.any(String));
    }
  }
});

it('[AC-B1-25a#12] 根路由和每个子路由的有效 group_by 恰好为 alertname 与 app_id', () => {
  const routes = effectiveRoutes(configuration());
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect([...route.groupBy].sort(), `effective group_by → ${route.receiver}`).toEqual([
      'alertname',
      'app_id',
    ]);
  }
});
