import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

// CT-13a（D10-1315 / D10-1330，C4 第三项）：specs/events.yaml 登记四个客户端 Agent 流诊断事件。
// 独立预期只来自 SPEC_REF ea7850e2f45f 上 规划/03 §4.7「agent_* 事件的字段」两张表、§4.7 诊断字段一条、
// §7.2 三条与编排者说明（version 递增、文件头 TODO 去掉 agent_*、agent_output_filtered 不登记）。
// 不从被测文件推导预期。
export type Obj = Record<string, unknown>;
export const root = new URL('../../../../', import.meta.url);
export const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const eventsPath = 'specs/events.yaml';

/** HEAD（本任务开始前）的 events.yaml version；本任务改动后必须大于它（文件头「每次改动递增」）。 */
export const baselineVersion = 2;

/** 03 §4.7：`agent_*` 目前只有这四个事件。 */
export const agentEvents = [
  'agent_stream_seq_gap',
  'agent_stream_frame_too_large',
  'agent_stream_limit',
  'agent_stream_unknown_event',
] as const;
export type AgentEvent = (typeof agentEvents)[number];

/** 03 §4.7 / 10 G-15：出站过滤在服务端做，不是客户端事件，不登记。 */
export const notRegistered = 'agent_output_filtered';

export type FieldSpec = {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  required: boolean;
  values?: readonly string[];
};

/** 03 §4.7「共有字段（四个事件都带）」表。 */
export const sharedFields: Readonly<Record<string, FieldSpec>> = {
  run_id: { type: 'string', required: false },
  message_id: { type: 'string', required: false },
  schema_version: { type: 'string', required: true },
  bridge_version: { type: 'string', required: true },
  config_version: { type: 'string', required: true },
  h5_release: { type: 'string', required: true },
};

/** 03 §4.7 诊断字段一条：四项必填，取不到时填固定值 "unknown"。 */
export const diagnosticFields = [
  'schema_version',
  'bridge_version',
  'config_version',
  'h5_release',
] as const;

/** 03 §4.7「各事件自己的字段」表。 */
export const ownFields: Readonly<Record<AgentEvent, Readonly<Record<string, FieldSpec>>>> = {
  agent_stream_seq_gap: {
    expected: { type: 'integer', required: true },
    received: { type: 'integer', required: true },
  },
  agent_stream_frame_too_large: {},
  agent_stream_limit: {
    kind: { type: 'enum', required: true, values: ['text', 'cards', 'frames'] },
  },
  agent_stream_unknown_event: {
    type: { type: 'string', required: true },
  },
};

/** 03 §4.7：四个事件不带的内容（card_id、用户原文、帧 data / delta、卡片内容、fallback_text）。 */
export const bannedFieldNames = [
  'card_id',
  'data',
  'delta',
  'text',
  'content',
  'fallback_text',
  'message',
  'input',
  'query',
] as const;

export function expectedFields(name: AgentEvent): Readonly<Record<string, FieldSpec>> {
  return { ...sharedFields, ...ownFields[name] };
}

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

/** 登记的事件条目：必须存在且是映射。 */
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

/** 文件头注释里的 TODO 段（TODO 那一行加其后缩进续行）。 */
export function headerTodo(): string {
  const lines = read(eventsPath).split('\n');
  const header: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    header.push(line);
  }
  const start = header.findIndex((line) => line.includes('TODO'));
  if (start < 0) return '';
  const block = [header[start] ?? ''];
  for (const line of header.slice(start + 1)) {
    if (!/^#\s{2,}\S/u.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}
