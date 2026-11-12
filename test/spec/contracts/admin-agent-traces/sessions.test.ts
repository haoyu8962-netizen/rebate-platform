// CT-24zzi 会话留痕列表 adminListAgentSessions 与单会话明细 adminGetAgentSession 的契约形状
// （任务书第 9 节第 1、2 项；08 BR-AI-19、BR-AI-20、BR-AI-22；04 §3.2）。
// 独立预期，不从契约生成；静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  check,
  compile,
  contract,
  enumField,
  errorExamples,
  expand,
  field,
  list,
  missingRejected,
  object,
  resolve,
  response,
  text,
  type Obj,
} from '../admin-order-actions/kit.ts';
import { closed, examples } from '../order-claims/kit.ts';
import {
  arrayItem,
  badTimes,
  bareRun,
  dataOf,
  descOf,
  expectRange,
  fieldsList,
  forbiddenKey,
  goodTimes,
  guestSessionRow,
  headerKeys,
  listItem,
  memberSessionRow,
  messageKeys,
  noAudit,
  notProbed,
  param,
  paramSchema,
  propertyNames,
  rawParams,
  readOnly,
  run,
  runKeys,
  sessionHeader,
  sessionPath,
  sessionRowKeys,
  sessionsPath,
  sentences,
  someSentence,
  toolCall,
  toolCallKeys,
  uuid1,
  uuid2,
  uuid3,
} from './kit.ts';

const listQuery = [
  'page',
  'page_size',
  'user_id',
  'session_id',
  'from',
  'to',
  'badcase',
  'reported',
];

// 布尔筛选：可以是 boolean，也可以是 "true" / "false" 字符串；别的值一律拒。
function booleanFilter(doc: Obj, schema: Obj, name: string): void {
  const validate = compile(doc, schema);
  const asBoolean = validate(true) && validate(false);
  const asString = validate('true') && validate('false');
  expect(asBoolean || asString, name).toBe(true);
  for (const bad of ['yes', '', 2, null, {}]) check(validate, bad, false);
}

// 「pii.* 不解开任何东西」的否定式（中文或英文）。
const piiNoReveal =
  /不解开|不会?(显示|返回|展示)原文|恒为脱敏|始终(是|为)?脱敏|always\s+masked|never\s+unmask/i;
// 「显示原文」类字眼；不用 reveal，免得权限点名 pii.reveal_phone 自己误中。
const rawWord = /原文|明文|完整(的)?手机号|\braw\b|\boriginal\b|unmask|full\s+phone/i;
const negation = /不|未|无|没|非|never|\bnot\b|\bno\b|n't|without|always\s+masked/i;

// 把描述切到分句（句号、分号、逗号、顿号），挑出同时提到 pii.* 与原文却没有否定词的分句。
function piiRevealClauses(desc: string): string[] {
  return sentences(desc)
    .flatMap((part) => part.split(/[，,、]/))
    .map((part) => part.trim())
    .filter((part) => /pii\./.test(part) && rawWord.test(part) && !negation.test(part));
}

function message(doc: Obj): Obj {
  return arrayItem(doc, dataOf(doc, sessionPath, 'get'), 'messages');
}

const userMessage = {
  message_id: uuid1,
  role: 'user',
  text: '我的订单 2310****7890 怎么还没到账',
  card_ids: [],
  feedback: null,
  badcase: false,
  reported_at: null,
  report_reason: null,
  report_status: null,
  report_note: null,
};
const reportedReply = {
  message_id: uuid2,
  role: 'assistant',
  text: '这笔订单预计 10 月 15 日结算。',
  card_ids: ['c1', 'c2'],
  feedback: 'down',
  badcase: true,
  reported_at: '2026-09-29T10:00:00+08:00',
  report_reason: '回答内容与事实不符',
  report_status: 'handled',
  report_note: '已核对，答复口径已修正',
};
// 账号注销后消息文本置空、行保留（BR-AI-22）。
const erasedMessage = { ...userMessage, message_id: uuid3, text: null };

it('[AC-CT-24zzi#7] 会话列表参数恰为 X-Trace-Id、page、page_size、user_id、session_id、from、to、badcase、reported，前三个引用现有组件，筛选都可选', () => {
  const doc = contract();
  const raws = rawParams(doc, sessionsPath, 'get');
  for (const name of ['TraceId', 'AdminPage', 'AdminPageSize'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  const names = raws.map((raw) => text(resolve(doc, raw)['name']));
  expect(names.toSorted()).toEqual(['X-Trace-Id', ...listQuery].toSorted());
  for (const name of listQuery) {
    const entry = param(doc, sessionsPath, 'get', name);
    expect(entry['in'], name).toBe('query');
    expect([undefined, false], name).toContain(entry['required']);
  }
  for (const name of ['user_id', 'session_id'])
    accepts(doc, paramSchema(doc, sessionsPath, 'get', name), [uuid1], [1, null, {}]);
  for (const name of ['badcase', 'reported'])
    booleanFilter(doc, paramSchema(doc, sessionsPath, 'get', name), name);
  for (const name of ['from', 'to']) {
    const schema = paramSchema(doc, sessionsPath, 'get', name);
    expect(schema['format'], name).toBe('date-time');
    accepts(doc, schema, goodTimes, badTimes);
  }
});

it('[AC-CT-24zzi#8] 会话列表描述：agent.trace 只读、列表不写审计；from（含）/ to（不含）按 started_at，from 不早于 to → 20001 [from, to]；按 started_at 倒序；游客会话 user_id 为 null', () => {
  const desc = descOf(contract(), sessionsPath, 'get');
  expect(desc).toContain('agent.trace');
  expect(desc).toMatch(readOnly);
  expect(desc).toMatch(noAudit);
  expectRange(desc, 'started_at');
  expect(desc).toMatch(/started_at`?\s*(降序|倒序|desc)/i);
  expect(desc).not.toMatch(/started_at`?\s*(升序|正序|asc)/i);
  expect(desc).toMatch(/badcase/);
  expect(desc).toMatch(/举报|report/i);
  expect(desc).toMatch(/游客|guest/i);
  expect(desc).toMatch(/user_id`?[^。]{0,40}?null/);
});

it('[AC-CT-24zzi#9] 会话列表 200 是后台分页信封，行封闭且恰为 8 个字段、全部 required，不含设备标识、手机号与消息文本', () => {
  const doc = contract();
  const data = dataOf(doc, sessionsPath, 'get');
  expect(list(data['required'])).toEqual(
    expect.arrayContaining(['items', 'page', 'page_size', 'total']),
  );
  accepts(
    doc,
    data,
    [{ items: [guestSessionRow, memberSessionRow], page: 1, page_size: 20, total: 2 }],
    [{ items: [guestSessionRow], page: 1, page_size: 20 }],
  );
  const row = listItem(doc, sessionsPath);
  closed(row, sessionRowKeys);
  missingRejected(doc, row, memberSessionRow, sessionRowKeys);
  accepts(doc, field(doc, row, 'user_id'), [null, uuid3], [1, {}]);
  accepts(doc, field(doc, row, 'expired'), [true, false], ['true', null]);
  for (const name of ['started_at', 'last_active_at'])
    accepts(doc, field(doc, row, name), goodTimes, [...badTimes, null]);
  for (const name of ['run_count', 'badcase_count', 'report_count'])
    accepts(doc, field(doc, row, name), [0, 3], [-1, 1.5, '1', null]);
  const names = propertyNames(expand(doc, response(doc, sessionsPath, 'get')));
  expect(names.filter((name) => forbiddenKey.test(name))).toEqual([]);
  expect(names).not.toContain('text');
});

it('[AC-CT-24zzi#10] 会话列表 200 示例过 schema，含一条游客会话（user_id null）与一条登录用户会话', () => {
  const doc = contract();
  const media = at(
    resolve(doc, at(doc, 'paths', sessionsPath, 'get', 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, sessionsPath, 'get'));
  const samples = examples(doc, media);
  for (const sample of samples) check(validate, sample, true);
  const items = samples.flatMap((sample) => list(at(sample, 'data')['items']).map(object));
  expect(items.some((entry) => entry['user_id'] === null)).toBe(true);
  expect(items.some((entry) => typeof entry['user_id'] === 'string')).toBe(true);
});

it('[AC-CT-24zzi#11] 单会话明细只有 X-Trace-Id 与必填路径参数 session_id，无请求体', () => {
  const doc = contract();
  const raws = rawParams(doc, sessionPath, 'get');
  expect(raws).toContainEqual({ $ref: '#/components/parameters/TraceId' });
  const names = raws.map((raw) => text(resolve(doc, raw)['name']));
  expect(names.toSorted()).toEqual(['X-Trace-Id', 'session_id']);
  const id = param(doc, sessionPath, 'get', 'session_id');
  expect(id).toMatchObject({ in: 'path', required: true });
  accepts(doc, resolve(doc, at(id, 'schema')), [uuid1], [1, null]);
});

it('[AC-CT-24zzi#12] 单会话明细描述：agent.trace 只读，每次成功读取写一条审计 agent_trace_view；不存在或别的 app 的会话 → 20001 data.fields=[session_id]（不探测）', () => {
  const doc = contract();
  const desc = descOf(doc, sessionPath, 'get');
  expect(desc).toContain('agent.trace');
  expect(desc).toMatch(readOnly);
  expect(desc).toMatch(/agent_trace_view/);
  expect(someSentence(desc, [/agent_trace_view|审计|audit/i, /每次|each|every/i])).toBe(true);
  expect(desc).toMatch(/审计|audit/i);
  // 只有成功读取才写审计：正向钉「审计」与「成功」同句（不再整段否定「不写审计」，失败不记审计的精确表述也允许）。
  expect(someSentence(desc, [/agent_trace_view|审计|audit/i, /成功|success(ful(ly)?)?/i])).toBe(
    true,
  );
  expect(desc).toMatch(/BR-AI-19/);
  expect(someSentence(desc, [/20001/, fieldsList('session_id')])).toBe(true);
  expect(desc).toMatch(/app/i);
  expect(desc).toMatch(notProbed);
  expect(errorExamples(doc, sessionPath, 'get')).toContainEqual(
    expect.objectContaining({
      code: 20001,
      data: expect.objectContaining({ fields: ['session_id'] }),
    }),
  );
});

it('[AC-CT-24zzi#13] 单会话明细描述：只给落库的脱敏形式，pii.* 不解开任何东西；不返回原文、完整手机号、设备标识；注销后消息 text 为 null；收益卡不带金额', () => {
  const desc = descOf(contract(), sessionPath, 'get');
  expect(desc).toMatch(/pii\./);
  expect(someSentence(desc, [/pii\./, /脱敏|mask|redact/i])).toBe(true);
  // pii.* 不解开任何东西：正向要有一句把 pii.* 与否定式放在一起；反向不许有分句把 pii.* 与「显示原文」直接相连而无否定。
  expect(someSentence(desc, [/pii\./, piiNoReveal])).toBe(true);
  expect(piiRevealClauses(desc)).toEqual([]);
  expect(desc).toMatch(/原文|raw|original/i);
  expect(desc).toMatch(/手机号|phone/i);
  expect(desc).toMatch(/设备|device/i);
  expect(someSentence(desc, [/注销|account\s+deletion|deleted\s+account/i, /null/])).toBe(true);
  expect(desc).toMatch(/BR-AI-22/);
  expect(
    someSentence(desc, [
      /earnings_summary|收益卡|收益/i,
      /(不带|不含|不存|没有|无|without|no|never|not)[^。；;\n]{0,24}?(金额|amounts?)/i,
    ]),
  ).toBe(true);
});

it('[AC-CT-24zzi#14] 单会话明细 data 含会话头（session_id、user_id、started_at、last_active_at、expired）与 messages、runs、tool_calls、cards 四个数组', () => {
  const doc = contract();
  const data = dataOf(doc, sessionPath, 'get');
  expect(data['additionalProperties']).toBe(false);
  for (const name of ['messages', 'runs', 'tool_calls', 'cards']) {
    expect(list(data['required']), name).toContain(name);
    expect(field(doc, data, name)['type'], name).toBe('array');
  }
  const header = sessionHeader(doc);
  expect(header['additionalProperties']).toBe(false);
  expect(list(header['required'])).toEqual(expect.arrayContaining(headerKeys));
  accepts(doc, field(doc, header, 'session_id'), [uuid1], [1, null]);
  accepts(doc, field(doc, header, 'user_id'), [null, uuid3], [1, {}]);
  accepts(doc, field(doc, header, 'expired'), [true, false], ['false', null]);
  for (const name of ['started_at', 'last_active_at'])
    accepts(doc, field(doc, header, name), goodTimes, [...badTimes, null]);
});

it('[AC-CT-24zzi#15] messages 的元素封闭、含 message_id、role、text、card_ids、feedback、badcase 与举报四项，取值与 04 §3.2 一致', () => {
  const doc = contract();
  const schema = message(doc);
  closed(schema, messageKeys);
  missingRejected(doc, schema, reportedReply, messageKeys);
  accepts(doc, schema, [userMessage, reportedReply, erasedMessage], [{ ...userMessage, x: 1 }]);
  enumField(doc, schema, 'role', ['user', 'assistant']);
  enumField(doc, schema, 'feedback', ['up', 'down'], true);
  enumField(doc, schema, 'report_status', ['pending', 'handled'], true);
  accepts(doc, field(doc, schema, 'text'), [null, '订单 2310****7890'], [1, {}]);
  accepts(doc, field(doc, schema, 'card_ids'), [[], ['c1', 'c12']], [[1], null, 'c1']);
  accepts(doc, field(doc, schema, 'badcase'), [true, false], ['true', null]);
  accepts(doc, field(doc, schema, 'reported_at'), [null, ...goodTimes], badTimes);
  for (const name of ['report_reason', 'report_note'])
    accepts(doc, field(doc, schema, name), [null, '回答不对'], [1, {}]);
});

it('[AC-CT-24zzi#16] runs 的元素封闭且恰为任务书所列 14 个字段，计数非负、可空列按 04 §3.2 可为 null', () => {
  const doc = contract();
  const schema = arrayItem(doc, dataOf(doc, sessionPath, 'get'), 'runs');
  closed(schema, runKeys);
  missingRejected(doc, schema, run, runKeys);
  accepts(doc, schema, [run, bareRun], [{ ...run, user_text: 'x' }]);
  accepts(doc, field(doc, schema, 'run_id'), [uuid2], [null, 1]);
  accepts(doc, field(doc, schema, 'prompt_version'), ['p-2026-11-01'], [null, 1]);
  accepts(doc, field(doc, schema, 'intent'), [null, 'order_query'], [1, {}]);
  for (const name of ['model', 'model_snapshot'])
    accepts(doc, field(doc, schema, name), [null, 'qwen-plus'], [1, {}]);
  for (const name of ['input_tokens', 'output_tokens', 'cost_mfen', 'ttft_ms', 'latency_ms'])
    accepts(doc, field(doc, schema, name), [null, 0, 1200], [-1, 1.5, '1']);
  accepts(doc, field(doc, schema, 'finish_reason'), [null, 'stop', 'fallback'], [1, {}]);
  accepts(doc, field(doc, schema, 'filter_hits'), [[], ['amount']], [null, [1]]);
  accepts(doc, field(doc, schema, 'accepted_at'), goodTimes, [...badTimes, null]);
  accepts(doc, field(doc, schema, 'ended_at'), [null, ...goodTimes], badTimes);
});

it('[AC-CT-24zzi#17] tool_calls 的元素封闭且恰为 run_id、seq、name、args、status、latency_ms；seq 从 1 起', () => {
  const doc = contract();
  const schema = arrayItem(doc, dataOf(doc, sessionPath, 'get'), 'tool_calls');
  closed(schema, toolCallKeys);
  missingRejected(doc, schema, toolCall, toolCallKeys);
  accepts(doc, field(doc, schema, 'run_id'), [uuid2], [null, 1]);
  accepts(doc, field(doc, schema, 'seq'), [1, 7], [0, -1, 1.5, '1', null]);
  accepts(doc, field(doc, schema, 'name'), ['order_lookup'], [null, 1]);
  accepts(doc, field(doc, schema, 'args'), [{}, { order_no: '2310****7890' }], [1, 'x']);
  accepts(doc, field(doc, schema, 'status'), ['ok'], [null, 1]);
  accepts(doc, field(doc, schema, 'latency_ms'), [null, 0, 120], [-1, 1.5, '1']);
});

it('[AC-CT-24zzi#18] cards 的元素与 AgentHistoryCard 同形（card_id、type、schema_version、data、fallback_text）', () => {
  const doc = contract();
  const schema = arrayItem(doc, dataOf(doc, sessionPath, 'get'), 'cards');
  const history = resolve(doc, at(doc, 'components', 'schemas', 'AgentHistoryCard'));
  closed(schema, Object.keys(at(history, 'properties')));
  const card = {
    card_id: 'c1',
    type: 'earnings_summary',
    schema_version: 1,
    data: { as_of: '2026-09-29T10:00:00+08:00', actions: [] },
    fallback_text: '收益概览',
  };
  accepts(
    doc,
    schema,
    [card],
    [
      { ...card, card_id: 'c0' },
      { ...card, extra: 1 },
    ],
  );
});

it('[AC-CT-24zzi#19] 单会话明细响应不出现设备标识、手机号、app_id、原文 user_text 等字段；200 示例过 schema', () => {
  const doc = contract();
  const names = propertyNames(expand(doc, response(doc, sessionPath, 'get')));
  expect(names.filter((name) => forbiddenKey.test(name))).toEqual([]);
  const media = at(
    resolve(doc, at(doc, 'paths', sessionPath, 'get', 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, sessionPath, 'get'));
  const samples = examples(doc, media);
  for (const sample of samples) check(validate, sample, true);
  const messages = samples.flatMap((sample) =>
    list(object(at(sample, 'data'))['messages']).map(object),
  );
  expect(messages.some((entry) => entry['report_status'] !== null)).toBe(true);
});
