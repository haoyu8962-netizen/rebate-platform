// CT-24zzi AI 举报列表 adminListAgentReports 的契约形状（任务书第 9 节第 3 项；08 BR-ID-15 细则
// 「举报的处理」；工作台卡 agent_report_overdue 同一超时口径）。独立预期，不从契约生成；静态读 contracts。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  check,
  compile,
  contract,
  enumField,
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
  badTimes,
  dataOf,
  descOf,
  expectRange,
  forbiddenKey,
  goodTimes,
  handledReport,
  listItem,
  noAudit,
  param,
  paramSchema,
  pendingReport,
  propertyNames,
  rawParams,
  readOnly,
  reportRowKeys,
  reportsPath,
  someSentence,
  uuid3,
} from './kit.ts';

const listQuery = ['page', 'page_size', 'status', 'overdue', 'from', 'to'];
const hours48 = 48 * 60 * 60 * 1000;

function booleanFilter(doc: Obj, schema: Obj): void {
  const validate = compile(doc, schema);
  const asBoolean = validate(true) && validate(false);
  const asString = validate('true') && validate('false');
  expect(asBoolean || asString).toBe(true);
  for (const bad of ['yes', '', 2, null, {}]) check(validate, bad, false);
}

it('[AC-CT-24zzi#20] 举报列表参数恰为 X-Trace-Id、page、page_size、status、overdue、from、to；status 取 pending / handled，筛选都可选', () => {
  const doc = contract();
  const raws = rawParams(doc, reportsPath, 'get');
  for (const name of ['TraceId', 'AdminPage', 'AdminPageSize'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  const names = raws.map((raw) => text(resolve(doc, raw)['name']));
  expect(names.toSorted()).toEqual(['X-Trace-Id', ...listQuery].toSorted());
  for (const name of listQuery) {
    const entry = param(doc, reportsPath, 'get', name);
    expect(entry['in'], name).toBe('query');
    expect([undefined, false], name).toContain(entry['required']);
  }
  const holder = {
    type: 'object',
    properties: { status: at(param(doc, reportsPath, 'get', 'status'), 'schema') },
  };
  enumField(doc, holder, 'status', ['pending', 'handled']);
  booleanFilter(doc, paramSchema(doc, reportsPath, 'get', 'overdue'));
  for (const name of ['from', 'to']) {
    const schema = paramSchema(doc, reportsPath, 'get', name);
    expect(schema['format'], name).toBe('date-time');
    accepts(doc, schema, goodTimes, badTimes);
  }
});

it('[AC-CT-24zzi#21] 举报列表描述：agent.trace 只读、不写审计；status 不传为全部；from（含）/ to（不含）按 reported_at，from 不早于 to → 20001 [from, to]', () => {
  const desc = descOf(contract(), reportsPath, 'get');
  expect(desc).toContain('agent.trace');
  expect(desc).toMatch(readOnly);
  expect(desc).toMatch(noAudit);
  const omitted = /不传|省略|缺省|absent|omitted|not\s+(given|sent|set)/i;
  expect(someSentence(desc, [/status/, omitted, /全部|所有|all/i])).toBe(true);
  expectRange(desc, 'reported_at');
});

it('[AC-CT-24zzi#22] 举报列表描述：48 小时从举报提交起算，deadline_at = reported_at + 48 小时；overdue 为待处理且当前时刻 ≥ deadline_at，与 agent_report_overdue 同一口径；已处理的 overdue 为 false', () => {
  const desc = descOf(contract(), reportsPath, 'get');
  expect(desc).toMatch(/BR-ID-15/);
  expect(desc).toMatch(
    /deadline_at`?\s*(=|＝|为|是|equals|is)\s*`?reported_at`?\s*\+\s*48\s*(小时|h\b|hours?)/i,
  );
  const atOrAfter =
    /(≥|>=|不早于|at\s+or\s+after|not\s+(earlier\s+than|before))\s*`?deadline_at|deadline_at`?\s*(≤|<=)/i;
  expect(someSentence(desc, [/overdue/, /待处理|pending/i, atOrAfter])).toBe(true);
  // 不能写成严格大于（到点即超时）。
  expect(desc).not.toMatch(/(?<![≥>])>(?!=)\s*`?deadline_at/);
  expect(someSentence(desc, [/agent_report_overdue/, /同一|一致|相同|same/i])).toBe(true);
  expect(someSentence(desc, [/overdue/, /已处理|handled/i, /\bfalse\b/])).toBe(true);
});

it('[AC-CT-24zzi#23] 举报列表排序：待处理在前按 reported_at 升序（最久的在最上），已处理在后按 handled_at 倒序', () => {
  const desc = descOf(contract(), reportsPath, 'get');
  expect(
    someSentence(desc, [
      /(待处理|pending)[^。；;\n]*?(在前|置顶|最前|first|on\s+top|before)/i,
      /reported_at`?\s*(升序|正序|asc)/i,
    ]),
  ).toBe(true);
  expect(
    someSentence(desc, [
      /(已处理|handled)[^。；;\n]*?(在后|之后|其后|after|last|then|follow)/i,
      /handled_at`?\s*(降序|倒序|desc)/i,
    ]),
  ).toBe(true);
  expect(desc).not.toMatch(/reported_at`?\s*(降序|倒序|desc)/i);
  expect(desc).not.toMatch(/handled_at`?\s*(升序|正序|asc)/i);
});

it('[AC-CT-24zzi#24] 举报列表 200 是后台分页信封，行封闭且恰为 13 个字段、全部 required', () => {
  const doc = contract();
  const data = dataOf(doc, reportsPath, 'get');
  expect(list(data['required'])).toEqual(
    expect.arrayContaining(['items', 'page', 'page_size', 'total']),
  );
  accepts(
    doc,
    data,
    [{ items: [pendingReport, handledReport], page: 1, page_size: 20, total: 2 }],
    [{ items: [pendingReport], page: 1, page_size: 20 }],
  );
  const row = listItem(doc, reportsPath);
  closed(row, reportRowKeys);
  missingRejected(doc, row, handledReport, reportRowKeys);
  accepts(doc, row, [pendingReport, handledReport], [{ ...pendingReport, extra: 1 }]);
});

it('[AC-CT-24zzi#25] 举报行各字段的取值：状态 pending / handled，overdue 布尔，处理人与处理时间、说明可为 null，row_version 非负整数', () => {
  const doc = contract();
  const row = listItem(doc, reportsPath);
  for (const name of ['message_id', 'session_id'])
    accepts(doc, field(doc, row, name), [uuid3], [null, 1]);
  for (const name of ['user_id', 'handler_id'])
    accepts(doc, field(doc, row, name), [null, uuid3], [1, {}]);
  enumField(doc, row, 'report_status', ['pending', 'handled']);
  for (const name of ['reported_at', 'deadline_at'])
    accepts(doc, field(doc, row, name), goodTimes, [...badTimes, null]);
  accepts(doc, field(doc, row, 'handled_at'), [null, ...goodTimes], badTimes);
  accepts(doc, field(doc, row, 'overdue'), [true, false], ['true', null, 1]);
  accepts(doc, field(doc, row, 'report_reason'), ['回答内容与事实不符'], [1, {}]);
  for (const name of ['handler_name', 'report_note'])
    accepts(doc, field(doc, row, name), [null, '运营小王'], [1, {}]);
  accepts(doc, field(doc, row, 'row_version'), [0, 2], [-1, 1.5, '1', null]);
  const names = propertyNames(expand(doc, response(doc, reportsPath, 'get')));
  expect(names.filter((name) => forbiddenKey.test(name))).toEqual([]);
  expect(names).not.toContain('text');
});

it('[AC-CT-24zzi#26] 举报列表 200 示例过 schema，含一条超时待处理与一条已处理；每行 deadline_at 恰为 reported_at + 48 小时，已处理的 overdue 为 false', () => {
  const doc = contract();
  const media = at(
    resolve(doc, at(doc, 'paths', reportsPath, 'get', 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, reportsPath, 'get'));
  const samples = examples(doc, media);
  for (const sample of samples) check(validate, sample, true);
  const items = samples.flatMap((sample) => list(at(sample, 'data')['items']).map(object));
  expect(
    items.some((entry) => entry['report_status'] === 'pending' && entry['overdue'] === true),
  ).toBe(true);
  expect(items.some((entry) => entry['report_status'] === 'handled')).toBe(true);
  for (const entry of items) {
    const gap = Date.parse(text(entry['deadline_at'])) - Date.parse(text(entry['reported_at']));
    expect(gap, JSON.stringify(entry)).toBe(hours48);
    expect([entry['report_status'] === 'handled', entry['overdue']]).not.toEqual([true, true]);
  }
});
