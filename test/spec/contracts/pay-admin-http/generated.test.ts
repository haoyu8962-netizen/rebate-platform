import ts from 'typescript';
import { expect, it } from 'vitest';
import { contract, endpoints, list, object, operation, read } from './kit.ts';

// 生成物只作文本/AST 读取，不 import、eval 或调用生成器。
function generated(path: string, name: string): unknown {
  const source = ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  expect(declarations).toHaveLength(1);
  let value = declarations[0]!.initializer;
  expect(value).toBeDefined();
  while (
    value &&
    (ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isParenthesizedExpression(value))
  )
    value = value.expression;
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(value!.getText());
  }).not.toThrow();
  return parsed;
}

it.each(
  endpoints.filter((e): boolean => e[2] === 'listAdminPayRefunds' || e[2] === 'getAdminPayRefund'),
)(
  '[AC-CT-21e#17] %s %s（退款单查询）已实现（不再 planned）、已生成类型、后台鉴权和无签名策略，并挂载校验路由',
  (method, path, id, permission) => {
    // B2-15o：两条退款单查询已实现，x-implementation 随路由上线移除；必须挂载校验路由。
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    const op = operation(contract(), endpoint);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    expect(schemas, `route-schemas.gen.ts: ${id}`).toHaveProperty(id);
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);

it.each(endpoints.filter((e): boolean => e[2] === 'listAdminPayReconDiffs'))(
  '[AC-CT-21e#17] %s %s（对账差错）已实现（不再 planned）、已生成类型、后台鉴权和无签名策略，并挂载校验路由',
  (method, path, id, permission) => {
    // B2-15j：对账差错列表已实现，x-implementation 随路由上线移除；
    // 必须挂载与契约一致的运行时请求校验。
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    const doc = contract();
    const op = operation(doc, endpoint);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    // 形状与契约一致：GET 无请求体、无 Idempotency-Key、无动态码；无路径参数；
    // 查询参数取自契约（page、page_size、type、status）且无多余。
    expect(schemas, `route-schemas.gen.ts: ${id}`).toHaveProperty(id);
    const entry = object(schemas[id]);
    const headers = object(entry['headers']);
    expect(headers['type']).toBe('object');
    expect(object(headers['properties'])).not.toHaveProperty(['idempotency-key']);
    expect(list(headers['required'] ?? [])).not.toContain('idempotency-key');
    expect(object(headers['properties'])).not.toHaveProperty(['x-step-up-token']);
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    expect(names).toEqual([]);
    expect(entry).not.toHaveProperty('params');
    // 路径级与操作级参数合并，逐个解析 #/ 引用（与 kit.ts 的 parameters / resolve 同义）。
    const pathItem = object(object(doc['paths'])[endpoint[1]]);
    const queries = [...list(pathItem['parameters'] ?? []), ...list(op['parameters'] ?? [])]
      .map((raw) => {
        let p = object(raw);
        const seen = new Set<string>();
        while (p['$ref'] !== undefined) {
          const ref = p['$ref'];
          expect(ref).toBeTypeOf('string');
          const pointer = String(ref);
          expect(pointer.startsWith('#/')).toBe(true);
          expect(seen.has(pointer), `循环引用 ${pointer}`).toBe(false);
          seen.add(pointer);
          p = object(
            pointer
              .slice(2)
              .split('/')
              .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
              .reduce<unknown>((node, key) => object(node)[key], doc),
          );
        }
        return p;
      })
      .filter((p) => p['in'] === 'query')
      .map((p) => String(p['name']));
    expect(queries.toSorted()).toEqual(['page', 'page_size', 'status', 'type']);
    const querystring = object(entry['querystring']);
    expect(querystring['type']).toBe('object');
    expect(Object.keys(object(querystring['properties'])).sort()).toEqual(queries.toSorted());
    expect(querystring['additionalProperties']).toBe(false);
    expect(method).toBe('get');
    expect(entry).not.toHaveProperty('body');
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);

// 标题沿用原文，二次验证期望以块内断言为准。
it.each(
  endpoints.filter(
    (e): boolean =>
      e[2] === 'listAdminPayOrders' ||
      e[2] === 'getAdminPayOrder' ||
      e[2] === 'resolveAdminPayOrder' ||
      e[2] === 'listAdminPayAnomalies',
  ),
)(
  '[AC-CT-21e#17] %s %s（支付单查询与处置）已生成类型、后台鉴权和无签名策略，已实现（不再 planned）并挂载校验路由',
  (method, path, id, permission) => {
    // B2-15f：四条支付单查询与处置操作已实现，x-implementation 随路由上线移除；
    // 必须挂载与契约一致的运行时请求校验。
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    const doc = contract();
    const op = operation(doc, endpoint);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    // 形状与契约一致：无 Idempotency-Key；头部不带二次验证凭证；路径参数与查询参数取自契约且无多余；
    // 只有处置有请求体（固定的 expected_status / action）。
    expect(schemas, `route-schemas.gen.ts: ${id}`).toHaveProperty(id);
    const entry = object(schemas[id]);
    const headers = object(entry['headers']);
    expect(headers['type']).toBe('object');
    expect(object(headers['properties'])).not.toHaveProperty(['idempotency-key']);
    expect(list(headers['required'] ?? [])).not.toContain('idempotency-key');
    expect(object(headers['properties'])).not.toHaveProperty(['x-step-up-token']);
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    if (names.length === 0) {
      expect(entry).not.toHaveProperty('params');
    } else {
      const params = object(entry['params']);
      expect(params['type']).toBe('object');
      expect(Object.keys(object(params['properties']))).toEqual(names);
      expect(list(params['required'])).toEqual(names);
    }
    // 路径级与操作级参数合并，逐个解析 #/ 引用（与 kit.ts 的 parameters / resolve 同义）。
    const pathItem = object(object(doc['paths'])[endpoint[1]]);
    const queries = [...list(pathItem['parameters'] ?? []), ...list(op['parameters'] ?? [])]
      .map((raw) => {
        let p = object(raw);
        const seen = new Set<string>();
        while (p['$ref'] !== undefined) {
          const ref = p['$ref'];
          expect(ref).toBeTypeOf('string');
          const pointer = String(ref);
          expect(pointer.startsWith('#/')).toBe(true);
          expect(seen.has(pointer), `循环引用 ${pointer}`).toBe(false);
          seen.add(pointer);
          p = object(
            pointer
              .slice(2)
              .split('/')
              .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
              .reduce<unknown>((node, key) => object(node)[key], doc),
          );
        }
        return p;
      })
      .filter((p) => p['in'] === 'query')
      .map((p) => String(p['name']));
    if (queries.length === 0) {
      expect(entry).not.toHaveProperty('querystring');
    } else {
      const querystring = object(entry['querystring']);
      expect(querystring['type']).toBe('object');
      expect(Object.keys(object(querystring['properties'])).sort()).toEqual(queries.sort());
      expect(querystring['additionalProperties']).toBe(false);
    }
    if (method === 'get') {
      expect(entry).not.toHaveProperty('body');
    } else {
      const body = object(entry['body']);
      expect(body['type']).toBe('object');
      expect(body['additionalProperties']).toBe(false);
      expect(list(body['required'])).toEqual(expect.arrayContaining(['expected_status', 'action']));
      expect(Object.keys(object(body['properties'])).sort()).toEqual(['action', 'expected_status']);
    }
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);

it.each(
  endpoints.filter(
    (e): boolean => e[2] === 'createAdminPayRefund' || e[2] === 'createAdminPayAnomalyRefund',
  ),
)(
  '[AC-CT-21e#17] %s %s（退款）已生成类型、后台鉴权和无签名策略，已实现（不再 planned）并挂载校验路由',
  (method, path, id, permission) => {
    // B2-15e：两条原路退款操作已实现，必须挂载与契约一致的运行时请求校验。
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    const op = operation(contract(), endpoint);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    // 形状与契约一致：头部含必填 Idempotency-Key，路径参数只有路径里那一个且必填，请求体为退款请求。
    expect(schemas, `route-schemas.gen.ts: ${id}`).toHaveProperty(id);
    const entry = object(schemas[id]);
    const headers = object(entry['headers']);
    expect(headers['type']).toBe('object');
    expect(object(headers['properties'])).toHaveProperty(['idempotency-key']);
    expect(list(headers['required'])).toContain('idempotency-key');
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    expect(names).toHaveLength(1);
    const params = object(entry['params']);
    expect(params['type']).toBe('object');
    expect(Object.keys(object(params['properties']))).toEqual(names);
    expect(list(params['required'])).toEqual(names);
    const body = object(entry['body']);
    expect(body['type']).toBe('object');
    expect(body['additionalProperties']).toBe(false);
    expect(list(body['required'])).toEqual(expect.arrayContaining(['amount_fen', 'reason_code']));
    expect(Object.keys(object(body['properties'])).sort()).toEqual([
      'amount_fen',
      'note',
      'reason_code',
    ]);
    expect(entry).not.toHaveProperty('querystring');
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);
