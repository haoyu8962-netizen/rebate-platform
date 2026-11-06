// B1-25a / D10-714 / D10-716: independent config oracle, never starts Alertmanager or a sink.
// YAML subset matches the existing metrics rule tests. Unsupported routing/time fields fail
// explicitly rather than being silently ignored. This is not a general Alertmanager validator.
// Semantics: https://github.com/prometheus/alertmanager/blob/v0.25.0/dispatch/route.go
// Match first (including muted routes), apply continue, then suppress selected notifications.
// Receiver/group settings inherit; mute/active interval lists and continue do not inherit.
import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const ROOT = new URL('../../../../', import.meta.url);
type Mapping = Record<string, unknown>;
export type Labels = Readonly<Record<string, string>>;

export interface Selection {
  receiver: string;
  groupBy: string[];
  groupWait: string;
  groupInterval: string;
  repeatInterval: string;
  mute: string[];
  active: string[];
}

export interface AlertConfig {
  route: Mapping;
  receivers: Mapping[];
  intervals: Map<string, Mapping[]>;
}

export function record(value: unknown, where: string): Mapping {
  expect(value, `${where}: mapping`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${where}: not a list`).toBe(false);
  return value as Mapping;
}

export function list(value: unknown, where: string): unknown[] {
  expect(Array.isArray(value), `${where}: list`).toBe(true);
  return value as unknown[];
}

export function string(value: unknown, where: string): string {
  expect(value, `${where}: string`).toEqual(expect.any(String));
  return value as string;
}

function strings(value: unknown, where: string): string[] {
  return list(value, where).map((item) => string(item, where));
}

export function keys(value: Mapping, allowed: string[], where: string): void {
  expect(
    Object.keys(value).filter((key) => !allowed.includes(key)),
    where,
  ).toEqual([]);
}

function document(path: string): Mapping {
  const file = new URL(path, ROOT);
  // Before readFileSync: missing implementation must fail an assertion, never ENOENT.
  expect(existsSync(file), `${path} exists`).toBe(true);
  let parsed: unknown;
  expect(() => {
    parsed = parseYamlLite(readFileSync(file, 'utf8'));
  }, path).not.toThrow();
  return record(parsed, path);
}

/** Config load happens inside each test, so every test is red while the config is absent. */
export function configuration(): AlertConfig {
  const doc = document('infra/monitoring/alertmanager/alertmanager.yml');
  keys(
    doc,
    [
      'global',
      'route',
      'receivers',
      'time_intervals',
      'mute_time_intervals',
      'templates',
      'inhibit_rules',
    ],
    'supported standalone staging config',
  );
  // No extra inhibition or templates hiding delivery/adding external integration settings.
  expect(doc['inhibit_rules'] ?? []).toEqual([]);
  expect(doc['templates'] ?? []).toEqual([]);
  keys(record(doc['global'] ?? {}, 'global'), ['resolve_timeout'], 'placeholder global settings');
  const intervals = new Map<string, Mapping[]>();
  for (const value of [
    ...list(doc['time_intervals'] ?? [], 'time_intervals'),
    ...list(doc['mute_time_intervals'] ?? [], 'legacy mute_time_intervals'),
  ]) {
    const named = record(value, 'named interval');
    keys(named, ['name', 'time_intervals'], 'named interval fields');
    const name = string(named['name'], 'interval name');
    expect(intervals.has(name), `duplicate interval ${name}`).toBe(false);
    const spans = list(named['time_intervals'], name).map((span) => record(span, name));
    expect(spans.length, `${name}: nonempty interval`).toBeGreaterThan(0);
    for (const span of spans) {
      // Daily quiet hours only; reject calendar constraints rather than approximating them.
      keys(span, ['times', 'location'], `${name}: supported daily interval`);
      string(span['location'] ?? 'UTC', `${name}: timezone`);
      for (const time of list(span['times'] ?? [], `${name}: times`)) {
        const range = record(time, name);
        keys(range, ['start_time', 'end_time'], `${name}: time range`);
        expect(minutes(range['start_time']), name).toBeLessThan(minutes(range['end_time']));
      }
    }
    intervals.set(name, spans);
  }
  const receivers = list(doc['receivers'], 'receivers').map((value) => record(value, 'receiver'));
  const names = receivers.map((receiver) => string(receiver['name'], 'receiver name'));
  expect([...names].sort(), 'exactly the finance and oncall groups').toEqual(['finance', 'oncall']);
  const route = record(doc['route'], 'root route');
  const validate = (node: Mapping, root: boolean): void => {
    keys(
      node,
      [
        'receiver',
        'routes',
        'matchers',
        'continue',
        'group_by',
        'group_wait',
        'group_interval',
        'repeat_interval',
        'mute_time_intervals',
        'active_time_intervals',
      ],
      'supported route fields',
    );
    if (root || node['receiver'] !== undefined) {
      expect(names).toContain(string(node['receiver'], 'route receiver'));
    }
    if (node['continue'] !== undefined) expect(typeof node['continue']).toBe('boolean');
    strings(node['matchers'] ?? [], 'matchers').forEach(parseMatcher);
    if (node['group_by'] !== undefined) strings(node['group_by'], 'group_by');
    for (const key of ['group_wait', 'group_interval', 'repeat_interval']) {
      if (node[key] !== undefined) {
        expect(string(node[key], key), key).toMatch(/^(?:\d+(?:ms|s|m|h|d|w|y))+$/);
      }
    }
    for (const key of ['mute_time_intervals', 'active_time_intervals']) {
      for (const name of strings(node[key] ?? [], key)) {
        expect(intervals.has(name), `defined interval ${name}`).toBe(true);
      }
      if (root) expect(node[key] ?? [], `root cannot use ${key}`).toEqual([]);
    }
    if (root) {
      expect(node['matchers'] ?? [], 'root matches all alerts').toEqual([]);
      expect(node['continue'] ?? false, 'root cannot continue').toBe(false);
    }
    for (const child of list(node['routes'] ?? [], 'routes'))
      validate(record(child, 'route'), false);
  };
  validate(route, true);
  return { route, receivers, intervals };
}

/** Exact matchers suffice for fund="true" and the non-fund fallback; reject unsupported syntax. */
function parseMatcher(value: string): { label: string; operator: string; value: string } {
  const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(!=|=)\s*(?:"([^"\\]*)"|([a-zA-Z0-9_]+))\s*$/.exec(
    value,
  );
  expect(match, `supported equality matcher: ${value}`).not.toBeNull();
  return { label: match![1]!, operator: match![2]!, value: match![3] ?? match![4]! };
}

// Alertmanager default route options; explicit descendant values override inherited values.
const DEFAULT_SELECTION: Selection = {
  receiver: '',
  groupBy: [],
  groupWait: '30s',
  groupInterval: '5m',
  repeatInterval: '4h',
  mute: [],
  active: [],
};

function optionsFor(node: Mapping, parent: Selection): Selection {
  return {
    receiver:
      node['receiver'] === undefined ? parent.receiver : string(node['receiver'], 'receiver'),
    groupBy:
      node['group_by'] === undefined ? parent.groupBy : strings(node['group_by'], 'group_by'),
    groupWait:
      node['group_wait'] === undefined
        ? parent.groupWait
        : string(node['group_wait'], 'group_wait'),
    groupInterval:
      node['group_interval'] === undefined
        ? parent.groupInterval
        : string(node['group_interval'], 'group_interval'),
    repeatInterval:
      node['repeat_interval'] === undefined
        ? parent.repeatInterval
        : string(node['repeat_interval'], 'repeat_interval'),
    mute: strings(node['mute_time_intervals'] ?? [], 'mute_time_intervals'),
    active: strings(node['active_time_intervals'] ?? [], 'active_time_intervals'),
  };
}

/** Include the root and intermediate/unselected nodes when checking effective grouping. */
export function effectiveRoutes(config: AlertConfig): Selection[] {
  const visit = (node: Mapping, parent: Selection): Selection[] => {
    const options = optionsFor(node, parent);
    return [
      options,
      ...list(node['routes'] ?? [], 'routes').flatMap((child) =>
        visit(record(child, 'child route'), options),
      ),
    ];
  };
  return visit(config.route, DEFAULT_SELECTION);
}

/** Select routes before muting: a muted match still consumes the branch unless continue=true. */
export function selected(config: AlertConfig, labels: Labels): Selection[] {
  const visit = (node: Mapping, parent: Selection): Selection[] => {
    const matches = strings(node['matchers'] ?? [], 'matchers').every((value) => {
      const matcher = parseMatcher(value);
      const equal = (labels[matcher.label] ?? '') === matcher.value;
      return matcher.operator === '=' ? equal : !equal;
    });
    if (!matches) return [];
    const options = optionsFor(node, parent);
    const out: Selection[] = [];
    for (const value of list(node['routes'] ?? [], 'routes')) {
      const child = record(value, 'child route');
      const found = visit(child, options);
      out.push(...found);
      if (found.length > 0 && child['continue'] !== true) break;
    }
    return out.length > 0 ? out : [options];
  };
  return visit(config.route, DEFAULT_SELECTION);
}

function minutes(value: unknown): number {
  const text = string(value, 'time HH:MM');
  expect(text).toMatch(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
  const [hour, minute] = text.split(':').map(Number);
  return hour! * 60 + minute!;
}

function within(config: AlertConfig, name: string, instant: string): boolean {
  const spans = config.intervals.get(name);
  expect(spans, `defined interval ${name}`).toBeDefined();
  return spans!.some((span) => {
    const location = string(span['location'] ?? 'UTC', 'location');
    let localTime = '';
    expect(() => {
      localTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: location,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(instant));
    }, `valid timezone ${location} and instant ${instant}`).not.toThrow();
    const minute = minutes(localTime);
    const times = list(span['times'] ?? [], 'times');
    return (
      times.length === 0 ||
      times.some((value) => {
        const range = record(value, 'time range');
        return minute >= minutes(range['start_time']) && minute < minutes(range['end_time']);
      })
    );
  });
}

/** Notification eligibility at an injected instant, not simulation of the dispatcher timer. */
export function notifications(config: AlertConfig, labels: Labels, instant: string): string[] {
  return selected(config, labels)
    .filter(
      (route) =>
        !route.mute.some((name) => within(config, name, instant)) &&
        (route.active.length === 0 || route.active.some((name) => within(config, name, instant))),
    )
    .map((route) => route.receiver)
    .sort();
}

/** Real rule names and static labels; app_id is a synthetic metric label, never a team tag. */
export function alerts(kind: 'fund' | 'ops', appId = 'couli'): Labels[] {
  const doc = document(`infra/monitoring/rules/${kind === 'fund' ? 'couli-fund' : 'couli'}.yaml`);
  const rules = list(doc['groups'], 'groups').flatMap((value) => {
    const group = record(value, 'rule group');
    return list(group['rules'], 'rules').map((item) => {
      const rule = record(item, 'rule');
      const labels = record(rule['labels'], 'rule labels');
      for (const value of Object.values(labels)) string(value, 'label value');
      return { app_id: appId, ...labels, alertname: string(rule['alert'], 'alertname') } as Labels;
    });
  });
  expect(rules.length, `${kind}: real rules must not be empty`).toBeGreaterThan(0);
  return rules;
}
