import { randomUUID } from 'node:crypto';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createDb, destroyDb } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { account, close, config, NAME, open, type Kit } from '../../identity/payout-account/kit.ts';
import { seedBlock } from '../../risk/blocklist/kit.ts';
import {
  approvedItem,
  itemsOf,
  withReviewAdmin,
} from '../admin-withdrawal-review/review-harness.ts';
import { assertContract } from '../rules/http-kit.ts';
import {
  accepted,
  client,
  nothingMoved,
  refused,
  TIMEOUT,
  type Client,
  type WireResponse,
} from '../withdraw-no-step-up/kit.ts';

const METHODS = 'withdraw.payout_methods';
const AMOUNT = 1000;
const METHODS_UNDER_TEST = ['alipay', 'bank_card'] as const;
type Method = (typeof METHODS_UNDER_TEST)[number];

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
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

function deactivateCurrentAccount(c: Client) {
  return kit.db
    .updateTable('payout_accounts')
    .set({ is_current: false })
    .where('app_id', '=', c.f.appId)
    .where('user_id', '=', c.f.uid)
    .where('is_current', '=', true)
    .execute();
}

async function member(method: Method = 'alipay', verified = true) {
  const c = await client(kit, { verified, balance: 10000n });
  if (method === 'bank_card') {
    await deactivateCurrentAccount(c);
    await account(kit, c.f, '6222021234567890123', { method });
  }
  const token = await kit.tokens.issueAccess({ ...c.principal, scp: 'full' });
  const set = (key: string, value: unknown) => config(kit, c.f, key, value);
  const openMethod = () => set(METHODS, [method]);
  const closeMethod = () => set(METHODS, [method === 'alipay' ? 'bank_card' : 'alipay']);

  async function rules(checkContract = false) {
    const response = await kit.app.inject({
      method: 'GET',
      url: '/v1/withdrawals/rules',
      headers: {
        authorization: `Bearer ${token}`,
        'x-app-id': c.f.appId,
        'x-device-id': c.deviceId,
        'x-platform': 'ios',
        'x-channel': 'appstore',
        'x-app-version': '2.0.0',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    if (checkContract) await assertContract(response, 'WithdrawRulesResponse');
    const body = response.json<Schema<'WithdrawRulesResponse'>>();
    expect(body).toMatchObject({ code: 0, data: expect.any(Object) });
    return body.data;
  }

  async function expectBlocked(code: number, status = 422) {
    expect(await rules()).toMatchObject({ can_withdraw: false, block_code: code });
    refused(await c.post({ amount: AMOUNT }), status, code);
  }

  return { ...c, set, openMethod, closeMethod, rules, expectBlocked };
}

it.each(METHODS_UNDER_TEST)(
  '[AC-B2-05u#1][AC-B2-05u#3] %s 关闭时两个提现接口都返回 30305，重新开放后都通过',
  async (method) => {
    const c = await member(method);
    await c.closeMethod();
    await c.expectBlocked(30305);

    await c.openMethod();
    expect(await c.rules(true)).toMatchObject({ can_withdraw: true, block_code: null });
    accepted(await c.post({ amount: AMOUNT }), AMOUNT);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05u#2] 关闭后提交 30305 不建单不冻结，原键跨配置变化重放首次错误，新键受理',
  async () => {
    const c = await member();
    await c.closeMethod();
    const initial = await c.state();
    expect(initial.withdrawals).toEqual([]);
    expect(initial.balances).toEqual([
      expect.objectContaining({ available_fen: 10000n, frozen_fen: 0n }),
    ]);

    const key = randomUUID();
    const first = await c.post({ key, amount: AMOUNT });
    refused(first, 422, 30305);
    await assertContract(first, 'ErrorEnvelope');
    const stored = await c.state();
    nothingMoved(stored, initial);
    expect(stored.keys).toEqual([
      expect.objectContaining({
        key,
        user_id: c.f.uid,
        method: 'POST',
        path: '/v1/withdrawals',
        status: 'completed',
        response: { status: 422, body: first.body },
      }),
    ]);

    async function expectReplay() {
      const replay = await c.post({ key, amount: AMOUNT });
      refused(replay, 422, 30305);
      expect(replay.body).toBe(first.body);
      expect(await c.state()).toEqual(stored);
    }
    await expectReplay();
    await c.openMethod();
    await expectReplay();

    accepted(await c.post({ key: randomUUID(), amount: AMOUNT }), AMOUNT);
    const after = await c.state();
    expect(after.withdrawals).toEqual([expect.objectContaining({ amount_fen: 1000n })]);
    expect(after.balances).toEqual([
      expect.objectContaining({ available_fen: 9000n, frozen_fen: 1000n }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05u#4] 方式关闭时两个接口仍优先判断总开关 30306、未实名 30304 和收款账号黑名单 44001',
  async () => {
    const c = await member('alipay', false);
    await c.closeMethod();
    await c.set('withdraw.enabled', false);
    await c.expectBlocked(30306);

    await c.set('withdraw.enabled', true);
    await c.expectBlocked(30304);

    await kit.db
      .insertInto('realname')
      .values({
        id: randomUUID(),
        app_id: c.f.appId,
        user_id: c.f.uid,
        status: 'verified',
        name_cipher: Buffer.from(kit.crypto.encrypt(NAME, 'realname.name')),
        id_no_cipher: Buffer.from(kit.crypto.encrypt(c.f.uid, 'realname.id_no')),
        id_no_hmac: kit.crypto.blindIndex(c.f.uid, 'realname.id_no'),
        birth_date_cipher: Buffer.from(kit.crypto.encrypt('1990-01-01', 'realname.birth_date')),
        provider: 'fixture',
        verified_at: kit.clock.now(),
      })
      .execute();

    const payee = await kit.db
      .selectFrom('payout_accounts')
      .select('alipay_hmac')
      .where('app_id', '=', c.f.appId)
      .where('user_id', '=', c.f.uid)
      .where('is_current', '=', true)
      .$narrowType<{ alipay_hmac: string }>()
      .executeTakeFirstOrThrow();
    const blockId = await seedBlock(kit.db, c.f.appId, 'alipay', payee.alipay_hmac, kit.clock);
    await c.expectBlocked(44001, 403);
    await kit.db
      .updateTable('blocklist')
      .set({ status: 'inactive' })
      .where('app_id', '=', c.f.appId)
      .where('id', '=', blockId)
      .execute();
    await c.expectBlocked(30305);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05u#5] 已关闭方式的可提上限按未绑定计算，开放时单方式上限为 3000 分',
  async () => {
    const c = await member();
    await c.openMethod();
    await c.set('withdraw.method_max_amount_fen.alipay', 3000);
    expect(await c.rules()).toMatchObject({ can_withdraw: true, max_withdrawable_fen: 3000 });

    await c.closeMethod();
    const closed = await c.rules();
    await deactivateCurrentAccount(c);
    const unbound = await c.rules();
    expect(unbound).toMatchObject({ can_withdraw: false, block_code: 30305 });
    expect(closed.max_withdrawable_fen).toBe(unbound.max_withdrawable_fen);
    expect(closed).toMatchObject({ can_withdraw: false, block_code: 30305 });
  },
  TIMEOUT,
);

it.each([
  { label: '空数组', value: [] },
  { label: '含未知方式', value: ['alipay', 'unknown'] },
  { label: '含重复项', value: ['bank_card', 'bank_card'] },
  { label: '非数组', value: 'alipay' },
])(
  '[AC-B2-05u#6] $label 按默认开放支付宝和银行卡，有效配置关闭后返回 30305',
  async ({ value }) => {
    for (const method of METHODS_UNDER_TEST) {
      const c = await member(method);
      await c.set(METHODS, value);
      expect(await c.rules()).toMatchObject({ can_withdraw: true, block_code: null });
      accepted(await c.post({ amount: AMOUNT }), AMOUNT);
      await c.closeMethod();
      await c.expectBlocked(30305);
    }
  },
  TIMEOUT,
);

function withdrawalId(response: WireResponse) {
  accepted(response, AMOUNT);
  return response.json<Schema<'WithdrawalResponse'>>().data.withdrawal_id;
}

it(
  '[AC-B2-05u#7] 关闭后新申请被拒，旧单各列保留且后台审核通过结果与关闭前相同',
  async () => {
    const c = await member();
    await c.openMethod();
    const control = withdrawalId(await c.post({ amount: AMOUNT }));
    const pending = withdrawalId(await c.post({ amount: AMOUNT }));
    const holder = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    const payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
    try {
      await withReviewAdmin(
        {
          appId: c.f.appId,
          clock: kit.clock,
          db: kit.db,
          ledger: c.ledger,
          payout,
          s: {
            db: () => kit.db,
            holder: () => holder,
            payout: () => payout,
            redisUrl: () => redis.url,
          },
        },
        async (admin) => {
          expect(await itemsOf(await admin.approve([control]))).toEqual([approvedItem(control)]);
          const before = await c.state();
          expect(before.withdrawals.find(({ id }) => id === pending)).toMatchObject({
            status: 'PENDING_REVIEW',
            amount_fen: 1000n,
          });

          await c.closeMethod();
          const next = await c.post({ amount: AMOUNT });
          refused(next, 422, 30305);
          nothingMoved(await c.state(), before);

          expect(await itemsOf(await admin.approve([pending]))).toEqual([approvedItem(pending)]);
          const after = await c.state();
          expect(after.withdrawals.find(({ id }) => id === pending)).toMatchObject({
            status: 'APPROVED',
            amount_fen: 1000n,
          });
          expect(after.balances).toEqual(before.balances);
        },
      );
    } finally {
      await Promise.all([destroyDb(holder), destroyDb(payout)]);
    }
  },
  TIMEOUT,
);
