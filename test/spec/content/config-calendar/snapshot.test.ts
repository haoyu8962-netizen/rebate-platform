import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { readReviewCalendars } from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import { resolveAppealDeadline } from '../../../../apps/api/src/modules/risk/application/appeal-calendar.ts';

const APP_ID = 'calendar_snapshot';
const HOLIDAYS = 'calendar.cn_holidays.2026';
const MAKEUP = 'calendar.cn_makeup_workdays.2026';
const CLOCK = new FixedClock('2026-10-01T12:00:00+08:00');
const CALENDAR = {
  holidays: ['2026-10-02', '2026-10-06'],
  makeupWorkdays: ['2026-10-03', '2026-10-04'],
};

function mixedRead(_appId: string, key: string) {
  // 模拟在两个单键查询之间提交批量保存，节假日读到旧值，补班日读到新值。
  return Promise.resolve(
    key === HOLIDAYS
      ? { value: ['2026-10-05'], version: 1 }
      : { value: CALENDAR.makeupWorkdays, version: 2 },
  );
}

function savedCalendar() {
  return Promise.resolve(
    new Map([
      [HOLIDAYS, { value: CALENDAR.holidays, version: 2 }],
      [MAKEUP, { value: CALENDAR.makeupWorkdays, version: 2 }],
    ]),
  );
}

type SavedCalendar = ReturnType<typeof savedCalendar>;
type BatchRead = (appId: string, keys: readonly string[]) => SavedCalendar;
type PayoutBatchRead = (appId: string, keys: readonly string[], db: Kysely<DB>) => SavedCalendar;

it('[AC-B1-34s#7] 提现审核一次批量读取同年双键并采用整组返回值', async () => {
  // 数据访问由测试端口完全接管，此处仅传递调用者的句柄。
  const handle = {} as Kysely<DB>;
  const config = {
    configValue: vi.fn(mixedRead),
    configValues: vi.fn<PayoutBatchRead>(savedCalendar),
  };
  const logger = { warn: vi.fn() };

  const calendars = await readReviewCalendars({ config, logger }, handle, APP_ID, CLOCK.now());

  expect(calendars).toStrictEqual({ 2026: CALENDAR });
  expect(config.configValues).toHaveBeenCalledExactlyOnceWith(
    APP_ID,
    expect.arrayContaining([HOLIDAYS, MAKEUP]),
    handle,
  );
  expect(config.configValues.mock.calls[0]?.[1]).toHaveLength(2);
  expect(config.configValue).not.toHaveBeenCalled();
});

it('[AC-B1-34s#8] 申诉按同一次批量读取的节假日和补班日计算期限', async () => {
  const config = {
    configValue: vi.fn(mixedRead),
    configValues: vi.fn<BatchRead>(savedCalendar),
  };
  const logger = { warn: vi.fn() };

  const deadline = await resolveAppealDeadline({ appId: APP_ID, clock: CLOCK, config, logger });

  // 10 月 3 日、4 日补班，5 日是第三个工作日，期限为 5 日 24:00（+08:00）。
  expect(deadline.toISOString()).toBe('2026-10-05T16:00:00.000Z');
  expect(config.configValues).toHaveBeenCalledTimes(1);
  const [appId, keys] = config.configValues.mock.calls[0]!;
  expect(appId).toBe(APP_ID);
  expect([...keys].sort()).toEqual([HOLIDAYS, MAKEUP]);
  expect(config.configValue).not.toHaveBeenCalled();
});
