// B1-02zzzc contract (D10-1665 / D10-1666 / D10-1671; BR-ID-08, BR-WDR-01, BR-WDR-07): POST
// /v1/withdrawals loses x-step-up, the X-Step-Up-Token parameter and 10003; StepUpAction loses
// withdraw and StepUpSummary loses StepUpSummaryWithdraw; AbandonIdempotencyKeyRequest.action takes
// the new IdempotencyAbandonAction (still with withdraw); the four sensitive operations carry
// `x-sensitive-operation: true` and x-step-up stays only on the three that still need it. Checked
// on the source document (raw, $ref kept), the dereferenced document and the generated artefacts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';

type Obj = Record<string, unknown>;
const ROOT = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

const SENSITIVE = [
  { method: 'post', path: '/v1/withdrawals', operationId: 'createWithdrawal', action: null },
  {
    method: 'put',
    path: '/v1/me/payout-account',
    operationId: 'savePayoutAccount',
    action: 'payout_account_change',
  },
  { method: 'post', path: '/v1/me/phone', operationId: 'bindPhone', action: 'phone_change' },
  {
    method: 'post',
    path: '/v1/me/deletion',
    operationId: 'requestDeletion',
    action: 'account_deletion',
  },
] as const;
const STEP_UP_ACTIONS = ['payout_account_change', 'phone_change', 'account_deletion'];
const ABANDON_ACTIONS = ['withdraw', 'payout_account_change', 'phone_change', 'account_deletion'];
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

// Shape first, so a missing node is an assertion failure, never a TypeError.
function object(value: unknown, label = 'node'): Obj {
  expect(value, `${label} 应为对象`).toBeTypeOf('object');
  expect(value, `${label} 不应为 null`).not.toBeNull();
  expect(Array.isArray(value), `${label} 不应为数组`).toBe(false);
  return value as Obj;
}
function at(value: unknown, ...keys: string[]): Obj {
  let node = object(value, 'root');
  for (const key of keys) node = object(node[key], keys.join('/'));
  return node;
}
function list(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} 应为数组`).toBe(true);
  return value as unknown[];
}
function raw(): Obj {
  return object(parseYamlLite(readFileSync(new URL('contracts/openapi.yaml', ROOT), 'utf8')));
}
async function dereferenced(): Promise<Obj> {
  const parser = createRequire(new URL('apps/api/package.json', ROOT))(
    '@readme/openapi-parser',
  ) as { dereference(path: string, options: object): Promise<Obj> };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}
function operations(doc: Obj): { where: string; op: Obj }[] {
  const found: { where: string; op: Obj }[] = [];
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    if (item === null || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = (item as Obj)[method];
      if (op !== null && typeof op === 'object')
        found.push({ where: `${method.toUpperCase()} ${path}`, op: op as Obj });
    }
  }
  return found;
}
function parameterRefs(op: Obj): string[] {
  return list(op['parameters'] ?? [], 'parameters').map((p) => String(object(p)['$ref'] ?? ''));
}
function generated(operationId: string, part: string): JsonSchema {
  const schemas = CONTRACT_ROUTE_SCHEMAS as unknown as Record<string, Obj | undefined>;
  const route = object(schemas[operationId], `CONTRACT_ROUTE_SCHEMAS.${operationId}`);
  return object(route[part], `CONTRACT_ROUTE_SCHEMAS.${operationId}.${part}`) as JsonSchema;
}
function requestSchema(doc: Obj, path: string, method: string): JsonSchema {
  return at(doc, 'paths', path, method, 'requestBody', 'content', 'application/json', 'schema');
}

it('[AC-B1-02zzzc#10] createWithdrawal 去 x-step-up、X-Step-Up-Token 参数与 10003；签名、幂等、realname、版本闸、20903 与敏感操作标记保留', () => {
  const op = at(raw(), 'paths', '/v1/withdrawals', 'post');
  expect(op['operationId']).toBe('createWithdrawal');
  expect(op).not.toHaveProperty('x-step-up');
  expect(op['x-sensitive-operation']).toBe(true);
  expect(op).toMatchObject({
    'x-auth': 'realname',
    'x-signed': true,
    'x-idempotent': true,
    'x-min-version-gate': true,
  });
  const refs = parameterRefs(op);
  expect(refs).not.toContain('#/components/parameters/StepUpToken');
  for (const name of ['Timestamp', 'Nonce', 'Sign', 'IdempotencyKey', 'DeviceId']) {
    expect(refs).toContain(`#/components/parameters/${name}`);
  }
  const codes = list(op['x-error-codes'], 'x-error-codes');
  expect(codes).not.toContain(10003);
  // 【放弃上一笔提现】 still abandons withdrawal keys (BR-WDR-07): 20903 stays listed.
  expect(codes).toContain(20903);
  expect(String(op['description'])).not.toMatch(/X-Step-Up-Token/);
});

it.each(SENSITIVE.filter((s) => s.action !== null))(
  '[AC-B1-02zzzc#11] $operationId 仍要二次验证：x-step-up $action、X-Step-Up-Token、10003 与 20903 保留，并带 x-sensitive-operation: true',
  ({ method, path, operationId, action }) => {
    const op = at(raw(), 'paths', path, method);
    expect(op['operationId']).toBe(operationId);
    expect(op['x-step-up']).toBe(action);
    expect(op['x-sensitive-operation']).toBe(true);
    expect(parameterRefs(op)).toContain('#/components/parameters/StepUpToken');
    const codes = list(op['x-error-codes'], 'x-error-codes');
    expect(codes).toContain(10003);
    expect(codes).toContain(20903);
  },
);

it('[AC-B1-02zzzc#12] 全契约恰好四个操作带 x-sensitive-operation（值为 true），恰好三个带 x-step-up', () => {
  const all = operations(raw());
  const sensitive = all.filter(({ op }) => Object.hasOwn(op, 'x-sensitive-operation'));
  expect(sensitive.map(({ where }) => where).sort()).toEqual(
    SENSITIVE.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort(),
  );
  for (const { op } of sensitive) expect(op['x-sensitive-operation']).toBe(true);
  const stepUp = all.filter(({ op }) => Object.hasOwn(op, 'x-step-up'));
  expect(
    stepUp
      .map(({ where, op }) => [where, op['x-step-up']])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual(
    SENSITIVE.filter((s) => s.action !== null)
      .map(({ method, path, action }) => [`${method.toUpperCase()} ${path}`, action])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  // Only an x-step-up operation lists the X-Step-Up-Token parameter (no admin header here: /v1).
  for (const { where, op } of all) {
    if (!where.includes(' /v1/')) continue;
    if (parameterRefs(op).includes('#/components/parameters/StepUpToken')) {
      expect(op, where).toHaveProperty('x-step-up');
    }
  }
});

it('[AC-B1-02zzzc#13] StepUpAction 去 withdraw；StepUpSummary 去 StepUpSummaryWithdraw 且全文不再引用它', () => {
  const doc = raw();
  const schemas = at(doc, 'components', 'schemas');
  expect([...list(at(schemas, 'StepUpAction')['enum'], 'StepUpAction.enum')].sort()).toEqual(
    [...STEP_UP_ACTIONS].sort(),
  );
  expect(schemas).not.toHaveProperty('StepUpSummaryWithdraw');
  const branches = list(at(schemas, 'StepUpSummary')['oneOf'], 'StepUpSummary.oneOf').map((b) =>
    String(object(b)['$ref']),
  );
  expect(branches.sort()).toEqual(
    [
      '#/components/schemas/StepUpSummaryAlipay',
      '#/components/schemas/StepUpSummaryBankCard',
      '#/components/schemas/StepUpSummaryWechat',
    ].sort(),
  );
  expect(JSON.stringify(doc)).not.toContain('StepUpSummaryWithdraw');
});

it('[AC-B1-02zzzc#14] AbandonIdempotencyKeyRequest.action 改引用新枚举 IdempotencyAbandonAction（四个动作，仍含 withdraw）', () => {
  const schemas = at(raw(), 'components', 'schemas');
  const actionEnum = at(schemas, 'IdempotencyAbandonAction');
  expect(actionEnum['type']).toBe('string');
  expect([...list(actionEnum['enum'], 'IdempotencyAbandonAction.enum')].sort()).toEqual(
    [...ABANDON_ACTIONS].sort(),
  );
  const request = at(schemas, 'AbandonIdempotencyKeyRequest');
  expect(at(request, 'properties', 'action')).toEqual({
    $ref: '#/components/schemas/IdempotencyAbandonAction',
  });
  expect(list(request['required'], 'required')).toEqual(
    expect.arrayContaining(['action', 'idempotency_key']),
  );
});

it.each(['source', 'generated'] as const)(
  '[AC-B1-02zzzc#15] %s：stepUp 请求体不再接受 action=withdraw 与提现形状的 summary；其余三个动作照常',
  async (source) => {
    const doc = source === 'source' ? await dereferenced() : null;
    const schema =
      doc === null ? generated('stepUp', 'body') : requestSchema(doc, '/v1/auth/step-up', 'post');
    const validate = createValidatorCompiler()({ schema, httpPart: 'body' });
    const id = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80';
    const rejected: unknown[] = [
      { action: 'withdraw', code: '123456' },
      { action: 'withdraw', code: '123456', summary: { payout_account_id: id, amount_fen: 100 } },
      { action: 'withdraw', provider: 'wechat', attempt_id: id, code: 'wechat-code' },
      {
        action: 'withdraw',
        provider: 'apple',
        attempt_id: id,
        identity_token: 'apple-identity',
        authorization_code: 'apple-code',
      },
      { action: 'withdraw', provider: 'huawei', attempt_id: id, authorization_code: 'hw-code' },
      {
        action: 'payout_account_change',
        code: '123456',
        summary: { payout_account_id: id, amount_fen: 100 },
      },
    ];
    for (const body of rejected) expect(validate(body), JSON.stringify(body)).toBe(false);
    const accepted: unknown[] = [
      {
        action: 'payout_account_change',
        code: '123456',
        summary: { payout_method: 'alipay', alipay_logon_id: 'someone@example.test' },
      },
      { action: 'phone_change', code: '123456' },
      { action: 'account_deletion', code: '123456' },
      { action: 'account_deletion', provider: 'wechat', attempt_id: id, code: 'wechat-code' },
    ];
    for (const body of accepted) {
      expect(validate(body), `${JSON.stringify(body)} ${JSON.stringify(validate.errors)}`).toBe(
        true,
      );
    }
    if (doc !== null) {
      // The operation's own request examples stay valid against the narrowed schema.
      const content = at(doc, 'paths', '/v1/auth/step-up', 'post', 'requestBody', 'content');
      const examples = object(at(content, 'application/json')['examples'] ?? {}, 'examples');
      for (const [name, example] of Object.entries(examples)) {
        const value = object(example, name)['value'];
        expect(validate(value), `example ${name} ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  },
);

it.each(['source', 'generated'] as const)(
  '[AC-B1-02zzzc#16] %s：作废请求体四个动作都接受（含 withdraw），未知动作拒绝；createWithdrawal 不再声明 X-Step-Up-Token 头',
  async (source) => {
    const doc = source === 'source' ? await dereferenced() : null;
    const body =
      doc === null
        ? generated('abandonIdempotencyKey', 'body')
        : requestSchema(doc, '/v1/idempotency-keys/abandon', 'post');
    const validate = createValidatorCompiler()({ schema: body, httpPart: 'body' });
    const idem = 'b1-02zzzc-abandon-key';
    for (const action of ABANDON_ACTIONS) {
      expect(validate({ action, idempotency_key: idem }), JSON.stringify(validate.errors)).toBe(
        true,
      );
    }
    expect(validate({ action: 'withdrawal', idempotency_key: idem })).toBe(false);
    if (doc === null) {
      const headers = generated('createWithdrawal', 'headers');
      const properties = Object.keys(object(object(headers)['properties'], 'properties'));
      expect(properties).not.toContain('x-step-up-token');
      expect(list(object(headers)['required'], 'required')).toEqual(
        expect.arrayContaining(['x-timestamp', 'x-nonce', 'x-sign', 'idempotency-key']),
      );
      // Still on the three step-up operations.
      for (const operationId of ['savePayoutAccount', 'bindPhone', 'requestDeletion']) {
        const others = Object.keys(
          object(object(generated(operationId, 'headers'))['properties'], 'properties'),
        );
        expect(others, operationId).toContain('x-step-up-token');
      }
    } else {
      const op = at(doc, 'paths', '/v1/withdrawals', 'post');
      const names = list(op['parameters'], 'parameters').map((p) =>
        String(object(p)['name']).toLowerCase(),
      );
      expect(names).not.toContain('x-step-up-token');
      expect(names).toEqual(expect.arrayContaining(['x-sign', 'idempotency-key']));
    }
  },
);

it('[AC-B1-02zzzc#17] 生成的 TS 类型同步：openapi.gen.ts 去 StepUpSummaryWithdraw、新增 IdempotencyAbandonAction', () => {
  const source = readFileSync(new URL('packages/contracts-ts/src/openapi.gen.ts', ROOT), 'utf8');
  expect(source).not.toContain('StepUpSummaryWithdraw');
  expect(source).toContain('IdempotencyAbandonAction');
});
