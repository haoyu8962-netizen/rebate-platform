// CT-24zzi 标记 AI 举报已处理 adminHandleAgentReport 的契约形状（任务书第 9 节第 4 项；08 BR-ID-15
// 细则「举报的处理」）。独立预期，不从契约生成；静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  body,
  check,
  compile,
  contract,
  errorWith,
  field,
  list,
  missingRejected,
  object,
  resolve,
  response,
  text,
} from '../admin-order-actions/kit.ts';
import { closed, examples } from '../order-claims/kit.ts';
import {
  dataOf,
  descOf,
  fieldsList,
  handledReport,
  handlePath,
  listItem,
  notProbed,
  param,
  rawParams,
  reportRowKeys,
  reportsPath,
  someSentence,
  uuid1,
} from './kit.ts';

const request = { note: '已核对，答复口径已修正', expected_row_version: 1 };

it('[AC-CT-24zzi#27] 处理接口只有 X-Trace-Id 与必填路径参数 message_id；请求体必填、封闭，恰为 note 与 expected_row_version', () => {
  const doc = contract();
  const raws = rawParams(doc, handlePath, 'post');
  expect(raws).toContainEqual({ $ref: '#/components/parameters/TraceId' });
  const names = raws.map((raw) => text(resolve(doc, raw)['name']));
  expect(names.toSorted()).toEqual(['X-Trace-Id', 'message_id']);
  const id = param(doc, handlePath, 'post', 'message_id');
  expect(id).toMatchObject({ in: 'path', required: true });
  accepts(doc, resolve(doc, at(id, 'schema')), [uuid1], [1, null]);
  const schema = body(doc, handlePath);
  closed(schema, ['note', 'expected_row_version']);
  missingRejected(doc, schema, request, ['note', 'expected_row_version']);
  accepts(doc, schema, [request], [{ ...request, status: 'handled' }]);
});

it('[AC-CT-24zzi#28] note 至多 500 字、不可为空；expected_row_version 为非负整数；请求示例过 schema', () => {
  const doc = contract();
  const schema = body(doc, handlePath);
  const longest = '处'.repeat(500);
  accepts(doc, field(doc, schema, 'note'), ['x', longest], ['', `${longest}处`, null, 1]);
  accepts(doc, field(doc, schema, 'expected_row_version'), [0, 3], [-1, 1.5, '1', null]);
  const media = at(
    resolve(doc, at(doc, 'paths', handlePath, 'post', 'requestBody')),
    'content',
    'application/json',
  );
  const validate = compile(doc, schema);
  for (const sample of examples(doc, media)) check(validate, sample, true);
});

it('[AC-CT-24zzi#29] 描述：agent.report；note 去首尾空白后 1–500 字否则 20001 [note]；未知字段 20001；消息不存在、别的 app 或未被举报 → 20001 [message_id]（不探测）', () => {
  const desc = descOf(contract(), handlePath, 'post');
  expect(desc).toContain('agent.report');
  expect(desc).toMatch(/首尾空白|去空白|trim/i);
  expect(someSentence(desc, [/500/, /20001/, fieldsList('note')])).toBe(true);
  expect(
    someSentence(desc, [
      /未知字段|多余字段|未定义的?字段|unknown\s+fields?|undefined\s+fields?|additional\s+propert/i,
      /20001/,
    ]),
  ).toBe(true);
  expect(someSentence(desc, [/20001/, fieldsList('message_id')])).toBe(true);
  expect(desc).toMatch(/未被举报|没有被举报|未举报|not\s+(been\s+)?reported|never\s+reported/i);
  expect(desc).toMatch(/app/i);
  expect(desc).toMatch(notProbed);
});

it('[AC-CT-24zzi#30] 描述：待处理 → 已处理写 report_status=handled、处理人、处理时间与说明，row_version + 1；expected_row_version 不符或已是已处理 → 20902 data.resource=agent_report；无 Idempotency-Key（CAS）', () => {
  const desc = descOf(contract(), handlePath, 'post');
  expect(desc).toMatch(/report_status`?\s*=\s*`?handled/);
  for (const column of ['report_handler_id', 'report_handled_at', 'report_note'])
    expect(desc, column).toContain(column);
  expect(desc).toMatch(/row_version`?\s*(\+\s*1|加\s*1|递增|增加|自增|increment|bump)/i);
  expect(desc).toContain('expected_row_version');
  expect(someSentence(desc, [/20902/, /data\.resource`?\s*(=|为|is|:)\s*`?agent_report\b/i])).toBe(
    true,
  );
  expect(
    someSentence(desc, [
      /(已是|已经是|已经)\s*(已)?处理|已处理过|already\s+(been\s+)?handled/i,
      /20902/,
    ]),
  ).toBe(true);
  // CAS 大小写敏感、带词界（不让 badcase / use case 误中）；只有英文短语忽略大小写。
  expect(/\bCAS\b/.test(desc) || /compare[- ]and[- ]set/i.test(desc), 'CAS').toBe(true);
  expect(desc).toMatch(/(无|不需要?|不用|不设|没有|no|without)\s*`?Idempotency-Key/i);
});

it('[AC-CT-24zzi#31] 描述：写一条审计 agent_report_handle（前后值为状态与说明，不含消息文本）；超时后照样可以标已处理', () => {
  const desc = descOf(contract(), handlePath, 'post');
  const auditWord = /agent_report_handle|审计|audit/i;
  expect(desc).toMatch(/agent_report_handle/);
  expect(desc).toMatch(/BR-ID-15/);
  expect(
    someSentence(desc, [
      auditWord,
      /(不含|不包含|不带|不记|without|excludes?|not\s+(include|contain)s?|never\s+(include|contain)s?|no)[^。；;\n]{0,20}?(消息文本|消息正文|消息内容|对话内容|message\s+text|the\s+text)/i,
    ]),
  ).toBe(true);
  expect(someSentence(desc, [auditWord, /前后值|before|old/i])).toBe(true);
  expect(
    someSentence(desc, [
      /超时|overdue|48/i,
      /照样|仍(然)?(可|能|可以)|也(可|能|可以)|不拒|不会被?拒|still|not\s+rejected|never\s+rejected/i,
    ]),
  ).toBe(true);
});

it('[AC-CT-24zzi#32] 成功响应的 data 是该举报行，与举报列表的行同形（13 个字段封闭）；200 示例为已处理且未超时', () => {
  const doc = contract();
  const data = dataOf(doc, handlePath, 'post');
  closed(data, reportRowKeys);
  closed(listItem(doc, reportsPath), reportRowKeys);
  accepts(doc, data, [handledReport], [{ ...handledReport, extra: 1 }]);
  const media = at(
    resolve(doc, at(doc, 'paths', handlePath, 'post', 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, handlePath));
  const samples = examples(doc, media);
  for (const sample of samples) {
    check(validate, sample, true);
    const row = object(at(sample, 'data'));
    expect(row['report_status']).toBe('handled');
    expect(row['overdue']).toBe(false);
    expect(row['handler_id']).toBeTypeOf('string');
    expect(row['handled_at']).toBeTypeOf('string');
  }
  expect(list(samples).length).toBeGreaterThan(0);
});

it('[AC-CT-24zzi#33] 错误示例：20001 data.fields=[note]、20001 data.fields=[message_id]、20902 data.resource=agent_report', () => {
  const doc = contract();
  errorWith(doc, handlePath, 20001, { fields: ['note'] });
  errorWith(doc, handlePath, 20001, { fields: ['message_id'] });
  errorWith(doc, handlePath, 20902, { resource: 'agent_report' });
});
