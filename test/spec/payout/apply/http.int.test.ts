// Real Fastify inject + AppModule, signatures, tokens, step-up, PG and Redis. No route or
// business handler is replaced. Synthetic encrypted identity material only, created in container.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { sign } from '../../risk/signature/kit.ts';
import {
  account,
  close,
  config,
  fixture,
  open,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import { assertContract } from '../rules/http-kit.ts';
import { fund, PATH, TIMEOUT } from './kit.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { IDEMPOTENCY } from '../../../../apps/api/src/modules/platform/idempotency/token.ts';

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

async function client(balance = 10000n) {
  // Part of every test's acceptance criteria, never a suite-hook failure. The test stage keeps
  // planned until implementation wires the real handler and regenerates all route metadata.
  expect(kit.document.paths[PATH]?.['post']).not.toHaveProperty('x-implementation');
  const f = await fixture(kit);
  await account(kit, f);
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const device = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(device.statusCode).toBe(200);
  const { device_id, install_secret } = device.json<{
    data: { device_id: string; install_secret: string };
  }>().data;
  const actor = { appId: f.appId, userId: f.uid };
  const ledger = createLedger({ clock: kit.clock });
  await fund(kit.db, ledger, actor, balance);
  for (const [key, value] of Object.entries({
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/labor',
    'legal.labor_agreement.text_sha256': 'a'.repeat(64),
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.daily_count_per_user': 0,
    'withdraw.monthly_count_per_user': 0,
    'withdraw.payee_daily_count': 0,
    'withdraw.payee_daily_distinct_users': 0,
  }))
    await config(kit, f, key, value);
  await sql`INSERT INTO app.consent_records
    (app_id,subject_type,user_id,device_id,type,version,accepted,channel,text_sha256,signer_snapshot,client_at,server_at)
    VALUES (${f.appId},'user',${f.uid},${device_id},'labor_agreement',1,true,'withdraw_flow',${'a'.repeat(64)},
      '{}'::jsonb,${kit.clock.now()},${kit.clock.now()})`.execute(kit.db);
  const session = await kit.db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  const principal = { uid: f.uid, app_id: f.appId, sid: session.sid, device_id };
  async function stepUp(action = 'withdraw') {
    return kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: { ...principal, action, jti: randomUUID() },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
  }
  async function post(
    options: {
      amount?: unknown;
      key?: string | null;
      step?: string | null;
      access?: string;
      extra?: Record<string, string>;
    } = {},
  ) {
    const body = JSON.stringify({ amount_fen: options.amount ?? 1000 });
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: PATH,
      payload: body,
      headers: {
        ...headers,
        'x-device-id': device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', PATH, Buffer.from(body), timestamp, nonce, install_secret),
        authorization: `Bearer ${options.access ?? session.access_token}`,
        ...(options.key === null ? {} : { 'idempotency-key': options.key ?? randomUUID() }),
        ...(options.step === null ? {} : { 'x-step-up-token': options.step ?? (await stepUp()) }),
        ...options.extra,
      },
    });
  }
  async function state() {
    const db = kit.db.withSchema('app');
    return {
      withdrawals: await db
        .selectFrom('withdrawals')
        .selectAll()
        .where('app_id', '=', f.appId)
        .orderBy('id')
        .execute(),
      keys: await db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', f.appId)
        .orderBy('key')
        .execute(),
      balances: await ledger.getBalances(kit.db, { appId: f.appId, userIds: [f.uid] }),
    };
  }
  return { f, actor, ledger, principal, stepUp, post, state };
}

it(
  '[AC-B2-05d#50] 真实 POST 返回契约响应；重放原样返回，同一 step-up 令牌换新键照常受理、再建一单',
  async () => {
    const c = await client();
    const step = await c.stepUp();
    const key = randomUUID();
    const response = await c.post({ step, key });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      code: 0,
      data: {
        status: 'PENDING_REVIEW',
        amount_fen: 1000,
        fee_fen: 0,
        tax_fen: 0,
        net_fen: 1000,
        payout_channel: 'alipay',
        payout_channel_name: '支付宝',
        masked_account: 'zh***@example.com',
        reason_code: null,
        fail_action: null,
        channel_order_id: null,
      },
    });
    await assertContract(response, 'WithdrawalResponse');
    const before = await c.state();
    expect((await c.post({ step: null, key })).body).toBe(response.body);
    // B1-02zzzc (D10-1665, D10-1702): the token is neither judged nor consumed.
    expect((await c.post({ step, key: randomUUID() })).json()).toMatchObject({ code: 0 });
    expect((await c.state()).withdrawals).toHaveLength(before.withdrawals.length + 1);
  },
  TIMEOUT,
);

it('[AC-B2-05d#51] h5_token 即使有有效签名和 step-up 也返回 10403，无副作用', async () => {
  const c = await client();
  const access = await kit.signScopedToken(kit.keys, {
    audience: 'h5',
    claims: { ...c.principal, scp: 'read_only' },
    issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
    ttlSeconds: 300,
  });
  const before = await c.state();
  const response = await c.post({ access });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 10403 });
  await assertContract(response, 'ErrorEnvelope');
  expect(await c.state()).toEqual(before);
});

it('[AC-B2-05d#52] 缺 Idempotency-Key → 20001，不消费 step-up、不建单', async () => {
  const c = await client();
  const step = await c.stepUp();
  const before = await c.state();
  const response = await c.post({ key: null, step });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: expect.any(Array) } });
  await assertContract(response, 'ErrorEnvelope');
  expect(await c.state()).toEqual(before);
  expect((await c.post({ step })).json()).toMatchObject({ code: 0 });
});

it.each([0, -1, 1.5, '1000'])(
  '[AC-B2-05d#53] amount_fen=%s 格式错误 → 20001，先于业务校验且不留幂等结果',
  async (amount) => {
    const c = await client();
    const before = await c.state();
    const response = await c.post({ amount });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 20001,
      data: { fields: expect.arrayContaining(['amount_fen']) },
    });
    await assertContract(response, 'ErrorEnvelope');
    expect(await c.state()).toEqual(before);
  },
);

// B1-02zzzc: an .each title may not be renamed (red-check), so the frozen title stays; what this
// block now asserts after D10-1665 / D10-1702 is in its body.
it.each(['missing', 'wrong-action'] as const)(
  '[AC-B2-05d#54] step-up %s → 10003，同键补齐后成功',
  async (mode) => {
    const c = await client();
    const key = randomUUID();
    const before = await c.state();
    const response = await c.post({
      key,
      step: mode === 'missing' ? null : await c.stepUp('payout_account_change'),
    });
    // B1-02zzzc (D10-1665, D10-1702): no token or another action's token, accepted alike.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
    expect((await c.state()).withdrawals).toHaveLength(before.withdrawals.length + 1);
    expect((await c.post({ key })).json()).toMatchObject({ code: 0 });
  },
);

it('[AC-B2-05d#55] HTTP 30301 文案来自默认契约、缓存原错误且释放 step-up，新键补款后可复用 token', async () => {
  const c = await client(0n);
  const key = randomUUID();
  const step = await c.stepUp();
  const first = await c.post({ key, step });
  expect(first.statusCode).toBe(422);
  expect(first.json()).toMatchObject({ code: 30301, msg: '可提现余额不足' });
  await assertContract(first, 'ErrorEnvelope');
  await fund(kit.db, c.ledger, c.actor, 2000n);
  expect((await c.post({ key, step: null })).body).toBe(first.body);
  expect((await c.post({ step })).json()).toMatchObject({ code: 0 });
  expect((await c.state()).withdrawals).toHaveLength(1);
});

it(
  '[AC-B2-05d#56] POST 等待 users 行锁时作废同键 → 40901，放锁后建单冻结一次，完成后作废返回原结果且同键原样重放',
  async () => {
    const c = await client();
    const key = randomUUID();
    const before = await c.state();
    const idempotency = kit.app.get<Idempotency>(IDEMPOTENCY);
    let pending: ReturnType<typeof c.post> | undefined;
    try {
      await kit.db.transaction().execute(async (trx) => {
        await lockUsersForUpdate(trx, { appId: c.f.appId, userIds: [c.f.uid] });
        const holder = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx))
          .rows[0]!.pid;
        pending = c.post({ key, step: await c.stepUp() });
        // Observe the actual PG wait edge before abandoning; elapsed time alone is no barrier.
        // Keep a rejection handled while polling, then await the original promise after unlock.
        void pending.catch(() => undefined);
        await expect
          .poll(
            async () =>
              (
                await sql<{ blocked: boolean }>`SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND ${holder}::int = ANY(pg_blocking_pids(pid))
                    AND position('users' in query) > 0
                    AND query ~* 'for (no key )?update'
                ) AS blocked`.execute(kit.db)
              ).rows[0]!.blocked,
            { timeout: 10_000, interval: 20 },
          )
          .toBe(true);
        // The handler waiting on users must share the idempotency transaction's backend.
        expect(
          (
            await sql<{ same_backend: boolean }>`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity AS activity
              WHERE activity.datname = current_database()
                AND ${holder}::int = ANY(pg_blocking_pids(activity.pid))
                AND position('users' in activity.query) > 0
                AND activity.query ~* 'for (no key )?update'
                AND EXISTS (
                  SELECT 1 FROM pg_locks AS locks
                  WHERE locks.pid = activity.pid
                    AND locks.locktype = 'advisory'
                    AND locks.granted
                    AND locks.objsubid = 2
                )
            ) AS same_backend`.execute(kit.db)
          ).rows[0]!.same_backend,
        ).toBe(true);
        // Use the application's real primitive, without replacing the controller or its trx.
        // The in-flight transaction holds K's advisory lock, so abandonment cannot win.
        const abandoned = await idempotency.abandon({
          appId: c.f.appId,
          userId: c.f.uid,
          action: 'withdraw',
          key,
          traceId: randomUUID(),
        });
        expect(abandoned.status).toBe(409);
        expect(JSON.parse(abandoned.body)).toMatchObject({ code: 40901 });
        const during = await c.state();
        expect(during.keys.filter((row) => row.key === key && row.status === 'abandoned')).toEqual(
          [],
        );
        expect(during.withdrawals).toEqual(before.withdrawals);
        expect(during.balances).toEqual(before.balances);
      });
    } finally {
      // Release the observer's lock even on assertion failure, then drain the HTTP request.
      if (pending !== undefined) await pending;
    }
    expect(pending).toBeDefined();
    const response = (await pending)!;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
    const after = await c.state();
    expect(after.withdrawals).toHaveLength(1);
    expect(after.withdrawals[0]).toMatchObject({
      user_id: c.f.uid,
      status: 'PENDING_REVIEW',
      amount_fen: 1000n,
    });
    expect(after.balances).toEqual([
      expect.objectContaining({ available_fen: 9000n, frozen_fen: 1000n }),
    ]);
    const vouchers = () =>
      kit.db
        .withSchema('app')
        .selectFrom('ledger_vouchers')
        .selectAll()
        .where('app_id', '=', c.f.appId)
        .where('biz_type', '=', 'withdrawal')
        .execute();
    const frozen = await vouchers();
    expect(frozen).toEqual([
      expect.objectContaining({
        uniq_key: `wd:${after.withdrawals[0]!.id}:FREEZE`,
        biz_id: after.withdrawals[0]!.id,
        operator: `user:${c.f.uid}`,
      }),
    ]);
    expect(after.keys).toEqual([
      expect.objectContaining({
        key,
        method: 'POST',
        path: PATH,
        user_id: c.f.uid,
        status: 'completed',
        response: { status: response.statusCode, body: response.body },
      }),
    ]);
    const completed = await idempotency.abandon({
      appId: c.f.appId,
      userId: c.f.uid,
      action: 'withdraw',
      key,
      traceId: randomUUID(),
    });
    const original = response.json<{ code: number; msg: string; data: unknown }>();
    expect(completed.status).toBe(200);
    expect(JSON.parse(completed.body)).toMatchObject({
      code: 0,
      data: {
        outcome: 'completed',
        original: { code: original.code, msg: original.msg, data: original.data },
      },
    });
    expect(await c.state()).toEqual(after);
    const replay = await c.post({ key, step: null });
    expect(replay.statusCode).toBe(response.statusCode);
    expect(replay.body).toBe(response.body);
    expect(await c.state()).toEqual(after);
    expect(await vouchers()).toEqual(frozen);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05d#57] 提现开关关闭后旧键无需 step-up 原样重放成功，新键返回 30306',
  async () => {
    const c = await client();
    const key = randomUUID();
    const first = await c.post({ key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ code: 0 });
    const before = await c.state();
    await config(kit, c.f, 'withdraw.enabled', false);
    const replay = await c.post({ key, step: null });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(await c.state()).toEqual(before);
    // source is internal, not an HTTP field: inspect the real persisted key through the
    // primitive as well, with a handler that must never run. The HTTP replay above is real.
    expect(
      await kit.app.get<Idempotency>(IDEMPOTENCY).executeInTransaction(
        {
          appId: c.f.appId,
          actor: { userId: c.f.uid, deviceId: c.principal.device_id, phoneHmac: null },
          method: 'POST',
          path: PATH,
          key,
          body: { amount_fen: 1000 },
          traceId: randomUUID(),
        },
        async () => expect.fail('completed withdrawal key must replay before business checks'),
      ),
    ).toEqual({ status: first.statusCode, body: first.body, source: 'replay' });
    const fresh = await c.post({ key: randomUUID() });
    expect(fresh.statusCode).toBe(422);
    expect(fresh.json()).toMatchObject({ code: 30306 });
    const after = await c.state();
    expect(after.withdrawals).toEqual(before.withdrawals);
    expect(after.balances).toEqual(before.balances);
  },
  TIMEOUT,
);
