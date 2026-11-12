// CT-24zzi 后台 Agent 留痕查询与 AI 举报处理（资源 agent-traces，D1，planned）的契约登记。
// 独立预期来自任务书第 9 节（编排 D10-1287 ⑤）与 08 BR-ID-15「举报的处理」、BR-AI-19、BR-AI-22、
// 04 §3.2 agent_* 表；不从契约生成。全部静态读 contracts 与 specs，不连库、不 listen。
import { expect } from 'vitest';
import {
  at,
  list,
  object,
  op,
  resolve,
  response,
  text,
  yaml,
  type Obj,
} from '../admin-order-actions/kit.ts';

export const tag = 'admin-agent-traces';
export const sessionsPath = '/admin/v1/agent-traces/sessions';
export const sessionPath = '/admin/v1/agent-traces/sessions/{session_id}';
export const reportsPath = '/admin/v1/agent-traces/reports';
export const handlePath = '/admin/v1/agent-traces/reports/{message_id}/handle';

// [method, path, operationId, 权限点, 恰有的错误码]
export const routes = [
  ['get', sessionsPath, 'adminListAgentSessions', 'agent.trace', [10001, 10403, 20001]],
  ['get', sessionPath, 'adminGetAgentSession', 'agent.trace', [10001, 10403, 20001]],
  ['get', reportsPath, 'adminListAgentReports', 'agent.trace', [10001, 10403, 20001]],
  ['post', handlePath, 'adminHandleAgentReport', 'agent.report', [10001, 10403, 20001, 20902]],
] as const;

export const uuid1 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a01';
export const uuid2 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a02';
export const uuid3 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a03';
export const goodTimes = ['2026-09-29T10:00:00+08:00', '2026-09-29T02:00:00Z'];
export const badTimes = ['2026-09-29', '2026-09-29 10:00:00', 'yesterday', 1];

// 会话列表行（任务书第 9 节第 1 项）。
export const sessionRowKeys = [
  'session_id',
  'user_id',
  'started_at',
  'last_active_at',
  'expired',
  'run_count',
  'badcase_count',
  'report_count',
];
export const guestSessionRow = {
  session_id: uuid1,
  user_id: null,
  started_at: '2026-09-29T09:50:00+08:00',
  last_active_at: '2026-09-29T10:05:00+08:00',
  expired: false,
  run_count: 2,
  badcase_count: 0,
  report_count: 1,
};
export const memberSessionRow = {
  ...guestSessionRow,
  session_id: uuid2,
  user_id: uuid3,
  expired: true,
  badcase_count: 1,
  report_count: 0,
};

// 单会话明细（任务书第 9 节第 2 项）。
export const headerKeys = ['session_id', 'user_id', 'started_at', 'last_active_at', 'expired'];
export const messageKeys = [
  'message_id',
  'role',
  'text',
  'card_ids',
  'feedback',
  'badcase',
  'reported_at',
  'report_reason',
  'report_status',
  'report_note',
];
export const runKeys = [
  'run_id',
  'intent',
  'model',
  'model_snapshot',
  'prompt_version',
  'input_tokens',
  'output_tokens',
  'cost_mfen',
  'ttft_ms',
  'latency_ms',
  'finish_reason',
  'filter_hits',
  'accepted_at',
  'ended_at',
];
export const toolCallKeys = ['run_id', 'seq', 'name', 'args', 'status', 'latency_ms'];
export const run = {
  run_id: uuid2,
  intent: 'order_query',
  model: 'qwen-plus',
  model_snapshot: 'qwen-plus-2026-09-01',
  prompt_version: 'p-2026-11-01',
  input_tokens: 1200,
  output_tokens: 300,
  cost_mfen: 4500,
  ttft_ms: 800,
  latency_ms: 3200,
  finish_reason: 'stop',
  filter_hits: [],
  accepted_at: '2026-09-29T10:00:00+08:00',
  ended_at: '2026-09-29T10:00:03+08:00',
};
// 无模型降级或仍在跑的 run：可空的列为 null（04 §3.2）。
export const bareRun = {
  ...run,
  intent: null,
  model: null,
  model_snapshot: null,
  input_tokens: null,
  output_tokens: null,
  cost_mfen: null,
  ttft_ms: null,
  latency_ms: null,
  finish_reason: null,
  ended_at: null,
};
export const toolCall = {
  run_id: uuid2,
  seq: 1,
  name: 'order_lookup',
  args: { order_no: '2310****7890' },
  status: 'ok',
  latency_ms: 120,
};

// 举报列表行（任务书第 9 节第 3 项）；处理接口的成功响应同形（第 4 项）。
export const reportRowKeys = [
  'message_id',
  'session_id',
  'user_id',
  'reported_at',
  'report_reason',
  'report_status',
  'deadline_at',
  'overdue',
  'handled_at',
  'handler_id',
  'handler_name',
  'report_note',
  'row_version',
];
// 例：9-29 10:00 举报，最迟 10-01 10:00 前须标为已处理（08 BR-ID-15）。
export const pendingReport = {
  message_id: uuid1,
  session_id: uuid2,
  user_id: null,
  reported_at: '2026-09-29T10:00:00+08:00',
  report_reason: '回答内容与事实不符',
  report_status: 'pending',
  deadline_at: '2026-10-01T10:00:00+08:00',
  overdue: true,
  handled_at: null,
  handler_id: null,
  handler_name: null,
  report_note: null,
  row_version: 1,
};
export const handledReport = {
  ...pendingReport,
  user_id: uuid3,
  report_status: 'handled',
  overdue: false,
  handled_at: '2026-10-01T11:00:00+08:00',
  handler_id: uuid3,
  handler_name: '运营小王',
  report_note: '已核对，答复口径已修正',
  row_version: 2,
};

// 不得出现在响应字段名里的标识：设备标识、手机号、app_id、原文 user_text、user_hash。
export const forbiddenKey = /device|phone|mobile|app_?id|user_text|raw|original|hash/i;

export function rawParams(doc: Obj, path: string, method: string): Obj[] {
  const pathItem = at(doc, 'paths', path);
  return [
    ...list(pathItem['parameters'] ?? []),
    ...list(op(doc, path, method)['parameters'] ?? []),
  ].map(object);
}

export function param(doc: Obj, path: string, method: string, name: string): Obj {
  const matches = rawParams(doc, path, method)
    .map((raw) => resolve(doc, raw))
    .filter((entry) => entry['name'] === name);
  expect(matches, `参数 ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function paramSchema(doc: Obj, path: string, method: string, name: string): Obj {
  return resolve(doc, at(param(doc, path, method, name), 'schema'));
}

export function descOf(doc: Obj, path: string, method: string): string {
  return text(op(doc, path, method)['description']);
}

export function dataOf(doc: Obj, path: string, method: string): Obj {
  return resolve(doc, at(response(doc, path, method), 'properties', 'data'));
}

export function listItem(doc: Obj, path: string): Obj {
  return resolve(doc, at(dataOf(doc, path, 'get'), 'properties', 'items', 'items'));
}

// 数组字段的元素 schema。
export function arrayItem(doc: Obj, schema: Obj, name: string): Obj {
  const property = resolve(doc, at(schema, 'properties', name));
  expect(property['type'], name).toBe('array');
  return resolve(doc, at(property, 'items'));
}

// 会话头：可以平铺在 data 上，也可以放在 data.session 里。
export function sessionHeader(doc: Obj): Obj {
  const data = dataOf(doc, sessionPath, 'get');
  const properties = at(data, 'properties');
  return properties['session'] === undefined ? data : resolve(doc, properties['session']);
}

export function permissionEntry(key: string): Obj {
  const all = list(yaml('specs/permissions.yaml')['permissions']).map(object);
  const entries = all.filter((entry) => entry['key'] === key);
  expect(entries, key).toHaveLength(1);
  return entries[0]!;
}

// 展开后的 schema 里所有 properties 的键名（不看描述文字）。
export function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Obj;
  const own =
    node['properties'] !== null && typeof node['properties'] === 'object'
      ? Object.keys(node['properties'] as Obj)
      : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

// 描述按句切开（中文句号、分号、换行、英文句末「. 」）；`data.fields` 里的点不切。
export function sentences(desc: string): string[] {
  return desc
    .split(/[。；;\n]|\.\s/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// 至少有一句同时满足全部模式。
export function someSentence(desc: string, patterns: RegExp[]): boolean {
  return sentences(desc).some((part) => patterns.every((pattern) => pattern.test(part)));
}

// 描述措辞的宽松模式（中文或英文都可）。
export const readOnly = /只读|read[- ]only/i;
export const noStepUp =
  /(无|不需要?|不设|没有)\s*`?step-up|no\s+`?step-up|without\s+`?step-up|step-up`?\s*(不需要|无)/i;
export const noAudit =
  /(不写|不记|不留|不产生|不落)\s*审计|(does not|doesn't|never|not)\s+(write|record|create)s?\s+(an?\s+)?audit|no\s+audit/i;
export const notProbed =
  /不探测|不(加)?区分|无法区分|同一(个)?错误|(never|not)\s+(be\s+)?told\s+apart|indistinguishable|no\s+probing|not\s+distinguish|same\s+(error|answer|response)/i;

export function fieldsList(name: string): RegExp {
  return new RegExp(
    `data\\.fields\`?\\s*(?:=|为|恰为|is|:)?\\s*\`?\\s*\\[\\s*["'\`]?${name}["'\`]?\\s*\\]`,
    'i',
  );
}

// 区间边界：from 紧跟「含 / inclusive」，to 紧跟「不含 / exclusive」；from 不早于 to → 20001 [from, to]。
export function expectRange(desc: string, column: string): void {
  expect(desc).toContain(column);
  // 期望写法：`from`（含）、`to`（不含），或 `from` (inclusive)、`to` (exclusive)；写反的一律不行。
  expect(desc).toMatch(/`from`\s*(?:[(（]\s*(?:inclusive|含|包含)\s*[)）]|is\s+inclusive)/i);
  expect(desc).toMatch(/`to`\s*(?:[(（]\s*(?:exclusive|不含|不包含)\s*[)）]|is\s+exclusive)/i);
  expect(desc).not.toMatch(/\bfrom`?\s*[(（]\s*(?:exclusive|不含|不包含)/i);
  expect(desc).not.toMatch(/\bto`?\s*[(（]\s*(?:inclusive|含|包含)\s*[)）]/i);
  const notBefore =
    /`?from`?\s*(?:>=|≥|不早于|is\s+not\s+(?:earlier\s+than|before)|not\s+(?:earlier\s+than|before))\s*`?to`?/i;
  const exactFields =
    /data\.fields`?\s*(?:=|为|恰为|is|:)?\s*`?\s*\[\s*["'`]?from["'`]?\s*,\s*["'`]?to["'`]?\s*\]/i;
  expect(someSentence(desc, [notBefore, /20001/, exactFields])).toBe(true);
}
