import { expect, it } from 'vitest';
import {
  accepts,
  at,
  contract,
  data,
  description,
  importPath,
  list,
  field,
  op,
  params,
  resolve,
  required,
  response,
  routes,
  text,
  yaml,
} from './kit.ts';

function assertPlannedRegistration(
  method: string,
  path: string,
  operationId: string,
  permission: string,
): void {
  const doc = contract();
  const operation = op(doc, path, method);
  expect(operation).toMatchObject({
    operationId,
    'x-auth': 'admin',
    'x-implementation': 'planned',
  });
  expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
  expect(description(doc, path, method)).toContain(permission);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false]).toContain(operation[key]);
  expect(operation).not.toHaveProperty('x-step-up');
  const parameters = params(doc, path, method);
  const names = parameters.map((param) => text(param['name']).toLowerCase());
  expect(names).not.toContain('idempotency-key');
  expect(names).not.toContain('x-app-id');
  expect(names).not.toContain('x-sign');
  const needsToken = method === 'post' && (path === importPath || path.endsWith('/reassign'));
  expect(names.includes('x-step-up-token')).toBe(needsToken);
  if (needsToken) {
    expect(description(doc, path, method)).toMatch(/totp|动态码/i);
    expect(parameters.find((param) => param['name'] === 'X-Step-Up-Token')).toMatchObject({
      in: 'header',
      required: false,
    });
    expect(list(operation['x-error-codes'])).toContain(10003);
  }
  for (const name of ['order_id', 'import_id']) {
    if (!path.includes(`{${name}}`)) continue;
    const parameter = parameters.find((entry) => entry['name'] === name);
    expect(parameter).toMatchObject({ in: 'path', required: true });
    expect(resolve(doc, at(parameter, 'schema'))).toEqual(
      resolve(doc, at(doc, 'components', 'schemas', 'Id')),
    );
  }
  const codes = list(operation['x-error-codes']);
  expect(codes).toEqual(expect.arrayContaining([10001, 10403]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
  for (const code of codes) {
    expect(catalog.filter((entry) => at(entry)['code'] === code)).toHaveLength(1);
  }
  const schema = response(doc, path, method);
  expect(schema['required']).toEqual(expect.arrayContaining(['code', 'msg', 'data', 'trace_id']));
  accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
  for (const raw of Object.values(at(operation, 'responses'))) {
    const header = resolve(doc, at(resolve(doc, raw), 'headers', 'X-Trace-Id'));
    expect(resolve(doc, at(header, 'schema'))['type']).toBe('string');
  }
}

it.each(
  routes.filter((r): boolean =>
    ['adminCreateRightsImport', 'adminListRightsImports', 'adminGetRightsImport'].includes(r[2]),
  ),
)(
  '[AC-CT-24n#1] %s %s（维权导入）登记 %s、后台权限和已实现（不再 planned）',
  (method, path, operationId, permission) => {
    const doc = contract();
    const operation = op(doc, path, method);
    expect(operation).toMatchObject({
      operationId,
      'x-auth': 'admin',
    });
    expect(operation['x-implementation']).toBeUndefined();
    expect(() => assertPlannedRegistration(method, path, operationId, permission)).toThrow();
    expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(description(doc, path, method)).toContain(permission);
    for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
      expect([undefined, false]).toContain(operation[key]);
    expect(operation).not.toHaveProperty('x-step-up');
    const parameters = params(doc, path, method);
    const names = parameters.map((param) => text(param['name']).toLowerCase());
    expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-app-id');
    expect(names).not.toContain('x-sign');
    const needsToken = method === 'post' && (path === importPath || path.endsWith('/reassign'));
    expect(names.includes('x-step-up-token')).toBe(needsToken);
    if (needsToken) {
      expect(description(doc, path, method)).toMatch(/totp|动态码/i);
      expect(parameters.find((param) => param['name'] === 'X-Step-Up-Token')).toMatchObject({
        in: 'header',
        required: false,
      });
      expect(list(operation['x-error-codes'])).toContain(10003);
    }
    for (const name of ['order_id', 'import_id']) {
      if (!path.includes(`{${name}}`)) continue;
      const parameter = parameters.find((entry) => entry['name'] === name);
      expect(parameter).toMatchObject({ in: 'path', required: true });
      expect(resolve(doc, at(parameter, 'schema'))).toEqual(
        resolve(doc, at(doc, 'components', 'schemas', 'Id')),
      );
    }
    const codes = list(operation['x-error-codes']);
    expect(codes).toEqual(expect.arrayContaining([10001, 10403]));
    const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
    for (const code of codes) {
      expect(catalog.filter((entry) => at(entry)['code'] === code)).toHaveLength(1);
    }
    const schema = response(doc, path, method);
    expect(schema['required']).toEqual(expect.arrayContaining(['code', 'msg', 'data', 'trace_id']));
    accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
    for (const raw of Object.values(at(operation, 'responses'))) {
      const header = resolve(doc, at(resolve(doc, raw), 'headers', 'X-Trace-Id'));
      expect(resolve(doc, at(header, 'schema'))['type']).toBe('string');
    }
  },
);

it.each(
  routes.filter((r): boolean =>
    ['adminHoldOrder', 'adminUnholdOrder', 'adminReassignOrder'].includes(r[2]),
  ),
)(
  '[AC-CT-24n#1] %s %s（订单写操作）登记 %s、后台权限和已实现（不再 planned）',
  (method, path, operationId, permission) => {
    const doc = contract();
    const operation = op(doc, path, method);
    expect(operation).toMatchObject({
      operationId,
      'x-auth': 'admin',
    });
    expect(operation['x-implementation']).toBeUndefined();
    expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(description(doc, path, method)).toContain(permission);
    for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
      expect([undefined, false]).toContain(operation[key]);
    expect(operation).not.toHaveProperty('x-step-up');
    const parameters = params(doc, path, method);
    const names = parameters.map((param) => text(param['name']).toLowerCase());
    expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-app-id');
    expect(names).not.toContain('x-sign');
    const needsToken = method === 'post' && (path === importPath || path.endsWith('/reassign'));
    expect(names.includes('x-step-up-token')).toBe(needsToken);
    if (needsToken) {
      expect(description(doc, path, method)).toMatch(/totp|动态码/i);
      expect(parameters.find((param) => param['name'] === 'X-Step-Up-Token')).toMatchObject({
        in: 'header',
        required: false,
      });
      expect(list(operation['x-error-codes'])).toContain(10003);
    }
    for (const name of ['order_id', 'import_id']) {
      if (!path.includes(`{${name}}`)) continue;
      const parameter = parameters.find((entry) => entry['name'] === name);
      expect(parameter).toMatchObject({ in: 'path', required: true });
      expect(resolve(doc, at(parameter, 'schema'))).toEqual(
        resolve(doc, at(doc, 'components', 'schemas', 'Id')),
      );
    }
    const codes = list(operation['x-error-codes']);
    expect(codes).toEqual(expect.arrayContaining([10001, 10403]));
    const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
    for (const code of codes) {
      expect(catalog.filter((entry) => at(entry)['code'] === code)).toHaveLength(1);
    }
    const schema = response(doc, path, method);
    expect(schema['required']).toEqual(expect.arrayContaining(['code', 'msg', 'data', 'trace_id']));
    accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
    for (const raw of Object.values(at(operation, 'responses'))) {
      const header = resolve(doc, at(resolve(doc, raw), 'headers', 'X-Trace-Id'));
      expect(resolve(doc, at(header, 'schema'))['type']).toBe('string');
    }
  },
);

it.each(
  routes.filter((r): boolean =>
    ['adminCreateOrderSync', 'adminListOrderSyncs', 'adminGetOrderSyncLimits'].includes(r[2]),
  ),
)(
  '[AC-CT-24n#1] %s %s（手动同步）登记 %s、后台权限和已实现（不再 planned）',
  (method, path, operationId, permission) => {
    const doc = contract();
    const operation = op(doc, path, method);
    expect(operation).toMatchObject({
      operationId,
      'x-auth': 'admin',
    });
    expect(operation['x-implementation']).toBeUndefined();
    expect(operation['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(description(doc, path, method)).toContain(permission);
    for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
      expect([undefined, false]).toContain(operation[key]);
    expect(operation).not.toHaveProperty('x-step-up');
    const parameters = params(doc, path, method);
    const names = parameters.map((param) => text(param['name']).toLowerCase());
    expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-app-id');
    expect(names).not.toContain('x-sign');
    const needsToken = method === 'post' && (path === importPath || path.endsWith('/reassign'));
    expect(names.includes('x-step-up-token')).toBe(needsToken);
    if (needsToken) {
      expect(description(doc, path, method)).toMatch(/totp|动态码/i);
      expect(parameters.find((param) => param['name'] === 'X-Step-Up-Token')).toMatchObject({
        in: 'header',
        required: false,
      });
      expect(list(operation['x-error-codes'])).toContain(10003);
    }
    for (const name of ['order_id', 'import_id']) {
      if (!path.includes(`{${name}}`)) continue;
      const parameter = parameters.find((entry) => entry['name'] === name);
      expect(parameter).toMatchObject({ in: 'path', required: true });
      expect(resolve(doc, at(parameter, 'schema'))).toEqual(
        resolve(doc, at(doc, 'components', 'schemas', 'Id')),
      );
    }
    const codes = list(operation['x-error-codes']);
    expect(codes).toEqual(expect.arrayContaining([10001, 10403]));
    const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
    for (const code of codes) {
      expect(catalog.filter((entry) => at(entry)['code'] === code)).toHaveLength(1);
    }
    const schema = response(doc, path, method);
    expect(schema['required']).toEqual(expect.arrayContaining(['code', 'msg', 'data', 'trace_id']));
    accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
    for (const raw of Object.values(at(operation, 'responses'))) {
      const header = resolve(doc, at(resolve(doc, raw), 'headers', 'X-Trace-Id'));
      expect(resolve(doc, at(header, 'schema'))['type']).toBe('string');
    }
  },
);

it.each(['/admin/v1/order-syncs', '/admin/v1/rights-imports'])(
  '[AC-CT-24n#2] %s 使用后台页码分页',
  (path) => {
    const doc = contract();
    const parameters = params(doc, path, 'get');
    for (const name of ['page', 'page_size']) {
      const parameter = parameters.find((entry) => entry['name'] === name);
      expect(parameter).toMatchObject({ in: 'query' });
      expect(resolve(doc, at(parameter, 'schema'))).toMatchObject({ type: 'integer', minimum: 1 });
    }
    const size = parameters.find((entry) => entry['name'] === 'page_size');
    expect(resolve(doc, at(size, 'schema'))['maximum']).toBe(200);
    expect(parameters.map((entry) => entry['name'])).not.toContain('cursor');
    const page = data(doc, path, 'get');
    required(page, ['items', 'page', 'page_size', 'total']);
    expect(field(doc, page, 'items')['type']).toBe('array');
    accepts(doc, field(doc, page, 'page'), [1, 2], [0, -1, 1.5, '1', null]);
    accepts(doc, field(doc, page, 'page_size'), [1, 200], [0, 201, 1.5, '1', null]);
    accepts(doc, field(doc, page, 'total'), [0, 1], [-1, 1.5, '1', null]);
  },
);

it('[AC-CT-24n#3] channel 导入的额外权限和动态码仅条件适用', () => {
  const doc = contract();
  const desc = description(doc, importPath);
  for (const word of ['channel', 'order.claim', 'risk.blocklist']) expect(desc).toContain(word);
  expect(desc).toMatch(/totp|动态码/i);
  expect(desc).toMatch(/only|仅|只有/i);
  expect(op(doc, importPath)).not.toHaveProperty('x-step-up');
});
