// CT-26x GET /admin/v1/product-feedbacks（adminListProductFeedbacks）的契约形状（任务书第 9 节第 2–6 项）。
// 独立预期，不从契约生成；静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  compile,
  check,
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
  yaml,
  type Obj,
} from '../admin-order-actions/kit.ts';
import { closed, examples } from '../order-claims/kit.ts';
import {
  badTimes,
  descriptionOf,
  forbiddenKey,
  goodTimes,
  guestItem,
  itemKeys,
  memberItem,
  operation,
  operationId,
  param,
  path,
  permission,
  rawParams,
  reasons,
} from './kit.ts';

const id = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7c01';
const queryNames = ['page', 'page_size', 'platform', 'reason', 'from', 'to'];

function platformEnum(doc: Obj): unknown[] {
  return list(resolve(doc, at(doc, 'components', 'schemas', 'PlatformCode'))['enum']);
}

function page(doc: Obj): Obj {
  return resolve(doc, at(response(doc, path, 'get'), 'properties', 'data'));
}

function item(doc: Obj): Obj {
  return resolve(doc, at(page(doc), 'properties', 'items', 'items'));
}

// 展开后的 schema 里所有 properties 的键名（不看描述文字）。
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Obj;
  const own =
    node['properties'] !== null && typeof node['properties'] === 'object'
      ? Object.keys(node['properties'] as Obj)
      : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

it('[AC-CT-26x#5] 登记 GET /admin/v1/product-feedbacks：adminListProductFeedbacks、后台鉴权、planned、无幂等与 step-up、错误码恰为 10001/10403/20001', () => {
  const doc = contract();
  const op = operation(doc);
  expect(op).toMatchObject({ operationId, 'x-auth': 'admin', 'x-implementation': 'planned' });
  expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(op[key]);
  expect(op).not.toHaveProperty('x-step-up');
  expect(op).not.toHaveProperty('requestBody');
  const names = rawParams(doc).map((raw) => text(resolve(doc, raw)['name']).toLowerCase());
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names).not.toContain(name);
  const codes = list(op['x-error-codes']);
  expect(codes).toHaveLength(3);
  expect(codes).toEqual(expect.arrayContaining([10001, 10403, 20001]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
  for (const code of codes)
    expect(
      catalog.filter((entry) => at(entry)['code'] === code),
      String(code),
    ).toHaveLength(1);
});

it('[AC-CT-26x#6] 描述写明 feedback.view、只读无 step-up、不写审计、缺权限 10403 admin_permission_denied', () => {
  const desc = descriptionOf(contract());
  expect(desc).toContain(permission);
  expect(desc).toMatch(/只读|read[- ]only/i);
  expect(desc).toMatch(/(无|不需要?|不设|没有)\s*`?step-up|no\s+`?step-up|without\s+`?step-up/i);
  expect(desc).toMatch(
    /(不写|不记|不留|不产生|不落)\s*审计|(does not|doesn't|never|not)\s+(write|record|create)s?\s+(an?\s+)?audit|no\s+audit/i,
  );
  expect(desc).toContain('10403');
  expect(desc).toContain('admin_permission_denied');
});

// 描述按句切开（中文句号、分号、换行、英文句末「. 」）；`data.fields` 里的点不切。
function sentences(desc: string): string[] {
  return desc
    .split(/[。；;\n]|\.\s/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// 至少有一句同时满足全部模式。
function someSentence(desc: string, patterns: RegExp[]): boolean {
  return sentences(desc).some((part) => patterns.every((pattern) => pattern.test(part)));
}

// 期望措辞（实现方照写其一即可）：
// 范围：「只列本控制台 app 的记录」或 "only the console's app"；
// 注销：「注销完成的用户其反馈已删除（BR-ID-28），不会出现」或 "feedbacks of users whose account deletion completed are deleted (BR-ID-28) and never appear"。
const onlyConsoleApp =
  /只(列|返回|含|显示|列出)\s*本控制台\s*(所属\s*)?(的\s*)?`?app`?|only\s+(the|this)\s+console's\s+`?app`?/i;
const otherApps =
  /(所有|全部|任意|各)\s*`?app|(?<!不)跨\s*`?app|all\s+apps|every\s+app|across\s+apps/i;
const deletionWord = /注销|account\s+deletion/i;
const deletedWord = /已(被)?删除|(are|were|have\s+been|has\s+been)\s+deleted/i;
const absentWord =
  /不会(出现|返回|列出)|不(出现|返回|列出)|never\s+(appear|returned|listed)|not\s+(be\s+)?(listed|returned|shown)/i;
const stillKept =
  /仍(然)?(保留|展示|显示|出现|返回|列出)|保留并(展示|显示|返回)|still\s+(kept|retained|shown|listed|returned|appear)|(are|is)\s+retained/i;

it('[AC-CT-26x#7] 描述写明只列本控制台 app 的记录、注销用户的反馈已删除（BR-ID-28）、游客记录 user_id 为 null', () => {
  const desc = descriptionOf(contract());
  // 范围限定为本控制台 app，不能是所有 / 跨 app。
  expect(desc).toMatch(onlyConsoleApp);
  expect(desc).not.toMatch(otherApps);
  // 注销用户的反馈：同一句里写明注销、BR-ID-28、已删除、不会出现；不能写成仍保留或仍展示。
  expect(someSentence(desc, [deletionWord, /BR-ID-28/, deletedWord, absentWord])).toBe(true);
  // 「仍保留」只在讲注销用户的分句里算写反；讲游客记录不随注销删除的分句不算。
  const kept = desc
    .split(/[。；;，,\n]|\.\s/)
    .filter((part) => deletionWord.test(part) && stillKept.test(part) && !/游客|guest/i.test(part));
  expect(kept).toEqual([]);
  expect(desc).toMatch(/游客|guest/i);
  expect(desc).toMatch(/user_id`?[^。]{0,40}?null/);
});

it('[AC-CT-26x#8] 描述写明按 created_at 降序排列，created_at 相同再按服务端内部顺序', () => {
  const desc = descriptionOf(contract());
  expect(desc).toMatch(/created_at`?\s*(降序|倒序|desc)/i);
  expect(desc).not.toMatch(/created_at`?\s*(升序|正序|asc)/i);
  // 同一句：先 created_at 降序，再按服务端内部顺序（不限定具体内部字段）。
  expect(desc).toMatch(
    /created_at`?\s*(降序|倒序|desc(ending)?)[^。；;\n]*?(再按|其次按|相同时?按|then\s+(by\s+)?|ties?\s+(are\s+)?(broken\s+)?by\s+)[^。；;\n]*?(服务端内部顺序|server[- ]internal\s+order|internal\s+server\s+order)/i,
  );
});

it('[AC-CT-26x#9] 参数恰为 X-Trace-Id、page、page_size、platform、reason、from、to；前三个引用现有组件，筛选都可选', () => {
  const doc = contract();
  const raws = rawParams(doc);
  for (const name of ['TraceId', 'AdminPage', 'AdminPageSize'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  const resolved = raws.map((raw) => resolve(doc, raw));
  expect(resolved.map((entry) => text(entry['name'])).sort()).toEqual(
    ['X-Trace-Id', ...queryNames].sort(),
  );
  expect(param(doc, 'X-Trace-Id')['in']).toBe('header');
  for (const name of queryNames) {
    const entry = param(doc, name);
    expect(entry['in'], name).toBe('query');
    expect([undefined, false], name).toContain(entry['required']);
  }
  const size = resolve(doc, at(param(doc, 'page_size'), 'schema'));
  expect(size['maximum']).toBe(200);
  accepts(doc, size, [1, 200], [0, 201, 1.5, '20']);
  accepts(doc, resolve(doc, at(param(doc, 'page'), 'schema')), [1, 2], [0, -1, 1.5]);
});

it('[AC-CT-26x#10] 筛选 platform 取 PlatformCode，reason 取 price / rebate / info / other', () => {
  const doc = contract();
  const platform = resolve(doc, at(param(doc, 'platform'), 'schema'));
  expect(list(platform['enum'])).toEqual(platformEnum(doc));
  accepts(doc, platform, ['taobao', 'jd', 'pdd'], ['unknown', '', 'TAOBAO', null, 1]);
  const holder = { type: 'object', properties: { reason: at(param(doc, 'reason'), 'schema') } };
  enumField(doc, holder, 'reason', reasons);
});

it('[AC-CT-26x#11] from（含）、to（不含）都是 date-time；from 不早于 to 时 20001 且 data.fields 为 from、to', () => {
  const doc = contract();
  for (const name of ['from', 'to']) {
    const schema = resolve(doc, at(param(doc, name), 'schema'));
    expect(schema['format'], name).toBe('date-time');
    accepts(doc, schema, goodTimes, badTimes);
  }
  const desc = descriptionOf(contract());
  // 区间边界：from 紧跟「含 / inclusive」，to 紧跟「不含 / exclusive」（期望写法：`from`（含）、`to`（不含），
  // 或 `from` (inclusive)、`to` (exclusive)）；写反的一律不行。
  expect(desc).toMatch(/`from`\s*(?:[(（]\s*(?:inclusive|含|包含)\s*[)）]|is\s+inclusive)/i);
  expect(desc).toMatch(/`to`\s*(?:[(（]\s*(?:exclusive|不含|不包含)\s*[)）]|is\s+exclusive)/i);
  expect(desc).not.toMatch(/\bfrom`?\s*[(（]?\s*(?:is\s+)?(?:exclusive|不含|不包含)/i);
  expect(desc).not.toMatch(/\bto`?\s*[(（]?\s*(?:is\s+)?(?:inclusive|含|包含)/i);
  // 错误条件：同一句写明 from 不早于 to（相等也算）→ 20001，data.fields 恰为 [from, to]
  // （期望写法：`from` 不早于 `to`（相等也算）时返回 20001，`data.fields=["from","to"]`）。
  const notBefore =
    /`?from`?\s*(?:>=|≥|不早于|is\s+not\s+(?:earlier\s+than|before)|not\s+(?:earlier\s+than|before))\s*`?to`?/i;
  const equalToo = /相等|equal/i;
  const exactFields =
    /data\.fields`?\s*(?:=|为|恰为|is|:)?\s*`?\s*\[\s*["'`]?from["'`]?\s*,\s*["'`]?to["'`]?\s*\]/i;
  expect(someSentence(desc, [notBefore, equalToo, /20001/, exactFields])).toBe(true);
  // 写成「from 早于 to」「from < to」报错的不行（「不早于」「not before」不受影响）。
  expect(desc).not.toMatch(
    /`?from`?\s*(?:<(?!=)|(?<!不)早于|is\s+(?:earlier\s+than|before))\s*`?to`?/i,
  );
  // data.fields 只能是 [from, to]：不能只列其中一个或多列别的。
  const fieldLists = /data\.fields`?\s*(?:=|为|恰为|is|:)?\s*`?\s*\[([^\]]*)\]/gi;
  const listed = [...desc.matchAll(fieldLists)].map((match) =>
    (match[1] ?? '').replace(/["'`\s]/g, ''),
  );
  expect(listed.length).toBeGreaterThan(0);
  for (const value of listed) expect(value).toBe('from,to');
});

it('[AC-CT-26x#12] 200 响应是后台分页信封：code/msg/data/trace_id，data 含 items、page、page_size、total', () => {
  const doc = contract();
  const schema = response(doc, path, 'get');
  expect(list(schema['required'])).toEqual(
    expect.arrayContaining(['code', 'msg', 'data', 'trace_id']),
  );
  accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
  const data = page(doc);
  expect(list(data['required'])).toEqual(
    expect.arrayContaining(['items', 'page', 'page_size', 'total']),
  );
  expect(field(doc, data, 'items')['type']).toBe('array');
  accepts(doc, field(doc, data, 'page'), [1, 2], [0, -1, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'page_size'), [1, 200], [0, 201, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'total'), [0, 1], [-1, 1.5, '1', null]);
  accepts(
    doc,
    data,
    [{ items: [guestItem, memberItem], page: 1, page_size: 20, total: 2 }],
    [{ items: [guestItem], page: 1, page_size: 20 }],
  );
});

it('[AC-CT-26x#13] 列表项封闭且恰为 12 个字段，全部 required', () => {
  const doc = contract();
  const schema = item(doc);
  closed(schema, itemKeys);
  missingRejected(doc, schema, memberItem, itemKeys);
  accepts(doc, schema, [guestItem, memberItem], [{ ...guestItem, extra: 1 }]);
});

it('[AC-CT-26x#14] 列表项各字段的取值：金额为非负整数分，item_ref / shown_rebate_fen / note / user_id 可为 null，note ≤ 100', () => {
  const doc = contract();
  const schema = item(doc);
  accepts(doc, field(doc, schema, 'id'), [id], [null, 1]);
  accepts(doc, field(doc, schema, 'link_id'), [id], [null, 1]);
  accepts(doc, field(doc, schema, 'user_id'), [null, id], [1, {}]);
  expect(list(field(doc, schema, 'platform')['enum'])).toEqual(platformEnum(doc));
  accepts(doc, field(doc, schema, 'platform'), ['taobao', 'pdd'], ['unknown', null]);
  accepts(doc, field(doc, schema, 'product_key'), ['pdd:1234567890'], [null, 1]);
  accepts(doc, field(doc, schema, 'item_ref'), [null, 'opaque-item-ref'], [1, {}]);
  accepts(doc, field(doc, schema, 'shown_final_price_fen'), [0, 1990], [-1, 1.5, '1990', null]);
  accepts(doc, field(doc, schema, 'shown_rebate_fen'), [null, 0, 120], [-1, 1.5, '120']);
  accepts(
    doc,
    field(doc, schema, 'note'),
    [null, '价格不对', 'x'.repeat(100)],
    ['x'.repeat(101), 1],
  );
  enumField(doc, schema, 'reason', reasons);
  for (const name of ['quoted_at', 'created_at'])
    accepts(doc, field(doc, schema, name), goodTimes, badTimes);
});

it('[AC-CT-26x#15] 响应里不出现手机号、昵称、设备标识与 app_id', () => {
  const doc = contract();
  const schema = item(doc);
  const names = propertyNames(expand(doc, response(doc, path, 'get')));
  expect(names.filter((name) => forbiddenKey.test(name))).toEqual([]);
  const validate = compile(doc, schema);
  for (const extra of [
    { device_id: id },
    { device_hash: 'abc' },
    { phone: '13800000000' },
    { phone_masked: '138****0000' },
    { nickname: '小明' },
    { app_id: 'couli' },
  ])
    check(validate, { ...guestItem, ...extra }, false);
});

it('[AC-CT-26x#16] 200 示例过 schema，含一条游客记录（user_id null）与一条登录用户记录', () => {
  const doc = contract();
  const media = at(
    resolve(doc, at(operation(doc), 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, path, 'get'));
  const samples = examples(doc, media);
  for (const sample of samples) check(validate, sample, true);
  const items = samples.flatMap((sample) => list(at(sample, 'data')['items']).map(object));
  expect(items.some((entry) => entry['user_id'] === null)).toBe(true);
  expect(items.some((entry) => typeof entry['user_id'] === 'string')).toBe(true);
});
