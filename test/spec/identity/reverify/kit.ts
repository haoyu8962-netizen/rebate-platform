// B1-02zp rule-test kit (BR-WDR-01 细则「旧手机号被二次放号时的提现加验」; D10-149, D10-161; contract
// getReverify / reverifyByIdNumber / reverifyByOauth, createOauthAttempt purpose=reverify).
// The real AppModule over a test database and Redis, reached through its HTTP entries only. Two
// seams, both external vendors, installed while the app is built and restored right after init:
//   - IdentityModule.forRoot `thirdPartyIdentity`: the provider exchange (CT-15i) is kit.exchange;
//   - createRealnameVerifier: the paid two-element vendor is kit.vendor, so "only compares" can be
//     asserted (reverify must never call it).
// Every apps/api module is imported at run time; static imports are types only. Nothing here
// imports a skeleton of this task. Before the implementation the three routes are not mounted, so
// every rule test is red on its first status assertion (404), never on a TypeError: read a body
// only after asserting its status.
//
// Access tokens are minted from a sessions row written here, never through createSession or a
// login: where the implementation places the session-time judgement is its own choice, and a
// fixture token must not move last_active_at or set a flag. The flagging tests log in for real.
//
// The switch is seeded before the app's first request of every fixture (a fresh app_id per test),
// so the content reader cannot cache a missing row; the value is read through the real config.
// fixture(kit, { days: null }) leaves the row out on purpose: the registry default then applies
// (D10-567 ②).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { SmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import type { ThirdPartyIdentityPort } from '../../../../apps/api/src/modules/identity/application/step-up.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
} from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import type { JsonSchema } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { RiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { closeSuite, openSuite, type Suite } from '../session/kit.ts';
import { buildApp, outbox, type HttpApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger, phone } from '../sms-codes/kit.ts';

type ClockModule = typeof import('../../../../apps/api/src/modules/platform/clock/index.ts');
type PlatformModule = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type ValidatorModule =
  typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type VerifierModule =
  typeof import('../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts');
type Clock = InstanceType<ClockModule['FixedClock']>;
type ForRoot = (options: Record<string, unknown>) => unknown;

export const STATUS = '/v1/me/reverify';
export const BY_ID = '/v1/me/reverify/id-number';
export const BY_OAUTH = '/v1/me/reverify/oauth';
export const ATTEMPTS = '/v1/auth/oauth-attempts';
export const REFRESH = '/v1/auth/refresh';
export const SMS_LOGIN = '/v1/auth/login/sms';
export const LOGIN = {
  wechat: '/v1/auth/login/wechat',
  apple: '/v1/auth/login/apple',
} as const;

/** 2026-10-08 10:00 +08:00. */
export const INSTANT = '2026-10-08T02:00:00.000Z';
/** The +08:00 natural day of INSTANT. */
export const TODAY = '2026-10-08';
export const YESTERDAY = '2026-10-07';
export const TOMORROW = '2026-10-09';
/** 2026-10-09 00:00:00 +08:00: the day boundary, still 2026-10-08 in UTC. */
export const MIDNIGHT = '2026-10-08T16:00:00.000Z';
export const SECOND = 1000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** The value of the switch in a default fixture (a positive number, as BR-WDR-01's default). */
export const DAYS = 180;
export const DORMANT = DAYS * DAY;
export const SWITCH = 'withdraw.dormant_reverify_days';
/** BR-WDR-01 细则「加验依据」: five consecutive failures. */
export const FAIL_LIMIT = 5;

/** The stored resident ID of a default realname row, and well-formed numbers that differ from it. */
export const ID = '11010519491231002X';
export const OTHER_ID = residentId('1990-01-01');
export const THIRD_ID = residentId('1991-02-03');
const NAME = '欧阳小明';
const REALNAME_CONTEXT = {
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
};
const PHONE_CONTEXT = 'users.phone';
const LEGAL = { privacy: 7, agreement: 4 };
/** Channel whose minimum version (3.0.0) every fixture seeds; RESTRICTED headers are below it. */
export const RESTRICTED = { 'x-channel': 'official', 'x-app-version': '1.0.0' };

export type Provider = 'wechat' | 'apple' | 'huawei';
export type Scope = 'full' | 'deletion_only';
export type ExchangeAnswer = Awaited<ReturnType<ThirdPartyIdentityPort['exchange']>>;
export interface Trusted {
  realname: boolean;
  providers: Provider[];
}
export interface ReverifyState {
  last_active_at: Date | null;
  last_login_device_hash: string | null;
  reverify_flagged_at: Date | null;
  reverify_trusted: Trusted | null;
  reverify_fail_count: number;
  reverify_fail_day: string | null;
}
export interface Device {
  id: string;
  hash: string;
  secret: string;
}
export interface LoginData {
  user_id: string;
  is_new_user: boolean;
  tokens: {
    access_token: string;
    refresh_token: string;
    session_scope: Scope;
  };
}
export interface Envelope {
  code: number;
  msg: string;
  trace_id: string;
  data?: Record<string, unknown>;
}
export interface CallOptions {
  /** No Authorization header (a guest). */
  guest?: boolean;
  /** Idempotency-Key of the request; a fresh one when absent. */
  key?: string;
  /** No Idempotency-Key header at all. */
  noKey?: boolean;
  headers?: Record<string, string>;
}

type Contract = {
  paths: Record<
    string,
    Record<
      string,
      {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
      }
    >
  >;
};

/** The api app; this kit also sends GET and bodyless requests. */
interface App extends HttpApp {
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

export interface Kit {
  suite: Suite;
  app: App;
  dir: string;
  clock: Clock;
  document: Contract;
  compile: ReturnType<ValidatorModule['createValidatorCompiler']>;
  lines: string[];
  exchange: ReturnType<typeof vi.fn<ThirdPartyIdentityPort['exchange']>>;
  vendor: ReturnType<
    typeof vi.fn<(input: RealnameVerificationInput) => Promise<RealnameVerificationResult>>
  >;
  crypto: FieldCrypto;
  sms: SmsCodeService;
  tokens: TokenService;
  risk: RiskStateService;
}

/** The checksum digit of a mainland resident ID, so a number differs without being malformed. */
function residentId(birth: string, serial = '002'): string {
  const prefix = `110105${birth.replaceAll('-', '')}${serial}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...prefix].reduce((total, digit, index) => {
    return total + Number(digit) * weights[index]!;
  }, 0);
  return prefix + '10X98765432'[sum % 11]!;
}

export async function openKit(): Promise<Kit> {
  // openSuite -> createTestDatabase: the database address comes from the global setup only.
  const suite = await openSuite();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02zp-'));
  const { logger, lines } = memoryLogger();
  const exchange = vi
    .fn<ThirdPartyIdentityPort['exchange']>()
    .mockResolvedValue({ unavailable: true });
  const vendor = vi
    .fn<(input: RealnameVerificationInput) => Promise<RealnameVerificationResult>>()
    .mockResolvedValue({ outcome: 'mismatch', provider: 'test-two-elements' });
  const restore: (() => void)[] = [];
  let app: App | undefined;
  try {
    const { FixedClock } = (await import(
      new URL('apps/api/src/modules/platform/clock/index.ts', ROOT).href
    )) as ClockModule;
    const { createValidatorCompiler } = (await import(
      new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
    )) as ValidatorModule;
    const verifiers = (await import(
      new URL('apps/api/src/modules/identity/infra/fake-realname-verifier.ts', ROOT).href
    )) as VerifierModule;
    const { IdentityModule } = (await import(
      new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
    )) as { IdentityModule: { forRoot: ForRoot } };
    const clock = new FixedClock(INSTANT);

    const vendorSpy = vi
      .spyOn(verifiers, 'createRealnameVerifier')
      .mockImplementation(() => ({ verify: vendor }));
    restore.push(() => vendorSpy.mockRestore());
    const forRoot = IdentityModule.forRoot;
    const wiring = vi
      .spyOn(IdentityModule, 'forRoot')
      .mockImplementation((options: Record<string, unknown>) =>
        forRoot.call(IdentityModule, {
          ...options,
          thirdPartyIdentity: { useFactory: () => ({ exchange }) },
        }),
      );
    restore.push(() => wiring.mockRestore());

    app = (await buildApp(suite.db, dir, suite.server.url, clock, logger)) as App;
    await app.init();
    for (const undo of restore.splice(0)) undo();

    const platform = (await import(
      new URL('apps/api/src/modules/platform/index.ts', ROOT).href
    )) as PlatformModule;
    const { TOKEN_SERVICE, SMS_CODES } = (await import(
      new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
    )) as { TOKEN_SERVICE: symbol; SMS_CODES: symbol };
    const { riskStateServiceToken } = (await import(
      new URL('apps/api/src/modules/risk/index.ts', ROOT).href
    )) as { riskStateServiceToken(): symbol };
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return {
      suite,
      app,
      dir,
      clock,
      document,
      compile: createValidatorCompiler(),
      lines,
      exchange,
      vendor,
      crypto: app.get<FieldCrypto>(platform.FIELD_CRYPTO),
      sms: app.get<SmsCodeService>(SMS_CODES),
      tokens: app.get<TokenService>(TOKEN_SERVICE),
      risk: app.get<RiskStateService>(riskStateServiceToken()),
    };
  } catch (error) {
    for (const undo of restore.splice(0)) undo();
    await app?.close();
    await closeSuite(suite);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeKit(kit: Kit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    try {
      await closeSuite(kit.suite);
    } finally {
      rmSync(kit.dir, { recursive: true, force: true });
    }
  }
}

function credentials(provider: Provider) {
  const tag = randomUUID();
  if (provider === 'wechat') return { code: `wechat-code-${tag}` };
  if (provider === 'huawei') return { authorization_code: `huawei-code-${tag}` };
  return {
    identity_token: `apple-identity-token-${tag}`,
    authorization_code: `apple-authorization-code-${tag}`,
  };
}

/** A reverifyByOauth body: the provider, the attempt and fresh credentials of that provider. */
export function oauthBody(provider: Provider, attemptId: string) {
  return { provider, attempt_id: attemptId, ...credentials(provider) };
}

export function ago(kit: Kit, ms: number): Date {
  return new Date(kit.clock.now().getTime() - ms);
}

export async function fixture(kit: Kit, options: { days?: number | null } = {}) {
  kit.clock.set(INSTANT);
  kit.exchange.mockReset().mockResolvedValue({ unavailable: true });
  kit.vendor.mockClear();
  kit.lines.length = 0;
  const appId = `rv_${randomBytes(10).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  const base = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const days = options.days === undefined ? DAYS : options.days;
  // Seeded before this app's first request, so no reader caches a missing row.
  if (days !== null) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${appId}, ${SWITCH}, ${JSON.stringify(days)}::jsonb, 'b1-02zp-fixture')`.execute(db);
  }
  await db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'ios',
      channel: RESTRICTED['x-channel'],
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试版本',
      update_notes: '旧号加验受限作用域测试',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();

  const device = async (): Promise<Device> => {
    const hash = randomBytes(32).toString('hex');
    const created = await kit.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: base,
      payload: JSON.stringify({ device_hash: hash, id_source: 'idfv' }),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ code: 0 });
    const { data } = created.json<{ data: { device_id: string; install_secret: string } }>();
    return { id: data.device_id, hash, secret: data.install_secret };
  };

  const post = (from: Device, path: string, body: object, headers: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...base,
        'x-device-id': from.id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, from.secret),
        ...headers,
      },
    });
  };

  /** An account of this app with a bound phone; nothing else (no activity, no flag). */
  const user = async () => {
    const number = phone('139');
    const uid = await seedUser(db, appId, {
      method: 'sms',
      phoneHmac: kit.crypto.blindIndex(number, PHONE_CONTEXT),
    });
    return { uid, number };
  };

  const bind = async (uid: string, provider: Provider) => {
    const unionId = `union-${randomUUID()}`;
    await db
      .insertInto('user_oauth')
      .values({ id: randomUUID(), app_id: appId, user_id: uid, provider, union_id: unionId })
      .execute();
    return unionId;
  };

  const realname = async (uid: string, idNo = ID) => {
    const encrypted = (value: string, context: string) =>
      Buffer.from(kit.crypto.encrypt(value, context));
    const birth = `${idNo.slice(6, 10)}-${idNo.slice(10, 12)}-${idNo.slice(12, 14)}`;
    await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher,
        id_no_hmac, birth_date_cipher, provider, verified_at)
      VALUES (${randomUUID()}, ${appId}, ${uid}, 'verified',
        ${encrypted(NAME, REALNAME_CONTEXT.name)}, ${encrypted(idNo, REALNAME_CONTEXT.idNo)},
        ${kit.crypto.blindIndex(idNo, REALNAME_CONTEXT.idNo)},
        ${encrypted(birth, REALNAME_CONTEXT.birthDate)},
        'test-two-elements', ${kit.clock.now()})`.execute(db);
  };

  /** A real-name attempt that failed: the row exists, the real name was never completed. */
  const failedRealname = async (uid: string) => {
    await sql`INSERT INTO app.realname (id, app_id, user_id, status, provider)
      VALUES (${randomUUID()}, ${appId}, ${uid}, 'failed', 'test-two-elements')`.execute(db);
  };

  const active = async (uid: string, at: Date | null, deviceHash: string | null) => {
    await sql`UPDATE app.users SET last_active_at = ${at}, last_login_device_hash = ${deviceHash}
      WHERE app_id = ${appId} AND id = ${uid}`.execute(db);
  };

  const flag = async (uid: string, trusted: Trusted, at = kit.clock.now()) => {
    await sql`UPDATE app.users SET reverify_flagged_at = ${at},
        reverify_trusted = ${JSON.stringify(trusted)}::jsonb
      WHERE app_id = ${appId} AND id = ${uid}`.execute(db);
  };

  /** What the manual clearing of BR-WDR-01 does to the two flag columns. */
  const unflag = async (uid: string) => {
    await sql`UPDATE app.users SET reverify_flagged_at = NULL, reverify_trusted = NULL
      WHERE app_id = ${appId} AND id = ${uid}`.execute(db);
  };

  const failures = async (uid: string, count: number, day = TODAY) => {
    await sql`UPDATE app.users SET reverify_fail_count = ${count},
        reverify_fail_day = ${day}::date
      WHERE app_id = ${appId} AND id = ${uid}`.execute(db);
  };

  const reverified = async (uid: string, from: Device, source: 'self' | 'admin' = 'self') => {
    await sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
      VALUES (${randomUUID()}, ${appId}, ${uid}, ${from.hash}, ${source})`.execute(db);
  };

  const state = async (uid: string): Promise<ReverifyState> => {
    const result = await sql<ReverifyState>`SELECT last_active_at, last_login_device_hash,
        reverify_flagged_at, reverify_trusted, reverify_fail_count,
        reverify_fail_day::text AS reverify_fail_day
      FROM app.users WHERE app_id = ${appId} AND id = ${uid}`.execute(db);
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  };

  const devices = async (uid: string) =>
    (
      await sql<{ device_hash: string; source: string }>`SELECT device_hash, source
        FROM app.reverified_devices WHERE app_id = ${appId} AND user_id = ${uid}
        ORDER BY device_hash, source`.execute(db)
    ).rows;

  /** The account's realname row, every column, as text (to_jsonb: ciphers and timestamps). */
  const realnameRow = async (uid: string) => {
    const result = await sql<{ row: string }>`SELECT to_jsonb(r)::text AS row FROM app.realname r
      WHERE r.app_id = ${appId} AND r.user_id = ${uid}`.execute(db);
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.row;
  };

  /**
   * The barrier of D10-161 「不得先读后写」: another connection holds the account's users row until
   * release(), so a request stops at its first write to that row, after all it read before it.
   * FOR NO KEY UPDATE, not FOR UPDATE: it conflicts with an UPDATE of the row's non-key columns and
   * with FOR UPDATE, but not with the FOR KEY SHARE of a foreign-key check. Under FOR UPDATE the
   * sessions row of client() would wait here, seen as a waiting request that has not even started.
   */
  const holdUser = async (uid: string) => {
    let open!: () => void;
    const released = new Promise<void>((resolve) => {
      open = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      const rows = await sql`SELECT 1 FROM app.users WHERE app_id = ${appId} AND id = ${uid}
        FOR NO KEY UPDATE`.execute(trx);
      expect(rows.rows).toHaveLength(1);
      locked();
      await released;
    });
    await Promise.race([ready, holder]);
    return {
      release: async () => {
        open();
        await holder;
      },
    };
  };

  /**
   * Polls until `count` sessions of the test database wait on a heavyweight lock (row locks
   * included) or every one of `requests` has ended, at most `ms`; the number last seen. Each kit
   * has its own database and the tests of a file run one at a time, so these are its requests.
   */
  const lockWaiters = async (
    count: number,
    requests: readonly Promise<unknown>[],
    ms = 5000,
  ): Promise<number> => {
    let running = requests.length;
    const ended = () => {
      running -= 1;
    };
    for (const request of requests) void request.then(ended, ended);
    const deadline = Date.now() + ms;
    for (;;) {
      const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
      const seen = result.rows[0]!.n;
      if (seen >= count || running === 0 || Date.now() >= deadline) return seen;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Audit rows of the app as text (to_jsonb: audit_logs.id is a bigint). */
  const auditText = async () =>
    JSON.stringify(
      (
        await sql<{ row: string }>`SELECT to_jsonb(a)::text AS row FROM app.audit_logs a
          WHERE a.app_id = ${appId}`.execute(db)
      ).rows,
    );

  const idempotencyRows = async (path: string) =>
    (
      await sql<{ request_hash: string | null; status: string; response: string | null }>`
        SELECT request_hash, status, response::text AS response FROM app.idempotency_keys
        WHERE app_id = ${appId} AND path = ${path}`.execute(db)
    ).rows;

  const ban = (uid: string) =>
    db.transaction().execute((trx) =>
      kit.risk.setRiskState(trx, {
        app_id: appId,
        user_id: uid,
        state: 'banned',
        reason: 'fixture reason',
        reason_category: 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );

  /** A token of a session row written here: minted per call, the Clock may have moved. */
  const mint = async (uid: string, from: Device, scope: Scope) => {
    const now = kit.clock.now();
    const sid = randomBytes(16).toString('base64url');
    await db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        app_id: appId,
        sid,
        login_method: null,
        user_id: uid,
        device_id: from.id,
        revoked_at: null,
        revoke_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return kit.tokens.issueAccess({
      uid,
      app_id: appId,
      sid,
      device_id: from.id,
      scp: scope,
    });
  };

  /** The three interfaces and the attempt, as this user on this device. */
  const client = (uid: string, from: Device, scope: Scope = 'full') => {
    const authorization = async (options: CallOptions): Promise<Record<string, string>> =>
      options.guest === true ? {} : { authorization: `Bearer ${await mint(uid, from, scope)}` };
    const submit = async (path: string, body: object, options: CallOptions) =>
      post(from, path, body, {
        ...(await authorization(options)),
        ...(options.noKey === true ? {} : { 'idempotency-key': options.key ?? randomUUID() }),
        ...options.headers,
      });
    return {
      status: async (options: CallOptions = {}) =>
        kit.app.inject({
          method: 'GET',
          url: STATUS,
          headers: {
            ...base,
            'x-device-id': from.id,
            ...(await authorization(options)),
            ...options.headers,
          },
        }),
      byId: (idNo: string, options: CallOptions = {}) => submit(BY_ID, { id_no: idNo }, options),
      byOauth: (body: object, options: CallOptions = {}) => submit(BY_OAUTH, body, options),
      attempt: async (provider: Provider, options: CallOptions = {}) =>
        post(
          from,
          ATTEMPTS,
          { provider, purpose: 'reverify' },
          { ...(await authorization(options)), ...options.headers },
        ),
    };
  };

  const sendLoginCode = async (number: string, from: Device) => {
    expect(
      await kit.sms.send({ app_id: appId, phone: number, purpose: 'login', device_id: from.id }),
    ).toMatchObject({ code: 0 });
    const sent = outbox(kit.app)
      .filter((m) => m.app_id === appId && m.phone === number && m.purpose === 'login')
      .at(-1);
    expect(sent).toBeDefined();
    return sent!.code;
  };

  const smsBody = (number: string, code: string) => ({
    phone: number,
    code,
    legal_versions: LEGAL,
    consent_at: ago(kit, 5 * SECOND).toISOString(),
  });

  /** A real SMS login; asserts it succeeded. */
  const smsLogin = async (number: string, from: Device, headers: Record<string, string> = {}) => {
    const code = await sendLoginCode(number, from);
    return loggedIn(await post(from, SMS_LOGIN, smsBody(number, code), headers));
  };

  /** A real third-party login of an identity; asserts it succeeded. */
  const oauthLogin = async (
    provider: keyof typeof LOGIN,
    unionId: string,
    from: Device,
    headers: Record<string, string> = {},
  ) => {
    kit.exchange.mockResolvedValue({
      union_id: unionId,
      ...(provider === 'apple' ? { apple_refresh_token: `apple-refresh-${randomUUID()}` } : {}),
    });
    const made = await post(from, ATTEMPTS, { provider, purpose: 'login' }, headers);
    expect(made.statusCode).toBe(200);
    const attemptId = made.json<{ data: { attempt_id: string } }>().data.attempt_id;
    return loggedIn(
      await post(
        from,
        LOGIN[provider],
        {
          attempt_id: attemptId,
          ...credentials(provider),
          legal_versions: LEGAL,
          consent_at: ago(kit, 5 * SECOND).toISOString(),
        },
        headers,
      ),
    );
  };

  /** A real refresh; asserts it succeeded. */
  const refresh = async (token: string, from: Device) => {
    const response = await post(from, REFRESH, { refresh_token: token });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
  };

  return {
    kit,
    appId,
    device,
    post,
    user,
    bind,
    realname,
    failedRealname,
    active,
    flag,
    unflag,
    failures,
    reverified,
    state,
    devices,
    realnameRow,
    holdUser,
    lockWaiters,
    auditText,
    idempotencyRows,
    ban,
    client,
    sendLoginCode,
    smsBody,
    smsLogin,
    oauthLogin,
    refresh,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

function loggedIn(response: Response): LoginData {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  return response.json<{ data: LoginData }>().data;
}

const HTTP_STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  10006: 403,
  10010: 403,
  10405: 403,
  20001: 400,
  20004: 400,
  20005: 400,
  20901: 409,
  50305: 503,
};

/** The response envelope, checked against the contract of the operation. */
export function envelope(
  kit: Kit,
  path: string,
  response: Response,
  code: number,
  method: 'get' | 'post' = 'post',
): Envelope {
  expect(response.statusCode).toBe(HTTP_STATUS[code]);
  const body = response.json<Envelope>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const status = code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX';
  const schema =
    kit.document.paths[path]![method]!.responses[status]!.content['application/json']!.schema;
  const check = kit.compile({ schema, httpPart: 'body' });
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
  return body;
}

/** The data of GET /v1/me/reverify. */
export function statusOf(kit: Kit, response: Response) {
  return envelope(kit, STATUS, response, 0, 'get').data;
}
export const NOT_REQUIRED = {
  required: false,
  method: null,
  providers: [],
  fail_limit: null,
  fail_remaining: null,
};
export function idNumberRequired(remaining: number) {
  return {
    required: true,
    method: 'id_number',
    providers: [],
    fail_limit: FAIL_LIMIT,
    fail_remaining: remaining,
  };
}
export function oauthRequired(providers: readonly Provider[], remaining: number) {
  return {
    required: true,
    method: 'oauth',
    providers,
    fail_limit: FAIL_LIMIT,
    fail_remaining: remaining,
  };
}
export const MANUAL_REQUIRED = {
  required: true,
  method: 'manual',
  providers: [],
  fail_limit: null,
  fail_remaining: null,
};

/** 200 {passed: true}, nothing else (no step_up_token). */
export function passed(kit: Kit, path: string, response: Response): void {
  expect(envelope(kit, path, response, 0).data).toEqual({ passed: true });
}

/** 20005 with data.fail_limit and data.fail_remaining. */
export function mismatch(kit: Kit, path: string, response: Response, remaining: number): void {
  expect(envelope(kit, path, response, 20005).data).toMatchObject({
    fail_limit: FAIL_LIMIT,
    fail_remaining: remaining,
  });
}

/** 10010 with the current method (error-codes.yaml: data.method, providers, fail_limit). */
export function pending(kit: Kit, path: string, response: Response, data: object): void {
  expect(envelope(kit, path, response, 10010).data).toMatchObject(data);
}
export const PENDING_MANUAL = { method: 'manual' };

/** The attempt of a successful POST /v1/auth/oauth-attempts. */
export function attemptOf(kit: Kit, response: Response) {
  const data = envelope(kit, ATTEMPTS, response, 0).data;
  return data as { attempt_id: string; nonce: string; expire_at: string };
}

/** The snapshot with its providers sorted: the contract fixes no order. */
export function trustedOf(state: ReverifyState) {
  const trusted = state.reverify_trusted;
  return trusted === null
    ? null
    : { realname: trusted.realname, providers: [...trusted.providers].sort() };
}

/**
 * Parks every exchange until release(); `reached` resolves once `calls` exchanges are waiting.
 * With it a test can look at the account between the reservation and the end of the request.
 */
export function holdExchange(kit: Kit, calls = 1) {
  let open!: (answer: ExchangeAnswer) => void;
  const answer = new Promise<ExchangeAnswer>((resolve) => {
    open = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let waiting = 0;
  kit.exchange.mockImplementation(() => {
    waiting += 1;
    if (waiting >= calls) arrive();
    return answer;
  });
  return { reached, release: open };
}

/** Waits for the first of `pending`, at most `ms`: a request that never ends must not hang a test. */
export async function firstOf(pending: readonly Promise<unknown>[], ms = 3000): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    for (const item of pending) void item.then(done, done);
  });
}
