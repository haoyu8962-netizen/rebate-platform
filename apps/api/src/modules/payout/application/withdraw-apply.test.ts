import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { reviewDeadline } from '../domain/review-deadline.ts';
import { CALENDAR_KEYS, readReviewCalendars } from './withdraw-apply.ts';

const APP_ID = 'calendar_unit';
// Only passed through to the port.
const HANDLE = {} as Kysely<DB>;
const FROM = new Date('2026-10-01T12:00:00+08:00');
const CALENDAR = {
  holidays: ['2026-10-02', '2026-10-06'],
  makeupWorkdays: ['2026-10-03', '2026-10-04'],
};

/** Per-key reads that pair an old holiday list with the new make-up list (a save in between). */
type Read = (
  appId: string,
  key: string,
  handle: Kysely<DB>,
) => Promise<{ value: unknown; version: number }>;
type BatchRead = (
  appId: string,
  keys: readonly string[],
  handle: Kysely<DB>,
) => Promise<Map<string, { value: unknown; version: number }>>;

const mixedRead: Read = (_appId, key) => {
  return Promise.resolve(
    key === CALENDAR_KEYS.holidays(2026)
      ? { value: ['2026-10-05'], version: 1 }
      : { value: CALENDAR.makeupWorkdays, version: 2 },
  );
};

function batch(values: Readonly<Record<string, unknown>>) {
  return vi.fn<BatchRead>((_appId, keys) =>
    Promise.resolve(
      new Map(
        keys.filter((key) => key in values).map((key) => [key, { value: values[key], version: 2 }]),
      ),
    ),
  );
}

it('[AC-B1-34s#7] with a batch read the year two keys come from one call on the handle, taken whole', async () => {
  const config = {
    configValue: vi.fn<Read>(mixedRead),
    configValues: batch({
      [CALENDAR_KEYS.holidays(2026)]: CALENDAR.holidays,
      [CALENDAR_KEYS.makeupWorkdays(2026)]: CALENDAR.makeupWorkdays,
    }),
  };
  const logger = { warn: vi.fn() };
  expect(await readReviewCalendars({ config, logger }, HANDLE, APP_ID, FROM)).toStrictEqual({
    2026: CALENDAR,
  });
  expect(config.configValues).toHaveBeenCalledExactlyOnceWith(
    APP_ID,
    [CALENDAR_KEYS.holidays(2026), CALENDAR_KEYS.makeupWorkdays(2026)],
    HANDLE,
  );
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#7] a key the batch read does not return leaves the year unconfigured, never read on its own', async () => {
  const config = {
    configValue: vi.fn<Read>(mixedRead),
    configValues: batch({ [CALENDAR_KEYS.holidays(2026)]: CALENDAR.holidays }),
  };
  const logger = { warn: vi.fn() };
  expect(await readReviewCalendars({ config, logger }, HANDLE, APP_ID, FROM)).toStrictEqual({});
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    { app_id: APP_ID, year: 2026 },
    'workday_calendar_unconfigured',
  );
});

it('[AC-B1-34s#7] a deadline reaching into January reads both years in one call', async () => {
  const config = { configValue: vi.fn<Read>(mixedRead), configValues: batch({}) };
  const logger = { warn: vi.fn() };
  const result = await readReviewCalendars(
    { config, logger },
    HANDLE,
    APP_ID,
    new Date('2026-12-31T20:00:00+08:00'),
  );
  expect(result).toStrictEqual({});
  expect(config.configValues.mock.calls.map(([, keys]) => keys)).toEqual([
    [
      CALENDAR_KEYS.holidays(2026),
      CALENDAR_KEYS.makeupWorkdays(2026),
      CALENDAR_KEYS.holidays(2027),
      CALENDAR_KEYS.makeupWorkdays(2027),
    ],
  ]);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn.mock.calls).toEqual([
    [{ app_id: APP_ID, year: 2026 }, 'workday_calendar_unconfigured'],
    [{ app_id: APP_ID, year: 2027 }, 'workday_calendar_unconfigured'],
  ]);
});

it('[AC-B1-34s#7] a batch save between the reads of two years is seen whole: the deadline is the old or the new one', async () => {
  // B1-34s (D10-3115). OLD wrongly lists 2026-12-31 as a holiday and misses 2027-01-01; one save
  // corrects both. From Thu 2026-12-31 20:00: whole OLD gives 2027-01-02 00:00, whole NEW
  // 2027-01-04 20:00; OLD 2026 with NEW 2027 (one call per year) drops both days: 2027-01-05 00:00.
  const OLD: Readonly<Record<string, readonly string[]>> = {
    [CALENDAR_KEYS.holidays(2026)]: ['2026-12-31'],
    [CALENDAR_KEYS.makeupWorkdays(2026)]: [],
    [CALENDAR_KEYS.holidays(2027)]: [],
    [CALENDAR_KEYS.makeupWorkdays(2027)]: [],
  };
  const NEW: Readonly<Record<string, readonly string[]>> = {
    [CALENDAR_KEYS.holidays(2026)]: [],
    [CALENDAR_KEYS.makeupWorkdays(2026)]: [],
    [CALENDAR_KEYS.holidays(2027)]: ['2027-01-01'],
    [CALENDAR_KEYS.makeupWorkdays(2027)]: [],
  };
  let calls = 0;
  const configValues = vi.fn<BatchRead>((_appId, keys) => {
    const saved = calls === 0 ? OLD : NEW;
    calls += 1;
    return Promise.resolve(
      new Map(
        keys.filter((key) => key in saved).map((key) => [key, { value: saved[key], version: 2 }]),
      ),
    );
  });
  const config = { configValue: vi.fn<Read>(mixedRead), configValues };
  const logger = { warn: vi.fn() };
  const from = new Date('2026-12-31T20:00:00+08:00');
  const calendars = await readReviewCalendars({ config, logger }, HANDLE, APP_ID, from);
  expect(reviewDeadline(from, calendars).toISOString()).toBe('2027-01-01T16:00:00.000Z');
  expect(calendars).toStrictEqual({
    2026: { holidays: ['2026-12-31'], makeupWorkdays: [] },
    2027: { holidays: [], makeupWorkdays: [] },
  });
  expect(configValues).toHaveBeenCalledTimes(1);
  expect([...configValues.mock.calls[0]![1]].sort()).toEqual(Object.keys(OLD).sort());
  expect(configValues.mock.calls[0]![2]).toBe(HANDLE);
  expect(config.configValue).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-34s#7] without a batch read each key of the year is read once on the handle', async () => {
  const configValue = vi.fn<Read>((_appId, key) =>
    Promise.resolve({
      value: key === CALENDAR_KEYS.holidays(2026) ? CALENDAR.holidays : CALENDAR.makeupWorkdays,
      version: 2,
    }),
  );
  const logger = { warn: vi.fn() };
  expect(
    await readReviewCalendars({ config: { configValue }, logger }, HANDLE, APP_ID, FROM),
  ).toStrictEqual({ 2026: CALENDAR });
  expect(configValue.mock.calls).toEqual([
    [APP_ID, CALENDAR_KEYS.holidays(2026), HANDLE],
    [APP_ID, CALENDAR_KEYS.makeupWorkdays(2026), HANDLE],
  ]);
});
