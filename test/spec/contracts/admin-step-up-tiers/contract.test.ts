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

function wording(value: unknown): string {
  return text(value).replaceAll('`', '').replace(/\s+/g, ' ').trim().toLowerCase();
}

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
    const description = wording(byId.get(id)?.operation['description']);
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
  const legacyTier = /(?:动态码|短信|totp|sms)\s*档|\b(?:totp|sms)[ -]tier\b/;
  for (const field of ['meaning', 'action']) {
    const description = wording(stepUpRequired?.[field]);
    expect(description, field).not.toMatch(legacyTier);
    expect(description, field).toMatch(/\bsudo\b/);
    expect(description, field).toMatch(/\bstrict\b/);
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
    /\b(?:no longer|not|never|doesn['’]t) (?:requires?|needs?) [^.!?;,]{0,80}?\b(?:(?:x-)?step[- _]up(?:[- _](?:checks?|tokens?|verification))?|(?:totp|sms)[ -]tier|(?:sudo|strict) verification)\b/g,
    /\b(?:no longer|not|never|doesn['’]t|won['’]t) (?:returns?|answers?|responds? with) 10003(?: with data\.tier(?:\s*=\s*\w+)?)?\b/g,
    /\b10003(?: with data\.tier(?:\s*=\s*\w+)?)? (?:is not|isn['’]t) (?:an? )?(?:error(?: here)?|returned)\b/g,
    /不再(?:需要|需)(?:通过|完成)?二次验证/g,
  ];
  const requirements = [
    /\b(?:x-step-up-token|step_up_token)\b/,
    /(?:→\s*|\b(?:returns?|answers?|responds? with) )10003\b|\b10003 with data\.tier\b/,
    /\b(?:totp|sms)[ -]tier\b/,
    /\b(?:requires?|needs?|must|without a valid) [^.!?;,]{0,80}\bstep[- ]up\b/,
    /\bstep[- ]up\s*(?:[:(]|(?:totp|sms|sudo|strict|checks?|token is a header|as above|(?:is )?(?:needed|required))\b)/,
    /(?:\b(?:and |permission, |with )|→\s*)step[- ]up\b/,
    /,\s*step[- ]up and\b/,
    /\b(?:sudo|strict)(?:[ -]tier| (?:verification|every time|on every (?:call|request|operation)|(?:is )?(?:needed|required)))\b/,
    /\b(?:requires?|needs?|must (?:pass|use)) (?:an? )?(?:sudo|strict)(?=\s*(?:[,.!?;)]|$)| (?:for|on|before|when|to)\b)/,
    /(?<![不无])(?:需要|需|必须)(?:通过|完成)?二次验证/,
  ];
  for (const { id, operation } of operations(contract(), '/admin/v1/')) {
    if (!formerlyProtected.has(id)) continue;
    let description = wording(operation['description'] ?? '');
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

it('[AC-CT-24zzv#9] strict 凭证在首次使用时绑定操作，只能重试同一操作', () => {
  const doc = contract();
  const properties = at(doc, 'components', 'schemas', 'AdminStepUpRequest', 'properties');
  expect(Object.keys(properties).toSorted()).toEqual(['code', 'method', 'tier']);

  const token = at(doc, 'components', 'parameters', 'AdminStepUpToken');
  const issue = at(doc, 'paths', '/admin/v1/auth/step-up', 'post');
  const binding = [
    /\bfirst\b/,
    /\b(?:bound|binds?|binding)\b/,
    /\bsame (?:strict )?operation\b/,
    /\b(?:retry|retries|retried|reuse[ds]?|replay(?:ed)?|used again)\b/,
  ];
  const descriptions = [token, issue].map((entry) => wording(entry['description']));
  expect(
    descriptions.some((description) => binding.every((keyword) => keyword.test(description))),
    'AdminStepUpToken 或 adminStepUp 应说明首次使用时绑定操作及同一操作重试',
  ).toBe(true);
});

it('[AC-CT-24zzv#10] 签发接口与凭证请求头说明验证成功起五分钟有效', () => {
  const doc = contract();
  const token = at(doc, 'components', 'parameters', 'AdminStepUpToken');
  const issue = at(doc, 'paths', '/admin/v1/auth/step-up', 'post');
  for (const [name, entry] of [
    ['AdminStepUpToken', token],
    ['adminStepUp', issue],
  ] as const) {
    const description = wording(entry['description']);
    expect(description, name).toMatch(/\b(?:5|five)[ -]minutes?\b/);
    expect(description, name).toMatch(
      /\b(?:successful (?:second[- ]factor )?(?:verification|check)|verification (?:succeeds?|success|passes?)|successfully verified|verified successfully)\b/,
    );
  }
  expect(wording(issue['description'])).not.toMatch(
    /\b(?:token lifetime|validity (?:period|duration))\b[^.]*\b(?:server decides|left to the server)\b/,
  );
});

it('[AC-CT-24zzv#11] strict 凭证成功即消耗、明确失败可重试、结果未知占用到过期', () => {
  const doc = contract();
  const token = wording(at(doc, 'components', 'parameters', 'AdminStepUpToken')['description']);
  const issue = wording(at(doc, 'paths', '/admin/v1/auth/step-up', 'post')['description']);
  const success = /\b(?:business success|successful operation|operation succeeds?|code\s*=\s*0)\b/;
  const spent = /\b(?:spent|consum(?:ed|es?))\b/;
  const failure = /\b(?:reject\w*|refus\w*|fail\w*|errors?)\b/;
  const known = /\b(?:definit\w*|explicit\w*|clear\w*|confirmed|known|unambiguous)\b/;
  const retry = /\b(?:retr\w+|replay\w*|reuse\w*|used again|sent again|another attempt)\b/;
  const unknown =
    /\bunknown (?:\w+ )?(?:outcome|result)\b|\b(?:outcome|result)\b[^.!?;]{0,60}\bunknown\b/;
  const occupied =
    /\b(?:held|holds?|reserved|occupied|locked|blocked|unavailable|retained|claimed)\b/;
  const expires = /\b(?:expir\w*|still valid|within (?:its |the )?validity)\b/;
  const sentences = token.split(/(?<=[.!?])\s+/);
  const passages = sentences.map((sentence, index) => `${sentence} ${sentences[index + 1] ?? ''}`);
  for (const [label, keywords] of [
    ['业务成功即消耗', [success, spent]],
    ['明确失败后在有效期内可重试', [known, failure, retry, expires]],
    ['结果未知时占用到过期', [unknown, occupied, expires]],
  ] as const) {
    const matches = passages.some((passage) => keywords.every((keyword) => keyword.test(passage)));
    expect(matches, label).toBe(true);
  }

  const blanketRelease =
    /\b(?:on|after) (?:a )?(?:rejection|failure|error) or (?:an? )?(?:rejection|failure|error),? (?:it|the token) (?:is |will be )?released\b/;
  const releaseOnUnknown =
    /\b(?:outcome|result)(?: is)? unknown,? (?:it|the (?:token|reservation)) (?:is|will be|can be) (?:released|reused)\b/;
  for (const description of [token, issue]) {
    expect(description).not.toMatch(blanketRelease);
    expect(description).not.toMatch(releaseOnUnknown);
  }
});

it('[AC-CT-24zzv#12] 我的权限中最高档位仅供展示，验证由操作标记和 10003 决定', () => {
  const doc = contract();
  const description = wording(at(doc, 'paths', '/admin/v1/me/permissions', 'get')['description']);

  expect(description).toMatch(/\bstep_up_tier\b/);
  expect(description).toMatch(/\b(?:highest|maximum)\b/);
  expect(description).toMatch(
    /\b(?:display only|only (?:for|used for) display|for display purposes)\b/,
  );
  expect(description).toMatch(/\bx-step-up\b/);
  expect(description).toMatch(/\b10003\b/);
});

it('[AC-CT-24zzv#13] 签发与发送验证码接口说明移除已取消的验证方式档位', () => {
  const doc = contract();
  const obsoleteTier =
    /\b(?:sms|totp)(?:[ -]step[ -]up)?[ -]tier\b|\bdata\.tier\s*=\s*(?:sms|totp)\b|短信档|动态码档/;
  for (const path of ['/admin/v1/auth/step-up', '/admin/v1/auth/step-up/sms-codes']) {
    const operation = at(doc, 'paths', path, 'post');
    for (const field of ['summary', 'description']) {
      expect(wording(operation[field] ?? ''), `${path} ${field}`).not.toMatch(obsoleteTier);
    }
  }
});
