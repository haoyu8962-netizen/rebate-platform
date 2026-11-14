// CT-13n（FU-EVENTS-CONTRACT-STORED-TEXT，D10-1626）ingestEvents 说明照实改的契约测试共用件。
// 独立预期来自任务书第 9 节；静态读 contracts/openapi.yaml（仓库现成的 yaml-lite），不连库、不 listen。
import { expect } from 'vitest';
import { at, text, type Obj } from '../order-claims/kit.ts';

export { contract } from '../order-claims/kit.ts';
export type { Obj } from '../order-claims/kit.ts';

export const path = '/v1/events';
export const operationId = 'ingestEvents';

// 改动前（主干 75ba00a0a）ingestEvents 除 description 以外的全部字段，逐字照抄；本单只改说明文字。
export const operationShape: Obj = {
  operationId: 'ingestEvents',
  tags: ['events'],
  summary: 'Upload a batch of analytics events',
  'x-auth': 'optional',
  'x-signed': false,
  'x-idempotent': false,
  'x-min-version-gate': true,
  'x-error-codes': [20001, 10405],
  security: [{}, { bearerAuth: [] }],
  parameters: [
    { $ref: '#/components/parameters/AppId' },
    { $ref: '#/components/parameters/Platform' },
    { $ref: '#/components/parameters/AppVersion' },
    { $ref: '#/components/parameters/Build' },
    { $ref: '#/components/parameters/Channel' },
    { $ref: '#/components/parameters/TraceId' },
    { $ref: '#/components/parameters/DeviceId' },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/IngestEventsRequest' },
        example: {
          events: [
            {
              event_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a90',
              name: 'link_jump',
              client_at: '2026-11-13T10:00:00+08:00',
              session_id: 'example-session',
              device_id: 'example-device',
              platform: 'ios',
              app_version: '1.0.0',
              page: 'ProductDetail',
              phase: 'purchase',
              attempt_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a91',
              link_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a92',
              union_platform: 'taobao',
              step: 'sdk',
              result: 'requested',
              sdk_open_by: 'url',
              duration_ms: 120,
              installed: 'true',
            },
          ],
        },
      },
    },
  },
  responses: {
    '200': {
      description:
        'The batch is accepted (the client removes it from its queue); dropped_count events were non-conforming and dropped.',
      headers: { 'X-Trace-Id': { $ref: '#/components/headers/TraceId' } },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/IngestEventsResponse' },
          example: {
            code: 0,
            msg: '',
            data: { dropped_count: 0 },
            trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
          },
        },
      },
    },
    '429': { $ref: '#/components/responses/TooManyRequests' },
    '4XX': { $ref: '#/components/responses/ClientError' },
    '5XX': { $ref: '#/components/responses/ServerError' },
  },
};

// requestBody / responses 引用的三个组件，同样逐字照抄改动前的样子。
export const componentShapes: Obj = {
  IngestEventsRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        minItems: 0,
        maxItems: 100,
        description:
          'The events of the batch. Items are deliberately not constrained here; each one is checked against specs/events.yaml on its own and a non-conforming one is dropped and counted, never rejecting the batch.',
        items: {
          description:
            'One event as defined by specs/events.yaml (common fields plus the fields of its event).',
        },
      },
    },
  },
  IngestEventsData: {
    type: 'object',
    additionalProperties: false,
    required: ['dropped_count'],
    properties: {
      dropped_count: {
        type: 'integer',
        format: 'int32',
        minimum: 0,
        description:
          'Number of events of this batch that were non-conforming and dropped (0 when all conformed); duplicates are not counted.',
      },
    },
  },
  IngestEventsResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'msg', 'data', 'trace_id'],
    properties: {
      code: { $ref: '#/components/schemas/SuccessCode' },
      msg: { type: 'string' },
      data: { $ref: '#/components/schemas/IngestEventsData' },
      trace_id: { $ref: '#/components/schemas/TraceId' },
    },
  },
};

export function operation(doc: Obj): Obj {
  // 先断言路径存在，缺接口时只产生断言失败，不产生 TypeError。
  return at(doc, 'paths', path, 'post');
}

// 键排序后的 JSON：规范化序列化，键的书写顺序不影响比较。
export function canonical(value: unknown): string {
  function sort(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== 'object') return node;
    const source = node as Obj;
    const keys = Object.keys(source).toSorted();
    return Object.fromEntries(keys.map((key) => [key, sort(source[key])]));
  }
  return JSON.stringify(sort(value));
}

// 附带断言（任务书第 9 节第 4 条，主干上本来就绿）：除 description 外形状逐字不变。
export function shapeUnchanged(doc: Obj): void {
  const op = operation(doc);
  expect(op['operationId']).toBe(operationId);
  const { description: ignored, ...rest } = op;
  void ignored;
  expect(canonical(rest), 'ingestEvents 除 description 外的字段').toBe(canonical(operationShape));
  const schemas = at(doc, 'components', 'schemas');
  for (const [name, shape] of Object.entries(componentShapes)) {
    expect(canonical(at(schemas, name)), `components.schemas.${name}`).toBe(canonical(shape));
  }
}

// ingestEvents 的 description，去掉反引号、空白折成单个空格。
export function description(doc: Obj): string {
  return text(operation(doc)['description']).replaceAll('`', '').replaceAll(/\s+/gu, ' ');
}

// pattern 每处命中前后 radius 个字符的片段。
export function windows(value: string, pattern: RegExp, radius: number): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  return [...value.matchAll(global)].map((match) => {
    const start = match.index ?? 0;
    const end = start + (match[0] ?? '').length;
    return value.slice(Math.max(0, start - radius), end + radius);
  });
}
