// B1-02zzzc rule-test fixture (BR-ID-08, BR-WDR-01, BR-WDR-03 ②取消, BR-WDR-07; D10-1665 / D10-1666 /
// D10-1671): the real AppModule over the business-role PG and a real Redis, exactly as
// test/spec/payout/apply/http.int.test.ts assembles it — no route, controller, use case or check is
// replaced. Every withdrawal prerequisite holds (verified real name unless asked otherwise, bound
// phone, current payout account, signed labor agreement, funded balance, counts unlimited), so the
// request checks and BR-WDR-03 decide each answer. Requests carry no X-Step-Up-Token unless the test
// passes one. Synthetic identity material only; only the orchestrator runs this, in its container.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { account, config, fixture, type Kit } from '../../identity/payout-account/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { fund, PATH } from '../apply/kit.ts';

export { PATH, TIMEOUT } from '../apply/kit.ts';
export const ABANDON_PATH = '/v1/idempotency-keys/abandon';
export const STEP_UP_PATH = '/v1/auth/step-up';
export const BALANCE = 10000n;
export const AMOUNT = 1000;

export interface WireResponse {
  statusCode: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

export interface SendOptions {
  /** The Idempotency-Key header; null sends none, undefined a fresh one (withdrawals only). */
  readonly key?: string | null;
  /** The X-Step-Up-Token header; null or undefined sends none. */
  readonly step?: string | null;
  /** Replaces the access token (Authorization: Bearer …). */
  readonly access?: string;
  /** Corrupts X-Sign after signing. */
  readonly badSign?: boolean;
  readonly amount?: number;
}

export async function client(
  kit: Kit,
  options: { readonly verified?: boolean; readonly balance?: bigint } = {},
) {
  const f = await fixture(kit, options.verified === false ? { verified: false } : {});
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
  await fund(kit.db, ledger, actor, options.balance ?? BALANCE);
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

  /** A step_up_token exactly as POST /v1/auth/step-up signs one (aud=step_up, 5 minutes). */
  function stepUp(action: string) {
    return kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: { ...principal, action, jti: randomUUID() },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
  }

  function h5() {
    return kit.signScopedToken(kit.keys, {
      audience: 'h5',
      claims: { ...principal, scp: 'read_only' },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
  }

  /** A signed POST of the app on this user's device and session. */
  async function send(
    path: string,
    payload: unknown,
    sendOptions: SendOptions = {},
  ): Promise<WireResponse> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = sign('POST', path, Buffer.from(body), timestamp, nonce, install_secret);
    const response = await kit.app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: {
        ...headers,
        'x-device-id': device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sendOptions.badSign === true ? 'f'.repeat(64) : signature,
        'x-trace-id': randomUUID(),
        authorization: `Bearer ${sendOptions.access ?? session.access_token}`,
        ...(typeof sendOptions.key === 'string' ? { 'idempotency-key': sendOptions.key } : {}),
        ...(typeof sendOptions.step === 'string' ? { 'x-step-up-token': sendOptions.step } : {}),
      },
    });
    return response;
  }

  /** POST /v1/withdrawals; without options: a fresh key and no X-Step-Up-Token. */
  function post(sendOptions: SendOptions = {}): Promise<WireResponse> {
    const key = sendOptions.key === undefined ? randomUUID() : sendOptions.key;
    return send(PATH, { amount_fen: sendOptions.amount ?? AMOUNT }, { ...sendOptions, key });
  }

  /** POST /v1/idempotency-keys/abandon (【放弃上一笔提现】, BR-WDR-07 细则「前置步骤的回流」). */
  function abandon(idempotencyKey: string, action = 'withdraw'): Promise<WireResponse> {
    return send(ABANDON_PATH, { action, idempotency_key: idempotencyKey });
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

  return {
    f,
    actor,
    ledger,
    principal,
    deviceId: device_id,
    stepUp,
    h5,
    send,
    post,
    abandon,
    state,
    ban,
  };
}
export type Client = Awaited<ReturnType<typeof client>>;
export type Snapshot = Awaited<ReturnType<Client['state']>>;

/** No withdrawal, freeze voucher or balance moved since `initial`. */
export function nothingMoved(current: Snapshot, initial: Snapshot): void {
  expect(current.withdrawals).toEqual(initial.withdrawals);
  expect(current.vouchers).toEqual(initial.vouchers);
  expect(current.balances).toEqual(initial.balances);
}

/** HTTP 200, code 0, a PENDING_REVIEW withdrawal of `amount` (BR-WDR-07 建单). */
export function accepted(response: WireResponse, amount = AMOUNT): void {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    msg: '',
    data: { status: 'PENDING_REVIEW', amount_fen: amount },
  });
}

/** An error envelope with this HTTP status and code. */
export function refused(response: WireResponse, status: number, code: number): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({
    code,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
}
