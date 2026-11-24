import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  endpoints,
  list,
  lists,
  object,
  operation,
  parameters,
  read,
  refunds,
  resolve,
  resolveEndpoint,
  values,
  yaml,
} from './kit.ts';

it.each(
  endpoints.filter((e): boolean => e[2] === 'listAdminPayRefunds' || e[2] === 'getAdminPayRefund'),
)(
  '[AC-CT-21e#1] %s %s（退款单查询）已实现（不再 planned）、后台鉴权与权限点',
  (method, path, id, permission) => {
    // B2-15o：两条退款单查询已实现，x-implementation 随路由上线移除。
    const doc = contract();
    const endpoint = endpoints.find((e) => e[2] === id)!;
    const op = operation(doc, endpoint);
    expect(op['operationId']).toBe(id);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    expect(op['x-auth']).toBe('admin');
    expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(op['description']).toMatch(
      new RegExp('Permission point:?\\s+`' + permission.replace('.', '\\.') + '`'),
    );
    expect([undefined, false]).toContain(op['x-signed']);
    expect(op).not.toHaveProperty('x-min-version-gate');
    expect(op).not.toHaveProperty('x-session-scopes');
    const params = parameters(doc, endpoint);
    for (const forbidden of [
      'X-App-Id',
      'X-Platform',
      'X-Device-Id',
      'X-Sign',
      'X-Timestamp',
      'X-Nonce',
    ]) {
      expect(params.map((p) => String(p['name']).toLowerCase())).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      expect(params).toContainEqual(
        expect.objectContaining({ in: 'path', name: match[1], required: true }),
      );
    }
    for (const entry of Object.values(at(op, 'responses'))) {
      expect(resolve(doc, entry)).toHaveProperty('headers.X-Trace-Id');
    }
    if (method === 'get') {
      expect(op).not.toHaveProperty('requestBody');
      expect(op).not.toHaveProperty('x-step-up');
      expect(params.map((p) => p['name'])).not.toContain('X-Step-Up-Token');
      expect(params.map((p) => p['name'])).not.toContain('Idempotency-Key');
    }
  },
);

it.each(endpoints.filter((e): boolean => e[2] === 'listAdminPayReconDiffs'))(
  '[AC-CT-21e#1] %s %s（对账差错）已实现（不再 planned）、后台鉴权与权限点',
  (method, path, id, permission) => {
    // B2-15j：对账差错列表已实现，x-implementation 随路由上线移除。
    const doc = contract();
    const endpoint = endpoints.find((e) => e[2] === id)!;
    const op = operation(doc, endpoint);
    expect(op['operationId']).toBe(id);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    expect(op['x-auth']).toBe('admin');
    expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(op['description']).toMatch(
      new RegExp('Permission point:?\\s+`' + permission.replace('.', '\\.') + '`'),
    );
    expect([undefined, false]).toContain(op['x-signed']);
    expect(op).not.toHaveProperty('x-min-version-gate');
    expect(op).not.toHaveProperty('x-session-scopes');
    const params = parameters(doc, endpoint);
    for (const forbidden of [
      'X-App-Id',
      'X-Platform',
      'X-Device-Id',
      'X-Sign',
      'X-Timestamp',
      'X-Nonce',
    ]) {
      expect(params.map((p) => String(p['name']).toLowerCase())).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      expect(params).toContainEqual(
        expect.objectContaining({ in: 'path', name: match[1], required: true }),
      );
    }
    for (const entry of Object.values(at(op, 'responses'))) {
      expect(resolve(doc, entry)).toHaveProperty('headers.X-Trace-Id');
    }
    if (method === 'get') {
      expect(op).not.toHaveProperty('requestBody');
      expect(op).not.toHaveProperty('x-step-up');
      expect(params.map((p) => p['name'])).not.toContain('X-Step-Up-Token');
      expect(params.map((p) => p['name'])).not.toContain('Idempotency-Key');
    }
  },
);

it.each(
  endpoints.filter(
    (e): boolean =>
      e[2] === 'listAdminPayOrders' ||
      e[2] === 'getAdminPayOrder' ||
      e[2] === 'resolveAdminPayOrder' ||
      e[2] === 'listAdminPayAnomalies',
  ),
)(
  '[AC-CT-21e#1] %s %s（支付单查询与处置）已实现（不再 planned）、后台鉴权与权限点',
  (method, path, id, permission) => {
    // B2-15f：四条支付单查询与处置操作已实现，x-implementation 随路由上线移除。
    const doc = contract();
    const endpoint = endpoints.find((e) => e[2] === id)!;
    const op = operation(doc, endpoint);
    expect(op['operationId']).toBe(id);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    expect(op['x-auth']).toBe('admin');
    expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(op['description']).toMatch(
      new RegExp('Permission point:?\\s+`' + permission.replace('.', '\\.') + '`'),
    );
    expect([undefined, false]).toContain(op['x-signed']);
    expect(op).not.toHaveProperty('x-min-version-gate');
    expect(op).not.toHaveProperty('x-session-scopes');
    const params = parameters(doc, endpoint);
    for (const forbidden of [
      'X-App-Id',
      'X-Platform',
      'X-Device-Id',
      'X-Sign',
      'X-Timestamp',
      'X-Nonce',
    ]) {
      expect(params.map((p) => String(p['name']).toLowerCase())).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      expect(params).toContainEqual(
        expect.objectContaining({ in: 'path', name: match[1], required: true }),
      );
    }
    for (const entry of Object.values(at(op, 'responses'))) {
      expect(resolve(doc, entry)).toHaveProperty('headers.X-Trace-Id');
    }
    if (method === 'get') {
      expect(op).not.toHaveProperty('requestBody');
      expect(op).not.toHaveProperty('x-step-up');
      expect(params.map((p) => p['name'])).not.toContain('X-Step-Up-Token');
      expect(params.map((p) => p['name'])).not.toContain('Idempotency-Key');
    }
  },
);

it.each(
  endpoints.filter(
    (e): boolean => e[2] === 'createAdminPayRefund' || e[2] === 'createAdminPayAnomalyRefund',
  ),
)(
  '[AC-CT-21e#1] %s %s（退款）已实现（不再 planned）、后台鉴权与权限点',
  (method, path, id, permission) => {
    // B2-15e：两条原路退款操作已实现，x-implementation 随路由上线移除。
    const doc = contract();
    const endpoint = endpoints.find((e) => e[2] === id)!;
    const op = operation(doc, endpoint);
    expect(op['operationId']).toBe(id);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
    expect(op['x-auth']).toBe('admin');
    expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
    expect(op['description']).toMatch(
      new RegExp('Permission point:?\\s+`' + permission.replace('.', '\\.') + '`'),
    );
    expect([undefined, false]).toContain(op['x-signed']);
    expect(op).not.toHaveProperty('x-min-version-gate');
    expect(op).not.toHaveProperty('x-session-scopes');
    const params = parameters(doc, endpoint);
    for (const forbidden of [
      'X-App-Id',
      'X-Platform',
      'X-Device-Id',
      'X-Sign',
      'X-Timestamp',
      'X-Nonce',
    ]) {
      expect(params.map((p) => String(p['name']).toLowerCase())).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      expect(params).toContainEqual(
        expect.objectContaining({ in: 'path', name: match[1], required: true }),
      );
    }
    for (const entry of Object.values(at(op, 'responses'))) {
      expect(resolve(doc, entry)).toHaveProperty('headers.X-Trace-Id');
    }
    if (method === 'get') {
      expect(op).not.toHaveProperty('requestBody');
      expect(op).not.toHaveProperty('x-step-up');
      expect(params.map((p) => p['name'])).not.toContain('X-Step-Up-Token');
      expect(params.map((p) => p['name'])).not.toContain('Idempotency-Key');
    }
  },
);

it.each(lists)('[AC-CT-21e#2] %s %s 使用后台页码且 page_size 上限为 200', (...endpoint) => {
  const doc = contract();
  const params = parameters(doc, endpoint);
  expect(params.map((p) => p['name'])).not.toContain('cursor');
  for (const name of ['page', 'page_size']) {
    const param = params.find((p) => p['name'] === name);
    expect(param).toMatchObject({ in: 'query' });
    const schema = resolve(doc, at(param, 'schema'));
    const validate = compile(doc, schema);
    check(validate, 1, true);
    for (const invalid of [0, -1, 1.5]) check(validate, invalid, false);
    if (name === 'page_size') {
      check(validate, 200, true);
      check(validate, 201, false);
    }
  }
});

it('[AC-CT-21e#3] 支付单列表包含规定筛选项和有界状态/渠道', () => {
  const doc = contract();
  const params = parameters(doc, endpoints[0]);
  const queries = Object.fromEntries(
    params
      .filter((p) => p['in'] === 'query')
      .map((p) => [String(p['name']), resolve(doc, at(p, 'schema'))]),
  );
  expect(Object.keys(queries)).toEqual(
    expect.arrayContaining([
      'status',
      'pay_channel',
      'biz_type',
      'user_id',
      'out_trade_no',
      'needs_manual',
      'created_from',
      'created_to',
    ]),
  );
  expect(values(object(queries['status'])).toSorted()).toEqual(['CLOSED', 'PAID', 'PENDING']);
  expect(values(object(queries['pay_channel'])).toSorted()).toEqual(['alipay', 'wechat_pay']);
  expect(queries['needs_manual']).toMatchObject({ type: 'boolean' });
  for (const name of ['created_from', 'created_to'])
    expect(queries[name]).toMatchObject({ type: 'string', format: 'date-time' });
});

// 标题沿用原文，二次验证期望以块内断言为准。
it('[AC-CT-21e#4] 人工处置要求动态码并声明 needs_manual、查询凭证与审计', () => {
  const doc = contract();
  const op = operation(doc, resolveEndpoint);
  expect(op).not.toHaveProperty('x-step-up');
  expect(op['parameters']).not.toContainEqual({
    $ref: '#/components/parameters/AdminStepUpToken',
  });
  expect(parameters(doc, resolveEndpoint)).not.toContainEqual(
    expect.objectContaining({ name: 'X-Step-Up-Token', in: 'header' }),
  );
  expect(parameters(doc, resolveEndpoint).map((p) => p['name'])).not.toContain('Idempotency-Key');
  expect(op['x-error-codes']).toContain(20902);
  expect(op['x-error-codes']).not.toContain(10003);
  expect(op['x-error-codes']).not.toContain(20903);
  const description = String(op['description']);
  expect(description).not.toMatch(/step[ -]up|二次验证|totp|动态码|10003/i);
  expect(description).toMatch(/needs_manual\s*(?:=|is|为|:)?\s*`?true/i);
  expect(description).toContain('PENDING');
  expect(description).toMatch(/query|查询/i);
  expect(description).toMatch(/evidence|凭证/i);
  expect(description).toMatch(/audit|审计/i);
  expect(description).toContain('pay_order');
  expect(description).toMatch(/unknown|未知/i);
  expect(description).toContain('PAID');
  expect(description).toContain('CLOSED');
  expect(description).toMatch(/BR-PAY-05|close_grace_minutes/);
  expect(description).toMatch(/not.exist|not.found|不存在/i);
});

it.each(refunds)('[AC-CT-21e#5] %s %s 必须幂等、不要二次验证并复用错误码', (...endpoint) => {
  const doc = contract();
  const op = operation(doc, endpoint);
  expect(op['x-idempotent']).toBe(true);
  expect(op).not.toHaveProperty('x-step-up');
  const params = parameters(doc, endpoint);
  expect(params).toContainEqual(
    expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
  );
  expect(params.map((p) => p['name'])).not.toContain('X-Step-Up-Token');
  expect(op['parameters']).not.toContainEqual({
    $ref: '#/components/parameters/AdminStepUpToken',
  });
  expect(op['x-error-codes']).toEqual(expect.arrayContaining([20001, 20901]));
  expect(op['x-error-codes']).not.toContain(10003);
  expect(op['x-error-codes']).not.toContain(30903);
  const description = String(op['description']);
  expect(description).toMatch(/audit|审计/i);
  expect(description).toMatch(/exceed|excess|超过|超出/i);
  expect(description).toContain('amount_fen');
  // 幂等的主体裁定不强迫重复到操作描述；共享 header 仍必须复用。
  expect(op['parameters']).toEqual(
    expect.arrayContaining([{ $ref: '#/components/parameters/IdempotencyKey' }]),
  );
  if (endpoint[2] === 'createAdminPayRefund') {
    expect(op['x-error-codes']).toContain(20902);
    expect(description).toContain('PAID');
    expect(description).toContain('pay_order');
  }
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of list(op['x-error-codes'])) {
    expect(catalog.filter((entry) => entry['code'] === code)).toHaveLength(1);
  }
  const conflict = catalog.find((entry) => entry['code'] === 20902);
  expect(at(conflict, 'data')['resource']).toEqual(
    expect.arrayContaining(['pay_order', 'pay_refund']),
  );
});

it('[AC-CT-21e#6] README 登记后台支付契约', () => {
  operation(contract(), endpoints[0]);
  expect(read('contracts/README.md')).toContain('/admin/v1/pay-orders');
});
