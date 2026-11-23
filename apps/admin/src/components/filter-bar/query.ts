// F1-07ec: the URL side of FilterBar. Each field owns its query parameters (one name, or a start /
// end or min / max pair); the bar reads and writes only those and leaves every other parameter,
// repeated ones included, as it is. Values read back are checked: an option that is not offered,
// a date that is not a real YYYY-MM-DD day, a number that is not a plain non-negative decimal, and
// a reversed range (both ends dropped) count as not set. No Date and no floating point: dates and
// decimals are compared as text.

type Named = { readonly name: string; readonly label: string };

export type FilterField = {
  readonly label: string;
  readonly advanced?: boolean;
} & (
  | { readonly kind: 'exact-text' | 'fuzzy-text'; readonly name: string }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'date-range'; readonly start: Named; readonly end: Named }
  | { readonly kind: 'number-range'; readonly min: Named; readonly max: Named }
);

export type FilterValues = Readonly<Record<string, string>>;

/** The query parameter names a field owns. */
export function paramNames(field: FilterField): readonly string[] {
  switch (field.kind) {
    case 'date-range':
      return [field.start.name, field.end.name];
    case 'number-range':
      return [field.min.name, field.max.name];
    default:
      return [field.name];
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isIsoDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

/** True for a non-negative decimal such as `0`, `350` or `12.5`. */
export function isDecimal(text: string): boolean {
  return DECIMAL.test(text);
}

/** Compares two texts accepted by isDecimal by value, without converting them to numbers. */
export function compareDecimal(left: string, right: string): number {
  const [, leftWhole = '', leftFraction = ''] = DECIMAL.exec(left) ?? [];
  const [, rightWhole = '', rightFraction = ''] = DECIMAL.exec(right) ?? [];
  const a = leftWhole.replace(/^0+(?=\d)/, '');
  const b = rightWhole.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const c = leftFraction.padEnd(width, '0');
  const d = rightFraction.padEnd(width, '0');
  return c === d ? 0 : c < d ? -1 : 1;
}

/** The valid, non-empty values of `fields` taken from `raw` (form input or the URL). */
export function sanitize(fields: readonly FilterField[], raw: FilterValues): FilterValues {
  const out: Record<string, string> = {};
  const take = (name: string): string => (Object.hasOwn(raw, name) ? (raw[name] ?? '') : '').trim();
  for (const field of fields) {
    switch (field.kind) {
      case 'exact-text':
      case 'fuzzy-text': {
        const value = take(field.name);
        if (value !== '') out[field.name] = value;
        break;
      }
      case 'select': {
        const value = take(field.name);
        if (field.options.some((option) => option.value === value)) out[field.name] = value;
        break;
      }
      case 'date-range': {
        const start = take(field.start.name);
        const end = take(field.end.name);
        const okStart = isIsoDate(start);
        const okEnd = isIsoDate(end);
        // ISO dates of the same length order as text.
        if (okStart && okEnd && start > end) break;
        if (okStart) out[field.start.name] = start;
        if (okEnd) out[field.end.name] = end;
        break;
      }
      case 'number-range': {
        const min = take(field.min.name);
        const max = take(field.max.name);
        const okMin = isDecimal(min);
        const okMax = isDecimal(max);
        if (okMin && okMax && compareDecimal(min, max) > 0) break;
        if (okMin) out[field.min.name] = min;
        if (okMax) out[field.max.name] = max;
        break;
      }
    }
  }
  return out;
}

/** The fields' values in the current URL (first occurrence of each owned parameter), checked. */
export function readQueryValues(fields: readonly FilterField[]): FilterValues {
  const params = new URLSearchParams(window.location.search);
  const raw: Record<string, string> = {};
  for (const field of fields)
    for (const name of paramNames(field)) {
      const value = params.get(name);
      if (value !== null) raw[name] = value;
    }
  return sanitize(fields, raw);
}

/** Replaces the fields' own parameters in the URL with `values`; other parameters stay. */
export function writeQueryValues(fields: readonly FilterField[], values: FilterValues): void {
  const params = new URLSearchParams(window.location.search);
  const owned = fields.flatMap(paramNames);
  for (const name of owned) params.delete(name);
  for (const name of owned) {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value !== undefined && value !== '') params.append(name, value);
  }
  const search = params.toString();
  const { pathname, hash } = window.location;
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${search === '' ? '' : `?${search}`}${hash}`,
  );
}
