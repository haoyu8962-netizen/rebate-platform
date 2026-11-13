import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

// CT-13c（D10-1377 / D10-1381）：specs/events.yaml 的 sdui_card_error、bridge_call 补 03 §4.7 四项诊断字段。
// 独立预期只来自 SPEC_REF 62b5c99338f8 上 规划/03 §4.7「诊断字段」一条（agent_*、bridge_call、sdui_card_error
// 另带 schema_version / bridge_version / config_version / h5_release，四项必填，取不到填固定值 "unknown"）、
// §6.2 / §7.2（sdui_card_error 原有字段）、§5.3（bridge_call 原有字段）与编排说明 D10-1381
// （version 递增、其他事件不动、写法照 CT-13a）。不从被测文件推导预期。
// validateEvent 照抄 test/spec/contracts/sdui-card-error-page-version/kit.ts（已合并的规则测试，不改它）。
export type Obj = Record<string, unknown>;
export const root = new URL('../../../../', import.meta.url);
export const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const eventsPath = 'specs/events.yaml';
export const cardError = 'sdui_card_error';
export const bridgeCall = 'bridge_call';
export const targetEvents = [cardError, bridgeCall] as const;
export type TargetEvent = (typeof targetEvents)[number];

/** HEAD（本任务开始前，主干 964f4f522）的 events.yaml version；本任务改动后必须大于它（文件头「每次改动递增」）。 */
export const baselineVersion = 4;

/** 03 §4.7 诊断字段一条：四项必填 string，所在层不存在或尚未取到时填固定值 "unknown"。 */
export const diagnosticFields = [
  'schema_version',
  'bridge_version',
  'config_version',
  'h5_release',
] as const;
export type DiagnosticField = (typeof diagnosticFields)[number];

export type FieldSpec = {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  required?: boolean;
  required_when?: Readonly<Record<string, string>>;
  values?: readonly string[];
};

/** 诊断字段的形状：必填 string，不是 enum，不用 required_when。 */
export const diagnosticSpec: FieldSpec = { type: 'string', required: true };

/** 两个事件原有的字段（本单照旧）：sdui_card_error 见 03 §6.2 / §7.2（page_version 可选，CT-13b），bridge_call 见 03 §5.3。 */
export const originalFields: Readonly<Record<TargetEvent, Readonly<Record<string, FieldSpec>>>> = {
  sdui_card_error: {
    type: { type: 'string', required: true },
    version: { type: 'integer', required: false },
    page_version: { type: 'integer', required: false },
    reason: { type: 'string', required: true },
  },
  bridge_call: {
    method: { type: 'string', required: true },
    code: { type: 'integer', required: true },
  },
};

/** 本单之后两事件的完整字段：原有字段加四项诊断字段，不多不少。 */
export function expectedFields(name: TargetEvent): Readonly<Record<string, FieldSpec>> {
  const diag: Record<string, FieldSpec> = {};
  for (const fieldName of diagnosticFields) diag[fieldName] = diagnosticSpec;
  return { ...originalFields[name], ...diag };
}

/** 本单不动的其他事件（抽查）：四个 agent_stream_*（03 §4.7 两张表，CT-13a）与 link_jump（主干 964f4f522 的形状）。 */
const agentShared: Readonly<Record<string, FieldSpec>> = {
  run_id: { type: 'string', required: false },
  message_id: { type: 'string', required: false },
  schema_version: { type: 'string', required: true },
  bridge_version: { type: 'string', required: true },
  config_version: { type: 'string', required: true },
  h5_release: { type: 'string', required: true },
};
const unionPlatforms = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];
const purchase = { phase: 'purchase' };
export const untouchedEvents: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
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
  link_jump: {
    phase: { type: 'enum', required: true, values: ['purchase', 'startup'] },
    attempt_id: { type: 'string', required_when: purchase },
    link_id: { type: 'string', required_when: purchase },
    union_platform: { type: 'enum', required: true, values: unionPlatforms },
    step: {
      type: 'enum',
      required: true,
      values: ['sdk', 'scheme', 'universal_link', 'h5', 'copy_tpwd'],
    },
    result: {
      type: 'enum',
      required: true,
      values: ['requested', 'failed', 'unknown'],
    },
    failure_reason: {
      type: 'enum',
      required_when: { result: 'failed' },
      values: ['sdk_init_failed', 'step_failed'],
    },
    sdk_open_by: { type: 'enum', required: false, values: ['url', 'code'] },
    sdk_error_code: { type: 'string', required: false },
    duration_ms: { type: 'integer', required_when: purchase },
    installed: { type: 'enum', required_when: purchase, values: ['true', 'false', 'unknown'] },
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

/** 断言 yaml 里的一个字段定义与预期形状一致（type、required / required_when，enum 时 values）。 */
export function expectFieldShape(name: string, fieldName: string, spec: FieldSpec): void {
  const def = field(name, fieldName);
  const label = `${name}.${fieldName}`;
  expect(def['type'], `${label}.type`).toBe(spec.type);
  expect(def['required'], `${label}.required`).toBe(spec.required);
  if (spec.required_when === undefined) {
    expect(def['required_when'], `${label} 不用 required_when`).toBeUndefined();
  } else {
    expect(def['required_when'], `${label}.required_when`).toEqual(spec.required_when);
  }
  if (spec.values === undefined) {
    expect(def['values'], `${label} 不是 enum`).toBeUndefined();
  } else {
    expect(Array.isArray(def['values']), `${label}.values 必须是数组`).toBe(true);
    expect((def['values'] as unknown[]).map(String).sort(), `${label}.values`).toEqual(
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

/** 一条事件的公共字段（03 §4.7）。 */
export function commonPart(name: string, page: string): Obj {
  return {
    event_id: '01J9Z8Y7X6W5V4T3S2R1Q0P9N8',
    name,
    client_at: '2026-11-13T10:00:00+08:00',
    session_id: 'sess-1',
    device_id: 'dev-1',
    platform: 'ios',
    app_version: '1.0.0',
    page,
  };
}

/** 四项诊断字段都取到的样例值。 */
export function diagnostics(schemaVersion: string): Obj {
  return {
    schema_version: schemaVersion,
    bridge_version: '3',
    config_version: 'cfg-20261113-01',
    h5_release: 'h5-2026.11.13-1',
  };
}

/** 四项诊断字段都取不到时：全部填固定值 "unknown"（03 §4.7）。 */
export function unknownDiagnostics(): Obj {
  const out: Obj = {};
  for (const fieldName of diagnosticFields) out[fieldName] = 'unknown';
  return out;
}

/** 首页（配置化页面，03 §6.2）卡片解码失败：带 page_version；schema_version 是卡片自带 version 转成的字符串（D10-1381）。 */
export function homeCardError(extra: Obj = {}): Obj {
  return {
    ...commonPart(cardError, 'home'),
    type: 'product_grid',
    version: 2,
    page_version: 17,
    reason: 'missing_field',
    ...diagnostics('2'),
    h5_release: 'unknown',
    ...extra,
  };
}

/** AI 助手页（03 §7.2）卡片 data 解码失败：不带 page_version；schema_version 是该卡 schema_version 转成的字符串。 */
export function agentCardError(extra: Obj = {}): Obj {
  return {
    ...commonPart(cardError, 'agent'),
    type: 'product_card',
    reason: 'type_mismatch',
    ...diagnostics('1'),
    h5_release: 'unknown',
    ...extra,
  };
}

/** 正是因为取不到卡片版本而解码失败：不带 version，schema_version 填 "unknown"（D10-1381）。 */
export function versionlessCardError(): Obj {
  return without(
    homeCardError({ schema_version: 'unknown', reason: 'missing_version' }),
    'version',
  );
}

/** JSBridge 调用被拒（03 §5.3）；schema_version 是调用方所依据的 bridge.schema.json 顶层 version 转成的字符串。 */
export function bridgeCallEvent(extra: Obj = {}): Obj {
  return {
    ...commonPart(bridgeCall, 'h5_activity'),
    method: 'track.event',
    code: 90002,
    ...diagnostics('5'),
    ...extra,
  };
}

/** 去掉一个字段后的副本。 */
export function without(payload: Obj, fieldName: string): Obj {
  const copy: Obj = { ...payload };
  delete copy[fieldName];
  return copy;
}
