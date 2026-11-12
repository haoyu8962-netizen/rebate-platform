// B1-10u rule-test kit on a real database (claude-independent, SPEC_REF 62b5c993): 08 BR-ID-15 ④
// and 编排 D10-1382 ② / D10-1399 (a) — the count of overdue AI reply reports per app, and the report
// list adminListAgentReports (GET /admin/v1/agent-traces/reports, CT-24zzi, permission agent.trace)
// giving the same answer under the same injected clock.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions, the
// admin entry (createHttpApp('admin'): token, session, permission, contract validation) — the
// shared suite and fixtures of ../admin-traces/kit.ts (B1-10q). Synthetic: agent_sessions /
// agent_runs / agent_messages rows written directly with INSERT (the report columns of
// db/schema.sql), admin accounts. No real user data. A missing route fails as an assertion (it does
// not answer 200 with code 0).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  answer,
  doneRun,
  insertMessage,
  insertRun,
  marker,
  reply,
  seedHandler,
  seedSession,
  type AdminCaller,
  type AdminSent,
  type Envelope,
  type Fixture,
  type Session,
} from '../admin-traces/kit.ts';
import { DEADLINE_MS, HOUR_MS, expectedOverdue, type ReportStatus } from './rule.ts';

export { agentTables, fixture, newAppId, otherApp, suite } from '../admin-traces/kit.ts';
export type { Fixture } from '../admin-traces/kit.ts';

export const REPORTS_PATH = '/admin/v1/agent-traces/reports';
/** specs/permissions.yaml (CT-24zzi): the trace console's read point, it covers the report list. */
export const TRACE = 'agent.trace';

const ROOT = new URL('../../../../', import.meta.url);
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------------------------
// Report rows.

/** One seeded assistant reply with its report columns, as written. */
export interface SeededReport {
  readonly label: string;
  readonly messageId: string;
  readonly appId: string;
  readonly status: ReportStatus;
  readonly reportedAt: Date | null;
}

export interface ReportSeed {
  readonly label: string;
  /** null: a reply that was never reported (reportedAt must then be null too). */
  readonly status: ReportStatus;
  readonly reportedAt: Date | null;
}

/** A session of `appId` started a month before the fixture's clock. */
export function reportSession(f: Fixture, appId = f.appId): Promise<Session> {
  const startedAt = new Date(f.clock.now().getTime() - 40 * DAY_MS);
  return seedSession(f, { appId, startedAt, lastActiveAt: startedAt });
}

/**
 * One finished run with an assistant reply carrying the report columns (pending: reported only;
 * handled: also a handler, handled_at and a note; null: not reported).
 */
export async function seedReport(
  f: Fixture,
  session: Session,
  seed: ReportSeed,
): Promise<SeededReport> {
  const anchor = seed.reportedAt ?? new Date(f.clock.now().getTime() - 3 * HOUR_MS);
  const repliedAt = new Date(anchor.getTime() - 60_000);
  const run = doneRun(new Date(repliedAt.getTime() - 2000));
  await insertRun(f, session, run);
  const handled = seed.status === 'handled';
  const message = reply(run.id, repliedAt, marker('ro-answer'), {
    reportStatus: seed.status,
    reportedAt: seed.status === null ? null : seed.reportedAt,
    reportReason: seed.status === null ? null : marker('ro-reason'),
    reportNote: handled ? marker('ro-note') : null,
    handlerId: handled ? await seedHandler(f, session.appId) : null,
    handledAt: handled ? new Date(anchor.getTime() + 1000) : null,
  });
  await insertMessage(f, session, message);
  return {
    label: seed.label,
    messageId: message.id,
    appId: session.appId,
    status: seed.status,
    reportedAt: seed.status === null ? null : seed.reportedAt,
  };
}

export interface Batch {
  /** The fixture app's replies (reported or not). */
  readonly own: readonly SeededReport[];
  /** Pending, long overdue reports of another app on the same database. */
  readonly foreign: readonly SeededReport[];
  readonly foreignAppId: string;
}

/**
 * The shared batch, relative to the fixture clock T, over two sessions of the fixture app:
 * pending at T−48 h (exactly due), T−48 h+1 ms (1 ms short), T−72 h, T−30 d (overdue), T−1 h
 * (not yet); handled at T−96 h and T−48 h; one reply never reported. Another app gets two pending
 * reports at T−72 h and T−48 h. At T the fixture app has exactly 3 overdue reports.
 */
export async function seedBatch(f: Fixture, foreignAppId: string): Promise<Batch> {
  const T = f.clock.now().getTime();
  const one = (session: Session, label: string, status: ReportStatus, agoMs: number | null) =>
    seedReport(f, session, {
      label,
      status,
      reportedAt: agoMs === null ? null : new Date(T - agoMs),
    });
  const a = await reportSession(f);
  const b = await reportSession(f);
  const own: SeededReport[] = [
    await one(a, 'pending T-48h', 'pending', DEADLINE_MS),
    await one(b, 'pending T-48h+1ms', 'pending', DEADLINE_MS - 1),
    await one(a, 'pending T-72h', 'pending', 72 * HOUR_MS),
    await one(b, 'pending T-30d', 'pending', 30 * DAY_MS),
    await one(a, 'pending T-1h', 'pending', HOUR_MS),
    await one(b, 'handled T-96h', 'handled', 96 * HOUR_MS),
    await one(a, 'handled T-48h', 'handled', DEADLINE_MS),
    await one(b, 'not reported', null, null),
  ];
  const c = await reportSession(f, foreignAppId);
  const foreign: SeededReport[] = [
    await one(c, 'other app pending T-72h', 'pending', 72 * HOUR_MS),
    await one(c, 'other app pending T-48h', 'pending', DEADLINE_MS),
  ];
  return { own, foreign, foreignAppId };
}

/** The seeded rows overdue at `now` by the test's own reading of the rule. */
export function overdueAt(rows: readonly SeededReport[], now: Date): SeededReport[] {
  return rows.filter((row) => expectedOverdue(row.status, row.reportedAt, now));
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface ReportsAdmin {
  /** GET the report list with the query as an account holding agent.trace only. */
  reports(query?: Record<string, string>): Promise<AdminSent>;
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withReportsAdmin(
  f: Fixture,
  run: (h: ReportsAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b1-10u-'));
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
        JWT_KEY_ID: 'b1_10u_test',
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
    const id = randomUUID();
    await f.db
      .insertInto('admin_users')
      .values({
        id,
        app_id: f.appId,
        login_name: `ro_${id}`,
        password_hash: 'unused-test-login',
        is_super: false,
        status: 'active',
        password_must_change: false,
        totp_bound_at: f.clock.now(),
        verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await f.db
      .insertInto('admin_permissions')
      .values({
        app_id: f.appId,
        admin_id: id,
        permission_key: TRACE,
        granted_by: id,
        granted_at: f.clock.now(),
      })
      .execute();
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
    const viewer: AdminCaller = { id, token, sessionId: claims.sessionId };
    await run({
      viewer,
      async reports(query) {
        const text = new URLSearchParams(query ?? {}).toString();
        const response = await server.inject({
          method: 'GET',
          url: text === '' ? REPORTS_PATH : `${REPORTS_PATH}?${text}`,
          headers: { 'x-trace-id': randomUUID(), authorization: `Bearer ${viewer.token}` },
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          template: REPORTS_PATH,
          json: () => JSON.parse(response.body) as Envelope,
        };
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

export interface ReportPage {
  readonly items: readonly Record<string, unknown>[];
  readonly total: number;
}

/** A successful list response (200, code 0, contract schema), its items and total. */
export async function reportPage(sent: AdminSent): Promise<ReportPage> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Array.isArray(data['items']), sent.body).toBe(true);
  expect(typeof data['total'], sent.body).toBe('number');
  return {
    items: data['items'] as Record<string, unknown>[],
    total: data['total'] as number,
  };
}
