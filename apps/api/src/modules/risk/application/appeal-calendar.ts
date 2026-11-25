// Working-day calendar of the appeal deadline (BR-ID-36 处理时限, task B1-03i §9.3 #5).
// Per +08:00 civil year it reads `calendar.cn_holidays.<year>` and
// `calendar.cn_makeup_workdays.<year>` through the configuration port (values: arrays of
// `YYYY-MM-DD` strings of that year). A year whose two keys are not both configured with valid
// values, or whose read fails, counts weekends only (with a batch read, a failed re-read keeps the
// years of the last successful read, D10-3209), and one warn line
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

function keysOf(year: number): [string, string] {
  return [`calendar.cn_holidays.${year}`, `calendar.cn_makeup_workdays.${year}`];
}

/** The year's calendar from its two read values; null unless both are valid date lists. */
function calendarOf(
  year: number,
  holidays: { readonly value: unknown } | null,
  makeup: { readonly value: unknown } | null,
): AppealCalendarYear | null {
  if (holidays === null || makeup === null) return null;
  const holidayDates = datesOf(holidays.value, year);
  const makeupDates = datesOf(makeup.value, year);
  if (holidayDates === null || makeupDates === null) return null;
  return { holidays: holidayDates, makeupWorkdays: makeupDates };
}

/** Without a batch read: each key of the year read once on its own. */
async function readYear(source: CalendarSource, year: number): Promise<AppealCalendarYear | null> {
  const [holidaysKey, makeupKey] = keysOf(year);
  try {
    const [holidays, makeup] = await Promise.all([
      source.config.configValue(source.appId, holidaysKey),
      source.config.configValue(source.appId, makeupKey),
    ]);
    return calendarOf(year, holidays, makeup);
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
  const batch = source.config.configValues;
  if (batch !== undefined) {
    return resolveDeadlineBatched(source, batch, from, workingDays, unconfiguredKey);
  }
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

/**
 * B1-34s (D10-3115): with a batch read, the keys of every year the computation reaches come from
 * one statement (one snapshot of config_items, so a batch save is seen whole or not at all). When
 * the deadline turns out to reach a later year, all years are read again in one statement and the
 * deadline is recomputed from that result alone (an earlier read is never combined with a later
 * one). A key the batch read does not return leaves its year unconfigured (never read on its own).
 * D10-3209: a failed read leaves the calendars of the last successful read in force (as a whole,
 * nothing of the failed read is used) and every year it did not cover counts weekends only; when
 * the very first read fails every year counts weekends only.
 */
async function resolveDeadlineBatched(
  source: CalendarSource,
  batch: NonNullable<WorkingDayCalendarReader['configValues']>,
  from: Date,
  workingDays: number,
  unconfiguredKey: string,
): Promise<Date> {
  const firstYear = appealLocalYear(from);
  // Start with the years a weekends-only deadline reaches.
  let lastRead = Math.max(
    firstYear,
    appealLocalYear(workingDayDeadline(from, {}, workingDays), -1),
  );
  // The calendars of the last successful read (none before the first one).
  let inForce: Record<number, AppealCalendarYear> = {};
  for (;;) {
    const years: number[] = [];
    for (let year = firstYear; year <= lastRead; year += 1) years.push(year);
    let rows: ReadonlyMap<string, { readonly value: unknown }> | null;
    try {
      rows = await batch.call(source.config, source.appId, years.flatMap(keysOf));
    } catch {
      // The error may carry configuration values or driver details: never logged.
      rows = null;
    }
    if (rows !== null) {
      const calendars: Record<number, AppealCalendarYear> = {};
      for (const year of years) {
        const [holidaysKey, makeupKey] = keysOf(year);
        const calendar = calendarOf(
          year,
          rows.get(holidaysKey) ?? null,
          rows.get(makeupKey) ?? null,
        );
        if (calendar !== null) calendars[year] = calendar;
      }
      inForce = calendars;
    }
    const deadline = workingDayDeadline(from, inForce, workingDays);
    // The last working day counted is the civil day before the deadline instant.
    const lastYear = appealLocalYear(deadline, -1);
    // A failed read is not retried: the deadline stands on the calendars in force.
    if (rows === null || lastYear <= lastRead) {
      for (let year = firstYear; year <= lastYear; year += 1) {
        if (inForce[year] === undefined) {
          source.logger.warn({ app_id: source.appId, year }, unconfiguredKey);
        }
      }
      return deadline;
    }
    // The deadline reaches a year not read: read them all again together and start over.
    lastRead = lastYear;
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
   * B1-34s (D10-3001 / D10-3002 / D10-3115): when given, the keys of every year a deadline
   * reaches are read in one statement (one snapshot of config_items, so a batch save is seen whole
   * or not at all); absent keys have no entry. Without it each key is read once on its own.
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
