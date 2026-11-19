// B1-27g fixtures: the B1-27a admin entry (real database, FieldCrypto, Redis, admin sessions;
// container runner only) plus, where the monthly count is read, the api entry over the same
// database, keys, Clock and Redis. Built like admin-realname/kit.ts's setup, except for the app id:
// X-App-Id allows only [a-z0-9_]{1,32}, so the member side of the same app can be called over HTTP
// (GET /v1/me/payout-account). Payout accounts are encrypted with the entry's own field keys so the
// masked projection can be read back; the rebinding goes through identity's createPayoutAccountService
// (the B2-05j precedent, payout-account-exempt/count.int.test.ts). Sources: 08 BR-WDR-02 细则「实名
// 更正后的失效与重绑」「保存在用户级锁内」, BR-ID-25 细则「实名更正」; 04 §3.2 limit_exempt_reason,
// §6.6 users/{id}/realname-correction; task B1-27g §9.4.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Verifier from '../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
} from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  loadConfig,
  PRIOR_IDENTITY_FIELD_CRYPTO,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { seed } from '../../admin/accounts/kit.ts';
import { payoutSummary } from '../step-up-digest/payout-summary.ts';
import {
  apiRequire,
  factory,
  NOW,
  READ,
  signedIn,
  type Fixture,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import {
  NEW,
  OLD,
  TRACE,
  type AuditRow,
  type PriorInsert,
  type Setup,
  type User,
} from '../admin-realname/kit.ts';
import { memoryLogger, redisConnection } from '../sms-codes/kit.ts';

type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
// Only the erasable service surface is typed (payout-account/kit.ts precedent).
type PayoutAccounts =
  typeof import('../../../../apps/api/src/modules/identity/application/payout-account.ts');
type Risk = typeof import('../../../../apps/api/src/modules/risk/index.ts');

const ROOT = new URL('../../../../', import.meta.url);
/** 04 §3.2: the one limit_exempt_reason value. */
export const EXEMPT = 'realname_correction';
/** The audit field B1-27a writes on a success; B1-27g takes it from the port's `retired`. */
export const INVALIDATED = 'payout_accounts_invalidated';
/** BR-WDR-02 ④: the monthly limit, set explicitly for every app of these tests. */
export const LIMIT = 2;
export const LIMIT_KEY = 'withdraw.payout_account_change_per_month';
export const PAYOUT_ACCOUNT = '/v1/me/payout-account';
/** Cipher AAD and blind-index contexts of the payout account (identity/application/payout-account.ts). */
export const ALIPAY = 'payout_accounts.alipay';
export const BANK = 'payout_accounts.bank_card';
const VERSION = '2.0.0';

/** The operator B1-27g records on the change rows: `admin:<操作员 id>` (task §9.3 ①). */
export const operatorOf = (adminId: string) => `admin:${adminId}`;

/** A fresh app id that is also a valid X-App-Id. */
export const appIdOf = (prefix = 'b127g') => `${prefix}_${randomBytes(8).toString('hex')}`;

// ---------------------------------------------------------------- the admin entry

/** admin-realname/kit.ts's setup over an app id the api entry accepts. */
export async function setup(h: Harness): Promise<Setup> {
  const verifiers = (await import(
    new URL('apps/api/src/modules/identity/infra/fake-realname-verifier.ts', ROOT).href
  )) as typeof Verifier;
  const vendor = vi
    .fn<(input: RealnameVerificationInput) => Promise<RealnameVerificationResult>>()
    .mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
  const spy = vi
    .spyOn(verifiers, 'createRealnameVerifier')
    .mockImplementation(() => ({ verify: vendor }));
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const overrides = {
    config: loadConfig(h.env),
    clock,
    logger,
    dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
    redisUrl: redisConnection(h.redis.url).redisUrl,
  };
  // The vendor is assembled while the entry starts; the spy ends once it has.
  const boot = async (): Promise<HttpApp> => {
    try {
      const created = await (await factory())('admin', overrides);
      h.apps.push(created);
      await expect(created.init()).resolves.toBeDefined();
      return created;
    } finally {
      spy.mockRestore();
    }
  };
  const app = await boot();
  const post = (
    suffix: string,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'POST',
      url: `/admin/v1/auth${suffix}`,
      payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...headers },
      remoteAddress: ip,
    });
  const read = (
    token: string,
    url = READ,
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      remoteAddress: ip,
    });
  const f: Fixture = {
    app,
    clock,
    lines,
    overrides,
    post,
    read,
    closeRedis: async () => undefined,
  };
  const appId = appIdOf();
  await limit(h, appId);
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  const prior: PriorInsert[] = [];
  return {
    ...f,
    h,
    appId,
    actor,
    token: session.admin_token,
    vendor,
    prior,
    priorCrypto: app.get<FieldCrypto>(PRIOR_IDENTITY_FIELD_CRYPTO),
  };
}

/** withdraw.payout_account_change_per_month of `appId` = LIMIT. */
export async function limit(h: Harness, appId: string, value = LIMIT) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${LIMIT_KEY}, ${JSON.stringify(value)}::jsonb, 'fixture')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(h.db);
}

// ---------------------------------------------------------------- seeds

/** A payout account of `target` encrypted with the entry's field keys (readable by GET). */
export async function bound(
  h: Harness,
  target: User,
  method: 'alipay' | 'bank_card',
  current: boolean,
  value: string,
  payee = OLD.name,
) {
  const context = method === 'alipay' ? ALIPAY : BANK;
  const hmac = h.fields.blindIndex(value, context);
  const cipher = Buffer.from(h.fields.encrypt(value, context), 'utf8');
  return h.db
    .insertInto('payout_accounts')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      payout_method: method,
      alipay_logon_id_cipher: method === 'alipay' ? cipher : null,
      alipay_hmac: method === 'alipay' ? hmac : null,
      bank_card_no_cipher: method === 'bank_card' ? cipher : null,
      bank_card_hmac: method === 'bank_card' ? hmac : null,
      bank_name: method === 'bank_card' ? '合成银行' : null,
      card_bin: method === 'bank_card' ? value.slice(0, 6) : null,
      payee_name: payee,
      is_current: current,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** An ordinary (counted) change row of `target` at `at`. */
export async function change(h: Harness, target: User, at: Date) {
  return h.db
    .insertInto('payout_account_changes')
    .values({
      app_id: target.appId,
      user_id: target.id,
      old_payout_method: 'bank_card',
      new_payout_method: 'alipay',
      old_hmac: randomBytes(32).toString('hex'),
      new_hmac: randomBytes(32).toString('hex'),
      operator: 'fixture',
      changed_at: at,
      created_at: at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ---------------------------------------------------------------- reads

export const changesOf = (h: Harness, target: User) =>
  h.db
    .selectFrom('payout_account_changes')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('id')
    .execute();

/** Payout accounts and change rows of `target` (what a refusal must leave alone). */
export async function payoutState(h: Harness, target: User) {
  return {
    accounts: await h.db
      .selectFrom('payout_accounts')
      .selectAll()
      .where('app_id', '=', target.appId)
      .where('user_id', '=', target.id)
      .orderBy('id')
      .execute(),
    changes: await changesOf(h, target),
  };
}

/** Every value of INVALIDATED anywhere in the audit row (the layout is the implementation's). */
export function invalidatedIn(entry: AuditRow): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const inner of value) walk(inner);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === INVALIDATED) found.push(inner);
        walk(inner);
      }
    }
  };
  walk(entry.before);
  walk(entry.after);
  return found;
}

// ---------------------------------------------------------------- the member side

interface PayoutDocument {
  paths: Record<
    string,
    { get?: { responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }> } }
  >;
}
let payoutSchema: Promise<JsonSchema | undefined> | undefined;
function payoutAccountSchema(): Promise<JsonSchema | undefined> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<PayoutDocument>;
  };
  payoutSchema ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then(
      (document) =>
        document.paths[PAYOUT_ACCOUNT]?.get?.responses['200']?.content?.['application/json']
          ?.schema,
    );
  return payoutSchema;
}

/** A 200 GET /v1/me/payout-account against the contract; returns data. */
export async function view(response: Response): Promise<Record<string, unknown>> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  const body = response.json<{ code: number; data: Record<string, unknown> }>();
  expect(body).toMatchObject({ code: 0 });
  const schema = await payoutAccountSchema();
  expect(schema, `GET ${PAYOUT_ACCOUNT} 200 must be in the contract`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
  return body.data;
}

/**
 * The api entry over the same database, keys, Clock and Redis, with one registered device of
 * `target`'s app; `get()` is GET /v1/me/payout-account under a fresh full session of `target`.
 * The payout account reads require a bound phone, so `target` gets one first (the
 * payout-account/kit.ts fixture's phone_cipher / phone_hmac).
 */
export async function memberSide(s: Setup, target: User) {
  const phone = '13800138000';
  await s.h.db
    .updateTable('users')
    .set({
      phone_cipher: Buffer.from(s.h.fields.encrypt(phone, 'users.phone')),
      phone_hmac: s.h.fields.blindIndex(target.id, 'users.phone'),
    })
    .where('app_id', '=', target.appId)
    .where('id', '=', target.id)
    .execute();
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const app = await (await factory())('api', s.overrides);
  s.h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  await sql`INSERT INTO app.app_versions
    (id, app_id, platform, channel, latest_version, min_supported_version, update_title,
     update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${target.appId}, 'ios', 'appstore', ${VERSION}, ${VERSION}, 'fixture',
     'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)
    ON CONFLICT DO NOTHING`.execute(s.h.db);
  const headers = {
    'x-app-id': target.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': VERSION,
  };
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(registered.statusCode, JSON.stringify(registered.json())).toBe(200);
  const deviceId = registered.json<{ data: { device_id: string } }>().data.device_id;
  expect(typeof deviceId).toBe('string');
  const service = app.get<Parameters<Sessions['createSession']>[2]['tokens']>(tokens.TOKEN_SERVICE);
  return {
    async get(): Promise<Response> {
      const session = await s.h.db
        .transaction()
        .execute((trx) =>
          sessions.createSession(
            trx,
            { uid: target.id, app_id: target.appId, device_id: deviceId, scp: 'full' },
            { clock: s.clock, tokens: service },
          ),
        );
      return app.inject({
        method: 'GET',
        url: PAYOUT_ACCOUNT,
        headers: {
          ...headers,
          'x-device-id': deviceId,
          'x-trace-id': TRACE,
          authorization: `Bearer ${session.access_token}`,
        },
      });
    },
  };
}

/** An Alipay binding of `target` through identity's payout account service, on its own transaction. */
export async function rebind(s: Setup, target: User, alipayLogonId: string, payeeName = NEW.name) {
  // Built in each test, so a failure is a test failure, not a hook failure.
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as PayoutAccounts;
  const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as Risk;
  const options = {
    db: s.h.db,
    clock: s.clock,
    crypto: s.h.fields,
    logger: s.overrides.logger,
  };
  const service = identity.createPayoutAccountService({
    ...options,
    blocklist: risk.createBlocklistService(options),
  });
  return s.h.db.transaction().execute((trx) =>
    service.save(trx, {
      appId: target.appId,
      userId: target.id,
      alipayLogonId,
      payeeName,
      // B1-02zzzb: the step_up_token digest of the account this call saves.
      stepUpSummary: payoutSummary(s.h.fields, { alipayLogonId }),
    }),
  );
}
