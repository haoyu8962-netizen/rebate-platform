import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-11-14T02:00:00.000Z';
export const CLIENT_AT = '2026-11-13T08:00:00+08:00';
export const TRACE = '0199a3b4-5c6d-7000-8000-000000000621';
export type Event = Record<string, unknown>;

export interface CommonEvent extends Event {
  event_id: string;
  name: string;
  client_at: string;
  session_id: string;
  device_id: string;
  platform: string;
  app_version: string;
  page: string;
}

const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

interface Field {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  required?: boolean;
  required_when?: Record<string, string>;
  values?: string[];
}
export const spec = parseYamlLite(readFileSync(new URL('specs/events.yaml', ROOT), 'utf8')) as {
  common_fields: Record<string, Field>;
  events: Record<string, { fields: Record<string, Field> }>;
};

export function common(name = 'page_view'): CommonEvent {
  return {
    event_id: randomUUID(),
    name,
    client_at: CLIENT_AT,
    session_id: 'synthetic-session',
    device_id: 'synthetic-body-device',
    platform: 'ios',
    app_version: '2.0.0',
    page: 'ProductDetail',
  };
}

export function jump(patch: object = {}): CommonEvent {
  return {
    ...common('link_jump'),
    phase: 'purchase',
    attempt_id: randomUUID(),
    link_id: randomUUID(),
    union_platform: 'jd',
    step: 'h5',
    result: 'requested',
    duration_ms: 120,
    installed: 'unknown',
    ...patch,
  };
}

export function without(event: Event, key: string): Event {
  const copy = { ...event };
  delete copy[key];
  return copy;
}

/** Independent fixtures from the governed field table, not a production validator. */
export function allEvents(): Event[] {
  return Object.entries(spec.events).map(([name, { fields }]) => {
    if (name === 'link_jump') return jump();
    const event = common(name);
    for (const [key, field] of Object.entries(fields)) {
      if (field.required !== true) continue;
      event[key] =
        field.type === 'integer'
          ? 1
          : field.type === 'boolean'
            ? true
            : field.type === 'enum'
              ? field.values![0]!
              : 'unknown';
    }
    // Notes constrain these diagnostics beyond their primitive types.
    if (name === 'agent_stream_seq_gap') Object.assign(event, { expected: 1, received: 3 });
    if (name === 'bridge_call') Object.assign(event, { method: 'openLink', code: 90001 });
    if (name === 'external_page_nav_host') event['registered_domain'] = 'example.test';
    return event;
  });
}

export const INVALID_ITEMS: readonly unknown[] = [
  null,
  [],
  7,
  'event',
  {},
  { ...common(), name: 'unregistered_event' },
  { ...common(), event_id: 'not-a-uuid' },
  { ...common(), client_at: 'not-a-time' },
  { ...common(), client_at: '2026-11-13T08:00:00' },
  without(jump(), 'result'),
  jump({ result: 'launched' }),
  jump({ result: 'copied' }),
  jump({ result: 'sdk_init_failed' }),
  jump({ result: 'failed' }),
  jump({ result: 'failed', failure_reason: 'unregistered_reason' }),
  jump({ union_platform: 'taobao', step: 'sdk' }),
  jump({ union_platform: 'taobao', step: 'sdk', sdk_open_by: 'invalid' }),
  jump({ duration_ms: 1.5 }),
  jump({ duration_ms: '120' }),
  jump({ installed: true }),
  jump({ phase: 'invalid' }),
];
