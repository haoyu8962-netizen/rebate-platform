// Real signed POST, AppModule, PG and Redis; only synthetic identity material.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { account, config, fixture, type Kit } from '../../identity/payout-account/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { fund, PATH } from '../apply/kit.ts';

export { open, close, type Kit } from '../../identity/payout-account/kit.ts';
export { seedBlock, UUID_V7 } from '../../risk/blocklist/kit.ts';
export const PHONE = '13800138000';

export async function client(kit: Kit, method: 'alipay' | 'bank_card' = 'alipay') {
  const f = await fixture(kit);
  const payee = await account(
    kit,
    f,
    method === 'alipay' ? 'member@example.test' : '6222021234567890123',
    { method },
  );
  // The inherited fixture intentionally uses a different index; this task needs the real
  // current phone's users.phone digest (not a digest of the UID or of an already hashed value).
  const phoneHmac = kit.crypto.blindIndex(PHONE, 'users.phone');
  await sql`UPDATE app.users SET phone_hmac = ${phoneHmac} WHERE id = ${f.uid}`.execute(kit.db);
  const id = await kit.db
    .withSchema('app')
    .selectFrom('realname')
    .select('id_no_hmac')
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.uid)
    .executeTakeFirstOrThrow();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const deviceHash = randomBytes(32).toString('hex');
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  const actor = { appId: f.appId, userId: f.uid };
  const ledger = createLedger({ clock: kit.clock });
  await fund(kit.db, ledger, actor, 10000n);
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
    VALUES (${f.appId},'user',${f.uid},${device.device_id},'labor_agreement',1,true,'withdraw_flow',
      ${'a'.repeat(64)},'{}'::jsonb,${kit.clock.now()},${kit.clock.now()})`.execute(kit.db);
  const session = await kit.db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id: device.device_id, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  async function post(requestId = randomUUID(), amount = 1300) {
    const step = await kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: {
        uid: f.uid,
        app_id: f.appId,
        sid: session.sid,
        device_id: device.device_id,
        action: 'withdraw',
        jti: randomUUID(),
      },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
    const body = JSON.stringify({ amount_fen: amount });
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: PATH,
      payload: body,
      headers: {
        ...headers,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', PATH, Buffer.from(body), timestamp, nonce, device.install_secret),
        authorization: `Bearer ${session.access_token}`,
        'idempotency-key': requestId,
        'x-step-up-token': step,
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
        .execute(),
      balances: await ledger.getBalances(kit.db, { appId: f.appId, userIds: [f.uid] }),
      holds: await db
        .selectFrom('withdraw_holds')
        .selectAll()
        .where('app_id', '=', f.appId)
        .execute(),
      vouchers: await db
        .selectFrom('ledger_vouchers')
        .selectAll()
        .where('app_id', '=', f.appId)
        .where('biz_type', '=', 'withdrawal')
        .execute(),
      keys: await db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', f.appId)
        .execute(),
    };
  }
  return {
    f,
    post,
    state,
    deviceId: device.device_id,
    deviceHash,
    phoneHmac,
    values: {
      phone: phoneHmac,
      id_no: id.id_no_hmac!,
      device: deviceHash,
      alipay: payee.alipay_hmac!,
      bank_card: payee.bank_card_hmac!,
    },
  };
}

export async function hits(kit: Pick<Kit, 'db'>, appId: string) {
  return kit.db
    .withSchema('app')
    .selectFrom('risk_hits')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export async function rule(
  kit: Pick<Kit, 'db' | 'clock'>,
  appId: string,
  dimension: string,
  status: string,
) {
  await sql`INSERT INTO app.risk_rules
    (id,app_id,rule_id,scene,conditions,risk_action,status,version,created_at,updated_at)
    VALUES (${randomUUID()},${appId},${`BLACKLIST_${dimension.toUpperCase()}`},'withdraw',
      '{}'::jsonb,'block',${status},1,${kit.clock.now()},${kit.clock.now()})
    ON CONFLICT (app_id,rule_id) DO UPDATE SET status=EXCLUDED.status`.execute(kit.db);
}
