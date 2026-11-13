// B1-06zo (C-31 第一步, D10-1469 / D10-1471): the per-event check of POST /v1/events against
// specs/events.yaml, read once from the same file the client generators use (no second copy of the
// field table). One non-conforming event never fails the batch: it is dropped and counted. The
// result is the shape agreed with CT-13g for the future recordEvents (CT-13h wires it there).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The shared, erasable TypeScript parser (as agent/http/message-schema.ts loads it); src/ and dist/
// have the same depth, so this also works from the built entry point.
const { parseYamlLite } = createRequire(import.meta.url)(
  '../../../../../../tools/lib/yaml-lite.ts',
) as {
  parseYamlLite(text: string): unknown;
};

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const EVENTS_SPEC_FILE = new URL('../../../../../../specs/events.yaml', import.meta.url);

/** B1-06zo / CT-13g: validated batch at the future recordEvents connection point. */
export interface EventBatchContext {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

export interface PreparedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly clientAt: string;
}

export interface PreparedEventBatch extends EventBatchContext {
  readonly events: readonly PreparedEvent[];
}

export interface PreparedEvents {
  readonly droppedCount: number;
  readonly batch: PreparedEventBatch;
}

interface FieldSpec {
  readonly type: 'string' | 'integer' | 'boolean' | 'enum';
  readonly required: boolean;
  readonly requiredWhen: Readonly<Record<string, string>> | null;
  readonly values: ReadonlySet<string> | null;
}

type FieldTable = ReadonlyMap<string, FieldSpec>;

/** Transport and identity fields: kept out of props (identity comes from the server only). */
const NOT_PROPS: ReadonlySet<string> = new Set([
  'event_id',
  'name',
  'client_at',
  'user_id',
  'device_id',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 date-time with a zone (Z or ±hh:mm), as events.yaml asks of client_at. */
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldSpec(raw: unknown, where: string): FieldSpec {
  if (!isRecord(raw)) throw new Error(`specs/events.yaml: ${where} must be a mapping`);
  const type = raw['type'];
  if (type !== 'string' && type !== 'integer' && type !== 'boolean' && type !== 'enum') {
    throw new Error(`specs/events.yaml: ${where}.type is not supported`);
  }
  const values = raw['values'];
  if (type === 'enum' && (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))) {
    throw new Error(`specs/events.yaml: ${where}.values must list strings`);
  }
  const when = raw['required_when'];
  if (
    when !== undefined &&
    (!isRecord(when) || !Object.values(when).every((v) => typeof v === 'string'))
  ) {
    throw new Error(`specs/events.yaml: ${where}.required_when must map fields to strings`);
  }
  return {
    type,
    required: raw['required'] === true,
    requiredWhen: when === undefined ? null : (when as Record<string, string>),
    values: type === 'enum' ? new Set(values as string[]) : null,
  };
}

function fieldTable(raw: unknown, where: string): Map<string, FieldSpec> {
  const table = new Map<string, FieldSpec>();
  if (raw === undefined) return table;
  if (!isRecord(raw)) throw new Error(`specs/events.yaml: ${where} must be a mapping`);
  for (const [name, field] of Object.entries(raw)) {
    table.set(name, fieldSpec(field, `${where}.${name}`));
  }
  return table;
}

/** Parses the governed table; a malformed file stops the entry rather than guessing. */
export function parseEventsSpec(document: unknown): ReadonlyMap<string, FieldTable> {
  if (!isRecord(document)) throw new Error('specs/events.yaml must be a mapping');
  const common = fieldTable(document['common_fields'], 'common_fields');
  const events = document['events'];
  if (!isRecord(events)) throw new Error('specs/events.yaml: events must be a mapping');
  const result = new Map<string, FieldTable>();
  for (const [name, entry] of Object.entries(events)) {
    if (!isRecord(entry)) throw new Error(`specs/events.yaml: events.${name} must be a mapping`);
    const own = fieldTable(entry['fields'], `events.${name}.fields`);
    result.set(name, new Map([...common, ...own]));
  }
  return result;
}

// Read once at module initialization; requests perform no file I/O.
const EVENTS: ReadonlyMap<string, FieldTable> = parseEventsSpec(
  parseYamlLite(readFileSync(EVENTS_SPEC_FILE, 'utf8')),
);

/** An absent optional value: not sent, or JSON null (a guest's empty user_id, 游客为空). */
function absent(event: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(event, key) || event[key] === undefined || event[key] === null;
}

function typeMatches(field: FieldSpec, value: unknown): boolean {
  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && field.values!.has(value);
  }
}

/**
 * The rules the field table states in prose (events.yaml notes, "必带" / "不带"), beyond types:
 * - link_jump.failure_reason: required when result=failed (required_when), absent otherwise;
 * - link_jump.sdk_open_by: required on a purchase's Taobao Baichuan step (step=sdk), and only
 *   sent on step=sdk.
 * A purchase step without attempt_id stays a conforming analytics event (BR-ATTR-21 细则).
 */
function linkJumpConforms(event: Record<string, unknown>): boolean {
  if (event['result'] !== 'failed' && !absent(event, 'failure_reason')) return false;
  const sdkStep = event['step'] === 'sdk';
  if (!sdkStep && !absent(event, 'sdk_open_by')) return false;
  if (
    sdkStep &&
    event['phase'] === 'purchase' &&
    event['union_platform'] === 'taobao' &&
    absent(event, 'sdk_open_by')
  ) {
    return false;
  }
  return true;
}

/** Field exemptions from required_when that BR-ATTR-21 states explicitly. */
function exemptFromRequiredWhen(name: string, key: string): boolean {
  return name === 'link_jump' && key === 'attempt_id';
}

function conforms(event: Record<string, unknown>, name: string, fields: FieldTable): boolean {
  for (const [key, field] of fields) {
    if (absent(event, key)) {
      if (field.required) return false;
      if (field.requiredWhen !== null && !exemptFromRequiredWhen(name, key)) {
        const triggered = Object.entries(field.requiredWhen).every(
          ([other, value]) => event[other] === value,
        );
        if (triggered) return false;
      }
      continue;
    }
    if (!typeMatches(field, event[key])) return false;
  }
  if (!UUID.test(event['event_id'] as string)) return false;
  const clientAt = event['client_at'] as string;
  if (!ZONED_TIME.test(clientAt) || Number.isNaN(Date.parse(clientAt))) return false;
  if (name === 'link_jump' && !linkJumpConforms(event)) return false;
  return true;
}

/** Validate individually against specs/events.yaml; omit transport/identity fields from props.
 * Missing link_jump.attempt_id is analytics-only (BR-ATTR-21), not a dropped event.
 * The HTTP receiver uses this boundary; CT-13h can later pass batch to recordEvents.
 */
export function prepareEvents(
  context: EventBatchContext,
  events: readonly unknown[],
): PreparedEvents {
  let droppedCount = 0;
  const seen = new Set<string>();
  const prepared: PreparedEvent[] = [];
  for (const item of events) {
    const name = isRecord(item) ? item['name'] : undefined;
    const fields = typeof name === 'string' ? EVENTS.get(name) : undefined;
    if (!isRecord(item) || typeof name !== 'string' || fields === undefined) {
      droppedCount += 1;
      continue;
    }
    if (!conforms(item, name, fields)) {
      droppedCount += 1;
      continue;
    }
    const eventId = item['event_id'] as string;
    // (event_type, event_id) dedupe (03 §6.2 第 9 条): a repeat is neither kept nor dropped.
    const key = `${name}\u0000${eventId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only fields of the governed table reach props; unknown fields are not carried on.
    const props: Record<string, unknown> = {};
    for (const field of fields.keys()) {
      if (NOT_PROPS.has(field) || !Object.hasOwn(item, field)) continue;
      props[field] = item[field];
    }
    prepared.push({ eventId, eventType: name, props, clientAt: item['client_at'] as string });
  }
  return {
    droppedCount,
    batch: {
      appId: context.appId,
      userId: context.userId,
      deviceId: context.deviceId,
      events: prepared,
    },
  };
}
