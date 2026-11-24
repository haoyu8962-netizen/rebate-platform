import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  examples,
  list,
  object,
  resolve,
  text,
  yaml,
  type Obj,
} from '../order-claims/kit.ts';

// D10-2783 / D10-2792：白名单独立于被测契约，包含 planned 操作。
const sudoOperations = [
  'adminRevealUserField',
  'adminResetUserUnionBinding',
  'adminStartUnionReauthorization',
  'adminPutUnionCredential',
  'adminCreateUnionPid',
  'adminUpdateUnionPid',
  'adminActivateUnionPid',
  'adminRetireUnionPid',
  'adminBatchApproveWithdrawals',
  'adminRejectWithdrawal',
  'adminCreateExport',
  'adminRetryExport',
  'adminUpdateUserRiskState',
  'adminResolveAppeal',
  'closeAdminReconDiff',
];
const strictOperations = [
  'adminSaveAdminPermissions',
  'adminCreateAdjustment',
  'adminApproveAdjustment',
  'adminApproveBadDebtWriteoff',
  'adminCreatePayoutBatch',
  'adminUpdateKillSwitch',
  'adminBatchUpdateConfigItems',
  'adminUpdateConfigItem',
  'adminRollbackConfigItem',
];
const tiers = new Map<string, 'sudo' | 'strict'>([
  ...sudoOperations.map((id) => [id, 'sudo'] as const),
  ...strictOperations.map((id) => [id, 'strict'] as const),
]);
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const retest = 'adminRetestNotifySms';
const adminTokenRef = '#/components/parameters/AdminStepUpToken';
const factorMethods = ['totp', 'sms'];

function operations(doc: Obj, prefix: string) {
  return Object.entries(at(doc, 'paths')).flatMap(([path, rawPathItem]) => {
    if (!path.startsWith(prefix)) return [];
    const pathItem = resolve(doc, rawPathItem);
    return methods.flatMap((method) => {
      if (!Object.hasOwn(pathItem, method)) return [];
      const operation = object(pathItem[method]);
      return [{ path, method, pathItem, operation, id: text(operation['operationId']) }];
    });
  });
}

it('[AC-CT-24zzv#1] 后台档位严格按白名单标记，用户端三处标记保持原值', () => {
  const doc = contract();
  const adminTags = operations(doc, '/admin/v1/')
    .filter(({ operation }) => Object.hasOwn(operation, 'x-step-up'))
    .map(({ id, operation }) => [id, operation['x-step-up']] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const appTags = operations(doc, '/v1/')
    .filter(({ operation }) => Object.hasOwn(operation, 'x-step-up'))
    .map(({ path, method, operation }) => [path, method, operation['x-step-up']] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  expect({ adminTags, appTags }).toEqual({
    adminTags: [...tiers].toSorted(([left], [right]) => left.localeCompare(right)),
    appTags: [
      ['/v1/me/deletion', 'post', 'account_deletion'],
      ['/v1/me/payout-account', 'put', 'payout_account_change'],
      ['/v1/me/phone', 'post', 'phone_change'],
    ],
  });
});

it('[AC-CT-24zzv#2] 只有 sudo 和 strict 声明二次验证令牌，只有短信重测可额外声明 10003', () => {
  const doc = contract();
  const adminOperations = operations(doc, '/admin/v1/');
  const token = at(doc, 'components', 'parameters', 'AdminStepUpToken');
  expect(token).toMatchObject({ name: 'X-Step-Up-Token', in: 'header' });
  expect(token['required']).not.toBe(true);

  const tokenRefs: string[] = [];
  const tokenHeaders: string[] = [];
  const code10003: string[] = [];
  for (const { id, pathItem, operation } of adminOperations) {
    const parameters = [
      ...list(pathItem['parameters'] ?? []),
      ...list(operation['parameters'] ?? []),
    ];
    if (parameters.some((parameter) => object(parameter)['$ref'] === adminTokenRef)) {
      tokenRefs.push(id);
    }
    if (
      parameters.some((parameter) => {
        const { name, in: location } = resolve(doc, parameter);
        return location === 'header' && String(name).toLowerCase() === 'x-step-up-token';
      })
    ) {
      tokenHeaders.push(id);
    }
    if (list(operation['x-error-codes'] ?? []).includes(10003)) code10003.push(id);
  }

  const allowed = [...tiers.keys()];
  expect({
    tokenRefs: tokenRefs.toSorted(),
    tokenHeaders: tokenHeaders.toSorted(),
    code10003: code10003.toSorted(),
  }).toEqual({
    tokenRefs: allowed.toSorted(),
    tokenHeaders: allowed.toSorted(),
    code10003: [...allowed, retest].toSorted(),
  });
});

it('[AC-CT-24zzv#3] 仅部分请求验证的后台操作在说明中写出档位与触发条件', () => {
  const byId = new Map(operations(contract(), '/admin/v1/').map((entry) => [entry.id, entry]));
  const configCaps = /withdraw\.auto_payout\.|payout\.(?:wechat\.)?(?:single|daily)_cap_fen/;
  const conditions = [
    ['adminCreateExport', /\bunmasked\b|\bmasked\s*=\s*false\b/],
    ['adminRetryExport', /\bunmasked\b|\bmasked\s*=\s*false\b/],
    ['adminUpdateUserRiskState', /\bunfreeze\b/],
    ['adminResolveAppeal', /\bfrozen\b|\bunfreez\w*\b|解除冻结/],
    ['closeAdminReconDiff', /\bwithdraw_holds\b|\bwithdrawal (?:hold|freeze)\b|提现冻结/],
    ['adminUpdateKillSwitch', /\bwithdraw\.auto_payout\.enabled\b/],
    ['adminBatchUpdateConfigItems', configCaps],
    ['adminUpdateConfigItem', configCaps],
    ['adminRollbackConfigItem', configCaps],
  ] as const;
  for (const [id, condition] of conditions) {
    const description = text(byId.get(id)?.operation['description']);
    expect(description, id).toMatch(new RegExp(`\\b${tiers.get(id)}\\b`));
    expect(description, id).toMatch(condition);
  }
});

it('[AC-CT-24zzv#4] 档位枚举过渡期保留四个值，验证方式枚举只有 totp 和 sms', () => {
  const doc = contract();
  const catalog = yaml('contracts/enums/admin.yaml');
  const declaration = [
    ['admin_step_up_tier', 'AdminStepUpTier', [...factorMethods, 'sudo', 'strict']],
    ['admin_step_up_method', 'AdminStepUpMethod', factorMethods],
  ] as const;

  for (const [enumName, schemaName, values] of declaration) {
    expect(Object.keys(at(catalog, 'enums', enumName, 'values')).toSorted()).toEqual(
      values.toSorted(),
    );
    const schema = at(doc, 'components', 'schemas', schemaName);
    expect(schema['type'], schemaName).toBe('string');
    expect(list(schema['enum']).toSorted(), schemaName).toEqual(values.toSorted());
  }
});

it('[AC-CT-24zzv#5] 签发请求只要求 code，method 和兼容字段 tier 都使用验证方式枚举', () => {
  const doc = contract();
  const issue = at(doc, 'paths', '/admin/v1/auth/step-up', 'post');
  const request = resolve(doc, at(issue, 'requestBody'));
  const schema = at(doc, 'components', 'schemas', 'AdminStepUpRequest');
  expect(resolve(doc, at(request, 'content', 'application/json', 'schema'))).toEqual(schema);
  expect(schema['required']).toEqual(['code']);
  const methodRef = { $ref: '#/components/schemas/AdminStepUpMethod' };
  expect(at(schema, 'properties', 'method')).toMatchObject(methodRef);
  expect(at(schema, 'properties', 'tier')).toMatchObject(methodRef);

  const validate = compile(doc, schema);
  const code = '123456';
  check(validate, { code }, true);
  check(validate, { method: 'totp' }, false);
  for (const field of ['method', 'tier']) {
    for (const method of factorMethods) check(validate, { code, [field]: method }, true);
    for (const tier of ['none', 'sudo', 'strict']) check(validate, { code, [field]: tier }, false);
  }
});

it('[AC-CT-24zzv#6] 后台 10003 示例的 data 只含对应档位，短信重测只含手机号缺失原因', () => {
  const doc = contract();
  const errorData = operations(doc, '/admin/v1/').flatMap(({ id, operation }) =>
    Object.entries(at(operation, 'responses'))
      .filter(([status]) => status === 'default' || /^[45]/.test(status))
      .flatMap(([, response]) => {
        const { content } = resolve(doc, response);
        const media = object(content ?? {})['application/json'];
        if (media === undefined) return [];
        return examples(doc, object(media)).flatMap((example) => {
          if (
            example === null ||
            typeof example !== 'object' ||
            !('code' in example) ||
            example.code !== 10003
          ) {
            return [];
          }
          return [{ id, data: object(example)['data'] }];
        });
      }),
  );

  for (const { id, data } of errorData) {
    if (id === retest) {
      expect(data, id).toEqual({ reason: 'verify_phone_missing' });
    } else {
      expect(tiers.has(id), id).toBe(true);
      expect(data, id).toEqual({ tier: tiers.get(id) });
    }
  }
  expect(errorData).toContainEqual({ id: retest, data: { reason: 'verify_phone_missing' } });
  for (const tier of ['sudo', 'strict']) {
    expect(errorData).toContainEqual(expect.objectContaining({ data: { tier } }));
  }
});
