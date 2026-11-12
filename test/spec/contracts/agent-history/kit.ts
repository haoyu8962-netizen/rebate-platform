import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
export type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

export const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
export const testRequire = createRequire(import.meta.url);
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const historyPath = '/v1/agent/sessions/{id}/messages';
export const feedbackPath = '/v1/agent/messages/{message_id}/feedback';
export const reportPath = '/v1/agent/messages/{message_id}/report';
export type Endpoint = readonly ['get' | 'post', string, string];
export const historyEndpoint: Endpoint = ['get', historyPath, 'listAgentSessionMessages'];
export const endpoints: readonly Endpoint[] = [
  ['post', feedbackPath, 'setAgentMessageFeedback'],
  ['post', reportPath, 'reportAgentMessage'],
];

// 每次取字段先断言：缺接口或字段只能报 AssertionError，不能报 TypeError。
export function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

export function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) {
    expect(current, `缺少契约字段 ${keys.join('.')}`).toHaveProperty(key);
    current = object(current[key]);
  }
  return current;
}

export function list(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

export function text(value: unknown): string {
  expect(value).toBeTypeOf('string');
  return value as string;
}

let document: Promise<unknown> | undefined;
export async function contract(): Promise<Obj> {
  document ??= dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  return object(await document);
}

export function operation(doc: Obj, method: string, path: string): Obj {
  return at(doc, 'paths', path, method);
}

export function parameters(doc: Obj, method: string, path: string): Obj[] {
  const op = operation(doc, method, path);
  return [...list(at(doc, 'paths', path)['parameters'] ?? []), ...list(op['parameters'] ?? [])].map(
    object,
  );
}

export function jsonResponse(op: Obj): Obj {
  const content = at(op, 'responses', '200', 'content');
  expect(Object.keys(content)).toEqual(['application/json']);
  return at(content, 'application/json');
}

export function historyMedia(doc: Obj): Obj {
  return jsonResponse(operation(doc, 'get', historyPath));
}

export function messageSchema(doc: Obj): Obj {
  return at(historyMedia(doc), 'schema', 'properties', 'data', 'properties', 'items', 'items');
}

export function closed(schema: Obj, keys: string[]): void {
  expect(schema['type']).toBe('object');
  expect(schema['additionalProperties']).toBe(false);
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual(keys.toSorted());
  expect(list(schema['required']).toSorted()).toEqual(keys.toSorted());
}

export function compile(schema: Obj): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  let validate: Validator | undefined;
  expect(() => {
    validate = ajv.compile(schema);
  }, 'schema 必须能由 Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate!;
}

export function check(validate: Validator, value: unknown, expected: boolean): void {
  const actual = validate(value);
  expect(actual, JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

export function examples(media: Obj): unknown[] {
  const values: unknown[] = [];
  if (Object.hasOwn(media, 'example')) values.push(media['example']);
  if (Object.hasOwn(media, 'examples')) {
    for (const example of Object.values(object(media['examples']))) {
      const entry = object(example);
      expect(entry).toHaveProperty('value');
      values.push(entry['value']);
    }
  }
  expect(values.length, '至少一个内联示例').toBeGreaterThan(0);
  return values;
}

export function yaml(path: string): Obj {
  return object(parseYamlLite(readFileSync(new URL(path, root), 'utf8')));
}

export function opsEnums(): Obj {
  return at(yaml('contracts/enums/ops.yaml'), 'enums');
}

export function finishReasons(): string[] {
  const values = Object.keys(at(opsEnums(), 'agent_finish_reason', 'values'));
  expect(values.length).toBeGreaterThan(0);
  return values;
}

export function envelope(data: unknown): Obj {
  return { code: 0, msg: '', data, trace_id: '019a0000-0000-7000-8000-000000000002' };
}

export const message = {
  message_id: '019a0000-0000-7000-8000-000000000001',
  role: 'assistant',
  created_at: '2026-10-14T10:00:00+08:00',
  text: '',
  cards: [],
  finish_reason: null,
};

export function streamDefinition(name: string): Validator {
  const stream = object(
    JSON.parse(readFileSync(new URL('contracts/agent-stream.schema.json', root), 'utf8')),
  );
  const defs = at(stream, '$defs');
  at(defs, name);
  return compile({ $defs: defs, $ref: `#/$defs/${name}` });
}

// 包括内嵌商品卡；同一示例内所有 card_id 共用一个命名空间。
export function visitKeys(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitKeys(item, visit);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      visitKeys(child, visit);
    }
  }
}
