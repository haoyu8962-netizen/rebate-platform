import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  expand,
  list,
  object,
  resolve,
  text,
  yaml,
  type Obj,
} from '../order-claims/kit.ts';
import {
  generated,
  initializer,
  namedInterface,
  property,
  source,
} from '../order-claims/source-kit.ts';

// AC-CT-13d#n 仅标记本任务验收点。依据任务摘录的 04 §6.4、03 §4.5/4.7/6.2、
// BR-ID-01 接口表及 D10-1469/1470/1471；不测试 B1-06zo 的运行时存储或客户端队列。
const path = '/v1/events';
const results = ['requested', 'failed', 'unknown'];
const event = {
  event_id: 'a93c9c10-bf5f-4a79-a530-3a272fffe759',
  name: 'link_jump',
  client_at: '2026-11-13T10:00:00+08:00',
  session_id: 'ct-13d-session',
  device_id: 'ct-13d-device',
  platform: 'h5',
  app_version: '1.0.0',
  page: 'ProductDetail',
  phase: 'purchase',
  attempt_id: 'ct-13d-attempt',
  link_id: 'ct-13d-link',
  union_platform: 'taobao',
  step: 'sdk',
  result: 'requested',
  sdk_open_by: 'url',
  duration_ms: 12,
  installed: 'unknown',
};

function operation(doc: Obj): Obj {
  // 先断言路径存在，缺接口时只能产生断言失败，不能产生 TypeError。
  return at(doc, 'paths', path, 'post');
}

function request(doc: Obj): Obj {
  const body = resolve(doc, at(operation(doc), 'requestBody'));
  expect(body['required']).toBe(true);
  return resolve(doc, at(body, 'content', 'application/json', 'schema'));
}

function description(doc: Obj): string {
  const parts: string[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'description' && typeof child === 'string') parts.push(child);
        else visit(child);
      }
    }
  }
  visit(expand(doc, operation(doc)));
  return parts.join('\n').replaceAll('`', '').replaceAll(/\s+/gu, ' ');
}

function jumpFields(): Obj {
  return at(yaml('specs/events.yaml'), 'events', 'link_jump', 'fields');
}

it('[AC-CT-13d#1] 游客可报、令牌可识别本人、不签名且受最低版本闸门约束，错误码来自现有目录', () => {
  const doc = contract();
  const op = operation(doc);
  expect(op).toMatchObject({ 'x-auth': 'optional', 'x-signed': false, 'x-min-version-gate': true });
  expect(list(op['security'])).toEqual(expect.arrayContaining([{}, { bearerAuth: [] }]));
  const headers = list(op['parameters']).map((entry) => resolve(doc, entry));
  for (const header of ['X-App-Id', 'X-Platform', 'X-App-Version']) {
    expect(headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: header, required: true })]),
    );
  }
  expect(
    headers.filter(
      (header) =>
        ['x-sign', 'x-nonce', 'x-timestamp'].includes(String(header['name']).toLowerCase()) &&
        header['required'] === true,
    ),
  ).toEqual([]);
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const codes = list(op['x-error-codes']);
  expect(codes).toContain(20001);
  for (const code of codes) {
    expect(
      catalog.filter((entry) => entry['code'] === code && entry['deprecated'] !== true),
    ).toHaveLength(1);
  }
});

it('[AC-CT-13d#2] 请求是 events 数组，声明有限批量上限并拒绝不成形或超限的整批请求', () => {
  const doc = contract();
  const schema = request(doc);
  const events = resolve(doc, at(schema, 'properties', 'events'));
  expect(schema['type']).toBe('object');
  expect(list(schema['required'])).toContain('events');
  expect(events['type']).toBe('array');
  const max = events['maxItems'];
  expect(Number.isSafeInteger(max)).toBe(true);
  expect(max).toBeGreaterThanOrEqual(10);
  expect(max).toBeLessThanOrEqual(500);
  const validate = compile(doc, schema);
  check(validate, { events: Array.from({ length: max as number }, () => ({ ...event })) }, true);
  check(
    validate,
    { events: Array.from({ length: (max as number) + 1 }, () => ({ ...event })) },
    false,
  );
  for (const invalid of [
    null,
    [],
    'events',
    {},
    { events: null },
    { events: {} },
    { events: 'bad' },
  ]) {
    check(validate, invalid, false);
  }
  expect(description(doc)).toMatch(/(?:03|§)\s*(?:§\s*)?4\.7/u);
});

it('[AC-CT-13d#3] 缺字段、非法 UUID、未知事件、旧 result 或非对象事件均不能让整批 schema 拒绝', () => {
  const doc = contract();
  const validate = compile(doc, request(doc));
  const malformed = [
    null,
    7,
    'bad',
    [],
    {},
    { ...event, event_id: 'not-a-uuid' },
    { ...event, name: 'future_event' },
    { ...event, result: 'launched' },
  ];
  for (const bad of malformed) {
    check(validate, { events: [event, bad] }, true);
    check(validate, { events: [bad] }, true);
  }
  // 重复事件是受理后的去重事项，不能用 uniqueItems 把重放变成整批 4xx。
  check(validate, { events: [event, event] }, true);
});

it('[AC-CT-13d#4] 契约写明逐条丢弃、受理清队列、UUID 重试不换和按事件类型加 ID 去重', () => {
  const value = description(contract());
  expect(value).toMatch(/event_id.{0,160}UUID|UUID.{0,160}event_id/iu);
  expect(value).toMatch(/event_type\s*[,，+]\s*event_id/u);
  expect(value).toMatch(/去重|deduplicat/iu);
  expect(value).toMatch(
    /(?:重试|重投|retry|retries|redeliver).{0,160}(?:不换|沿用|同一|same|unchanged|reuse)/iu,
  );
  expect(value).toMatch(/(?:不合规|无效|非法|invalid|malformed).{0,160}(?:丢弃|drop|discard)/iu);
  expect(value).toMatch(
    /(?:受理|accepted|acknowledg).{0,240}(?:删除|移除|清除|remove|delete|dequeue)/iu,
  );
  expect(value).toMatch(/队列|queue/iu);
  expect(value).toMatch(
    /(?:不承诺|不保证|不代表|not|no guarantee|does not).{0,100}(?:保存|持久|落库|persist|stor|sav)/iu,
  );
});

it('[AC-CT-13d#5] 受理响应必须给被丢弃条数，零条和正数合法、负数小数或缺失非法', () => {
  const doc = contract();
  const responses = at(operation(doc), 'responses');
  const successes = Object.keys(responses).filter((status) => /^2\d\d$/u.test(status));
  expect(successes.length).toBeGreaterThan(0);
  for (const status of successes) {
    const response = resolve(doc, responses[status]);
    const schema = resolve(doc, at(response, 'content', 'application/json', 'schema'));
    const data = resolve(doc, at(schema, 'properties', 'data'));
    const properties = at(data, 'properties');
    // D10-1471 允许两种方案，本测试选择整批受理 + 丢弃计数；字段名由实现者决定。
    const counts = Object.keys(properties).filter((key) =>
      /drop|discard|reject|invalid/iu.test(key),
    );
    expect(counts).toHaveLength(1);
    const key = counts[0]!;
    const count = resolve(doc, properties[key]);
    expect(count).toMatchObject({ type: 'integer', minimum: 0 });
    expect(list(data['required'])).toContain(key);
    const validate = compile(doc, count);
    for (const valid of [0, 1, 10]) check(validate, valid, true);
    for (const invalid of [-1, 0.5, '1', null]) check(validate, invalid, false);
    expect(properties).not.toHaveProperty('saved');
  }
});

it('[AC-CT-13d#6] link_jump.result 恰好三值、版本递增，公共字段与购买外跳 attempt_id 保留', () => {
  const doc = yaml('specs/events.yaml');
  const fields = jumpFields();
  expect(at(fields, 'result')).toMatchObject({ type: 'enum', required: true });
  expect(list(at(fields, 'result')['values']).toSorted()).toEqual(results.toSorted());
  const resultNote = text(at(fields, 'result')['note']);
  expect(resultNote).toMatch(/requested.{0,160}(?:复制|copied|copy)/iu);
  expect(resultNote).toMatch(/unknown.{0,160}(?:不确定|未知|超时|uncertain|unknown|timeout)/iu);
  expect(text(doc['version'])).toMatch(/^\d+$/u);
  expect(Number(doc['version'])).toBeGreaterThan(5);
  for (const name of [
    'event_id',
    'name',
    'client_at',
    'session_id',
    'device_id',
    'app_version',
    'page',
  ]) {
    expect(at(doc, 'common_fields', name)).toMatchObject({ type: 'string', required: true });
  }
  expect(at(doc, 'common_fields', 'platform')).toMatchObject({
    type: 'enum',
    required: true,
    values: ['ios', 'android', 'harmony', 'h5'],
  });
  expect(at(fields, 'attempt_id')).toMatchObject({
    type: 'string',
    required_when: { phase: 'purchase' },
  });
  expect(text(at(fields, 'attempt_id')['note'])).toMatch(/open/iu);
});

it('[AC-CT-13d#7] 初始化失败作为 failed 的原因码保留，不再占 result；失败有步骤与原因码', () => {
  const fields = jumpFields();
  expect(list(at(fields, 'result')['values']).toSorted()).toEqual(results.toSorted());
  const reasons = Object.entries(fields).filter(
    ([name, field]) =>
      name !== 'result' && name !== 'phase' && /sdk_init_failed/u.test(JSON.stringify(field)),
  );
  expect(reasons.length).toBeGreaterThan(0);
  for (const [name, field] of reasons) {
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(
      name
        .split('_')
        .some((part) =>
          [
            'url',
            'href',
            'link',
            'deeplink',
            'tpwd',
            'pid',
            'adzone',
            'relation',
            'promo',
          ].includes(part),
        ),
    ).toBe(false);
    expect(name).not.toMatch(/sub_union_id|custom_parameters/u);
    expect(['string', 'enum']).toContain(object(field)['type']);
  }
  expect(at(fields, 'step')).toMatchObject({ type: 'enum', required: true });
  const notes = JSON.stringify(fields);
  expect(notes).toMatch(/failed/u);
  expect(notes).not.toMatch(/result\s*=\s*sdk_init_failed/u);
  expect(
    reasons.some(
      ([, field]) =>
        object(field)['required'] === true ||
        JSON.stringify(object(field)['required_when']) === JSON.stringify({ result: 'failed' }) ||
        /failed.{0,120}(?:必带|必填|required|must)/iu.test(String(object(field)['note'])),
    ),
  ).toBe(true);
});

it('[AC-CT-13d#8] 三值外跳保留淘宝 SDK 必带 sdk_open_by 与可选 sdk_error_code 的约束', () => {
  const fields = jumpFields();
  expect(list(at(fields, 'result')['values']).toSorted()).toEqual(results.toSorted());
  expect(at(fields, 'sdk_open_by')).toMatchObject({ type: 'enum', values: ['url', 'code'] });
  const note = text(at(fields, 'sdk_open_by')['note']);
  expect(note).toMatch(/step\s*=\s*sdk/u);
  expect(note).toMatch(/淘宝|百川|taobao/iu);
  expect(note).toMatch(/必带|必填|required|must/iu);
  expect(at(fields, 'sdk_error_code')).toMatchObject({ type: 'string', required: false });
});

it('[AC-CT-13d#9] 待跟单卡仅用本人令牌，requested 或 unknown 计成功、failed 不计，明确规则出处', () => {
  const value = description(contract());
  expect(value).toMatch(/BR-ATTR-21/u);
  expect(value).toMatch(/link_jump/u);
  expect(value).toMatch(/attempt_id/u);
  expect(value).toMatch(
    /(?:本人|登录|authenticated|own|bearer|token).{0,200}(?:待跟单|pending.?track)/iu,
  );
  expect(value).toMatch(
    /requested.{0,100}unknown.{0,160}(?:成功|success)|(?:成功|success).{0,160}requested.{0,100}unknown/iu,
  );
  expect(value).toMatch(/failed.{0,100}(?:不算|不计|不满足|not|exclude|never)/iu);
});

it('[AC-CT-13d#10] 鉴权、签名和版本生成表都包含新接口，生成类型及 planned 路由 schema 同步', () => {
  const doc = contract();
  const op = operation(doc);
  const id = text(op['operationId']);
  const tables = [
    [
      'apps/api/src/modules/platform/http/auth-routes.gen.ts',
      'CONTRACT_AUTH_ROUTES',
      { auth: 'optional' },
    ],
    [
      'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
      'CONTRACT_SIGNING_ROUTES',
      { signed: false },
    ],
    [
      'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
      'CONTRACT_MIN_VERSION_ROUTES',
      { gate: true, operationId: id },
    ],
  ] as const;
  for (const [file, name, expected] of tables) {
    const rows = list(generated(file, name))
      .map(object)
      .filter((row) => row['method'] === 'POST' && row['path'] === path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(expected);
  }
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  const post = property(property(namedInterface(file, 'paths'), path), 'post');
  expect(post.questionToken).toBeUndefined();
  expect(post.type?.getText(file).replaceAll('"', "'")).toBe(`operations['${id}']`);
  property(namedInterface(file, 'operations'), id);
  const planned = initializer(
    'packages/contracts-ts/src/planned-operations.gen.ts',
    'plannedOperations',
  ).getText();
  const schemas = object(
    generated(
      'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
      'CONTRACT_ROUTE_SCHEMAS',
    ),
  );
  if (op['x-implementation'] === 'planned') {
    expect(planned).toContain(JSON.stringify(id));
    expect(schemas).not.toHaveProperty(id);
  } else {
    expect(planned).not.toContain(JSON.stringify(id));
    const validate = compile(doc, at(schemas, id, 'body'));
    check(validate, { events: [event, null] }, true);
    check(validate, { events: 'bad' }, false);
  }
});
