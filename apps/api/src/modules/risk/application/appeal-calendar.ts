// Working-day calendar of the appeal deadline (BR-ID-36 处理时限, task B1-03i §9.3 #5).
// Per +08:00 civil year it reads `calendar.cn_holidays.<year>` and
// `calendar.cn_makeup_workdays.<year>` through the configuration port (values: arrays of
// `YYYY-MM-DD` strings of that year). A year whose two keys are not both configured with valid
// values, or whose read fails, counts weekends only, and one warn line
// `appeal_calendar_unconfigured` is logged for it with app_id and year only (never a value or the
// error): the calendar never refuses an appeal. Only the years the deadline actually reaches are
// read (a submission late in December may reach into January).
import type { Clock, RootLogger } from '../../platform/index.ts';
import {
  appealLocalYear,
  workingDayDeadline,
  type AppealCalendarYear,
} from '../domain/appeal-deadline.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

export interface AppealCalendarOptions {
  readonly appId: string;
  readonly clock: Clock;
  readonly config: RateLimitConfigReader & Pick<WorkingDayCalendarReader, 'configValues'>;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** An array of real `YYYY-MM-DD` dates of `year`; anything else is null (invalid). */
function datesOf(value: unknown, year: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const dates: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return null;
    const match = DATE.exec(entry);
    if (match === null || Number(match[1]) !== year) return null;
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    dates.push(entry);
  }
  return dates;
}

/** What the calendar reads need (AppealCalendarOptions and WorkingDayDeadlineOptions both fit). */
interface CalendarSource {
  readonly appId: string;
  readonly config: WorkingDayCalendarReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

async function readYear(source: CalendarSource, year: number): Promise<AppealCalendarYear | null> {
  const holidaysKey = `calendar.cn_holidays.${year}`;
  const makeupKey = `calendar.cn_makeup_workdays.${year}`;
  try {
    let holidays: { readonly value: unknown } | null;
    let makeup: { readonly value: unknown } | null;
    if (source.config.configValues !== undefined) {
      // B1-34s (D10-3001): both keys from one statement, taken as one saved state; a key the
      // batch read does not return is unconfigured (never read again on its own, which could pair
      // an old value of one key with a new value of the other).
      const rows = await source.config.configValues(source.appId, [holidaysKey, makeupKey]);
      holidays = rows.get(holidaysKey) ?? null;
      makeup = rows.get(makeupKey) ?? null;
    } else {
      [holidays, makeup] = await Promise.all([
        source.config.configValue(source.appId, holidaysKey),
        source.config.configValue(source.appId, makeupKey),
      ]);
    }
    if (holidays === null || makeup === null) return null;
    const holidayDates = datesOf(holidays.value, year);
    const makeupDates = datesOf(makeup.value, year);
    if (holidayDates === null || makeupDates === null) return null;
    return { holidays: holidayDates, makeupWorkdays: makeupDates };
  } catch {
    // The error may carry configuration values or driver details: never logged.
    return null;
  }
}

/**
 * The deadline `workingDays` working days after `from`, reading each +08:00 civil year it reaches
 * once; a year that cannot be read counts weekends only and logs `unconfiguredKey` (app_id, year).
 */
async function resolveDeadline(
  source: CalendarSource,
  from: Date,
  workingDays: number,
  unconfiguredKey: string,
): Promise<Date> {
  const firstYear = appealLocalYear(from);
  const calendars: Record<number, AppealCalendarYear> = {};
  const read = new Set<number>();
  for (;;) {
    let added = false;
    const deadline = workingDayDeadline(from, calendars, workingDays);
    // The last working day counted is the civil day before the deadline instant.
    const lastYear = appealLocalYear(deadline, -1);
    for (let year = firstYear; year <= lastYear; year += 1) {
      if (read.has(year)) continue;
      read.add(year);
      added = true;
      const calendar = await readYear(source, year);
      if (calendar === null) {
        source.logger.warn({ app_id: source.appId, year }, unconfiguredKey);
      } else {
        calendars[year] = calendar;
      }
    }
    // A newly read year may move the deadline into a later year: recompute until stable.
    if (!added) return deadline;
  }
}

/** Read per-year configuration; unavailable/invalid calendars fall back with a private warning. */
export async function resolveAppealDeadline(options: AppealCalendarOptions): Promise<Date> {
  return resolveDeadline(options, options.clock.now(), 3, 'appeal_calendar_unconfigured');
}

/** B1-15f: the configuration port of resolveWorkingDayDeadline (RateLimitConfigReader fits it). */
export interface WorkingDayCalendarReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
  /**
   * B1-34s (D10-3001 / D10-3002): when given, the year's two keys are read in one statement (one
   * snapshot of config_items, so a batch save is seen whole or not at all); absent keys have no
   * entry. Without it each key is read once on its own.
   */
  configValues?(
    appId: string,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly value: unknown }>>;
}

export interface WorkingDayDeadlineOptions {
  readonly appId: string;
  /** The instant counted from (its +08:00 civil date is excluded). */
  readonly from: Date;
  readonly workingDays: number;
  readonly config: WorkingDayCalendarReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

/**
 * B1-15f §9.2 #4: resolveAppealDeadline with `from` and the number of working days as parameters
 * (resolveAppealDeadline becomes this with clock.now() and 3; its signature, behaviour and log key
 * stay). Same calendar reads; an unconfigured year counts weekends only and logs one warn line
 * `workday_calendar_unconfigured` with app_id and year (never a value or the error).
 */
export function resolveWorkingDayDeadline(options: WorkingDayDeadlineOptions): Promise<Date> {
  return resolveDeadline(
    options,
    options.from,
    options.workingDays,
    'workday_calendar_unconfigured',
  );
}
