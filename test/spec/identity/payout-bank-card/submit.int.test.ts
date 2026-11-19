import { createHash, randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ALIPAY,
  BANK,
  BANK_CONTEXT,
  BIN,
  NAME,
  PATH,
  account,
  bankBody,
  block,
  card,
  change,
  close,
  config,
  envelope,
  fixture,
  open,
  privateDataAbsent,
  reset,
  seedAttempt,
  state,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
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
});

// CT-26c 起收款账号响应必返 payout_account_id（当前收款账号行的编号，契约 PayoutAccount*）。
// 期望值必须是确定的行编号（字符串）；响应缺该键或值不同都让 toEqual 失败。
function withPayoutAccountId(
  expected: Record<string, unknown>,
  currentId: string | undefined,
): Record<string, unknown> {
  expect(currentId).toEqual(expect.any(String));
  return { payout_account_id: currentId, ...expected };
}

it('[AC-B1-13f#1] PUT 去 planned，契约声明错误码且开户行由服务端 BIN 带出', async () => {
  const operation = kit.document.paths[PATH]!['put']!;
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({
    'x-auth': 'realname',
    'x-signed': true,
    'x-idempotent': true,
    'x-step-up': 'payout_account_change',
    'x-min-version-gate': true,
    'x-error-codes': expect.arrayContaining([20001, 44001, 40901, 50401, 50301]),
  });
  const f = await fixture(kit);
  expect(envelope(kit, await f.submit()).data).toMatchObject({ bank_name: BANK });
});

it.each([12, 16, 19])(
  '[AC-B1-13f#2] %i 位合法卡号去空格连字符，银行名忽略用户输入，密文与 HMAC 使用统一上下文',
  async (length) => {
    const f = await fixture(kit);
    const digits = card(1, length);
    const typed = ` ${digits.slice(0, 6)}-${digits.slice(6, 10)} ${digits.slice(10)} `;
    const key = randomUUID();
    const body = bankBody(typed, { bank_name: '用户伪填银行' });
    const response = await f.submit(body, key);
    const data = envelope(kit, response).data;
    const currentId = (await state(kit, f)).accounts.find((row) => row.is_current)?.id;
    expect(data).toEqual(
      withPayoutAccountId(
        {
          payout_method: 'bank_card',
          masked_account: `尾号 ${digits.slice(-4)}`,
          bank_name: BANK,
          masked_payee_name: '*******提',
          change_remaining_this_month: 2,
        },
        currentId,
      ),
    );
    expect(kit.lookup).toHaveBeenCalledWith(digits);
    expect(kit.verify).toHaveBeenCalledTimes(1);
    const attempts = await f.attempts();
    expect(attempts).toHaveLength(1);
    const rn = await kit.db
      .selectFrom('realname')
      .select('id')
      .where('user_id', '=', f.uid)
      .executeTakeFirstOrThrow();
    const hmac = kit.crypto.blindIndex(digits, BANK_CONTEXT);
    expect(attempts[0]).toMatchObject({
      status: 'matched',
      idempotency_key: key,
      origin_action: 'payout_account_change',
      request_fingerprint: `${rn.id}:${hmac}`,
      resolved_at: kit.clock.now(),
      vendor_request_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(kit.verify).toHaveBeenCalledWith({
      vendor_request_id: attempts[0]!.vendor_request_id,
      card_no: digits,
      name: NAME,
      id_no: f.idNo,
    });
    const stored = await state(kit, f);
    expect(stored.accounts).toHaveLength(1);
    expect(stored.changes).toEqual([]);
    const row = stored.accounts[0]!;
    expect(row).toMatchObject({
      bank_name: BANK,
      card_bin: BIN,
      bank_card_hmac: hmac,
      is_current: true,
    });
    expect(kit.crypto.decrypt(row.bank_card_no_cipher!.toString('utf8'), BANK_CONTEXT)).toBe(
      digits,
    );
    const records = await f.idempotency(key);
    expect(records).toHaveLength(1);
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    expect(records[0]!.request_hash).toBe(
      `hmac1:${kit.crypto.blindIndex(canonical, 'idempotency.request_hash')}`,
    );
    expect(records[0]!.request_hash).not.toBe(createHash('sha256').update(canonical).digest('hex'));
    privateDataAbsent(
      kit,
      [response.json()],
      [digits, typed, NAME, f.idNo, hmac, row.bank_card_no_cipher!.toString('utf8'), BIN],
    );
  },
);

it.each([
  card(1, 11),
  card(1, 20),
  `${card().slice(0, -1)}${(Number(card().at(-1)) + 1) % 10}`,
  `A${card().slice(1)}`,
  `+${card()}`,
])('[AC-B1-13f#3] 不合法卡号 %s 返回 20001 card_no，不占额不外调', async (digits) => {
  const f = await fixture(kit);
  expect(envelope(kit, await f.submit(bankBody(digits)), 20001).data).toEqual({
    fields: ['card_no'],
  });
  expect(await f.attempts()).toEqual([]);
  expect((await state(kit, f)).accounts).toEqual([]);
  expect(kit.verify).not.toHaveBeenCalled();
});

it.each(['credit', 'unrecognised'] as const)(
  '[AC-B1-13f#4] BIN 为 %s 时拒绝且不收费',
  async (kind) => {
    const f = await fixture(kit);
    kit.lookup.mockResolvedValue(
      kind === 'credit' ? { card_type: 'credit', bank_name: BANK, bin: BIN } : null,
    );
    expect(envelope(kit, await f.submit(), 20001).data).toEqual({ fields: ['card_no'] });
    expect(await f.attempts()).toEqual([]);
    expect(kit.verify).not.toHaveBeenCalled();
  },
);

it.each(['bin', 'verifier'] as const)(
  '[AC-B1-13f#5] 未注入 %s 返回 50301，零预占且不核销 step-up',
  async (absent) => {
    const fallback = await open(database, redis, absent);
    try {
      const f = await fixture(fallback);
      // B1-02zzzb: the token is for the Alipay save that succeeds (50301 is judged before it).
      const token = await f.stepUp('payout_account_change', ALIPAY);
      envelope(fallback, await f.submit(bankBody(), randomUUID(), token), 50301);
      expect(await f.attempts()).toEqual([]);
      expect(fallback.verify).not.toHaveBeenCalled();
      envelope(fallback, await f.submit(ALIPAY, randomUUID(), token));
    } finally {
      await close(fallback);
    }
  },
);

it.each(['disabled', 'blacklist', 'name', 'occupied', 'changes'] as const)(
  '[AC-B1-13f#6] 本地拒绝 %s 先于预占和供应商',
  async (reason) => {
    const f = await fixture(kit);
    let body = bankBody();
    let code = 30303;
    if (reason === 'disabled') {
      await config(kit, f, 'withdraw.payout_methods', ['alipay']);
      code = 20001;
    }
    if (reason === 'blacklist') {
      await block(kit, f);
      code = 44001;
    }
    if (reason === 'name') {
      body = bankBody(card(), { payee_name: '不是本人' });
      code = 30307;
    }
    if (reason === 'occupied') {
      const other = await fixture(kit, { appId: f.appId });
      await account(kit, other, card(), { method: 'bank_card' });
      code = 30308;
    }
    if (reason === 'changes') {
      await account(kit, f);
      await change(kit, f);
      await change(kit, f);
    }
    const response = envelope(kit, await f.submit(body), code);
    if (reason === 'disabled') expect(response.data).toEqual({ fields: ['payout_method'] });
    if (reason === 'changes')
      expect(response.data).toEqual({ reason: 'payout_account_change_limit' });
    expect(await f.attempts()).toEqual([]);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(kit.query).not.toHaveBeenCalled();
  },
);

it('[AC-B1-13f#7] 相同当前银行卡即使月额度用尽仍成功，不写账号、变更或核验记录；仍先比户名', async () => {
  const f = await fixture(kit);
  await account(kit, f, card(), { method: 'bank_card' });
  await change(kit, f);
  await change(kit, f);
  const before = await state(kit, f);
  envelope(kit, await f.submit(bankBody(card(), { payee_name: '错误姓名' })), 30307);
  envelope(kit, await f.submit());
  expect(await state(kit, f)).toEqual(before);
  expect(await f.attempts()).toEqual([]);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13f#8] 默认每日三次，不一致保留占额，超限 30303 verify_limit 不调用且不消费 token', async () => {
  const f = await fixture(kit);
  kit.verify.mockResolvedValue('mismatch');
  let token = await f.stepUp();
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(bankBody(), randomUUID(), token), 30307);
  // B1-02zzzb: the token binds one account; the digest is compared before the day's quota.
  token = await f.stepUp('payout_account_change', bankBody(card(2)));
  expect(envelope(kit, await f.submit(bankBody(card(2)), randomUUID(), token), 30303).data).toEqual(
    { reason: 'payout_account_verify_limit' },
  );
  expect(kit.verify).toHaveBeenCalledTimes(3);
  expect(await f.attempts()).toHaveLength(3);
  expect((await f.attempts()).every((row) => row.status === 'mismatched')).toBe(true);
  token = await f.stepUp('payout_account_change', ALIPAY);
  envelope(kit, await f.submit(ALIPAY, randomUUID(), token));
  // B1-02zzzb: the same token, body and a new key again — consumed by the save above.
  envelope(kit, await f.submit(ALIPAY, randomUUID(), token), 10003);
});

it.each([0, -1, 1.5, '2', null])(
  '[AC-B1-13f#9] 无效每日额度 %j 回退三次且 warn 仅携带配置键',
  async (value) => {
    const f = await fixture(kit);
    const key = 'withdraw.payout_account_verify_per_day';
    await config(kit, f, key, value);
    kit.verify.mockResolvedValue('mismatch');
    for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30307);
    expect(envelope(kit, await f.submit(), 30303).data).toEqual({
      reason: 'payout_account_verify_limit',
    });
    const warnings = kit.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40 && line['config_key'] === key);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning).not.toHaveProperty('value');
      expect(warning).not.toHaveProperty('user_id');
      expect(warning).not.toHaveProperty('card_no');
    }
  },
);

it('[AC-B1-13f#10] 当日统计包括在途、unknown 与终态，排除 released、昨日和别的用户；按 +08:00 换日', async () => {
  kit.clock.set('2026-10-18T15:59:59.000Z');
  const f = await fixture(kit);
  await config(kit, f, 'withdraw.payout_account_verify_per_day', 3);
  await seedAttempt(kit, f, { status: 'reserved', cardNo: card(2) });
  await seedAttempt(kit, f, { status: 'unknown', cardNo: card(3) });
  await seedAttempt(kit, f, { status: 'expired_unresolved', cardNo: card(4) });
  expect(envelope(kit, await f.submit(), 30303).data).toEqual({
    reason: 'payout_account_verify_limit',
  });
  kit.clock.set('2026-10-18T16:00:00.000Z');
  await seedAttempt(kit, f, { status: 'released', cardNo: card(5), verifyDate: '2026-10-19' });
  const other = await fixture(kit, { appId: f.appId });
  await seedAttempt(kit, other, { status: 'mismatched', verifyDate: '2026-10-19' });
  kit.verify.mockResolvedValue('mismatch');
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30307);
  envelope(kit, await f.submit(), 30303);
  expect(kit.verify).toHaveBeenCalledTimes(3);
  const rows = await f.attempts();
  expect(rows.filter((row) => row.status === 'mismatched')).toHaveLength(3);
  // pg's DATE representation is not assumed; compare using SQL's text projection.
  const dates = await kit.db
    .selectFrom('payout_account_verify_attempts')
    .select(sql<string>`verify_date::text`.as('day'))
    .where('user_id', '=', f.uid)
    .where('status', '=', 'mismatched')
    .execute();
  expect(dates.map((row) => row.day)).toEqual(['2026-10-19', '2026-10-19', '2026-10-19']);
});

it('[AC-B1-13f#11] 银行卡成功核销 step-up，同键回放绕过已消费 token；换支付宝共用变更计数', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const token = await f.stepUp();
  const first = await f.submit(bankBody(), key, token);
  envelope(kit, first);
  const replay = await f.submit(bankBody(), key, token);
  envelope(kit, replay);
  expect(replay.body).toBe(first.body);
  envelope(kit, await f.submit(bankBody(card(2)), randomUUID(), token), 10003);
  envelope(kit, await f.submit(ALIPAY));
  const rows = await state(kit, f);
  expect(rows.accounts.filter((row) => row.is_current)).toHaveLength(1);
  expect(rows.accounts.find((row) => row.is_current)?.payout_method).toBe('alipay');
  expect(rows.changes).toHaveLength(1);
  expect(rows.changes[0]).toMatchObject({
    old_payout_method: 'bank_card',
    new_payout_method: 'alipay',
  });
  expect(kit.verify).toHaveBeenCalledTimes(1);
});

it('[AC-B1-13f#12] 未实名与无效 step-up 在预占前拒绝，正确 token 才能触达银行卡供应商', async () => {
  const unverified = await fixture(kit, { verified: false });
  envelope(kit, await unverified.submit(), 30304);
  const f = await fixture(kit);
  envelope(kit, await f.submit(bankBody(), randomUUID(), ''), 10003);
  envelope(kit, await f.submit(bankBody(), randomUUID(), await f.stepUp('withdraw')), 10003);
  expect(await f.attempts()).toEqual([]);
  expect(kit.verify).not.toHaveBeenCalled();
  envelope(kit, await f.submit());
  expect(kit.verify).toHaveBeenCalledTimes(1);
});
