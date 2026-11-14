// CT-24zzi 四个后台操作的登记：operationId、路径、后台鉴权、planned、安全、tag、错误码、权限点
// （任务书第 9 节第 1–4 项）。独立预期，不从契约生成；静态读 contracts、specs 与生成物。
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { at, contract, list, object, op, resolve, text, yaml } from '../admin-order-actions/kit.ts';
import { descOf, noStepUp, permissionEntry, rawParams, routes, tag } from './kit.ts';

function registered(index: number): void {
  const [method, path, operationId, permission, codes] = routes[index]!;
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toBeDefined();
  expect(operation).toMatchObject({
    operationId,
    'x-auth': 'admin',
    'x-implementation': 'planned',
  });
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(list(operation['tags'])).toEqual([tag]);
  // 无 step-up、无 Idempotency-Key（处理接口靠 CAS 防重）、不签名、不走版本闸。
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const names = rawParams(doc, path, method).map((raw) =>
    text(resolve(doc, raw)['name']).toLowerCase(),
  );
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names, name).not.toContain(name);
  if (method === 'get') expect(operation).not.toHaveProperty('requestBody');
  // 错误码恰为任务书所列，且都在错误码目录里。
  const declared = list(operation['x-error-codes']);
  expect(declared).toHaveLength(codes.length);
  expect(declared).toEqual(expect.arrayContaining([...codes]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of declared)
    expect(
      catalog.filter((entry) => entry['code'] === code),
      String(code),
    ).toHaveLength(1);
  // 描述写明权限点、缺权限 10403、无 step-up；权限点本身不标 step-up。
  const desc = descOf(doc, path, method);
  expect(desc).toContain(permission);
  expect(desc).toContain('10403');
  expect(desc).toMatch(noStepUp);
  expect(permissionEntry(permission)).toEqual({
    key: permission,
    step_up_tier: null,
    operations: [],
  });
}

it('[AC-CT-24zzi#1] 登记 GET /admin/v1/agent-traces/sessions：adminListAgentSessions、admin、已实现（不再 planned）、agent.trace、无 step-up、错误码恰为 10001/10403/20001', () => {
  // B1-10q 已实现：同 registered()，只把「x-implementation: planned」改为没有 planned。
  const [method, path, operationId, permission, codes] = routes[0];
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toBeDefined();
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(list(operation['tags'])).toEqual([tag]);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const names = rawParams(doc, path, method).map((raw) =>
    text(resolve(doc, raw)['name']).toLowerCase(),
  );
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names, name).not.toContain(name);
  expect(operation).not.toHaveProperty('requestBody');
  const declared = list(operation['x-error-codes']);
  expect(declared).toHaveLength(codes.length);
  expect(declared).toEqual(expect.arrayContaining([...codes]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of declared)
    expect(
      catalog.filter((entry) => entry['code'] === code),
      String(code),
    ).toHaveLength(1);
  const desc = descOf(doc, path, method);
  expect(desc).toContain(permission);
  expect(desc).toContain('10403');
  expect(desc).toMatch(noStepUp);
  expect(permissionEntry(permission)).toEqual({
    key: permission,
    step_up_tier: null,
    operations: [],
  });
});

it('[AC-CT-24zzi#2] 登记 GET /admin/v1/agent-traces/sessions/{session_id}：adminGetAgentSession、admin、已实现（不再 planned）、agent.trace、无 step-up、错误码恰为 10001/10403/20001', () => {
  // B1-10q 已实现：同 registered()，只把「x-implementation: planned」改为没有 planned。
  const [method, path, operationId, permission, codes] = routes[1];
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toBeDefined();
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(list(operation['tags'])).toEqual([tag]);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const names = rawParams(doc, path, method).map((raw) =>
    text(resolve(doc, raw)['name']).toLowerCase(),
  );
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names, name).not.toContain(name);
  expect(operation).not.toHaveProperty('requestBody');
  const declared = list(operation['x-error-codes']);
  expect(declared).toHaveLength(codes.length);
  expect(declared).toEqual(expect.arrayContaining([...codes]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of declared)
    expect(
      catalog.filter((entry) => entry['code'] === code),
      String(code),
    ).toHaveLength(1);
  const desc = descOf(doc, path, method);
  expect(desc).toContain(permission);
  expect(desc).toContain('10403');
  expect(desc).toMatch(noStepUp);
  expect(permissionEntry(permission)).toEqual({
    key: permission,
    step_up_tier: null,
    operations: [],
  });
});

it('[AC-CT-24zzi#3] 登记 GET /admin/v1/agent-traces/reports：adminListAgentReports、admin、已实现（不再 planned）、agent.trace、无 step-up、错误码恰为 10001/10403/20001', () => {
  // B1-10t 已实现：同 registered()，只把「x-implementation: planned」改为没有 planned。
  // registered() 留在块外（与主干一字不差、仍断言 planned），这里只引用、不调用。
  void registered;
  const [method, path, operationId, permission, codes] = routes[2];
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toBeDefined();
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(operation).not.toHaveProperty('x-implementation');
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(list(operation['tags'])).toEqual([tag]);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const names = rawParams(doc, path, method).map((raw) =>
    text(resolve(doc, raw)['name']).toLowerCase(),
  );
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names, name).not.toContain(name);
  expect(operation).not.toHaveProperty('requestBody');
  const declared = list(operation['x-error-codes']);
  expect(declared).toHaveLength(codes.length);
  expect(declared).toEqual(expect.arrayContaining([...codes]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of declared)
    expect(
      catalog.filter((entry) => entry['code'] === code),
      String(code),
    ).toHaveLength(1);
  const desc = descOf(doc, path, method);
  expect(desc).toContain(permission);
  expect(desc).toContain('10403');
  expect(desc).toMatch(noStepUp);
  expect(permissionEntry(permission)).toEqual({
    key: permission,
    step_up_tier: null,
    operations: [],
  });
});

it('[AC-CT-24zzi#4] 登记 POST /admin/v1/agent-traces/reports/{message_id}/handle：adminHandleAgentReport、admin、已实现（不再 planned）、agent.report、无 step-up 与 Idempotency-Key、错误码恰为 10001/10403/20001/20902', () => {
  // B1-10t 已实现：同 registered()，只把「x-implementation: planned」改为没有 planned。
  const [method, path, operationId, permission, codes] = routes[3];
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toBeDefined();
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(operation).not.toHaveProperty('x-implementation');
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(list(operation['tags'])).toEqual([tag]);
  // 无 step-up、无 Idempotency-Key（处理接口靠 CAS 防重）、不签名、不走版本闸。
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const names = rawParams(doc, path, method).map((raw) =>
    text(resolve(doc, raw)['name']).toLowerCase(),
  );
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names, name).not.toContain(name);
  const declared = list(operation['x-error-codes']);
  expect(declared).toHaveLength(codes.length);
  expect(declared).toEqual(expect.arrayContaining([...codes]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of declared)
    expect(
      catalog.filter((entry) => entry['code'] === code),
      String(code),
    ).toHaveLength(1);
  const desc = descOf(doc, path, method);
  expect(desc).toContain(permission);
  expect(desc).toContain('10403');
  expect(desc).toMatch(noStepUp);
  expect(permissionEntry(permission)).toEqual({
    key: permission,
    step_up_tier: null,
    operations: [],
  });
});

it('[AC-CT-24zzi#5] 顶层 tags 登记 admin-agent-traces；生成的 planned 清单不含 #1 / #2 / #3 / #4 四个已实现（不再 planned）的操作', () => {
  const doc = contract();
  const tags = list(doc['tags']).map((entry) => text(at(entry)['name']));
  expect(tags).toContain(tag);
  for (const [, , operationId] of routes)
    expect(plannedOperations.has(operationId), operationId).toBe(false);
});

it('[AC-CT-24zzi#6] 错误码目录 20902 的 data.resource 登记 agent_report', () => {
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const conflict = catalog.filter((entry) => entry['code'] === 20902);
  expect(conflict).toHaveLength(1);
  expect(list(at(conflict[0], 'data')['resource'])).toContain('agent_report');
});
