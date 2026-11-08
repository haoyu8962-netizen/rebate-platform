// BR-WDR-03 (D10-214, D10-1036): step ① the withdrawal switch comes before step ③ the risk state.
// Real Fastify inject + AppModule, signatures, tokens, step-up, PG and Redis, as http.int.test.ts.
// The banned state is a real app.user_risk_state row, which stage ⑤ reads on the idempotency
// claim's transaction; neither the risk service nor the switch check is replaced.
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
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { IDEMPOTENCY } from '../../../../apps/api/src/modules/platform/idempotency/token.ts';
import {
  account,
  close,
  config,
  fixture,
  open,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { assertContract } from '../rules/http-kit.ts';
import { fund, PATH, TIMEOUT } from './kit.ts';

const BALANCE = 10000n;
const AMOUNT = 1000;

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

// The same real path as http.int.test.ts's client: every withdrawal prerequisite holds, so only
// the switch and the risk state can decide the answer.
async function client() {
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
  const ledger = createLedger({ clock: kit.clock });
  await fund(kit.db, ledger, { appId: f.appId, userId: f.uid }, BALANCE);
  for (const [name, value] of Object.entries({
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/labor',
    'legal.labor_agreement.text_sha256': 'a'.repeat(64),
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.daily_count_per_user': 0,
    'withdraw.monthly_count_per_user': 0,
    'withdraw.payee_daily_count': 0,
    'withdraw.payee_daily_distinct_users': 0,
  }))
    await config(kit, f, name, value);
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
  async function stepUp() {
    return kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: { ...principal, action: 'withdraw', jti: randomUUID() },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
  }
  async function post(options: { key: string; step?: null }) {
    const body = JSON.stringify({ amount_fen: AMOUNT });
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
        authorization: `Bearer ${session.access_token}`,
        'idempotency-key': options.key,
        ...(options.step === null ? {} : { 'x-step-up-token': await stepUp() }),
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
      vouchers: await db
        .selectFrom('ledger_vouchers')
        .selectAll()
        .where('app_id', '=', f.appId)
        .where('biz_type', '=', 'withdrawal')
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
  async function ban() {
    const now = kit.clock.now();
    await kit.db
      .withSchema('app')
      .insertInto('user_risk_state')
      .values({
        user_id: f.uid,
        app_id: f.appId,
        state: 'banned',
        reason: 'synthetic',
        reason_category: 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
        changed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  return { f, deviceId: device_id, post, state, ban };
}

type Snapshot = Awaited<ReturnType<Awaited<ReturnType<typeof client>>['state']>>;

function expectNothingMoved(current: Snapshot, initial: Snapshot) {
  expect(current.withdrawals).toEqual(initial.withdrawals);
  expect(current.vouchers).toEqual(initial.vouchers);
  expect(current.balances).toEqual(initial.balances);
}

it(
  '[AC-B2-05s#1] 开关关闭且用户被封禁答 30306 并存幂等键，同键原样重放不跑业务校验，新键仍 30306；开关打开时同一封禁用户答 10006',
  async () => {
    const c = await client();
    await c.ban();
    const initial = await c.state();
    expect(initial.withdrawals).toEqual([]);
    expect(initial.vouchers).toEqual([]);
    expect(initial.keys).toEqual([]);
    expect(initial.balances).toEqual([
      expect.objectContaining({ available_fen: BALANCE, frozen_fen: 0n }),
    ]);

    // Control: with the switch on the banned row decides, and a 1xxxx refusal stores nothing.
    await config(kit, c.f, 'withdraw.enabled', true);
    const control = await c.post({ key: randomUUID() });
    expect(control.statusCode).toBe(403);
    expect(control.json()).toMatchObject({ code: 10006 });
    await assertContract(control, 'ErrorEnvelope');
    expect(await c.state()).toEqual(initial);

    // Same banned user, switch off: step ① answers first and the 3xxxx refusal is stored.
    await config(kit, c.f, 'withdraw.enabled', false);
    const firstRequest = randomUUID();
    const first = await c.post({ key: firstRequest });
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ code: 30306 });
    await assertContract(first, 'ErrorEnvelope');
    const stored = await c.state();
    expect(stored.keys).toEqual([
      expect.objectContaining({
        key: firstRequest,
        method: 'POST',
        path: PATH,
        user_id: c.f.uid,
        status: 'completed',
        response: { status: first.statusCode, body: first.body },
      }),
    ]);
    expectNothingMoved(stored, initial);

    const replay = await c.post({ key: firstRequest, step: null });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(await c.state()).toEqual(stored);
    // source is internal, not an HTTP field: inspect the persisted key through the primitive,
    // with a handler that must never run.
    expect(
      await kit.app.get<Idempotency>(IDEMPOTENCY).executeInTransaction(
        {
          appId: c.f.appId,
          actor: { userId: c.f.uid, deviceId: c.deviceId, phoneHmac: null },
          method: 'POST',
          path: PATH,
          key: firstRequest,
          body: { amount_fen: AMOUNT },
          traceId: randomUUID(),
        },
        async () => expect.fail('a stored 30306 must replay before business checks'),
      ),
    ).toEqual({ status: first.statusCode, body: first.body, source: 'replay' });

    const newRequest = randomUUID();
    const fresh = await c.post({ key: newRequest });
    expect(fresh.statusCode).toBe(422);
    expect(fresh.json()).toMatchObject({ code: 30306 });
    await assertContract(fresh, 'ErrorEnvelope');
    const after = await c.state();
    expect(after.keys).toHaveLength(2);
    expect(after.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: newRequest,
          status: 'completed',
          response: { status: fresh.statusCode, body: fresh.body },
        }),
      ]),
    );
    expectNothingMoved(after, initial);

    // With the switch back on a re-judged request would be 10006 for this banned user, so the
    // unchanged 30306 proves the replay ran neither the switch nor the risk state.
    await config(kit, c.f, 'withdraw.enabled', true);
    const late = await c.post({ key: firstRequest, step: null });
    expect(late.statusCode).toBe(first.statusCode);
    expect(late.body).toBe(first.body);
    expect(await c.state()).toEqual(after);
  },
  TIMEOUT,
);
