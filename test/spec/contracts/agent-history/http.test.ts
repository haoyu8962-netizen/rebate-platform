import { expect, it } from 'vitest';
import {
  at,
  check,
  closed,
  compile,
  contract,
  endpoints,
  envelope,
  feedbackPath,
  jsonResponse,
  list,
  object,
  operation,
  opsEnums,
  parameters,
  reportPath,
  text,
  yaml,
  type Obj,
} from './kit.ts';

// CT-08e §9 的契约范围；不调用控制器，不重复 CT-08d 的四个接口。
it.each(endpoints)(
  '[AC-CT-08e#1] %s %s（%s）标注、设备头、版本闸门及 JSON 错误外壳',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    expect(op['operationId']).toBe(id);
    expect(list(op['tags'])).toContain('agent');
    expect(op['x-auth']).toBe('optional');
    expect(op['security']).toEqual([{}, { bearerAuth: [] }]);
    expect(op['x-signed']).toBe(false);
    expect(op['x-idempotent']).toBe(false);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op).not.toHaveProperty('x-session-scopes');
    if (method === 'post') {
      expect(op['x-min-version-gate']).toBe(true);
      expect(list(op['x-error-codes'])).toContain(10405);
    } else {
      expect(op).not.toHaveProperty('x-min-version-gate');
    }
    const params = parameters(doc, method, path);
    const headers = params.filter((param) => param['in'] === 'header');
    expect(headers).toContainEqual(
      expect.objectContaining({ name: 'X-Device-Id', required: true }),
    );
    const names = headers.map((header) => text(header['name']).toLowerCase());
    for (const forbidden of ['x-timestamp', 'x-nonce', 'x-sign', 'idempotency-key']) {
      expect(names).not.toContain(forbidden);
    }
    expect(params).toContainEqual(
      expect.objectContaining({
        name: method === 'get' ? 'id' : 'message_id',
        in: 'path',
        required: true,
      }),
    );
    expect(at(op, 'responses', '429', 'headers', 'Retry-After')['required']).toBe(true);
    for (const status of ['4XX', '5XX']) {
      const content = at(op, 'responses', status, 'content');
      expect(Object.keys(content)).toEqual(['application/json']);
      expect(at(content, 'application/json', 'schema')).toEqual(
        at(doc, 'components', 'schemas', 'ErrorEnvelope'),
      );
    }
  },
);

it.each(endpoints)(
  '[AC-CT-08e#2] %s %s（%s）覆盖归属与目标检查所需的有效错误码',
  async (method, path) => {
    const op = operation(await contract(), method, path);
    const required = [30501, 10001, 10005, 10004, 30504];
    if (method === 'post') required.push(20001, 10405);
    const listed = list(op['x-error-codes']);
    expect(listed).toEqual(expect.arrayContaining(required));
    const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
    for (const code of listed) {
      expect(code).toBeTypeOf('number');
      const matches = codes.filter((entry) => entry['code'] === code);
      expect(matches, `错误码 ${String(code)} 必须唯一登记`).toHaveLength(1);
      expect([undefined, false]).toContain(object(matches[0])['deprecated']);
    }
  },
);

function requestSchema(op: Obj, key: string): Obj {
  const body = at(op, 'requestBody');
  expect(body['required']).toBe(true);
  const content = at(body, 'content');
  expect(Object.keys(content)).toEqual(['application/json']);
  const schema = at(content, 'application/json', 'schema');
  closed(schema, [key]);
  return schema;
}

it('[AC-CT-08e#7] feedback 只接受必填 up/down，拒绝撤销值和多余字段', async () => {
  const op = operation(await contract(), 'post', feedbackPath);
  const schema = requestSchema(op, 'feedback');
  expect(list(at(schema, 'properties', 'feedback')['enum']).toSorted()).toEqual(['down', 'up']);
  const validate = compile(schema);
  for (const feedback of ['up', 'down']) check(validate, { feedback }, true);
  for (const feedback of [null, 'none', '', 'UP', 1, {}, []]) {
    check(validate, { feedback }, false);
  }
  for (const body of [{}, null, [], { feedback: 'up', note: 'extra' }]) {
    check(validate, body, false);
  }
});

it('[AC-CT-08e#8] reason 是必填的 1–200 字自由文本，封闭且不自造原因枚举', async () => {
  const op = operation(await contract(), 'post', reportPath);
  const schema = requestSchema(op, 'reason');
  const reason = at(schema, 'properties', 'reason');
  expect(reason['type']).toBe('string');
  expect(reason['minLength']).toBe(1);
  expect(reason['maxLength']).toBe(200);
  expect(reason).not.toHaveProperty('enum');
  const validate = compile(schema);
  for (const reason of ['错', '任意原因，不使用分类枚举', '字'.repeat(200)]) {
    check(validate, { reason }, true);
  }
  for (const reason of ['', '字'.repeat(201), null, 1, {}, []]) {
    check(validate, { reason }, false);
  }
  for (const body of [{}, null, [], { reason: '错误', note: 'extra' }]) {
    check(validate, body, false);
  }
});

it.each([feedbackPath, reportPath])(
  '[AC-CT-08e#7][AC-CT-08e#8] %s 成功响应复用 EmptyResponse',
  async (path) => {
    const doc = await contract();
    const schema = at(jsonResponse(operation(doc, 'post', path)), 'schema');
    expect(schema).toBe(at(doc, 'components', 'schemas', 'EmptyResponse'));
    const validate = compile(schema);
    check(validate, envelope({}), true);
    for (const data of [null, [], '', { message_id: 'unexpected' }]) {
      check(validate, envelope(data), false);
    }
    const missing = envelope({});
    delete missing['data'];
    check(validate, missing, false);
  },
);

it('[AC-CT-08e#8][AC-CT-08e#9] 新举报契约使用 reason，废弃草稿的三个枚举均不出现', async () => {
  const schema = requestSchema(operation(await contract(), 'post', reportPath), 'reason');
  expect(at(schema, 'properties', 'reason')['type']).toBe('string');
  const enums = opsEnums();
  for (const name of ['agent_reply_status', 'agent_reply_content_status', 'agent_report_reason']) {
    expect(enums).not.toHaveProperty(name);
  }
});
