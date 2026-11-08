// B2-09zg rule-test kit (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml CT-24zzb —
// listAdminWithdrawals and getAdminWithdrawal accept user.lookup (04 §11.1; D10-1042; FU-WITHDRAWALS-
// USER-LOOKUP). An account "only holding user.lookup" holds user.lookup but neither withdraw.review
// nor fund.view; a super admin holds every point and is not such an account.
// Built on the frozen kit of B2-09c (../admin-withdrawals/kit.ts: database, seeds, expected views,
// contract checks), which is imported and not changed. It starts the admin entry itself because the
// frozen kit's detail() cannot carry a query, and this task needs `user_id` on the detail route.
// Real pieces: the admin entry (admin token, session and permission checks, route schema, the field
// cipher of the process), PostgreSQL as couli_app, Redis for the admin sessions. Observing the
// handle only records what is asked of the database; every query still runs.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FIELD_CRYPTO,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LIST_PATH,
  REVIEW,
  VIEW,
  ago,
  type AdminCaller,
  type AdminSent,
  type Envelope,
  type Fixture,
  type Sealer,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';

/** specs/permissions.yaml: the point this task opens the two reads to. */
export const LOOKUP = 'user.lookup';
/** data of the 10403 of an account without the point (permission-guard.ts). */
export const DENIED = { reason: 'admin_permission_denied' };
/** The stored internal note of a rich row; never in a response to a lookup-only account. */
export const NOTE_MARK = '内部备注-合成-B2-09zg';
/** The risk flag of a rich row; never in a response to a lookup-only account. */
export const FLAG_CODE = 'first_withdrawal';

const ROOT = new URL('../../../../', import.meta.url);

/** The tables behind the two reads; the guard's own admin_* tables are not among them. */
const READ_TABLES =
  /\b(?:withdrawals|withdraw_holds|payout_batches|payout_batch_items|payout_attempts|users)\b/;

/** The answer of a write route (not one of the two reads of the frozen kit). */
export interface WriteSent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface LookupAdmin extends Sealer {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/withdrawals with the query. */
  list(query: Readonly<Record<string, string>>, who: AdminCaller): Promise<AdminSent>;
  /** GET /admin/v1/withdrawals/{withdrawal_id} with the query. */
  detail(
    withdrawalId: string,
    query: Readonly<Record<string, string>>,
    who: AdminCaller,
  ): Promise<AdminSent>;
  /** POST of a write route with a fresh Idempotency-Key and no step-up token. */
  write(path: string, body: unknown, who: AdminCaller): Promise<WriteSent>;
  /** Runs one request and returns its answer with the queries it sent to the read tables. */
  observed<T>(request: () => Promise<T>): Promise<{ sent: T; reads: readonly string[] }>;
  /** An account with withdraw.review only. */
  readonly reviewer: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
  /** An account with user.lookup only. */
  readonly lookup: AdminCaller;
  /** An account with no permission point at all. */
  readonly none: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
    payload?: string;
  }): Promise<{ statusCode: number; body: string }>;
}

function withQuery(path: string, query: Readonly<Record<string, string>>): string {
  const text = new URLSearchParams(query).toString();
  return text === '' ? path : `${path}?${text}`;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withLookupAdmin(f: Fixture, run: (h: LookupAdmin) => Promise<void>) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: Fixture['clock'];
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  // Seeds use f.db directly, so only what the application asks of the database is recorded.
  const queries: string[] = [];
  const observedDb = f.db.withPlugin({
    transformQuery({ node }) {
      queries.push(
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09zg-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09zg_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: observedDb, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: LookupAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .withSchema('app')
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `wd_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .withSchema('app')
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token };
    };
    const read = async (op: AdminSent['op'], url: string, who: AdminCaller): Promise<AdminSent> => {
      const response = await server.inject({
        method: 'GET',
        url,
        headers: { 'x-trace-id': randomUUID(), authorization: `Bearer ${who.token}` },
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      crypto,
      caller,
      reviewer: await caller([REVIEW]),
      viewer: await caller([VIEW]),
      lookup: await caller([LOOKUP]),
      none: await caller([]),
      list(query, who) {
        return read('list', withQuery(LIST_PATH, query), who);
      },
      detail(withdrawalId, query, who) {
        return read(
          'detail',
          withQuery(`${LIST_PATH}/${encodeURIComponent(withdrawalId)}`, query),
          who,
        );
      },
      async write(path, body, who) {
        const response = await server.inject({
          method: 'POST',
          url: path,
          headers: {
            'x-trace-id': randomUUID(),
            authorization: `Bearer ${who.token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          remoteAddress: '127.0.0.1',
          payload: JSON.stringify(body),
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
      },
      async observed(request) {
        queries.length = 0;
        const sent = await request();
        return { sent, reads: queries.filter((query) => READ_TABLES.test(query)) };
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * A rejected withdrawal whose four internal fields all hold real values: the internal note, the
 * automatic decision and the risk flags snapshot (the fourth, holds[].source_ref, is on the holds).
 */
export function richSeed(f: Fixture, minutes: number, seed: WithdrawalSeed = {}): WithdrawalSeed {
  return {
    status: 'REJECTED',
    review_mode: 'manual',
    amount_fen: 30_000n,
    fee_fen: 100n,
    tax_fen: 50n,
    reject_reason_code: 'RISK_SUSPECT',
    reject_note: NOTE_MARK,
    auto_decision: {
      result: 'manual',
      failed_conditions: [`risk_flag:${FLAG_CODE}`],
      warn_values: {
        high_commission_order_ratio_bp: 1200,
        invalid_ratio_bp: 300,
        withdraw_received_ratio_bp: 4500,
      },
      rule_version: 3,
      decided_at: ago(f, minutes).toISOString(),
    },
    risk_flags: [{ code: FLAG_CODE, value: true, threshold: null }],
    risk_flags_at: ago(f, minutes),
    created_at: ago(f, minutes),
    updated_at: ago(f, minutes),
    ...seed,
  };
}

/** The list row a lookup-only account sees: the three blanked fields, the shape unchanged. */
export function blankedRow(view: Record<string, unknown>): Record<string, unknown> {
  return { ...view, reject_note: null, auto_decision: null, risk_flags: [] };
}

/** The detail a lookup-only account sees: the list blanks plus every holds[].source_ref. */
export function blankedDetail(view: Record<string, unknown>): Record<string, unknown> {
  const holds = view['holds'] as readonly Record<string, unknown>[];
  return { ...blankedRow(view), holds: holds.map((hold) => ({ ...hold, source_ref: null })) };
}

/** What two refusals must share to be the same answer (trace_id differs per request). */
export function refusal(body: Envelope): Record<string, unknown> {
  return { code: body.code, msg: body.msg, data: body.data };
}
