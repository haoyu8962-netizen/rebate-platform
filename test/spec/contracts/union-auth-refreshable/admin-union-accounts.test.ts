// CT-24ha · 后台联盟账号列表每行加 auth_refreshable（本次授权能否自动续期：true / false / null），字段可缺省。
// 依据只有两处（refs 为空，不对照 BR 取值；编排 D10-2585 / D10-2587）：契约 adminListUnionAccounts
// （contracts/openapi.yaml 的 GET /admin/v1/union-accounts）及其行 schema AdminUnionAccount，和台账
// ops/tasks/CT-24ha.yaml 的注释：true = 当前凭据来自一次返回 re_expires_in > 0 的联盟授权；false = 返回了
// re_expires_in = 0（或平台写明不可刷新）；null = 不知道；字段不进 required，缺省与 null 同义；只给结论，不返回
// re_expires_in 等原始时长，也不返回任何 token。
// 用例按样例过不过来判（Ajv2020 strict 实际编译契约里的 schema），不断言 schema 的结构字面：
// type 数组、anyOf / oneOf 等合法写法都能过。只动这一个操作：别的操作、错误码、枚举与生成物都不写测。
// 全部静态读 contracts/openapi.yaml：不连库、不 listen、不联网。
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

type Obj = Record<string, unknown>;

interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}

interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): ValidateFn;
}

interface Validators {
  row: ValidateFn;
  list: ValidateFn;
  response: ValidateFn;
}

const root = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;

// ---------------------------------------------------------------------------------------------
// 规则常量（独立预期）

const OPERATION_ID = 'adminListUnionAccounts';
const ROW_SCHEMA = 'AdminUnionAccount';
const LIST_RESPONSE_SCHEMA = 'AdminUnionAccountListResponse';
const FIELD = 'auth_refreshable';

/** 本次授权能否自动续期的三种取值（台账注释）。 */
const GOOD_VALUES: unknown[] = [true, false, null];

/** 类型错的取值：字符串、数字 0 / 1、对象、数组（be 补充第 3 条），再加几种同类写法。 */
const BAD_VALUES: unknown[] = [
  'true',
  'false',
  'null',
  '',
  0,
  1,
  {},
  { refreshable: true },
  [],
  [true],
];

/** 行里不该出现的别的属性（行仍然封闭，be 补充第 4 条）。 */
const OTHER_EXTRAS: Obj = { refreshable: true, auth_refresh: true, can_refresh: true };

/** 不返回的原始时长与凭据（be 补充第 5 条）：带它们的行一律被拒。 */
const RAW_DURATIONS = [
  're_expires_in',
  'r1_expires_in',
  'r2_expires_in',
  'w1_expires_in',
  'w2_expires_in',
  'expires_in',
];
const CREDENTIALS = ['access_token', 'refresh_token', 'token'];

/** 「缺省」的说法（宽松匹配，be 补充第 6 条）。 */
const OMITTED_LIKE = /omit|absent|missing|not present|缺省/i;

/** 主干必填字段给齐的两行（淘宝 oauth、京东 manual），不带 auth_refreshable。 */
const TAOBAO_ROW: Obj = {
  union_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01',
  platform: 'taobao',
  account_name: '凑狸淘宝联盟',
  status: 'active',
  sync_start_at: '2026-09-29T00:00:00+08:00',
  auth_expires_at: '2026-12-30T00:00:00+08:00',
  auth_expires_estimated: false,
  auth_status: 'active',
  auth_renewed_at: '2026-10-01T10:00:00+08:00',
  auth_renewed_by: null,
  last_probe_at: '2026-10-22T09:00:00+08:00',
  last_probe_ok: true,
  last_probe_error: null,
  alert_phones_configured: true,
  reauth_mode: 'oauth',
};
const JD_ROW: Obj = {
  union_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a02',
  platform: 'jd',
  account_name: '凑狸京东联盟',
  status: 'active',
  sync_start_at: '2026-09-29T00:00:00+08:00',
  auth_expires_at: '2026-12-28T10:00:00+08:00',
  auth_expires_estimated: true,
  auth_status: 'expiring',
  auth_renewed_at: '2026-09-29T10:00:00+08:00',
  auth_renewed_by: '0199a3b4-0000-7000-8000-0000a0000b01',
  last_probe_at: '2026-10-22T09:00:00+08:00',
  last_probe_ok: false,
  last_probe_error: 'probe timeout',
  alert_phones_configured: false,
  reauth_mode: 'manual',
};
/** 主干必填字段给齐的拼多多 none 行（无续期方式，auth_expires_at 为 null），不带 auth_refreshable。 */
const PDD_NONE_ROW: Obj = {
  union_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a03',
  platform: 'pdd',
  account_name: '凑狸拼多多联盟',
  status: 'active',
  sync_start_at: null,
  auth_expires_at: null,
  auth_expires_estimated: false,
  auth_status: 'active',
  auth_renewed_at: null,
  auth_renewed_by: null,
  last_probe_at: null,
  last_probe_ok: null,
  last_probe_error: null,
  alert_phones_configured: true,
  reauth_mode: 'none',
};
const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

// ---------------------------------------------------------------------------------------------
// 读文件与 Ajv

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown, label = '值'): Obj {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Obj;
}

function text(value: unknown, label = '值'): string {
  expect(typeof value, `${label} 必须是字符串`).toBe('string');
  return value as string;
}

function at(value: unknown, ...keys: string[]): Obj {
  let node = object(value);
  for (const [i, key] of keys.entries()) {
    const label = keys.slice(0, i + 1).join('.');
    expect(Object.hasOwn(node, key), `缺少 ${label}`).toBe(true);
    node = object(node[key], label);
  }
  return node;
}

function check(ok: boolean, valid: boolean, label: string): void {
  expect(ok, `${label}：期望${valid ? '通过' : '被拒'}`).toBe(valid);
}

let openapiCache: Obj | undefined;
function openapi(): Obj {
  if (openapiCache === undefined) {
    const file = new URL('contracts/openapi.yaml', root);
    expect(existsSync(file), '缺少 contracts/openapi.yaml').toBe(true);
    openapiCache = object(parseYamlLite(readFileSync(file, 'utf8')), 'openapi.yaml');
  }
  return openapiCache;
}

function newAjv(): AjvInstance {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (v) => Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv;
}

function compileStrict(schema: Obj, label: string): ValidateFn {
  let validate: ValidateFn | undefined;
  expect(() => {
    validate = newAjv().compile(schema);
  }, `${label}：Ajv2020 strict 编译`).not.toThrow();
  expect(validate, label).toBeTypeOf('function');
  return validate as ValidateFn;
}

function resolve(doc: Obj, value: unknown): Obj {
  let node = object(value);
  const seen = new Set<string>();
  while (node['$ref'] !== undefined) {
    const ref = text(node['$ref'], '$ref');
    expect(ref.startsWith('#/'), `只解析本文件内的引用：${ref}`).toBe(true);
    expect(seen.has(ref), `循环引用 ${ref}`).toBe(false);
    seen.add(ref);
    const { $ref: ignored, ...siblings } = node;
    void ignored;
    const keys = ref
      .slice(2)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    node = { ...at(doc, ...keys), ...siblings };
  }
  return node;
}

function expand(doc: Obj, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(doc, entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(resolve(doc, value)).map(([key, child]) => [key, expand(doc, child)]),
  );
}

function compileOpenapi(doc: Obj, schema: unknown, label: string): ValidateFn {
  return compileStrict(object(expand(doc, schema), label), label);
}

// ---------------------------------------------------------------------------------------------
// 操作与 schema

/** 按 operationId 找操作（恰一个）。 */
function operation(doc: Obj, operationId: string): Obj {
  const found: Obj[] = [];
  for (const item of Object.values(at(doc, 'paths'))) {
    if (!isObj(item)) continue;
    for (const op of Object.values(item)) {
      if (isObj(op) && op['operationId'] === operationId) found.push(op);
    }
  }
  expect(found, `operationId=${operationId} 的操作`).toHaveLength(1);
  return found[0] as Obj;
}

function component(doc: Obj, name: string): Obj {
  return at(doc, 'components', 'schemas', name);
}

/** adminListUnionAccounts 的 200 JSON 响应 schema（未展开）。 */
function okSchema(doc: Obj): unknown {
  const op = operation(doc, OPERATION_ID);
  const ok = resolve(doc, at(op, 'responses', '200'));
  return at(ok, 'content', 'application/json')['schema'];
}

let validatorsCache: Validators | undefined;
function validators(): Validators {
  if (validatorsCache === undefined) {
    const doc = openapi();
    validatorsCache = {
      row: compileOpenapi(doc, component(doc, ROW_SCHEMA), ROW_SCHEMA),
      list: compileOpenapi(doc, component(doc, LIST_RESPONSE_SCHEMA), LIST_RESPONSE_SCHEMA),
      response: compileOpenapi(doc, okSchema(doc), `${OPERATION_ID} 的 200 响应`),
    };
  }
  return validatorsCache;
}

function listBody(rows: Obj[]): Obj {
  return { code: 0, msg: '', data: { items: clone(rows) }, trace_id: TRACE_ID };
}

/** 单行过 AdminUnionAccount。 */
function rowVerdict(row: Obj, valid: boolean, label: string): void {
  check(validators().row(clone(row)), valid, `${label}（${ROW_SCHEMA}）`);
}

/** 两行放进 list，过 AdminUnionAccountListResponse 与操作的 200 响应 schema。 */
function listVerdict(rows: Obj[], valid: boolean, label: string): void {
  const body = listBody(rows);
  check(validators().list(clone(body)), valid, `${label}（${LIST_RESPONSE_SCHEMA}）`);
  check(validators().response(clone(body)), valid, `${label}（${OPERATION_ID} 200 响应）`);
}

/** 两行都经同一改动后，单行与列表都给同一结论。 */
function verdict(extra: Obj, valid: boolean, label: string): void {
  const rows = [TAOBAO_ROW, JD_ROW].map((row) => ({ ...clone(row), ...clone(extra) }));
  for (const [i, row] of rows.entries()) rowVerdict(row, valid, `第 ${i} 行 ${label}`);
  listVerdict(rows, valid, `两行都 ${label}`);
}

/** 从节点出发（顺着 $ref 与 allOf / anyOf / oneOf）能看到的 description。 */
function descriptionsUnder(doc: Obj, value: unknown): string[] {
  if (!isObj(value)) return [];
  const node = resolve(doc, value);
  const out: string[] = [];
  if (typeof node['description'] === 'string') out.push(node['description']);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) out.push(...descriptionsUnder(doc, branch));
  }
  return out;
}

/** 行 schema（含 allOf / anyOf / oneOf 各分支）里 auth_refreshable 属性节点的 description。 */
function fieldDescriptions(doc: Obj, schema: unknown): string[] {
  if (!isObj(schema)) return [];
  const node = resolve(doc, schema);
  const out: string[] = [];
  const props = node['properties'];
  const field = isObj(props) ? props[FIELD] : undefined;
  if (field !== undefined) out.push(...descriptionsUnder(doc, field));
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) out.push(...fieldDescriptions(doc, branch));
  }
  return out;
}

function paragraphs(value: string): string[] {
  return value.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim());
}

/** 同一段里点名字段、提到 null、并说缺省（named 为真时字段名由位置给出）。 */
function explains(paragraph: string, named: boolean): boolean {
  const hasName = named || paragraph.includes(FIELD);
  return hasName && /\bnull\b/i.test(paragraph) && OMITTED_LIKE.test(paragraph);
}

// ---------------------------------------------------------------------------------------------
// 用例

it('[AC-CT-24ha#1] 联盟账号行的 auth_refreshable：true / false / null 三种取值整行都过 AdminUnionAccount 与 AdminUnionAccountListResponse（list 两行，含一行带一行不带）；不带它的行照过（不进 required）；值为字符串、数字 0 / 1、对象、数组都拒；行仍封闭，多出 refreshable 等别的属性被拒；带 re_expires_in 等原始时长或 access_token / refresh_token / token 的行一律被拒（true / false 配 re_expires_in=0 也拒）；reauth_mode=none 的拼多多行 null 与缺省都过；列表逐行校验，一条合法行加一条 "true" 行不论顺序都拒', () => {
  // 台账注释：行 schema 加 auth_refreshable（boolean 或 null）；字段可缺省，缺省与 null 同义；只给能否续期的结论，
  // 不返回 re_expires_in 等原始时长，也不返回任何 token（D10-2587）。be 补充第 1～5 条。
  // ② 可缺省：主干必填字段给齐、不带 auth_refreshable 的行照过。
  for (const [i, row] of [TAOBAO_ROW, JD_ROW].entries()) {
    rowVerdict(row, true, `第 ${i} 行不带 ${FIELD}`);
  }
  listVerdict([TAOBAO_ROW, JD_ROW], true, `两行都不带 ${FIELD}`);

  // ① 三种取值都收。
  for (const value of GOOD_VALUES) {
    const shown = JSON.stringify(value);
    verdict({ [FIELD]: value }, true, `${FIELD}=${shown}`);
    const mixed = [{ ...clone(TAOBAO_ROW), [FIELD]: value }, clone(JD_ROW)];
    listVerdict(mixed, true, `第 0 行 ${FIELD}=${shown}、第 1 行不带`);
    const reversed = [clone(TAOBAO_ROW), { ...clone(JD_ROW), [FIELD]: value }];
    listVerdict(reversed, true, `第 0 行不带、第 1 行 ${FIELD}=${shown}`);
  }
  const first = { ...clone(TAOBAO_ROW), [FIELD]: true };
  const pair = [first, { ...clone(JD_ROW), [FIELD]: null }];
  listVerdict(pair, true, `两行 ${FIELD} 分别为 true、null`);

  // ①' reauth_mode = none 的拼多多行（auth_expires_at 为 null）：显式 null 与不带都过单行，
  // 与另一条合法行同放进列表（两种顺序）时列表组件与 200 响应都过。
  const pddNull = { ...clone(PDD_NONE_ROW), [FIELD]: null };
  const pddAbsent = clone(PDD_NONE_ROW);
  rowVerdict(pddNull, true, `拼多多 none 行 ${FIELD}=null`);
  rowVerdict(pddAbsent, true, `拼多多 none 行不带 ${FIELD}`);
  const taobaoTrue = { ...clone(TAOBAO_ROW), [FIELD]: true };
  const jdFalse = { ...clone(JD_ROW), [FIELD]: false };
  listVerdict([pddNull, taobaoTrue], true, `拼多多 none 行 ${FIELD}=null、淘宝行 true`);
  listVerdict([taobaoTrue, pddNull], true, `淘宝行 true、拼多多 none 行 ${FIELD}=null`);
  listVerdict([pddAbsent, jdFalse], true, `拼多多 none 行不带、京东行 ${FIELD}=false`);
  listVerdict([jdFalse, pddAbsent], true, `京东行 ${FIELD}=false、拼多多 none 行不带`);

  // ③ 类型错的拒。
  for (const value of BAD_VALUES) {
    verdict({ [FIELD]: value }, false, `${FIELD}=${JSON.stringify(value)}`);
  }

  // ③' 列表逐行校验（防 items 误写成 contains）：一条合法行加一条 auth_refreshable="true" 的非法行，
  // 两种顺序列表组件与 200 响应都拒。
  const badRow = { ...clone(JD_ROW), [FIELD]: 'true' };
  for (const goodRow of [taobaoTrue, clone(TAOBAO_ROW), pddNull]) {
    const good = Object.hasOwn(goodRow, FIELD) ? JSON.stringify(goodRow[FIELD]) : '不带';
    listVerdict([goodRow, badRow], false, `合法行（${good}）在前、"true" 行在后`);
    listVerdict([badRow, goodRow], false, `"true" 行在前、合法行（${good}）在后`);
  }

  // ④ 行仍然封闭：别的属性（单带或与合法的 auth_refreshable 同带）都被拒。
  for (const [key, value] of Object.entries(OTHER_EXTRAS)) {
    verdict({ [key]: value }, false, `另加 ${key}`);
    for (const good of GOOD_VALUES) {
      const label = `${FIELD}=${JSON.stringify(good)} 再另加 ${key}`;
      verdict({ [FIELD]: good, [key]: value }, false, label);
    }
  }

  // ⑤ 不返回原始时长与凭据：带它们的行（不论 auth_refreshable 取什么、带不带）一律被拒。
  const leaks: Obj = {};
  for (const key of RAW_DURATIONS) leaks[key] = 7_776_000;
  for (const key of CREDENTIALS) leaks[key] = '6201f2a8e3b9c4d5';
  for (const [key, value] of Object.entries(leaks)) {
    verdict({ [key]: value }, false, `带 ${key}`);
    for (const good of GOOD_VALUES) {
      const label = `${FIELD}=${JSON.stringify(good)} 再带 ${key}`;
      verdict({ [FIELD]: good, [key]: value }, false, label);
    }
  }
  // true / false 都不能配原始时长 0（false 的结论只给布尔，不附 re_expires_in = 0）：单行与列表都拒。
  for (const key of RAW_DURATIONS) {
    verdict({ [FIELD]: true, [key]: 0 }, false, `${FIELD}=true 再带 ${key}=0`);
    verdict({ [FIELD]: false, [key]: 0 }, false, `${FIELD}=false 再带 ${key}=0`);
  }
});

it('[AC-CT-24ha#2] 说明写清楚：adminListUnionAccounts 的 description、行 schema 的 description 或行里 auth_refreshable 的 description 至少一段同时点名 auth_refreshable、提到 null，并说明缺省（omitted / absent / missing）与 null 同义', () => {
  // 台账注释：说明段同步；字段可缺省，缺省与 null 同义（不知道 / 没记录）。be 补充第 6 条：宽松匹配，
  // 不写死整句英文；auth_refreshable 自身的 description 由位置点名字段。
  const doc = openapi();
  const op = operation(doc, OPERATION_ID);
  const row = component(doc, ROW_SCHEMA);
  const named: string[] = [];
  if (typeof op['description'] === 'string') named.push(op['description']);
  named.push(...descriptionsUnder(doc, row));
  const own = fieldDescriptions(doc, row);
  const hits = [
    ...named.flatMap(paragraphs).filter((part) => explains(part, false)),
    ...own.flatMap(paragraphs).filter((part) => explains(part, true)),
  ];
  const message = `${OPERATION_ID} / ${ROW_SCHEMA} 说明 ${FIELD} 缺省同 null`;
  expect(hits.length, message).toBeGreaterThan(0);
});
