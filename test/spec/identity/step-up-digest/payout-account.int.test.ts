// B1-02zzzb (BR-ID-08 细则「绑定业务摘要」action=payout_account_change; BR-WDR-02 细则「保存在用户级
// 锁内」): the payout_account_change step_up_token's digest is the new account's normalised
// fingerprint (payout_method + HMAC; WeChat: the payout_bind attempt_id). PUT /v1/me/payout-account
// normalises the body's account, computes the fingerprint and compares it with the claim inside the
// user lock; a different account → 10003 without data, the binding unchanged and the token not
// consumed; two spellings of one account → the same fingerprint → saved. Real AppModule, PG, Redis
// and PUT route; only the card BIN / verification vendors are the payout-bank-card kit's mocks.
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BANK_CONTEXT,
  NAME,
  TIMEOUT,
  bankBody,
  card,
  close,
  digestsOf,
  member,
  open,
  reset,
  saveRefused,
  saved,
  type Kit,
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

function alipay(logon: string) {
  return { payout_method: 'alipay', alipay_logon_id: logon, payee_name: NAME };
}
function spaced(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}
function hyphened(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1-');
}

it.each([
  ['手机号形式', '+86 139-0013-9000', '13900139000', '13900139000'],
  ['手机号形式（反向）', '13900139000', '+86 139 0013 9000', '13900139000'],
  ['邮箱形式', ' B.Payee@Example.COM', 'b.payee@example.com', 'b.payee@example.com'],
])(
  '[AC-B1-02zzzb#4] 支付宝（%s）：为账号 B 取令牌，保存账号 C → 10003、不改绑定、不核销；B 的另一种写法保存 → 通过',
  async (_name, typed, other, normalised) => {
    const m = await member(kit);
    const step = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: typed,
    });
    const before = await m.accounts();
    saveRefused(kit, await m.save(alipay('c.payee@example.com'), step));
    expect(await m.accounts()).toEqual(before);
    saved(kit, await m.save(alipay(other), step));
    const after = await m.accounts();
    const current = after.accounts.filter((row) => row.is_current);
    expect(current).toEqual([
      expect.objectContaining({
        payout_method: 'alipay',
        alipay_hmac: m.alipayHmac(normalised),
      }),
    ]);
    // Consumed by the save it passed.
    saveRefused(kit, await m.save(alipay(other), step));
  },
  TIMEOUT,
);

it.each([
  ['令牌带空格、保存不带', spaced, (digits: string) => digits],
  ['令牌不带、保存带连字符', (digits: string) => digits, hyphened],
])(
  '[AC-B1-02zzzb#4] 银行卡（%s）：为卡 B 取令牌，保存卡 C → 10003、不改绑定；B 的另一种写法保存 → 通过',
  async (_name, tokenForm, saveForm) => {
    const m = await member(kit);
    const b = card(1);
    const c = card(2);
    const step = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: tokenForm(b),
    });
    const before = await m.accounts();
    saveRefused(kit, await m.save(bankBody(c), step));
    expect(await m.accounts()).toEqual(before);
    saved(kit, await m.save(bankBody(saveForm(b)), step));
    const current = (await m.accounts()).accounts.filter((row) => row.is_current);
    expect(current).toEqual([
      expect.objectContaining({
        payout_method: 'bank_card',
        bank_card_hmac: kit.crypto.blindIndex(b, BANK_CONTEXT),
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#4] 换收款方式也比对：支付宝摘要的令牌保存银行卡、银行卡摘要的令牌保存支付宝 → 10003',
  async () => {
    const m = await member(kit);
    const before = await m.accounts();
    const forAlipay = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: 'b.payee@example.com',
    });
    saveRefused(kit, await m.save(bankBody(card(1)), forAlipay));
    const forCard = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: card(1),
    });
    saveRefused(kit, await m.save(alipay('b.payee@example.com'), forCard));
    expect(await m.accounts()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#5] 微信零钱：摘要为 p:wechat:<attempt_id>，该令牌不能用于保存支付宝 / 银行卡账号（10003，不改绑定）',
  async () => {
    const m = await member(kit);
    const attemptId = randomUUID();
    const step = await m.token('payout_account_change', {
      payout_method: 'wechat',
      attempt_id: attemptId,
    });
    expect(digestsOf(step)).toEqual([`p:wechat:${attemptId}`]);
    const before = await m.accounts();
    saveRefused(kit, await m.save(alipay('b.payee@example.com'), step));
    saveRefused(kit, await m.save(bankBody(card(1)), step));
    expect(await m.accounts()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zzzb#6] claims 不含摘要的 payout_account_change 令牌（签法同 POST /v1/auth/step-up）→ 10003、不改绑定',
  async () => {
    const m = await member(kit);
    const bare = await m.mint('payout_account_change');
    expect(digestsOf(bare)).toEqual([]);
    const before = await m.accounts();
    saveRefused(kit, await m.save(alipay('b.payee@example.com'), bare));
    saveRefused(kit, await m.save(bankBody(card(1)), bare));
    expect(await m.accounts()).toEqual(before);
  },
  TIMEOUT,
);
