import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  EVENTS,
  EVENT_TARGET,
  ROWS,
  STATES,
  machine,
  publicExports,
  readRequired,
  transitionFunction,
  yamlText,
} from './kit.ts';

it('[CT-10a#1] YAML 只有 U1–U10，状态、事件、起点与目标与独立预期逐行相同', () => {
  const doc = machine();
  expect(Object.keys(doc).sort()).toEqual(['events', 'field', 'name', 'states', 'transitions']);
  expect(doc.states).toEqual(STATES);
  expect(doc.events).toEqual(EVENTS);
  expect(doc.transitions).toHaveLength(ROWS.length);
  const actual = doc.transitions.map((row) => {
    expect(Object.keys(row).sort()).toEqual(['event', 'from', 'guard', 'id', 'test_id', 'to']);
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
    expect(row.test_id).toBe(`SM-UB-${row.id}`);
    return { id: row.id, from: row.from, event: row.event, to: row.to };
  });
  expect(actual).toEqual(ROWS.map(({ id, from, event, to }) => ({ id, from, event, to })));
});

it('[CT-10a#2] 状态集合与 04 §4.4 契约枚举、0018 union_bindings_status_check 逐值相同，无 cooling', () => {
  const doc = machine();
  const parsed = parseYamlLite(readRequired('contracts/enums/identity.yaml'));
  expect(parsed).toMatchObject({
    enums: {
      union_binding_status: { values: expect.any(Object) },
      union_binding_blocked_reason: { values: expect.any(Object) },
    },
  });
  const contract = parsed as {
    enums: {
      union_binding_status: { values: Record<string, unknown> };
      union_binding_blocked_reason: { values: Record<string, unknown> };
    };
  };
  const statuses = Object.keys(contract.enums.union_binding_status.values);
  expect(statuses).toEqual(STATES);
  expect(doc.states).toEqual(statuses);
  const sql = readRequired('db/migrations/0018_linking-bindings.sql').replace(/--[^\n]*/g, '');
  const check =
    /CONSTRAINT\s+union_bindings_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(
      sql,
    );
  expect(check, '须读取命名 CHECK 的真实取值').not.toBeNull();
  const dbStates = [...check![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect([...dbStates].sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual([...dbStates].sort());
  expect(doc.states).not.toContain('cooling');
  for (const row of doc.transitions) {
    expect(row.to).not.toBe('cooling');
    expect(row.from).not.toContain('cooling');
  }
});

it('[CT-10a#3] 停用原因与重置原因不进状态或事件，事件只按目标状态区分', () => {
  const doc = machine();
  const parsed = parseYamlLite(readRequired('contracts/enums/identity.yaml')) as {
    enums?: { union_binding_blocked_reason?: { values?: Record<string, unknown> } };
  };
  const reasons = Object.keys(parsed.enums?.union_binding_blocked_reason?.values ?? {});
  expect(reasons.sort()).toEqual(['admin_disable', 'ban', 'deletion']);
  const events = doc.events.map((event) => event.toLowerCase());
  for (const reason of [...reasons, 'admin_reset']) {
    expect(doc.states).not.toContain(reason);
    expect(events).not.toContain(reason);
  }
  for (const row of doc.transitions) {
    expect(EVENT_TARGET[row.event as keyof typeof EVENT_TARGET]).toBe(row.to);
  }
});

it('[CT-10a#4] 每条迁移的 guard 能对到 BR-ID-19 / 20 / 21（解封 31）原文，文件头注明 04 §4.4', () => {
  const text = yamlText();
  expect(text).toContain('04 §4.4');
  for (const ref of ['BR-ID-19', 'BR-ID-20', 'BR-ID-21']) expect(text).toContain(ref);
  const doc = machine();
  for (const expected of ROWS) {
    const row = doc.transitions.find((candidate) => candidate.id === expected.id);
    expect(row, `missing ${expected.id}`).toBeDefined();
    for (const ref of expected.refs) {
      expect(row!.guard, `${expected.id} guard 须引用 ${ref}`).toContain(ref);
    }
  }
});

it('[CT-10a#5] 包入口导出独立预期的状态与事件、完整 YAML 迁移表与 transition', () => {
  const exports = publicExports();
  expect(exports['UNION_BINDING_STATES']).toEqual(STATES);
  expect(exports['UNION_BINDING_EVENTS']).toEqual(EVENTS);
  const doc = machine();
  expect(exports['UNION_BINDING_STATES']).toEqual(doc.states);
  expect(exports['UNION_BINDING_EVENTS']).toEqual(doc.events);
  expect(exports['UNION_BINDING_TRANSITIONS']).toEqual(doc.transitions);
  expect(transitionFunction(exports)).toEqual(expect.any(Function));
});

it('[CT-10a#6] 只有 active 是首态，unbound 与 pending_auth 不作任何迁移的目标', () => {
  const doc = machine();
  const firsts = doc.transitions.filter((row) => row.from.includes(null));
  expect(firsts.map((row) => [row.id, row.to])).toEqual([['U1', 'active']]);
  for (const row of doc.transitions) {
    expect(['unbound', 'pending_auth', 'same']).not.toContain(row.to);
    expect(row.from).not.toContain(row.to);
  }
});
