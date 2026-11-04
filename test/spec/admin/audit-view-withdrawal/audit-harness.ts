// B2-09q §9: real admin writes → real audit HTTP reads. No synthetic audit rows or read ports.
// Reuse the payout seeds (real FREEZE vouchers, verified identities) and their DB/Redis suite;
// that suite imports DB testing through a computed URL and uses TEST_PG_ADMIN_URL in CI.
// db/schema.sql: withdrawals.id is globally unique; audit_logs / payout_watermarks are append-only.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
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
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contractPaths } from '../../ledger/admin-recon-write-off/kit.ts';
import { assembled } from '../../notification/risk-state-message/worker-kit.ts';
import { newKey, type ReviewFixture } from '../../payout/admin-withdrawal-review/review-harness.ts';
import type { Sealer } from '../../payout/admin-withdrawals/kit.ts';
import { detail, page, type Detail, type Item, type Page, type Query } from '../audit-query/kit.ts';
import type { Response } from '../auth/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const OPERATIONS = {
  approve: ['/admin/v1/withdrawals/batch-approve', 'post', 200],
  reject: ['/admin/v1/withdrawals/{withdrawal_id}/reject', 'post', 200],
  manual: ['/admin/v1/withdrawals/batch-manual-paid', 'post', 200],
  batch: ['/admin/v1/payout-batches', 'post', 200],
  watermark: ['/admin/v1/payout-watermarks', 'post', 200],
  risk: ['/admin/v1/users/{user_id}/risk-state', 'put', 200],
  export: ['/admin/v1/exports', 'post', 202],
} as const;
type Operation = keyof typeof OPERATIONS;

interface Caller {
  readonly appId: string;
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface AuditAdmin extends Sealer {
  caller(appId: string): Promise<Caller>;
  write<T>(op: Operation, body: unknown, id?: string, caller?: Caller): Promise<T>;
  page(query?: Query, caller?: Caller): Promise<Page>;
  detail(id: string, caller?: Caller): Promise<Detail>;
  readDetail(id: string, caller: Caller): Promise<Response>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response & { readonly body: string }>;
}

/** Authentication/session and step-up setup follows the payout admin harnesses. */
export async function withAuditAdmin(
  f: ReviewFixture,
  run: (h: AuditAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09q-'));
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const tokenKey = randomBytes(32);
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09q_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
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
    const caller = async (appId: string): Promise<Caller> => {
      const id = randomUUID();
      await f.db
        .withSchema('app')
        .insertInto('admin_users')
        .values({
          id,
          app_id: appId,
          login_name: `audit_${id}`,
          password_hash: 'unused-test-login',
          is_super: false,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      await f.db
        .withSchema('app')
        .insertInto('admin_permissions')
        .values(
          [
            'audit.view_all',
            'withdraw.review',
            'payout.manual_entry',
            'payout.execute',
            'fund.cash_entry',
            'risk.freeze',
            'user.list',
            'export',
          ].map((permission_key) => ({
            app_id: appId,
            admin_id: id,
            permission_key,
            granted_by: id,
            granted_at: f.clock.now(),
          })),
        )
        .execute();
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, appId, token, sessionId: claims.sessionId };
    };
    const actor = await caller(f.appId);
    const reader = (who: Caller) => ({
      token: who.token,
      read: (token: string, url = '/admin/v1/audit-logs') =>
        server.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}`, 'x-trace-id': randomUUID() },
          remoteAddress: '127.0.0.1',
        }),
    });
    await run({
      crypto,
      caller,
      async write<T>(op: Operation, body: unknown, id?: string, who = actor): Promise<T> {
        const [path, method, status] = OPERATIONS[op];
        const url = path.replace(/\{[^}]+\}/g, encodeURIComponent(id ?? ''));
        const step = await createAdminStepUpTokens({
          clock: f.clock,
          redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
        }).issue({ appId: who.appId, adminId: who.id, sessionId: who.sessionId, tier: 'totp' });
        const response = await server.inject({
          method: method === 'put' ? 'PUT' : 'POST',
          url,
          headers: {
            authorization: `Bearer ${who.token}`,
            'content-type': 'application/json',
            'idempotency-key': newKey(),
            'x-step-up-token': step.step_up_token,
            'x-trace-id': randomUUID(),
          },
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json(), response.body).toMatchObject({ code: 0 });
        const schema = (await contractPaths())[path]?.[method]?.responses[String(status)]
          ?.content?.['application/json']?.schema;
        expect(schema, `${method} ${path} response schema`).toBeDefined();
        const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
        expect(check(response.json()), response.body).toBe(true);
        return response.json<{ data: T }>().data;
      },
      page: (query = {}, who = actor) => page(reader(who), { page_size: 200, ...query }),
      detail: (id, who = actor) => detail(reader(who), id),
      readDetail: (id, who) =>
        reader(who).read(who.token, `/admin/v1/audit-logs/${encodeURIComponent(id)}`),
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Real worker registration and transaction/audit wiring, queue delivery supplied by the test. */
export async function systemReject(f: ReviewFixture, userId: string): Promise<void> {
  const worker = await assembled('worker', f.db, f.clock);
  try {
    const registrations = worker.registrations.filter(
      (item) => item.name === 'evt.payout-went-negative',
    );
    expect(registrations).toHaveLength(1);
    await registrations[0]!.handler({
      id: randomUUID(),
      queue: 'evt.payout-went-negative',
      name: 'account.went_negative',
      attempt: 1,
      payload: {
        app_id: f.appId,
        v: 1,
        occurred_at: f.clock.now().toISOString(),
        data: { user_id: userId },
      },
    });
  } finally {
    await worker.close();
  }
}

export type View = Pick<Item, 'action' | 'target_type' | 'target_id' | 'permission'>;

export function view(
  action: string,
  target_type: string | null,
  target_id: string | null,
  permission: Item['permission'],
): View {
  return { action, target_type, target_id, permission };
}

function derived(row: Item): View {
  return view(row.action, row.target_type, row.target_id, row.permission);
}

/** Exact multiset, including multiplicity; every returned list row and detail must agree. */
export async function expectPage(
  h: AuditAdmin,
  query: Query,
  expected: readonly View[],
): Promise<Item[]> {
  const result = await h.page(query);
  expect(result.total).toBe(expected.length);
  expect(result.items).toHaveLength(expected.length);
  const sorted = (rows: readonly View[]) => rows.map((row) => JSON.stringify(row)).sort();
  expect(sorted(result.items.map(derived))).toEqual(sorted(expected));
  for (const row of result.items) {
    for (const key of ['target_type', 'target_id', 'permission'] as const) {
      if (query[key] !== undefined) expect(row[key]).toBe(query[key]);
    }
    const detail = await h.detail(row.id);
    expect(detail).toMatchObject(row);
    expect(derived(detail)).toEqual(derived(row));
  }
  return result.items;
}
