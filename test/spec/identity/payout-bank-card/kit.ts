// Real AppModule/PG/Redis, reusing B1-13e setup; only vendor factories are spied on.
// All application runtime imports stay dynamic. No fake HTTP handler or business service.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  BankCardVerifierPort,
  CardBinPort,
} from '../../../../apps/api/src/modules/identity/ports/bank-card-verifier.ts';
import type * as Adapters from '../../../../apps/api/src/modules/identity/infra/fake-bank-card-verifier.ts';
import type * as Attempts from '../../../../apps/api/src/modules/identity/application/payout-account-verify-attempts.ts';
import {
  open as openBase,
  close,
  fixture as baseFixture,
  config,
  ROOT,
  PATH,
  NAME,
  NOW,
  BANK_CONTEXT,
  type Response,
} from '../payout-account/kit.ts';
import { payoutChangeClaim } from '../step-up-digest/payout-summary.ts';
export { close, config, PATH, NAME, NOW, BANK_CONTEXT, ROOT };
export { account, change, state, privateDataAbsent } from '../payout-account/kit.ts';

// Obviously fictional 990001 BIN; vectors are generated in tests, not a real BIN dataset.
export const BIN = '990001';
export const BANK = '示例银行';
export function card(serial = 1, length = 16): string {
  const prefix = BIN + String(serial).padStart(length - BIN.length - 1, '0');
  const sum = [...prefix].reverse().reduce((total, digit, i) => {
    const n = Number(digit) * (i % 2 === 0 ? 2 : 1);
    return total + (n > 9 ? n - 9 : n);
  }, 0);
  return prefix + String((10 - (sum % 10)) % 10);
}
export function bankBody(cardNo = card(), extra: Record<string, unknown> = {}) {
  return { payout_method: 'bank_card', card_no: cardNo, payee_name: NAME, ...extra };
}
export const ALIPAY = {
  payout_method: 'alipay',
  alipay_logon_id: 'fixture@example.com',
  payee_name: NAME,
};

export async function open(
  database: Parameters<typeof openBase>[0],
  redis: Parameters<typeof openBase>[1],
  absent: 'bin' | 'verifier' | undefined = undefined,
) {
  const adapters = (await import(
    new URL('apps/api/src/modules/identity/infra/fake-bank-card-verifier.ts', ROOT).href
  )) as typeof Adapters;
  const verify = vi.fn<BankCardVerifierPort['verify']>().mockResolvedValue('match');
  const query = vi.fn<BankCardVerifierPort['query']>().mockResolvedValue('unknown');
  const lookup = vi.fn<CardBinPort['lookup']>().mockResolvedValue({
    card_type: 'debit',
    bank_name: BANK,
    bin: BIN,
  });
  const binSpy = vi
    .spyOn(adapters, 'createCardBin')
    .mockImplementation(() => (absent === 'bin' ? null : { lookup }));
  const verifierSpy = vi
    .spyOn(adapters, 'createBankCardVerifier')
    .mockImplementation(() => (absent === 'verifier' ? null : { verify, query }));
  try {
    return { ...(await openBase(database, redis)), verify, query, lookup };
  } finally {
    binSpy.mockRestore();
    verifierSpy.mockRestore();
  }
}
export type Kit = Awaited<ReturnType<typeof open>>;
export function reset(kit: Kit) {
  kit.clock.set(NOW);
  kit.lines.length = 0;
  kit.verify.mockReset().mockResolvedValue('match');
  kit.query.mockReset().mockResolvedValue('unknown');
  kit.lookup.mockReset().mockResolvedValue({ card_type: 'debit', bank_name: BANK, bin: BIN });
}

export async function fixture(kit: Kit, options: Parameters<typeof baseFixture>[1] = {}) {
  const base = await baseFixture(kit, options);
  const { appId, uid } = base;
  // Keep the synthetic ID number distinct from user_id, which is allowed in operational logs.
  const idNo = `demo-id-${randomUUID()}`;
  await kit.db
    .updateTable('realname')
    .set({
      id_no_cipher: Buffer.from(kit.crypto.encrypt(idNo, 'realname.id_no')),
      id_no_hmac: kit.crypto.blindIndex(idNo, 'realname.id_no'),
    })
    .where('app_id', '=', appId)
    .where('user_id', '=', uid)
    .execute();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const deviceResponse = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(deviceResponse.statusCode).toBe(200);
  const device = deviceResponse.json<{ data: { device_id: string; install_secret: string } }>()
    .data;
  const issue = () =>
    kit.db.transaction().execute((trx) =>
      kit.createSession(
        trx,
        {
          uid,
          app_id: appId,
          device_id: device.device_id,
          scp: 'full',
        },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  const initial = await issue();
  // B1-02zzzb (BR-ID-08 细则「绑定业务摘要」): a payout_account_change token carries the digest
  // of the account it is for, as POST /v1/auth/step-up signs it (claim `summary`); `stepUpBody` is
  // the PUT body the token is taken for (when omitted: the default bank card body).
  const stepUp = (action = 'payout_account_change', stepUpBody?: unknown) =>
    kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: {
        uid,
        app_id: appId,
        sid: initial.sid,
        device_id: device.device_id,
        action,
        jti: randomUUID(),
        ...payoutChangeClaim(kit.crypto, action, stepUpBody, bankBody()),
      },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: 300,
    });
  const submit = async (
    body: unknown = bankBody(),
    key = randomUUID(),
    token?: string,
    extra: Record<string, string> = {},
  ) => {
    // Renew only the access token after Clock moves; concurrent requests keep one real session.
    const accessToken = await kit.tokens.issueAccess({
      uid,
      app_id: appId,
      device_id: device.device_id,
      sid: initial.sid,
      scp: 'full',
    });
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const text = [
      'PUT',
      PATH,
      timestamp,
      nonce,
      createHash('sha256').update(raw).digest('hex'),
    ].join('\n');
    return kit.app.inject({
      method: 'PUT',
      url: PATH,
      payload: raw,
      headers: {
        ...headers,
        authorization: `Bearer ${accessToken}`,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', device.install_secret).update(text).digest('hex'),
        'idempotency-key': key,
        'x-step-up-token': token ?? (await stepUp('payout_account_change', body)),
        'x-trace-id': randomUUID(),
        ...extra,
      },
    });
  };
  const attempts = () =>
    kit.db
      .selectFrom('payout_account_verify_attempts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .orderBy('reserved_at')
      .execute();
  const idempotency = (key: string) =>
    kit.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', uid)
      .where('key', '=', key)
      .execute();
  return { ...base, idNo, device, stepUp, submit, attempts, idempotency };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function envelope(kit: Kit, response: Response, code = 0) {
  const statuses: Record<number, number> = {
    0: 200,
    20001: 400,
    10003: 403,
    10401: 401,
    10402: 401,
    10403: 403,
    20901: 409,
    20903: 409,
    40901: 409,
    44001: 403,
    50301: 503,
    50401: 504,
  };
  expect(response.statusCode, response.body).toBe(statuses[code] ?? 422);
  const body = response.json<{ code: number; data?: Record<string, unknown> }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[PATH]!['put']!;
  const schema =
    operation.responses[code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

export async function seedAttempt(
  kit: Kit,
  f: Fixture,
  options: {
    status?: string;
    cardNo?: string;
    key?: string;
    reservedAt?: string;
    unknownAt?: string;
    resolvedAt?: string;
    verifyDate?: string;
    fingerprint?: string;
  } = {},
) {
  const rn = await kit.db
    .selectFrom('realname')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.uid)
    .executeTakeFirstOrThrow();
  const status = options.status ?? 'reserved';
  return kit.db
    .insertInto('payout_account_verify_attempts')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      verify_date: options.verifyDate ?? '2026-10-18',
      status,
      vendor_request_id: randomUUID(),
      request_fingerprint:
        options.fingerprint ??
        `${rn.id}:${kit.crypto.blindIndex(options.cardNo ?? card(), BANK_CONTEXT)}`,
      reserved_at: new Date(options.reservedAt ?? NOW),
      unknown_at: options.unknownAt
        ? new Date(options.unknownAt)
        : status === 'unknown'
          ? kit.clock.now()
          : null,
      resolved_at: options.resolvedAt
        ? new Date(options.resolvedAt)
        : ['matched', 'mismatched', 'expired_unresolved', 'released'].includes(status)
          ? kit.clock.now()
          : null,
      origin_action: 'payout_account_change',
      idempotency_key: options.key ?? randomUUID(),
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function block(kit: Kit, f: Fixture, digits = card()) {
  await kit.db
    .insertInto('blocklist')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      dimension: 'bank_card',
      value_hmac: kit.crypto.blindIndex(digits, BANK_CONTEXT),
      violation_type: 'other',
      status: 'active',
      created_by: 'fixture',
      expire_at: new Date('2027-01-01T00:00:00Z'),
    })
    .execute();
}

export async function maintenance(
  kit: Kit,
  verifier: BankCardVerifierPort | null = { verify: kit.verify, query: kit.query },
) {
  const api = (await import(
    new URL('apps/api/src/modules/identity/application/payout-account-verify-attempts.ts', ROOT)
      .href
  )) as typeof Attempts;
  return api.createPayoutAccountVerifyAttempts({
    db: kit.db,
    clock: kit.clock,
    logger: kit.logger,
    verifier,
    config: {
      configValue: async (appId, key, handle) =>
        (await handle
          .withSchema('app')
          .selectFrom('config_items')
          .select('value')
          .where('app_id', '=', appId)
          .where('key', '=', key)
          .executeTakeFirst()) ?? null,
    },
  });
}

/** A bounded observation, never an unbounded wait for a vendor that the red route won't call. */
export async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(10);
  }
  expect.fail('expected event was not observed');
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** An independent short transaction must acquire the same user lock during vendor I/O. */
export async function userLockAvailable(kit: Kit, f: Fixture) {
  await kit.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx);
    await trx
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.uid)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
  });
}
