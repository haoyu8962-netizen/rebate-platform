import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

// CT-13b（D10-1376 ③）：specs/events.yaml 的 sdui_card_error.page_version 改为可选。
// 独立预期只来自 SPEC_REF 62b5c99338f8 上 规划/03 §6.2「解码隔离」（首页卡片解码失败记
// sdui_card_error(type, version, page_version, reason)）、§7.2（AI 助手页卡片 data 解码失败也记
// sdui_card_error，AI 助手页不是配置化页面、没有 page_version）与编排说明（version 递增、其余字段与
// 其他事件不动、本单不加诊断字段）。不从被测文件推导预期。
export type Obj = Record<string, unknown>;
export const root = new URL('../../../../', import.meta.url);
export const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const eventsPath = 'specs/events.yaml';
export const eventName = 'sdui_card_error';

/** HEAD（本任务开始前，主干 a9777caad）的 events.yaml version；本任务改动后必须大于它（文件头「每次改动递增」）。 */
export const baselineVersion = 3;

export type FieldSpec = {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  required: boolean;
  values?: readonly string[];
};

/** 03 §6.2 的 sdui_card_error(type, version, page_version, reason)；page_version 本单起可选（03 §7.2）。 */
export const expectedCardErrorFields: Readonly<Record<string, FieldSpec>> = {
  type: { type: 'string', required: true },
  version: { type: 'integer', required: false },
  page_version: { type: 'integer', required: false },
  reason: { type: 'string', required: true },
  schema_version: { type: 'string', required: true },
  bridge_version: { type: 'string', required: true },
  config_version: { type: 'string', required: true },
  h5_release: { type: 'string', required: true },
};

/** 本单不动的其他事件：抽查 bridge_call（03 §5.3，已含 CT-13c 的四项诊断字段）与四个 agent_stream_*（03 §4.7）的字段形状。 */
const agentShared: Readonly<Record<string, FieldSpec>> = {
  run_id: { type: 'string', required: false },
  message_id: { type: 'string', required: false },
  schema_version: { type: 'string', required: true },
  bridge_version: { type: 'string', required: true },
  config_version: { type: 'string', required: true },
  h5_release: { type: 'string', required: true },
};
export const untouchedEvents: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  bridge_call: {
    method: { type: 'string', required: true },
    code: { type: 'integer', required: true },
    schema_version: { type: 'string', required: true },
    bridge_version: { type: 'string', required: true },
    config_version: { type: 'string', required: true },
    h5_release: { type: 'string', required: true },
  },
  agent_stream_seq_gap: {
    ...agentShared,
    expected: { type: 'integer', required: true },
    received: { type: 'integer', required: true },
  },
  agent_stream_frame_too_large: { ...agentShared },
  agent_stream_limit: {
    ...agentShared,
    kind: { type: 'enum', required: true, values: ['text', 'cards', 'frames'] },
  },
  agent_stream_unknown_event: {
    ...agentShared,
    type: { type: 'string', required: true },
  },
};

export function read(path: string): string {
  const file = new URL(path, root);
  // 文件不存在时在测试体内断言失败，不能让 ENOENT 冒充先红。
  expect(existsSync(file), `缺少规格文件 ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function object(value: unknown, label = '值'): Obj {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Obj;
}

export function doc(): Obj {
  return object(parseYamlLite(read(eventsPath)), eventsPath);
}

export function events(): Obj {
  return object(doc()['events'], `${eventsPath} 的 events`);
}

export function event(name: string): Obj {
  const all = events();
  expect(Object.hasOwn(all, name), `${eventsPath} 的 events 缺少 ${name}`).toBe(true);
  return object(all[name], `events.${name}`);
}

export function fields(name: string): Obj {
  return object(event(name)['fields'], `events.${name}.fields`);
}

export function field(name: string, fieldName: string): Obj {
  const all = fields(name);
  expect(Object.hasOwn(all, fieldName), `events.${name}.fields 缺少 ${fieldName}`).toBe(true);
  return object(all[fieldName], `events.${name}.fields.${fieldName}`);
}

/** 断言 yaml 里的一个字段定义与预期形状一致（type、required，enum 时 values）。 */
export function expectFieldShape(name: string, fieldName: string, spec: FieldSpec): void {
  const def = field(name, fieldName);
  expect(def['type'], `${name}.${fieldName}.type`).toBe(spec.type);
  expect(def['required'], `${name}.${fieldName}.required`).toBe(spec.required);
  expect(def['required_when'], `${name}.${fieldName} 不用 required_when`).toBeUndefined();
  if (spec.values === undefined) {
    expect(def['values'], `${name}.${fieldName} 不是 enum`).toBeUndefined();
  } else {
    expect(Array.isArray(def['values']), `${name}.${fieldName}.values 必须是数组`).toBe(true);
    expect((def['values'] as unknown[]).map(String).sort(), `${name}.${fieldName}.values`).toEqual(
      [...spec.values].sort(),
    );
  }
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOk(def: Obj, value: unknown): boolean {
  switch (def['type']) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return (
        typeof value === 'string' && Array.isArray(def['values']) && def['values'].includes(value)
      );
    default:
      return false;
  }
}

function isRequired(def: Obj, payload: Obj): boolean {
  if (def['required'] === true) return true;
  const when = def['required_when'];
  if (!isObj(when)) return false;
  return Object.entries(when).some(([f, v]) => payload[f] === v);
}

/**
 * 按 events.yaml 文件头写明的结构（common_fields 加 events.<name>.fields；每个字段
 * {type, required | required_when, values?}）校验一条事件，只从 yaml 读规则。
 * 返回问题列表（空 = 通过），每条形如 `<字段>: missing` / `<字段>: wrong type` / `<字段>: not in spec`。
 */
export function validateEvent(name: string, payload: Obj): string[] {
  const common = object(doc()['common_fields'], 'common_fields');
  const own = fields(name);
  const spec: Obj = { ...common, ...own };
  const problems: string[] = [];
  for (const [fieldName, def] of Object.entries(spec)) {
    if (!isObj(def)) {
      problems.push(`${fieldName}: bad spec`);
      continue;
    }
    const present = Object.hasOwn(payload, fieldName) && payload[fieldName] !== undefined;
    if (!present) {
      if (isRequired(def, payload)) problems.push(`${fieldName}: missing`);
      continue;
    }
    if (!typeOk(def, payload[fieldName])) problems.push(`${fieldName}: wrong type`);
  }
  for (const fieldName of Object.keys(payload)) {
    if (!Object.hasOwn(spec, fieldName)) problems.push(`${fieldName}: not in spec`);
  }
  return problems;
}

/** 一条事件的公共字段（03 §4.7）；page 由样例给出。 */
export function commonPart(page: string): Obj {
  return {
    event_id: '01J9Z8Y7X6W5V4T3S2R1Q0P9N8',
    name: eventName,
    client_at: '2026-11-13T10:00:00+08:00',
    session_id: 'sess-1',
    device_id: 'dev-1',
    platform: 'ios',
    app_version: '1.0.0',
    page,
  };
}

/** 首页（配置化页面，03 §6.2）的卡片解码失败：带 page_version。 */
export function homeCardError(extra: Obj = {}): Obj {
  return {
    ...commonPart('home'),
    type: 'product_grid',
    version: 2,
    page_version: 17,
    reason: 'missing_field',
    schema_version: '2',
    bridge_version: '3',
    config_version: 'cfg-20261113-01',
    h5_release: 'unknown',
    ...extra,
  };
}

/** AI 助手页（03 §7.2）的卡片 data 解码失败：不是配置化页面，不带 page_version。 */
export function agentCardError(): Obj {
  return {
    ...commonPart('agent'),
    type: 'product_card',
    reason: 'type_mismatch',
    schema_version: '1',
    bridge_version: '3',
    config_version: 'cfg-20261113-01',
    h5_release: 'unknown',
  };
}

/** 去掉一个字段后的副本。 */
export function without(payload: Obj, fieldName: string): Obj {
  const copy: Obj = { ...payload };
  delete copy[fieldName];
  return copy;
}
