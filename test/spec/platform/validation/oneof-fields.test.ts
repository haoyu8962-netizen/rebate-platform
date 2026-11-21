import { expect, it } from 'vitest';
import { contractRouteSchema } from '../../../../apps/api/src/modules/platform/validation/contract-routes.ts';
import {
  validationErrorEnvelope,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { fastifyValidationError } from './kit.ts';

// D10-2260 / D10-2267 口径甲：从实际路由 schema 取得 Ajv 错误，字段期望按契约手算。
function expectFields(
  schema: JsonSchema,
  body: object,
  expected: readonly string[],
  previous: readonly string[],
): void {
  const error = fastifyValidationError(schema, 'body', body);
  const response = validationErrorEnvelope(error, 'trace-oneof-fields');
  const fields = [...(response?.body.data.fields ?? [])].sort();
  expect(fields).toEqual(expected);
  expect(fields.filter((field) => !previous.includes(field))).toEqual([]);
  expect(response?.body.code).toBe(20001);
}

const SMS = { code: '123456' };
const ALIPAY_SUMMARY = { payout_method: 'alipay', alipay_logon_id: 'payee@example.com' };
const WITHDRAW_SUMMARY = {
  payout_account_id: '00000000-0000-4000-8000-000000000000',
  amount_fen: 10000,
};

const STEP_UP_PREVIOUS_FIELDS = [
  'attempt_id',
  'authorization_code',
  'body',
  'code',
  'identity_token',
  'provider',
];
const WITHDRAW_PREVIOUS_FIELDS = ['action', ...STEP_UP_PREVIOUS_FIELDS];
const WITHDRAW_SUMMARY_PREVIOUS_FIELDS = [
  ...STEP_UP_PREVIOUS_FIELDS,
  'summary',
  'summary.alipay_logon_id',
  'summary.amount_fen',
  'summary.attempt_id',
  'summary.card_no',
  'summary.payout_account_id',
  'summary.payout_method',
];
const PAYOUT_ACCOUNT_PREVIOUS_FIELDS = [
  'alipay_logon_id',
  'body',
  'card_no',
  'payee_name',
  'payout_method',
];
const OAUTH_ATTEMPT_PREVIOUS_FIELDS = ['action', 'body', 'purpose'];

type RequestCase = [
  title: string,
  operation:
    | 'stepUp'
    | 'savePayoutAccount'
    | 'bindUnion'
    | 'createOauthAttempt'
    | 'adminCreateExport'
    | 'adminCreateAdjustment',
  body: object,
  expected: readonly string[],
  previous: readonly string[],
];

it.each<RequestCase>([
  [
    'stepUp withdraw 带支付宝形状',
    'stepUp',
    { ...SMS, action: 'withdraw', summary: ALIPAY_SUMMARY },
    ['action', 'body'],
    WITHDRAW_PREVIOUS_FIELDS,
  ],
  [
    'stepUp withdraw 不带 summary',
    'stepUp',
    { ...SMS, action: 'withdraw' },
    ['action', 'body'],
    WITHDRAW_PREVIOUS_FIELDS,
  ],
  [
    'stepUp withdraw 带提现形状',
    'stepUp',
    { ...SMS, action: 'withdraw', summary: WITHDRAW_SUMMARY },
    ['action', 'body'],
    ['action', ...WITHDRAW_SUMMARY_PREVIOUS_FIELDS],
  ],
  [
    'stepUp payout_account_change 带提现形状',
    'stepUp',
    { ...SMS, action: 'payout_account_change', summary: WITHDRAW_SUMMARY },
    ['body', 'summary'],
    WITHDRAW_SUMMARY_PREVIOUS_FIELDS,
  ],
  [
    'stepUp phone_change 带提现形状',
    'stepUp',
    { ...SMS, action: 'phone_change', summary: WITHDRAW_SUMMARY },
    ['body', 'summary'],
    WITHDRAW_SUMMARY_PREVIOUS_FIELDS,
  ],
  [
    'stepUp account_deletion 带提现形状',
    'stepUp',
    { ...SMS, action: 'account_deletion', summary: WITHDRAW_SUMMARY },
    ['body', 'summary'],
    WITHDRAW_SUMMARY_PREVIOUS_FIELDS,
  ],
  [
    'stepUp 短信码格式错',
    'stepUp',
    { action: 'phone_change', code: '12' },
    ['body', 'code'],
    STEP_UP_PREVIOUS_FIELDS,
  ],
  [
    'stepUp 微信缺 attempt_id',
    'stepUp',
    { action: 'phone_change', provider: 'wechat', code: 'oauth-code' },
    ['attempt_id', 'body'],
    STEP_UP_PREVIOUS_FIELDS,
  ],
  [
    'stepUp 支付宝 summary 缺账号',
    'stepUp',
    { ...SMS, action: 'payout_account_change', summary: { payout_method: 'alipay' } },
    ['body', 'summary', 'summary.alipay_logon_id'],
    [
      ...STEP_UP_PREVIOUS_FIELDS,
      'summary',
      'summary.alipay_logon_id',
      'summary.attempt_id',
      'summary.card_no',
      'summary.payout_method',
    ],
  ],
  [
    'savePayoutAccount 支付宝缺账号和收款人',
    'savePayoutAccount',
    { payout_method: 'alipay' },
    ['alipay_logon_id', 'body', 'payee_name'],
    PAYOUT_ACCOUNT_PREVIOUS_FIELDS,
  ],
  [
    'savePayoutAccount 方式非法',
    'savePayoutAccount',
    { payout_method: 'paypal' },
    ['body', 'payout_method'],
    PAYOUT_ACCOUNT_PREVIOUS_FIELDS,
  ],
  [
    'bindUnion web_code 缺 code 和 state',
    'bindUnion',
    { auth_method: 'web_code' },
    ['body', 'code', 'state'],
    ['access_token', 'auth_method', 'body', 'code', 'expires_in', 'state'],
  ],
  [
    'createOauthAttempt step_up 缺 action',
    'createOauthAttempt',
    { purpose: 'step_up', provider: 'wechat' },
    ['action', 'body'],
    OAUTH_ATTEMPT_PREVIOUS_FIELDS,
  ],
  [
    'createOauthAttempt purpose 非法',
    'createOauthAttempt',
    { purpose: 'invalid', provider: 'wechat' },
    ['body', 'purpose'],
    OAUTH_ATTEMPT_PREVIOUS_FIELDS,
  ],
  [
    'adminCreateExport users 缺 filters',
    'adminCreateExport',
    { resource: 'users' },
    ['body', 'filters'],
    ['body', 'filters', 'resource'],
  ],
  [
    'adminCreateAdjustment 新调账金额为零',
    'adminCreateAdjustment',
    {
      user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02',
      direction: 'increase',
      amount_fen: 0,
      reason_code: 'OTHER',
      note: '更正',
    },
    ['amount_fen', 'body'],
    ['amount_fen', 'body', 'direction', 'reason_code', 'reverses_adjust_id', 'user_id'],
  ],
])('[AC-B1-01zzw#1] %s', (_title, operation, body, expected, previous) => {
  expectFields(contractRouteSchema(operation).body, body, expected, previous);
});

it('[AC-B1-01zzw#2] oneOf 打平且都只缺必填时报并集（产品池、空消息标记）', () => {
  // 产品池表单只缺二选一的入口，两个缺项都要保留。
  expectFields(
    contractRouteSchema('adminAddPoolItem').body,
    { sort: 0, start_at: null, end_at: null },
    ['body', 'item_ref', 'link_text'],
    ['body', 'item_ref', 'link_text'],
  );
  // 根层缺少 sort 时，二选一的缺项与根层的必填错误都要保留。
  expectFields(
    contractRouteSchema('adminAddPoolItem').body,
    { start_at: null, end_at: null },
    ['body', 'item_ref', 'link_text', 'sort'],
    ['body', 'item_ref', 'link_text', 'sort'],
  );
  // step_up 分支缺少 action，根层对 provider 的枚举校验也失败。
  expectFields(
    contractRouteSchema('createOauthAttempt').body,
    { provider: 'qq', purpose: 'step_up' },
    ['action', 'body', 'provider'],
    ['action', 'body', 'provider', 'purpose'],
  );
  // 两个分支都通过时，只有 oneOf 本身报错。
  expectFields(
    contractRouteSchema('adminAddPoolItem').body,
    { link_text: 'x', item_ref: 'y', sort: 0, start_at: null, end_at: null },
    ['body'],
    ['body'],
  );
  // 消息标记的两个分支打平且都只缺必填（二选一），同样报并集（口径甲细化，D10-2267 试跑 2）。
  expectFields(
    contractRouteSchema('markMessagesRead').body,
    {},
    ['all', 'body', 'message_ids'],
    ['all', 'body', 'message_ids'],
  );
});

it('[AC-B1-01zzw#3] 嵌套 anyOf 按 const 选分支并保留数组下标及转义后的字段名', () => {
  expectFields(
    contractRouteSchema('adminAddPoolItem').body,
    { link_text: 'product-link', sort: 0, start_at: 12, end_at: null },
    ['start_at'],
    ['start_at'],
  );

  const schema: JsonSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          unevaluatedProperties: false,
          anyOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'link' },
                label: { type: 'string' },
                'link/text~value': { type: 'string', minLength: 1 },
              },
              required: ['kind', 'label', 'link/text~value'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { const: 'reference' }, item_ref: { type: 'string' } },
              required: ['kind', 'item_ref'],
            },
          ],
        },
      },
    },
  };
  expectFields(
    schema,
    { items: [{ kind: 'link', 'link/text~value': '' }] },
    ['items.0', 'items.0.label', 'items.0.link/text~value'],
    ['items.0', 'items.0.item_ref', 'items.0.kind', 'items.0.label', 'items.0.link/text~value'],
  );
});
