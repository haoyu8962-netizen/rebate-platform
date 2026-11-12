import { expect, it } from 'vitest';
import {
  at,
  contract,
  historyEndpoint,
  list,
  object,
  operation,
  parameters,
  text,
  yaml,
} from './kit.ts';

// B3-08ze（D10-1347、D10-1385、D10-1390）：http.test.ts 里 [AC-CT-08e#1]、[AC-CT-08e#2] 两个 .each 的历史接口行
// 合成这里一条（先 #1 后 #2），断言与原回调对 get 行一条不少；只把 x-implementation 的期望改为不存在。
const [method, path, id] = historyEndpoint;

it('[AC-CT-08e#1][AC-CT-08e#2] get /v1/agent/sessions/{id}/messages（listAgentSessionMessages）标注、设备头、版本闸门及 JSON 错误外壳；覆盖归属与目标检查所需的有效错误码', async () => {
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
  expect(op).not.toHaveProperty('x-min-version-gate');
  const params = parameters(doc, method, path);
  const headers = params.filter((param) => param['in'] === 'header');
  expect(headers).toContainEqual(expect.objectContaining({ name: 'X-Device-Id', required: true }));
  const names = headers.map((header) => text(header['name']).toLowerCase());
  for (const forbidden of ['x-timestamp', 'x-nonce', 'x-sign', 'idempotency-key']) {
    expect(names).not.toContain(forbidden);
  }
  expect(params).toContainEqual(
    expect.objectContaining({
      name: 'id',
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
  const required = [30501, 10001, 10005, 10004, 30504];
  const listed = list(op['x-error-codes']);
  expect(listed).toEqual(expect.arrayContaining(required));
  const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of listed) {
    expect(code).toBeTypeOf('number');
    const matches = codes.filter((entry) => entry['code'] === code);
    expect(matches, `错误码 ${String(code)} 必须唯一登记`).toHaveLength(1);
    expect([undefined, false]).toContain(object(matches[0])['deprecated']);
  }
});
