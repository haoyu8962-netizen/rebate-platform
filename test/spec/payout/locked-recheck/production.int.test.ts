import { randomUUID } from 'node:crypto';
import { setTimeout as pollInterval } from 'node:timers/promises';
import type { DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  account,
  ALIPAY_CONTEXT,
  close,
  fixture,
  LOGIN,
  open,
  pid,
  type Fixture,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import {
  accepted,
  client,
  nothingMoved,
  PATH,
  TIMEOUT,
  type Client,
  type WireResponse,
} from '../withdraw-no-step-up/kit.ts';

const AMOUNT = 1000;
const OTHER_ACCOUNT = 'alternate@example.test';
const RISK_RULE = 'SAME_DEVICE_MULTI_ACCOUNT';
const RISK_INSERT = 'insert into "app"."risk_rules"%';
const USER_LOCK = 'select%from "app"."users"%for no key update%';
const WAIT_MS = 2000;

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
afterAll(async (): Promise<void> => {
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

interface Gate {
  readonly backend: Promise<number>;
  readonly locked: Promise<Transaction<DB>>;
  readonly release: () => void;
  readonly committed: Promise<void>;
}

function hold(acquire: (trx: Transaction<DB>) => Promise<void>): Gate {
  const backend = Promise.withResolvers<number>();
  const locked = Promise.withResolvers<Transaction<DB>>();
  const release = Promise.withResolvers<void>();
  const committed = kit.db.transaction().execute(async (trx): Promise<void> => {
    await sql`SET LOCAL lock_timeout = '3s'`.execute(trx);
    backend.resolve(await pid(trx));
    await acquire(trx);
    locked.resolve(trx);
    await release.promise;
  });
  void committed.catch((error: unknown): void => {
    backend.reject(error);
    locked.reject(error);
  });
  void backend.promise.catch((): void => {});
  void locked.promise.catch((): void => {});
  return {
    backend: backend.promise,
    locked: locked.promise,
    release: (): void => release.resolve(),
    committed,
  };
}

interface PendingRequest {
  readonly response: Promise<WireResponse>;
  readonly finished: () => boolean;
}

function submit(c: Client, key: string): PendingRequest {
  let finished = false;
  const response = c.post({ key, amount: AMOUNT }).finally((): void => {
    finished = true;
  });
  void response.catch((): void => {});
  return { response, finished: (): boolean => finished };
}

async function waitForRequest(
  holder: number,
  finished: () => boolean,
  query: string,
): Promise<number | null> {
  const deadline = performance.now() + WAIT_MS;
  do {
    if (finished()) return null;
    const { rows } = await sql<{ pid: number }>`SELECT activity.pid FROM pg_stat_activity activity
      WHERE datname = current_database() AND ${holder} = ANY(pg_blocking_pids(activity.pid))
        AND activity.query LIKE ${query}`.execute(kit.db);
    if (rows[0] !== undefined) return rows[0].pid;
    await pollInterval(10);
  } while (performance.now() < deadline);
  throw new Error('未观察到提现请求等待指定的数据库锁');
}

async function lockMember(trx: Transaction<DB>, f: Fixture): Promise<void> {
  await trx
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}

async function insertSameDeviceRule(
  db: Kysely<DB>,
  appId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: appId,
      rule_id: RISK_RULE,
      scene: 'withdrawal',
      conditions: sql`'{}'::jsonb`,
      risk_action: 'manual_review',
      status,
      version: 1,
    })
    .execute();
}

async function recordChange(
  trx: Transaction<DB>,
  f: Fixture,
  oldHmac: string,
  newHmac: string,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('payout_account_changes')
    .values({
      app_id: f.appId,
      user_id: f.uid,
      old_payout_method: 'alipay',
      new_payout_method: 'alipay',
      old_hmac: oldHmac,
      new_hmac: newHmac,
      operator: `user:${f.uid}`,
      changed_at: at,
      created_at: at,
    })
    .execute();
}

async function switchAccount(
  trx: Transaction<DB>,
  f: Fixture,
  login: string,
): Promise<{ id: string; hmac: string }> {
  const now = kit.clock.now();
  const old = await trx
    .withSchema('app')
    .updateTable('payout_accounts')
    .set({ row_version: sql`row_version + 1`, is_current: false, updated_at: now })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.uid)
    .where('payout_method', '=', 'alipay')
    .where('is_current', '=', true)
    .returning('alipay_hmac')
    .$narrowType<{ alipay_hmac: string }>()
    .executeTakeFirstOrThrow();
  const hmac = kit.crypto.blindIndex(login, ALIPAY_CONTEXT);
  await recordChange(trx, f, old.alipay_hmac, hmac, now);
  const { id } = await account(kit, f, login, { hmac, handle: trx });
  return { id, hmac };
}

async function seedPriorOwner(appId: string, hmac: string): Promise<void> {
  const former = await fixture(kit, { appId });
  const clock = new FixedClock('2026-10-11T04:00:00.000Z');
  const historical = { ...kit, clock };
  const nextLogin = 'former-owner@example.test';
  await kit.db.transaction().execute(async (trx): Promise<void> => {
    await account(historical, former, LOGIN, { current: false, handle: trx });
    clock.set('2026-10-12T04:00:00.000Z');
    const nextHmac = kit.crypto.blindIndex(nextLogin, ALIPAY_CONTEXT);
    await recordChange(trx, former, hmac, nextHmac, clock.now());
    await account(historical, former, nextLogin, { hmac: nextHmac, handle: trx });
  });
}

function expectContract(response: WireResponse, status: '200' | '5XX'): void {
  const schema =
    kit.document.paths[PATH]!['post']!.responses[status]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

function expectOneFreeze(state: Awaited<ReturnType<Client['state']>>): void {
  expect(state.withdrawals).toHaveLength(1);
  expect(state.withdrawals[0]!.amount_fen).toBe(1000n);
  expect(state.vouchers).toEqual([
    expect.objectContaining({ uniq_key: `wd:${state.withdrawals[0]!.id}:FREEZE` }),
  ]);
  expect(state.balances).toEqual([
    expect.objectContaining({ available_fen: 9000n, frozen_fen: 1000n }),
  ]);
}

it(
  '[AC-B2-05v#11] 真接口提现期间将 A 换成 B 再换回 A，新绑定触发重跑并保存历史风险标签，只建单冻结一次',
  async (): Promise<void> => {
    const c = await client(kit, { balance: 10000n });
    const original = await kit.db
      .withSchema('app')
      .selectFrom('payout_accounts')
      .select(['id', 'alipay_hmac'])
      .where('app_id', '=', c.f.appId)
      .where('user_id', '=', c.f.uid)
      .where('is_current', '=', true)
      .$narrowType<{ alipay_hmac: string }>()
      .executeTakeFirstOrThrow();
    await seedPriorOwner(c.f.appId, original.alipay_hmac);

    // 同设备判断注册规则时，在唯一键上等待。此时已读到 A，尚未读取收款历史。
    const riskGate = hold((trx): Promise<void> => insertSameDeviceRule(trx, c.f.appId, 'active'));
    let request: PendingRequest | undefined;
    let userGate: Gate | undefined;
    try {
      await riskGate.locked;
      request = submit(c, randomUUID());
      const waiter = await waitForRequest(await riskGate.backend, request.finished, RISK_INSERT);
      expect(waiter).not.toBeNull();
      await kit.db.transaction().execute(async (trx): Promise<void> => {
        await lockMember(trx, c.f);
        await switchAccount(trx, c.f, OTHER_ACCOUNT);
      });

      // 持有用户行锁时，风险读取能看见已提交的 B。等本遍风险读完才提交新的一行 A。
      userGate = hold((trx): Promise<void> => lockMember(trx, c.f));
      const writer = await userGate.locked;
      riskGate.release();
      await riskGate.committed;
      const userWaiter = await waitForRequest(await userGate.backend, request.finished, USER_LOCK);
      expect(userWaiter).toBe(waiter);
      const rebound = await switchAccount(writer, c.f, LOGIN);
      expect(rebound.id).not.toBe(original.id);
      expect(rebound.hmac).toBe(original.alipay_hmac);
      userGate.release();
      await userGate.committed;

      const response = await request.response;
      accepted(response, AMOUNT);
      expectContract(response, '200');
      const state = await c.state();
      expectOneFreeze(state);
      expect(state.withdrawals[0]!.payee_hmac).toBe(original.alipay_hmac);
      expect(state.withdrawals[0]!.risk_flags).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'payee_prev_other_user' })]),
      );
    } finally {
      riskGate.release();
      userGate?.release();
      await Promise.allSettled([riskGate.committed, userGate?.committed, request?.response]);
    }
  },
  TIMEOUT,
);

function holdUsersTable(): Gate {
  return hold(async (trx): Promise<void> => {
    await sql`LOCK TABLE ONLY app.users IN EXCLUSIVE MODE`.execute(trx);
  });
}

async function waitForQueuedGate(next: number, holder: number, waiter: number): Promise<void> {
  async function queued(): Promise<boolean> {
    const { rows } = await sql<{ queued: boolean }>`SELECT ARRAY[${holder}, ${waiter}]::int[]
      <@ pg_blocking_pids(${next}) AS queued`.execute(kit.db);
    return rows[0]!.queued;
  }
  await expect.poll(queued, { timeout: WAIT_MS, interval: 10 }).toBe(true);
}

it(
  '[AC-B2-05v#12] 真接口三遍换绑后返回 HTTP 500 与 50001，余额不动，账号稳定后原幂等键可建单',
  async (): Promise<void> => {
    const c = await client(kit, { balance: 10000n });
    // 关闭同设备判断的落库路径，让申请在显式取用户行锁时首次请求 users 的 RowShare 锁。
    await insertSameDeviceRule(kit.db, c.f.appId, 'disabled');
    const initial = await c.state();
    const key = randomUUID();
    const changedAccounts = [OTHER_ACCOUNT, LOGIN, OTHER_ACCOUNT];
    let gate = holdUsersTable();
    const gates = [gate];
    let request: PendingRequest | undefined;
    let swaps = 0;
    try {
      await gate.locked;
      request = submit(c, key);
      for (const [index, login] of changedAccounts.entries()) {
        const writer = await gate.locked;
        const holder = await gate.backend;
        // 表锁允许初读。等到申请取用户行锁时再换绑。
        const waiter = await waitForRequest(holder, request.finished, USER_LOCK);
        if (waiter === null) break;
        await lockMember(writer, c.f);
        await switchAccount(writer, c.f, login);
        const currentGate = gate;
        if (index < changedAccounts.length - 1) {
          gate = holdUsersTable();
          gates.push(gate);
          const next = await gate.backend;
          // 下一把表锁排在本遍请求之后。本遍取得 RowShare 锁后可走完复核，回滚释放
          // 锁时下一把才获准，因此下一遍能初读，却无法跨过下一次换绑。
          await waitForQueuedGate(next, holder, waiter);
        }
        currentGate.release();
        await currentGate.committed;
        swaps += 1;
      }
    } finally {
      for (const held of gates) held.release();
      const commits = gates.map((held): Promise<void> => held.committed);
      await Promise.allSettled([...commits, request?.response]);
    }

    const response = await request!.response;
    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({
      code: 50001,
      msg: '服务端错误',
      trace_id: expect.any(String),
    });
    expectContract(response, '5XX');
    expect(swaps).toBe(3);
    const afterError = await c.state();
    nothingMoved(afterError, initial);
    expect(afterError.keys).toEqual(initial.keys);

    const resubmitted = await c.post({ key, amount: AMOUNT });
    accepted(resubmitted, AMOUNT);
    expectContract(resubmitted, '200');
    expectOneFreeze(await c.state());
  },
  TIMEOUT,
);
