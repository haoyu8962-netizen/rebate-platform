import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createRootLogger, FixedClock, loadConfig } from '../../platform/index.ts';
import { RiskAppealsAdminModule } from '../http/admin/appeals-admin.module.ts';
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

// B1-34s (D10-3115): a batch save committing between the reads of two years. OLD wrongly lists
// 2026-12-31 as a holiday and misses 2027-01-01; NEW (one save) corrects both. No make-up days.
const OLD: Readonly<Record<string, readonly string[]>> = {
  'calendar.cn_holidays.2026': ['2026-12-31'],
  'calendar.cn_makeup_workdays.2026': [],
  'calendar.cn_holidays.2027': [],
  'calendar.cn_makeup_workdays.2027': [],
};
const NEW: Readonly<Record<string, readonly string[]>> = {
  'calendar.cn_holidays.2026': [],
  'calendar.cn_makeup_workdays.2026': [],
  'calendar.cn_holidays.2027': ['2027-01-01'],
  'calendar.cn_makeup_workdays.2027': [],
};
const BOTH_YEARS = Object.keys(OLD).sort();

/** The first batch call sees OLD, every later one NEW (the save commits after the first). */
function savedBetweenCalls() {
  let calls = 0;
  return vi.fn((_appId: string, keys: readonly string[]) => {
    const saved = calls === 0 ? OLD : NEW;
    calls += 1;
    return Promise.resolve(
      new Map(
        keys.filter((key) => key in saved).map((key) => [key, { value: saved[key], version: 2 }]),
      ),
    );
  });
}

it('[AC-B1-34s#8] a deadline into January reads both years in one batch call, so a save in between is seen whole', async () => {
  // Wed 2026-12-30: whole OLD and whole NEW both give Tue 2027-01-05 24:00; reading 2026 (OLD) and
  // 2027 (NEW) in two calls drops both 12-31 and 01-01 and gives 01-06 24:00.
  const config = { configValue: vi.fn(mixedRead), configValues: savedBetweenCalls() };
  const logger = { warn: vi.fn() };
  const deadline = await resolveAppealDeadline({
    appId: APP_ID,
    clock: new FixedClock('2026-12-30T12:00:00+08:00'),
    config,
    logger,
  });
  expect(deadline.toISOString()).toBe('2027-01-05T16:00:00.000Z');
  expect(config.configValues).toHaveBeenCalledTimes(1);
  expect([...config.configValues.mock.calls[0]![1]].sort()).toEqual(BOTH_YEARS);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#8] a deletion deadline (15 working days) into January reads both years in one batch call', async () => {
  // Whole OLD and whole NEW: Thu 2027-01-21 24:00; OLD 2026 with NEW 2027: 01-22 24:00.
  const config = { configValue: vi.fn(mixedRead), configValues: savedBetweenCalls() };
  const logger = { warn: vi.fn() };
  const deadline = await resolveWorkingDayDeadline({
    appId: APP_ID,
    from: new Date('2026-12-30T12:00:00+08:00'),
    workingDays: 15,
    config,
    logger,
  });
  expect(deadline.toISOString()).toBe('2027-01-21T16:00:00.000Z');
  expect(config.configValues).toHaveBeenCalledTimes(1);
  expect([...config.configValues.mock.calls[0]![1]].sort()).toEqual(BOTH_YEARS);
  expect(config.configValue).not.toHaveBeenCalled();
});

it('[AC-B1-34s#8] a year found only after computing is read again with all years in one call and recomputed from it alone', async () => {
  // Mon 2026-12-28: weekends only stays in 2026 (12-31 24:00), so the first call reads 2026 (OLD).
  // OLD's 12-31 holiday reaches into 2027: the second call (NEW, after the save) must carry both
  // years and the deadline is NEW's alone, 2026-12-31 24:00 (whole OLD: 2027-01-01 24:00).
  // Stitching OLD 2026 with NEW 2027 drops 12-31 and 01-01 and gives 2027-01-04 24:00.
  const config = { configValue: vi.fn(mixedRead), configValues: savedBetweenCalls() };
  const logger = { warn: vi.fn() };
  const deadline = await resolveAppealDeadline({
    appId: APP_ID,
    clock: new FixedClock('2026-12-28T12:00:00+08:00'),
    config,
    logger,
  });
  expect(deadline.toISOString()).toBe('2026-12-31T16:00:00.000Z');
  expect(config.configValues.mock.calls.map(([, keys]) => [...keys].sort())).toEqual([
    ['calendar.cn_holidays.2026', 'calendar.cn_makeup_workdays.2026'],
    BOTH_YEARS,
  ]);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#8] the admin console registration of an appeal is assembled with the batch calendar read', async () => {
  const forAdmin = vi.spyOn(RiskAppealsAdminModule, 'forAdmin');
  const clock = new FixedClock('2026-10-01T12:00:00+08:00');
  const logger = createRootLogger(
    { level: 'silent', entry: 'admin', appEnv: 'test' },
    { write() {} },
  );
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  // Kysely renders real SQL; the in-memory driver records it and answers with the saved calendar.
  const client = {
    processID: 1,
    release() {},
    query(sql: string, parameters: readonly unknown[] = []) {
      queries.push({ sql, parameters });
      const rows = [
        { key: HOLIDAYS, value: CALENDAR.holidays, version: 2 },
        { key: MAKEUP, value: CALENDAR.makeupWorkdays, version: 2 },
      ].filter(({ key }) => parameters.includes(key));
      return Promise.resolve({ command: 'SELECT', rowCount: rows.length, rows });
    },
  };
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    options: {},
  };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  try {
    AppModule.forEntry({ entry: 'admin', config: loadConfig({ APP_ENV: 'test' }), clock, logger });
    expect(forAdmin).toHaveBeenCalledTimes(1);
    const writes = forAdmin.mock.calls[0]![0].writes;
    expect(writes).toBeDefined();
    const config = writes!.config(db, clock);
    expect(config).toMatchObject({ configValues: expect.any(Function) });
    const deadline = await resolveAppealDeadline({ appId: APP_ID, clock, config, logger });
    expect(deadline.toISOString()).toBe(SAVED);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/^select\b.*"config_items"/i);
    expect(queries[0]!.parameters.map(String).sort()).toEqual([APP_ID, HOLIDAYS, MAKEUP].sort());
  } finally {
    forAdmin.mockRestore();
    await db.destroy();
  }
});
