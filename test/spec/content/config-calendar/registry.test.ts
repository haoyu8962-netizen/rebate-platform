import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';

const CALENDAR_KEYS = [
  ['calendar.cn_holidays.2026', 2026],
  ['calendar.cn_makeup_workdays.2026', 2026],
  ['calendar.cn_holidays.2027', 2027],
  ['calendar.cn_makeup_workdays.2027', 2027],
  ['calendar.cn_holidays.2028', 2028],
  ['calendar.cn_makeup_workdays.2028', 2028],
  ['calendar.cn_holidays.2029', 2029],
  ['calendar.cn_makeup_workdays.2029', 2029],
  ['calendar.cn_holidays.2030', 2030],
  ['calendar.cn_makeup_workdays.2030', 2030],
] as const;

it('[AC-B1-34s#1] D10-2946：仅登记 2026–2030 十个日历键，逐年追加在 agent.examples 后', () => {
  const keys = CALENDAR_KEYS.map(([key]) => key);
  const registry = configRegistry();
  expect(registry.slice(-(keys.length + 1)).map((spec) => spec.key)).toStrictEqual([
    'agent.examples',
    ...keys,
  ]);
  for (const key of keys) {
    expect(configItemSpecOf(key), key).toMatchObject({
      key,
      valueType: 'object',
      permission: 'config.general',
      adminEditable: true,
      options: null,
    });
  }
  for (const key of [
    'calendar.cn_holidays',
    'calendar.cn_makeup_workdays',
    'calendar.cn_holidays.2025',
    'calendar.cn_makeup_workdays.2025',
    'calendar.cn_holidays.2031',
    'calendar.cn_makeup_workdays.2031',
    'calendar.cn_holidays.2026.extra',
    'calendar.cn_makeup_workdays.2026.extra',
  ]) {
    expect(configItemSpecOf(key), key).toBeNull();
  }
});

it.each(CALENDAR_KEYS)('[AC-B1-34s#2] %s 逐项校验 %s 年的日期数组', (key, year) => {
  const spec = configItemSpecOf(key);
  expect(spec, key).not.toBeNull();
  const jan1 = `${year}-01-01`;
  const dec31 = `${year}-12-31`;
  expect(configValueFits(spec!, [])).toBe(true);
  expect(configValueFits(spec!, [dec31, jan1])).toBe(true);
  expect(configValueFits(spec!, [`${year}-02-29`])).toBe(year === 2028);

  for (const value of [
    null,
    jan1,
    { date: jan1 },
    [jan1, 1],
    [jan1, null],
    [jan1, [dec31]],
    [jan1, `${year}-1-02`],
    [jan1, `${year}-01-2`],
    [jan1, `${year}-01-02T00:00:00+08:00`],
    [jan1, `${year}-01-02\n`],
    [jan1, `${year}-00-02`],
    [jan1, `${year}-13-02`],
    [jan1, `${year}-01-00`],
    [jan1, `${year}-02-30`],
    [jan1, `${year}-04-31`],
    [jan1, `${year + 1}-01-01`],
    [jan1, dec31, jan1],
  ]) {
    expect(configValueFits(spec!, value), JSON.stringify(value)).toBe(false);
  }
});
