// B1-02zzzb (BR-ID-08 细则「绑定业务摘要」, 上送与签发): POST /v1/auth/step-up takes `summary` for
// payout_account_change only, its shape paired with the action (else 20001 data.fields=[summary],
// no token; withdraw, phone_change and account_deletion take none), and writes it into the token as
// one string claim — computed by the server, never the plaintext account. Real AppModule, PG and
// Redis (kit.ts).
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  STEP_UP,
  TIMEOUT,
  answered,
  card,
  claimsOf,
  close,
  digestsOf,
  member,
  open,
  reset,
  type Kit,
  type StepUpAction,
  type Summary,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, TIMEOUT);

const WITHDRAW_SHAPE: Summary = { payout_account_id: randomUUID(), amount_fen: 10000 };
const ALIPAY_SHAPE: Summary = {
  payout_method: 'alipay',
  alipay_logon_id: 'b.payee@example.com',
};
const BANK_SHAPE: Summary = { payout_method: 'bank_card', card_no: card(7) };
const WECHAT_SHAPE: Summary = { payout_method: 'wechat', attempt_id: randomUUID() };

const REFUSED: [string, StepUpAction, Summary | undefined][] = [
  ['payout_account_change 不带 summary', 'payout_account_change', undefined],
  ['phone_change 带支付宝形状', 'phone_change', ALIPAY_SHAPE],
  ['account_deletion 带微信形状', 'account_deletion', WECHAT_SHAPE],
];

it.each(REFUSED)(
  '[AC-B1-02zzzb#1] %s → 20001 data.fields=[summary]，不签发 token',
  async (_name, action, summary) => {
    const m = await member(kit);
    const response = await m.stepUp(action, summary);
    const body = answered(kit, STEP_UP, 'post', response, 20001);
    expect(body.data).toEqual({ fields: ['summary'] });
    expect(response.body).not.toContain('step_up_token');
  },
  TIMEOUT,
);

it.each<[string, StepUpAction, Summary | undefined, string[]]>([
  // 这组字段是参数校验对 StepUpRequest 四分支 oneOf 的合并报告，不是设计口径，见 FU-20001-ONEOF-FIELDS-NOISE（D10-2193）。
  [
    'withdraw 带支付宝形状',
    'withdraw',
    ALIPAY_SHAPE,
    ['action', 'attempt_id', 'authorization_code', 'body', 'code', 'identity_token', 'provider'],
  ],
  [
    'withdraw 带银行卡形状',
    'withdraw',
    BANK_SHAPE,
    ['action', 'attempt_id', 'authorization_code', 'body', 'code', 'identity_token', 'provider'],
  ],
  [
    'withdraw 带微信形状',
    'withdraw',
    WECHAT_SHAPE,
    ['action', 'attempt_id', 'authorization_code', 'body', 'code', 'identity_token', 'provider'],
  ],
  [
    'payout_account_change 带提现形状',
    'payout_account_change',
    WITHDRAW_SHAPE,
    [
      'attempt_id',
      'authorization_code',
      'body',
      'code',
      'identity_token',
      'provider',
      'summary',
      'summary.alipay_logon_id',
      'summary.amount_fen',
      'summary.attempt_id',
      'summary.card_no',
      'summary.payout_account_id',
      'summary.payout_method',
    ],
  ],
  [
    'phone_change 带提现形状',
    'phone_change',
    WITHDRAW_SHAPE,
    [
      'attempt_id',
      'authorization_code',
      'body',
      'code',
      'identity_token',
      'provider',
      'summary',
      'summary.alipay_logon_id',
      'summary.amount_fen',
      'summary.attempt_id',
      'summary.card_no',
      'summary.payout_account_id',
      'summary.payout_method',
    ],
  ],
  [
    'account_deletion 带提现形状',
    'account_deletion',
    WITHDRAW_SHAPE,
    [
      'attempt_id',
      'authorization_code',
      'body',
      'code',
      'identity_token',
      'provider',
      'summary',
      'summary.alipay_logon_id',
      'summary.amount_fen',
      'summary.attempt_id',
      'summary.card_no',
      'summary.payout_account_id',
      'summary.payout_method',
    ],
  ],
])(
  '[AC-B1-02zzzb#1] %s → 20001 data.fields 为参数校验的 oneOf 合并报告（见 FU-20001-ONEOF-FIELDS-NOISE），不签发 token',
  async (_name, action, summary, fields) => {
    const m = await member(kit);
    const response = await m.stepUp(action, summary);
    const body = answered(kit, STEP_UP, 'post', response, 20001);
    expect({ ...body.data, fields: [...(body.data!.fields as string[])].sort() }).toEqual({
      fields,
    });
    expect(response.body).not.toContain('step_up_token');
  },
  TIMEOUT,
);

it.each([
  ['手机号形式', '+86 139-0013-9000', '13900139000', '139-0013-9000'],
  ['邮箱形式', ' B.Payee@Example.COM', 'b.payee@example.com', 'B.Payee@Example.COM'],
])(
  '[AC-B1-02zzzb#4] 支付宝摘要（%s）由服务端规范化：同一账号两种写法指纹相同，换账号指纹不同，claims 无明文',
  async (_name, typed, normalised, raw) => {
    const m = await member(kit);
    const first = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: typed,
    });
    const second = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: normalised,
    });
    const other = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: 'c.payee@example.com',
    });
    const digests = digestsOf(first);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/^p:alipay:\S+$/);
    expect(digestsOf(second)).toEqual(digests);
    expect(digestsOf(other)).toHaveLength(1);
    expect(digestsOf(other)[0]).toMatch(/^p:alipay:\S+$/);
    expect(digestsOf(other)).not.toEqual(digests);
    for (const token of [first, second, other]) {
      const text = JSON.stringify(claimsOf(token));
      for (const secret of [normalised, raw, 'c.payee@example.com'])
        expect(text.includes(secret), 'plaintext logon id in the token claims').toBe(false);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#4] 银行卡摘要由服务端规范化：卡号带空格与不带空格指纹相同，换卡指纹不同，claims 无明文',
  async () => {
    const m = await member(kit);
    const digits = card(1);
    const spaced = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    const first = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: spaced,
    });
    const second = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: digits,
    });
    const other = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: card(2),
    });
    const digests = digestsOf(first);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/^p:bank_card:\S+$/);
    expect(digestsOf(second)).toEqual(digests);
    expect(digestsOf(other)).toHaveLength(1);
    expect(digestsOf(other)).not.toEqual(digests);
    for (const token of [first, second, other]) {
      const text = JSON.stringify(claimsOf(token));
      for (const secret of [digits, spaced, card(2)])
        expect(text.includes(secret), 'plaintext card number in the token claims').toBe(false);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#5] 微信零钱摘要 = p:wechat:<attempt_id>（不按 openid 算）',
  async () => {
    const m = await member(kit);
    const attemptId = randomUUID();
    const token = await m.token('payout_account_change', {
      payout_method: 'wechat',
      attempt_id: attemptId,
    });
    expect(digestsOf(token)).toEqual([`p:wechat:${attemptId}`]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#8] 只有 payout_account_change 绑摘要：phone_change、account_deletion、withdraw 不带 summary 照常签发且无摘要 claim，同一会员 withdraw 带 summary 则 20001',
  async () => {
    const m = await member(kit);
    for (const action of ['phone_change', 'account_deletion'] as const) {
      const token = await m.token(action);
      expect(claimsOf(token)).toMatchObject({ uid: m.uid, action, aud: 'step_up' });
      expect(digestsOf(token)).toEqual([]);
    }
    const withdrawRefused: [Summary | undefined, string[]][] = [
      // 这组字段是参数校验对 StepUpRequest 四分支 oneOf 的合并报告，不是设计口径，见 FU-20001-ONEOF-FIELDS-NOISE（D10-2193）。
      [
        undefined,
        [
          'action',
          'attempt_id',
          'authorization_code',
          'body',
          'code',
          'identity_token',
          'provider',
        ],
      ],
      [
        WITHDRAW_SHAPE,
        [
          'action',
          'attempt_id',
          'authorization_code',
          'body',
          'code',
          'identity_token',
          'provider',
          'summary',
          'summary.alipay_logon_id',
          'summary.amount_fen',
          'summary.attempt_id',
          'summary.card_no',
          'summary.payout_account_id',
          'summary.payout_method',
        ],
      ],
    ];
    for (const [summary, fields] of withdrawRefused) {
      const response = await m.stepUp('withdraw', summary);
      const refused = answered(kit, STEP_UP, 'post', response, 20001);
      expect({ ...refused.data, fields: [...(refused.data!.fields as string[])].sort() }).toEqual({
        fields,
      });
      expect(response.body).not.toContain('step_up_token');
    }
  },
  TIMEOUT,
);
