// Display and input rules of the configuration center. Everything that decides behaviour (which
// items exist, type, options, permission point, admin_editable, version) comes from the server
// row; this file derives labels, the page group of a key, the client-side gate and the parsing of
// what the operator typed. Amounts (`*_fen`) only go through @couli/money: integer fen, no floats.
import type { Schema } from '@couli/contracts-ts';
import { fenToJsonNumber, formatYuanAdmin, parseFen, yuanStrToFen } from '@couli/money';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { configCenterTexts as t } from '../../texts/config-center.ts';

export type ConfigRow = Schema<'AdminConfigItem'>;
export type ConfigVersion = Schema<'AdminConfigItemVersion'>;
export type ConfigValue = ConfigRow['value'];
export type ConfigPermission = ConfigRow['permission'];
/** A value the console sends (never null: null means never written). */
export type NewValue = number | string | boolean | object;

/** Page groups in navigation order; `other` only shows when some key falls in it. */
export const GROUP_IDS = ['withdraw', 'invite', 'risk', 'agent', 'model', 'examples'] as const;
export type GroupId = (typeof GROUP_IDS)[number] | 'other';

export const LIST_URL = '/admin/v1/config-items';
export const BATCH_URL = '/admin/v1/config-items/batch';
export const STEP_UP_URL = '/admin/v1/auth/step-up';
export const REASON_MAX = 200;

export function itemUrl(key: string): string {
  return `${LIST_URL}/${encodeURIComponent(key)}`;
}

/** Page group of a row: by the key's leading segments, a risk-point row otherwise in 风控阈值. */
export function groupOf(row: ConfigRow): GroupId {
  const key = row.key;
  if (/^(?:withdraw|payout)\./.test(key)) return 'withdraw';
  if (/^(?:invite|growth\.invite_reward)\./.test(key)) return 'invite';
  if (/^(?:model\.|agent\.model)/.test(key)) return 'model';
  if (/^agent\.(?:example|sample|suggest)/.test(key)) return 'examples';
  if (/^(?:agent|budget)\./.test(key)) return 'agent';
  if (/^risk\./.test(key) || row.permission === 'config.risk') return 'risk';
  return 'other';
}

export function groupLabel(group: GroupId): string {
  return t.groups[group];
}

function lookup(map: Readonly<Record<string, string>>, key: string): string | null {
  return Object.hasOwn(map, key) ? (map[key] ?? null) : null;
}

/** Business name of a key, or null when the page has none (the key is shown alone). */
export function nameOf(key: string): string | null {
  return lookup(t.names, key);
}

export function displayName(key: string): string {
  return nameOf(key) ?? key;
}

export function descriptionOf(key: string): string | null {
  return lookup(t.descriptions, key);
}

export function scopeOf(key: string): string {
  return lookup(t.scopes, key) ?? t.scopeDefault;
}

export function isMoney(row: ConfigRow): boolean {
  return row.value_type === 'number' && row.key.endsWith('_fen');
}

export function unitOf(key: string): string {
  if (t.countKeys.includes(key)) return t.units.count;
  if (t.itemKeys.includes(key)) return t.units.item;
  if (key.endsWith('_sec')) return t.units.seconds;
  if (key.endsWith('_minutes')) return t.units.minutes;
  if (key.endsWith('_hours')) return t.units.hours;
  if (key.endsWith('_days')) return t.units.days;
  if (key.endsWith('_months')) return t.units.months;
  if (key.endsWith('_bp')) return t.units.bp;
  return '';
}

export function typeLabel(row: ConfigRow): string {
  return isMoney(row) ? t.types.money : t.types[row.value_type];
}

/** Admin display of an amount in fen, or null when the value is not an integer fen amount. */
export function moneyLabel(value: unknown): string | null {
  try {
    return formatYuanAdmin(parseFen(value));
  } catch {
    return null;
  }
}

/** Integer fen of the value as a plain digit string (「500000」), or null. */
export function fenLabel(value: unknown): string | null {
  try {
    return parseFen(value).toString();
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? t.dash;
}

/** Readable form of a value of the row; null = never written (the built-in default applies). */
export function valueLabel(row: ConfigRow, value: unknown): string {
  if (value === null) return t.builtinDefault;
  if (isMoney(row)) return moneyLabel(value) ?? json(value);
  if (typeof value === 'number') {
    const unit = unitOf(row.key);
    return unit === '' ? String(value) : `${value} ${unit}`;
  }
  if (typeof value === 'boolean') return value ? t.booleanOn : t.booleanOff;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.map((item) => lookup(t.valueLabels, item) ?? item).join(t.separator);
  return json(value);
}

export function isPendingOwner(key: string): boolean {
  return t.pendingOwnerKeys.includes(key);
}

/** config.risk and config.business changes need the totp step-up; config.general none. */
export function needsStepUp(permission: string): boolean {
  return permission !== 'config.general';
}

export function permitted(row: ConfigRow, access: AccessControl): boolean {
  return access.can(row.permission);
}

/** Whether the account may change the row: the server allows it and the row's point is held. */
export function editable(row: ConfigRow, access: AccessControl): boolean {
  return row.admin_editable && permitted(row, access);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Form value of the new-value control: InputNumber in string mode, Switch, Select, Input. */
export type FieldValue = string | boolean | null | undefined;

export type Parsed =
  | { readonly ok: true; readonly value: NewValue }
  | { readonly ok: false; readonly message: string };

function fail(message: string): Parsed {
  return { ok: false, message };
}

/**
 * Yuan text → integer fen as a JSON number. The text is checked as typed: digits with at most two
 * decimals; a third decimal, a sign or anything else is refused (never rounded or truncated).
 */
export function parseYuan(text: string): Parsed {
  const trimmed = text.trim();
  if (trimmed === '') return fail(t.validation.required);
  if (trimmed.startsWith('-')) return fail(t.validation.moneyNegative);
  const match = /^\d+(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return fail(t.validation.moneyFormat);
  if ((match[1]?.length ?? 0) > 2) return fail(t.validation.moneyDecimals);
  try {
    return { ok: true, value: fenToJsonNumber(yuanStrToFen(trimmed)) };
  } catch {
    return fail(t.validation.moneyRange);
  }
}

function parseNumber(text: string): Parsed {
  const trimmed = text.trim();
  if (trimmed === '') return fail(t.validation.required);
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return fail(t.validation.number);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fail(t.validation.number);
  if (/^-?\d+$/.test(trimmed) && !Number.isSafeInteger(value)) return fail(t.validation.number);
  return { ok: true, value };
}

/** Whole number of at least 1 (hours, days): 0, a sign or a decimal is refused, never rounded. */
function parsePositiveInteger(text: string): Parsed {
  const trimmed = text.trim();
  if (trimmed === '') return fail(t.validation.required);
  if (!/^\d+$/.test(trimmed)) return fail(t.validation.positiveInteger);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return fail(t.validation.positiveInteger);
  return { ok: true, value };
}

/** The value to send for what the operator entered, or the message to show. */
export function parseInput(row: ConfigRow, raw: FieldValue): Parsed {
  switch (row.value_type) {
    case 'number': {
      if (raw === null || raw === undefined || typeof raw !== 'string')
        return fail(t.validation.required);
      if (isMoney(row)) return parseYuan(raw);
      return t.positiveIntegerKeys.includes(row.key) ? parsePositiveInteger(raw) : parseNumber(raw);
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail(t.validation.required);
    case 'enum':
      return typeof raw === 'string' && (row.options ?? []).includes(raw)
        ? { ok: true, value: raw }
        : fail(t.validation.enum);
    case 'string':
      return typeof raw === 'string' ? { ok: true, value: raw } : fail(t.validation.required);
    case 'object': {
      if (typeof raw !== 'string' || raw.trim() === '') return fail(t.validation.required);
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null) return fail(t.validation.json);
        return { ok: true, value };
      } catch {
        return fail(t.validation.json);
      }
    }
  }
}

/** Starting value of the new-value control: numbers start empty (the current value is shown). */
export function initialInput(row: ConfigRow): FieldValue {
  switch (row.value_type) {
    case 'number':
      return null;
    case 'boolean':
      return row.value === true;
    case 'enum':
      return typeof row.value === 'string' ? row.value : undefined;
    case 'string':
      return typeof row.value === 'string' ? row.value : '';
    case 'object':
      return row.value === null ? '' : JSON.stringify(row.value, null, 2);
  }
}

/** Whether the control holds nothing to send (batch rows left as they are). */
export function blankInput(row: ConfigRow, raw: FieldValue): boolean {
  if (row.value_type === 'number') return raw === null || raw === undefined || raw === '';
  if (row.value_type === 'object') return typeof raw !== 'string' || raw.trim() === '';
  return raw === undefined;
}

/** Whether a batch control still holds what it started with, or nothing (left as it is). */
export function unchangedInput(row: ConfigRow, raw: FieldValue): boolean {
  return blankInput(row, raw) || sameValue(raw, initialInput(row));
}

export type BatchCollected =
  | { readonly ok: true; readonly entries: readonly { row: ConfigRow; value: NewValue }[] }
  | { readonly ok: false; readonly key: string; readonly message: string };

/**
 * The batch entries: only items the operator touched whose control differs from its starting
 * value and from the current value. An untouched item (including a never-written one whose
 * control starts at a placeholder such as a switch shown off) is never sent.
 */
export function collectBatch(
  rows: readonly ConfigRow[],
  values: Readonly<Record<string, FieldValue>>,
  touched: (key: string) => boolean,
): BatchCollected {
  const entries: { row: ConfigRow; value: NewValue }[] = [];
  for (const row of rows) {
    if (!touched(row.key)) continue;
    const raw = values[row.key];
    if (unchangedInput(row, raw)) continue;
    const parsed = parseInput(row, raw);
    if (!parsed.ok) return { ok: false, key: row.key, message: parsed.message };
    if (!sameValue(parsed.value, row.value)) entries.push({ row, value: parsed.value });
  }
  return { ok: true, entries };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

export function authorOf(updatedBy: string | null): string {
  return updatedBy ?? t.systemInit;
}

/**
 * Whether a failed write may still have been applied: no readable answer arrived (network, parse,
 * non-200 envelope), a server error (5xxxx), or an unexpected throw. A refusal the server answered
 * (10003, 10403, 20001, 20902, 42901 …) or a request rejected before sending means not applied.
 */
export function writeOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind !== 'api') return true;
  return cause.code >= 50000;
}

export function fieldsOf(error: AdminApiError): readonly string[] {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return (data.fields as unknown[]).filter((field): field is string => typeof field === 'string');
  return [];
}

/** Message of a refused write the server answered (not 10003, 20902 or an unknown result). */
export function errorText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.errors.failed;
  if (cause.code === 10403) return t.errors.forbidden;
  if (cause.code === 42901) return t.errors.rateLimited;
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('to_version')) return t.errors.toVersion;
    if (fields.includes('value')) return t.errors.value;
    if (fields.includes('key')) return t.errors.key;
    const keys = fields.filter((field) => field !== 'items' && field !== 'reason');
    if (keys.length > 0) return t.errors.items(keys.join(t.separator));
    return t.errors.invalid;
  }
  return t.errors.failed;
}
