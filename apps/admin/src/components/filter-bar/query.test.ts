// F1-07ec unit tests for the URL side of FilterBar: year 0000 is not a date the native date input
// can show, so it counts as not set (money review r1 S2).
import { afterEach, expect, it } from 'vitest';
import { isIsoDate, readQueryValues, sanitize, type FilterField } from './query.ts';

const fields: readonly FilterField[] = [
  {
    kind: 'date-range',
    label: '下单时间',
    start: { name: 'from', label: '开始' },
    end: { name: 'to', label: '结束' },
  },
];

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-07ec-FILTER-BAR#2] rejects year 0000 and accepts year 0001 and later real days', () => {
  expect(isIsoDate('0000-02-29')).toBe(false);
  expect(isIsoDate('0000-01-01')).toBe(false);
  expect(isIsoDate('0001-01-01')).toBe(true);
  expect(isIsoDate('2024-02-29')).toBe(true);
  expect(isIsoDate('2023-02-29')).toBe(false);
});

it('[AC-F1-07ec-FILTER-BAR#2] drops a year-0000 end from form input and keeps the valid start', () => {
  expect(sanitize(fields, { from: '2026-01-01', to: '0000-02-29' })).toEqual({
    from: '2026-01-01',
  });
});

it('[AC-F1-07ec-FILTER-BAR#2] ignores a year-0000 date in the URL instead of filling it back', () => {
  window.history.replaceState(null, '', '/?from=0000-02-29&to=2026-11-01');
  expect(readQueryValues(fields)).toEqual({ to: '2026-11-01' });
});
