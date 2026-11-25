import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { resolveAppealDeadline, resolveWorkingDayDeadline } from './appeal-calendar.ts';

const APP_ID = 'calendar_unit';
const HOLIDAYS = 'calendar.cn_holidays.2026';
const MAKEUP = 'calendar.cn_makeup_workdays.2026';
// Thursday 2026-10-01 12:00 +08:00: weekends only, the third working day is Tuesday 10-06.
const CLOCK = new FixedClock('2026-10-01T12:00:00+08:00');
const WEEKENDS_ONLY = '2026-10-06T16:00:00.000Z';
// Holidays 10-02 and 10-06, make-up days 10-03 and 10-04: the third working day is 10-05.
const SAVED = '2026-10-05T16:00:00.000Z';
const CALENDAR = {
  holidays: ['2026-10-02', '2026-10-06'],
  makeupWorkdays: ['2026-10-03', '2026-10-04'],
};

/** Per-key reads that pair an old holiday list with the new make-up list (a save in between). */
function mixedRead(_appId: string, key: string) {
  return Promise.resolve(
    key === HOLIDAYS
      ? { value: ['2026-10-05'], version: 1 }
      : { value: CALENDAR.makeupWorkdays, version: 2 },
  );
}

function batch(entries: readonly (readonly [string, unknown])[]) {
  return vi.fn<
    (
      appId: string,
      keys: readonly string[],
    ) => Promise<Map<string, { value: unknown; version: number }>>
  >(() => Promise.resolve(new Map(entries.map(([key, value]) => [key, { value, version: 2 }]))));
}

it('[AC-B1-34s#8] with a batch read the year is one statement taken whole; per-key reads are not used', async () => {
  const config = {
    configValue: vi.fn(mixedRead),
    configValues: batch([
      [HOLIDAYS, CALENDAR.holidays],
      [MAKEUP, CALENDAR.makeupWorkdays],
    ]),
  };
  const logger = { warn: vi.fn() };
  const deadline = await resolveAppealDeadline({ appId: APP_ID, clock: CLOCK, config, logger });
  expect(deadline.toISOString()).toBe(SAVED);
  expect(config.configValues).toHaveBeenCalledTimes(1);
  expect(config.configValues.mock.calls[0]?.[0]).toBe(APP_ID);
  expect([...config.configValues.mock.calls[0]![1]].sort()).toEqual([HOLIDAYS, MAKEUP]);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#8] a key the batch read does not return leaves the year unconfigured, never read on its own', async () => {
  const config = {
    configValue: vi.fn(mixedRead),
    configValues: batch([[HOLIDAYS, CALENDAR.holidays]]),
  };
  const logger = { warn: vi.fn() };
  const deadline = await resolveWorkingDayDeadline({
    appId: APP_ID,
    from: CLOCK.now(),
    workingDays: 3,
    config,
    logger,
  });
  // A per-key fallback would pair the batch's holidays with mixedRead's make-up days (10-05).
  expect(deadline.toISOString()).toBe(WEEKENDS_ONLY);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    { app_id: APP_ID, year: 2026 },
    'workday_calendar_unconfigured',
  );
});

it('[AC-B1-34s#8] a failed batch read counts weekends only and logs app_id and year only', async () => {
  const config = {
    configValue: vi.fn(mixedRead),
    configValues: vi.fn(() => Promise.reject(new Error('secret driver detail'))),
  };
  const logger = { warn: vi.fn() };
  const deadline = await resolveAppealDeadline({ appId: APP_ID, clock: CLOCK, config, logger });
  expect(deadline.toISOString()).toBe(WEEKENDS_ONLY);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    { app_id: APP_ID, year: 2026 },
    'appeal_calendar_unconfigured',
  );
});

it('[AC-B1-34s#8] without a batch read each key of the year is read once on its own', async () => {
  const configValue = vi.fn((_appId: string, key: string) =>
    Promise.resolve({
      value: key === HOLIDAYS ? CALENDAR.holidays : CALENDAR.makeupWorkdays,
      version: 2,
    }),
  );
  const logger = { warn: vi.fn() };
  const deadline = await resolveAppealDeadline({
    appId: APP_ID,
    clock: CLOCK,
    config: { configValue },
    logger,
  });
  expect(deadline.toISOString()).toBe(SAVED);
  expect(configValue.mock.calls.map(([appId, key]) => [appId, key]).sort()).toEqual([
    [APP_ID, HOLIDAYS],
    [APP_ID, MAKEUP],
  ]);
});
