import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
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
const notifySmsRetest = 'adminRetestNotifySms';
const verifyPhoneMissingOperations = [notifySmsRetest, 'adminStepUp', 'adminSendStepUpSms'];
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

it('[AC-CT-24zzv#2] 只有标档操作声明二次验证令牌，10003 另允许三个验证手机号例外', () => {
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
    code10003: [...allowed, ...verifyPhoneMissingOperations].toSorted(),
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

it('[AC-CT-24zzv#6] 后台 10003 示例覆盖两档及短信重测，三个手机号例外的 data 只含缺失原因', () => {
  const doc = contract();
  const errorData = operations(doc, '/admin/v1/').flatMap(({ id, operation }) =>
    Object.values(at(operation, 'responses')).flatMap((response) => {
      const { content } = resolve(doc, response);
      const media = object(content ?? {})['application/json'];
      if (media === undefined) return [];
      const representation = object(media);
      const namedExamples = Object.values(object(representation['examples'] ?? {}));
      const examples = [
        representation['example'],
        ...namedExamples.map((entry) => resolve(doc, entry)['value']),
      ];
      return examples.flatMap((example) => {
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

  const missingPhoneData = { reason: 'verify_phone_missing' };
  for (const { id, data } of errorData) {
    const tier = tiers.get(id);
    if (tier !== undefined) {
      expect(data, id).toEqual({ tier });
    } else {
      expect(verifyPhoneMissingOperations, id).toContain(id);
      expect(data, id).toEqual(missingPhoneData);
    }
  }
  expect(errorData).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ data: { tier: 'sudo' } }),
      expect.objectContaining({ data: { tier: 'strict' } }),
      { id: notifySmsRetest, data: missingPhoneData },
    ]),
  );
});

it('[AC-CT-24zzv#7] 10003 码表含 sudo、strict 和手机号缺失原因', () => {
  const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const stepUpRequired = codes.find((entry) => entry['code'] === 10003);
  const data = at(stepUpRequired, 'data');

  expect(list(data['tier'])).toEqual(expect.arrayContaining(['sudo', 'strict']));
  expect(list(data['reason'])).toContain('verify_phone_missing');
  for (const field of ['meaning', 'action']) {
    const wording = text(stepUpRequired?.[field]);
    expect(wording, field).not.toMatch(/(?:动态码|短信|TOTP|SMS)\s*档|\b(?:totp|sms)[ -]tier\b/i);
    expect(wording, field).toMatch(/\bsudo\b/i);
    expect(wording, field).toMatch(/\bstrict\b/i);
  }
});

it('[AC-CT-24zzv#8] 原先带二次验证令牌且现在归 none 的操作移除验证要求说明', () => {
  // 固定改造前使用 AdminStepUpToken 且本次归 none 的 48 个操作。
  const formerlyProtected = new Set([
    'adminSendMyVerifyPhoneCode',
    'adminCreateAdmin',
    'adminRegenerateAdminInitialPassword',
    'adminDisableAdmin',
    'adminEnableAdmin',
    'adminResetAdminTotp',
    'adminSendAdminVerifyPhoneCode',
    'adminDisableUserUnionBinding',
    'adminEnableUserUnionBinding',
    'adminChangeUserLevel',
    'adminChangeInviter',
    'adminEditUserProfile',
    'adminAddUserReverifiedDevice',
    'adminCorrectUserRealname',
    'adminCreateUserDataExport',
    'adminDownloadUserDataExport',
    'adminReassignOrder',
    'adminCreateRightsImport',
    'adminAddUnionAlertPhone',
    'adminRemoveUnionAlertPhone',
    'adminPublishAgreementVersion',
    'adminSaveDictItems',
    'adminRollbackDictItems',
    'adminSwitchNotifyChannels',
    'adminRegisterNotifySms',
    'adminEnableNotifySms',
    'adminSaveAppVersion',
    'adminEnableRiskRule',
    'adminDisableRiskRule',
    'resolveAdminPayOrder',
    'writeOffAdminReconDiff',
    'restoreAdminReconDiff',
    'blacklistClawbackAdminReconDiff',
    'recalcBalanceAdminReconDiff',
    'adminApproveSettleAdjustBatch',
    'adminRejectSettleAdjustBatch',
    'adminRunSettleAdjust',
    'adminBatchManualPaid',
    'adminQueryPayoutResult',
    'adminResolveUnknownPayout',
    'confirmAdminSettleBill',
    'createAdminSettleSupplementBatches',
    'cancelAdminSettleBatchSchedule',
    'rejectAdminSettleBatch',
    'resumeAdminSettleBatch',
    'adminCreateUnionReceipt',
    'adminReverseUnionReceipt',
    'adminCreatePayoutWatermark',
  ]);
  const allowedMentions = [
    /\/auth\/step-up(?:\/[a-z0-9-]+)*/g,
    /\bstep[- ]up\s*:\s*none\b/g,
    /\b(?:no|without) step[- ]up(?: (?:checks?|token|verification))?\b/g,
    /\b(?:no longer|not|never) requires? step[- ]up(?: (?:checks?|token|verification))?\b/g,
    /不再(?:需要|需)(?:通过|完成)?二次验证/g,
  ];
  const requirements = [
    /\b(?:x-step-up-token|step_up_token|data\.tier|10003)\b/,
    /\b(?:totp|sms)[ -]tier\b/,
    /\b(?:requires?|needs?|must|without a valid) [^.!?;,]{0,80}\bstep[- ]up\b/,
    /\bstep[- ]up\s*(?:[:(]|(?:totp|sms|sudo|strict|checks?|token is a header|as above|(?:is )?(?:needed|required))\b)/,
    /(?:\b(?:and |permission, |with )|→\s*)step[- ]up\b/,
    /\b(?:sudo|strict)(?:[ -]tier| (?:verification|every time|on every (?:call|request|operation)|(?:is )?(?:needed|required)))\b/,
    /\b(?:requires?|needs?|must (?:pass|use)) (?:an? )?(?:sudo|strict)(?=\s*(?:[,.!?;)]|$)| (?:for|on|before|when|to)\b)/,
    /(?<![不无])(?:需要|需|必须)(?:通过|完成)?二次验证/,
  ];
  for (const { id, operation } of operations(contract(), '/admin/v1/')) {
    if (!formerlyProtected.has(id)) continue;
    let description = text(operation['description'] ?? '')
      .replaceAll('`', '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    for (const mention of allowedMentions) description = description.replace(mention, ' ');
    if (id === 'adminDisableAdmin' || id === 'adminResetAdminTotp') {
      description = description.replace(
        /\band step[- ]up tokens? of the account stops? working\b/g,
        ' ',
      );
    }
    for (const requirement of requirements) expect(description, id).not.toMatch(requirement);
  }
});
