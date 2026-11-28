import { expect, it } from 'vitest';
import { errorCodes } from '../../../../packages/contracts-ts/src/error-codes.gen.ts';
import { at, check, compile, contract, list, object, text, yaml } from '../order-claims/kit.ts';
import { namedInterface, property, source } from '../order-claims/source-kit.ts';

const authUrlPath = '/v1/unions/{platform}/auth-url';
const bindPath = '/v1/unions/{platform}/bindings';
const listBindingsPath = '/v1/unions/bindings';

function schemaRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function expectPairing(description: string): void {
  const normalized = description.replaceAll('`', '').replace(/\s+/gu, ' ');
  expect(normalized).toMatch(/sdk_app_key/u);
  expect(normalized).toMatch(/auth_methods[^.;。；]{0,120}sdk_token/iu);
  const requiredInChinese = /必带|必有|必填|必传|必须(?:带|携带|返回|提供|包含)/u;
  const needInEnglish = /(?<!not )\brequired\b|\bmust be (?:sent|returned|present|included)\b/iu;
  const clauses = normalized.split(/[.;。；]/u);
  const sdkClauses = clauses.filter((clause) => clause.includes('sdk_token'));
  const requiresKey = sdkClauses.some(
    (clause) => requiredInChinese.test(clause) || needInEnglish.test(clause),
  );
  expect(requiresKey, normalized).toBe(true);
  const otherwise = /其[余餘他它]|否则|不含|不包含|未含|未包含|没有|otherwise|other|without/iu;
  const omitInChinese = /不带|不下发|不返回|不提供|不出现|不存在|省略/u;
  const omitInEnglish = /omit|absent|(?:not|never) (?:be )?(?:sent|returned|present|included)/iu;
  const omitsKey = clauses.some((clause) => {
    const omission = omitInChinese.test(clause) || omitInEnglish.test(clause);
    return otherwise.test(clause) && omission;
  });
  expect(omitsKey, normalized).toBe(true);
}

it('[AC-CT-28#1] auth-url 只增加可选非空字符串及配对说明，保留原有契约', () => {
  // 漏字段、改成必填、放宽空字符串、改旧字段或在 schema 上强制配对都会失败。
  const doc = contract();
  const schemas = at(doc, 'components', 'schemas');
  const data = at(schemas, 'UnionAuthUrlData');
  const { description, properties, ...shape } = data;
  const { sdk_app_key: sdkAppKey, ...originalProperties } = object(properties);
  const { description: fieldDescription, ...fieldShape } = object(sdkAppKey);
  expect(fieldShape).toStrictEqual({ type: 'string', minLength: 1 });
  expect(shape).toStrictEqual({
    type: 'object',
    additionalProperties: false,
    required: ['auth_url', 'state'],
    oneOf: [
      {
        type: 'object',
        properties: { auth_methods: { type: 'array' } },
        required: ['auth_methods'],
      },
      {
        type: 'object',
        properties: { auth_jump: { type: 'object', additionalProperties: true } },
        required: ['auth_jump'],
      },
    ],
  });
  expect(originalProperties).toStrictEqual({
    auth_url: { type: 'string', format: 'uri' },
    state: { type: 'string', minLength: 1, maxLength: 128 },
    auth_methods: { type: 'array', minItems: 1, items: schemaRef('AuthMethod') },
    auth_jump: schemaRef('AuthJumpPlan'),
  });
  expect(at(schemas, 'AuthMethod')).toMatchObject({
    type: 'string',
    enum: ['web_code', 'sdk_token'],
  });
  expectPairing(`${text(description)} sdk_app_key ${fieldDescription ?? ''}`);

  const operation = at(doc, 'paths', authUrlPath, 'get');
  expect(operation).toMatchObject({
    operationId: 'getUnionAuthUrl',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [30101, 30102, 30153, 50301, 50303],
  });
  const media = at(operation, 'responses', '200', 'content', 'application/json');
  expect(at(media, 'schema')).toEqual(schemaRef('UnionAuthUrlResponse'));
  const response = at(schemas, 'UnionAuthUrlResponse');
  expect(response).toMatchObject({
    additionalProperties: false,
    required: ['code', 'msg', 'data', 'trace_id'],
  });
  expect(at(response, 'properties')).toEqual({
    code: schemaRef('SuccessCode'),
    msg: { type: 'string' },
    data: schemaRef('UnionAuthUrlData'),
    trace_id: schemaRef('TraceId'),
  });

  const validate = compile(doc, data);
  const base = { auth_url: 'https://oauth.example.test/authorize', state: 'st_01' };
  check(validate, { ...base, auth_methods: ['sdk_token'], sdk_app_key: 'demo-app-key' }, true);
  check(validate, { ...base, auth_methods: ['web_code'] }, true);
  for (const invalid of ['', null, 123]) {
    check(validate, { ...base, auth_methods: ['sdk_token'], sdk_app_key: invalid }, false);
  }
});

function checkExamplePairing(value: unknown, path: string[] = [], inExample = false): void {
  if (value === null || typeof value !== 'object') return;
  if (
    inExample &&
    !Array.isArray(value) &&
    ('auth_methods' in value || 'auth_jump' in value || 'sdk_app_key' in value)
  ) {
    const location = path.join('.');
    const methods = 'auth_methods' in value ? list(value.auth_methods) : [];
    if (methods.includes('sdk_token')) {
      expect(value, location).toHaveProperty('sdk_app_key', expect.stringMatching(/\S/u));
    } else {
      expect(value, location).not.toHaveProperty('sdk_app_key');
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const childInExample = inExample || key === 'example' || key === 'examples';
    checkExamplePairing(child, [...path, key], childInExample);
  }
}

it('[AC-CT-28#2] 全部 OpenAPI 示例按授权方式配对，既有淘宝和拼多多示例保留原值', () => {
  // 任一 SDK 示例漏补或填空、给网页授权或拼多多多填字段、删除示例或改旧值都会失败。
  const doc = contract();
  const operation = at(doc, 'paths', authUrlPath, 'get');
  const success = at(operation, 'responses', '200', 'content', 'application/json');
  const validate = compile(doc, at(doc, 'components', 'schemas', 'UnionAuthUrlResponse'));
  const pddUrl = 'https://auth.example.test/pdd/authorize?state=st_02';
  const traceId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
  const taobaoData = {
    auth_url: 'https://oauth.example.test/authorize?state=st_01',
    state: 'st_01',
    auth_methods: ['sdk_token', 'web_code'],
  };
  const pddJump = {
    primary: { type: 'universal_link', value: pddUrl },
    expire_at: '2026-10-02T09:40:00+08:00',
  };
  const responseExamples = [
    { media: success, isSuccess: true },
    ...['ClientError', 'NoStoreClientError'].map((name) => ({
      media: at(doc, 'components', 'responses', name, 'content', 'application/json'),
      isSuccess: false,
    })),
  ];
  for (const { media, isSuccess } of responseExamples) {
    const taobao = isSuccess ? 'taobao' : 'unionAuthRequired';
    const pdd = isSuccess ? 'pdd' : 'pddAuthRequired';
    const value = at(media, 'examples', taobao, 'value');
    const { sdk_app_key: sdkAppKey, ...data } = at(value, 'data');
    expect(sdkAppKey).toEqual(expect.stringMatching(/\S/u));
    expect({ ...value, data }).toEqual({
      code: isSuccess ? 0 : 30101,
      msg: isSuccess ? '' : '请先授权淘宝',
      data: taobaoData,
      trace_id: traceId,
    });
    expect(at(media, 'examples', pdd, 'value')).toEqual({
      code: isSuccess ? 0 : 30111,
      msg: isSuccess ? '' : '请先授权拼多多',
      trace_id: traceId,
      data: {
        ...(isSuccess ? { auth_url: pddUrl, state: 'st_02' } : {}),
        auth_jump: {
          ...pddJump,
          fallbacks: isSuccess ? [] : [{ type: 'h5', value: `${pddUrl}&web=1` }],
        },
      },
    });
  }
  check(validate, at(success, 'examples', 'taobao', 'value'), true);
  check(validate, at(success, 'examples', 'pdd', 'value'), true);
  checkExamplePairing(doc);
});

const authErrors = [
  { code: 30101, reasons: ['auth_unavailable'], retry: { auth_unavailable: 'later' } },
  {
    code: 30102,
    reasons: ['auth_unavailable', 'sharer_auth_invalid'],
    retry: { auth_unavailable: 'later', sharer_auth_invalid: 'never' },
  },
] as const;

it.each(authErrors)(
  '[AC-CT-28#3] $code 的 data 登记公开标识和有条件下发规则',
  ({ code, reasons, retry }) => {
    // 漏登一条错误码、改掉原有 data 枚举、漏写任一配对条件或漏重新生成都会失败。
    const matches = list(yaml('contracts/error-codes.yaml')['codes'])
      .map(object)
      .filter((entry) => entry['code'] === code);
    expect(matches).toHaveLength(1);
    const entry = object(matches[0]);
    const data = at(entry, 'data');
    expect(data).toStrictEqual({
      auth_url: null,
      state: null,
      auth_methods: ['web_code', 'sdk_token'],
      sdk_app_key: null,
      reason: reasons,
    });
    expect(entry).toMatchObject({
      http: 422,
      retry_kind: 'after_action',
      retry_kind_by_reason: retry,
    });
    const meaning = text(entry['meaning']);
    expect(meaning).toMatch(/公开.{0,8}(?:标识|AppKey)|public.{0,20}(?:identifier|app.?key)/iu);
    expectPairing(meaning);
    expect(errorCodes[code]).toMatchObject({ data, meaning });
  },
);

it('[AC-CT-28#4] 生成类型同步可选字符串，bindings 请求与响应维持独立', () => {
  // 漏生成、生成成必填或别的类型、把新字段放进 bindings 契约都会失败。
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  const generatedSchemas = property(namedInterface(file, 'components'), 'schemas');
  const generatedKey = property(property(generatedSchemas, 'UnionAuthUrlData'), 'sdk_app_key');
  expect(generatedKey.questionToken).toBeDefined();
  expect(generatedKey.type?.getText(file)).toBe('string');
  const doc = contract();
  const schemas = at(doc, 'components', 'schemas');
  const data = at(schemas, 'UnionAuthUrlData');
  expect(list(data['required'])).not.toContain('sdk_app_key');
  expect(at(data, 'properties', 'sdk_app_key')['type']).toBe(generatedKey.type?.getText(file));

  const bind = at(doc, 'paths', bindPath, 'post');
  expect(bind).toMatchObject({
    operationId: 'bindUnion',
    'x-auth': 'login',
    'x-signed': true,
    'x-idempotent': true,
    'x-min-version-gate': true,
    'x-error-codes': [20001, 30101, 30102, 30104, 30151, 30153, 10405],
  });
  expect(at(doc, 'paths', listBindingsPath, 'get')).toMatchObject({
    operationId: 'listUnionBindings',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [],
  });
  const request = at(bind, 'requestBody');
  expect(request).toMatchObject({ required: true });
  const requestMedia = at(request, 'content', 'application/json');
  expect(at(requestMedia, 'schema')).toEqual(schemaRef('BindUnionRequest'));
  const validateBind = compile(doc, at(schemas, 'BindUnionRequest'));
  for (const body of [
    { state: 'st_01', auth_method: 'web_code', code: 'example-authorization-code' },
    {
      state: 'st_01',
      auth_method: 'sdk_token',
      access_token: 'example-access-token',
      expires_in: 86400,
    },
  ]) {
    check(validateBind, body, true);
    check(validateBind, { ...body, sdk_app_key: 'demo-app-key' }, false);
  }
  for (const [path, method, response, dataName, dataKeys] of [
    [bindPath, 'post', 'UnionBindingResponse', 'UnionBindingState', ['platform', 'status']],
    [listBindingsPath, 'get', 'UnionBindingsResponse', 'UnionBindingsData', ['items']],
  ] as const) {
    const media = at(doc, 'paths', path, method, 'responses', '200', 'content', 'application/json');
    expect(at(media, 'schema')).toEqual(schemaRef(response));
    const envelope = at(schemas, response);
    const envelopeKeys = ['code', 'data', 'msg', 'trace_id'];
    expect(Object.keys(at(envelope, 'properties')).toSorted()).toEqual(envelopeKeys);
    expect(list(envelope['required']).toSorted()).toEqual(envelopeKeys);
    expect(envelope['additionalProperties']).toBe(false);
    expect(at(envelope, 'properties', 'data')).toEqual(schemaRef(dataName));
    const bindingData = at(schemas, dataName);
    expect(Object.keys(at(bindingData, 'properties')).toSorted()).toEqual(dataKeys);
    expect(list(bindingData['required']).toSorted()).toEqual(dataKeys);
    expect(bindingData['additionalProperties']).toBe(false);
  }
});
