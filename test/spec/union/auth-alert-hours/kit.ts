import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import type { ConfigValue } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createSiteAuthAlertPort,
  type TemplateSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  type AuditPort,
  type JobQueue,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { AdminUnionAccounts } from '../../../../apps/api/src/modules/union/application/admin-accounts.ts';
import {
  createSiteAuthMonitor,
  encodeAlertPhones,
  type SiteAuthMonitorOptions,
  type SiteAuthProbe,
} from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';

export const NOW = '2026-11-22T01:30:00.000Z';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const HOURS_KEY = 'union.auth_alert_hours';
export const PHONES = ['13800138000', '13900139000'] as const;

interface DatabaseHandle {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function databaseFixture(create: () => Promise<DatabaseHandle>) {
  let database: DatabaseHandle | undefined;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await create();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  }, 180_000);
  afterAll(async () => {
    if (db !== undefined) await destroyDb(db);
    await database?.drop();
  }, 60_000);
  return () => db;
}

export async function harness(db: Kysely<DB>, at = NOW) {
  const appId = `auth-alert-hours-${randomUUID()}`;
  const adminId = randomUUID();
  const actor = { appId, adminId, ip: '192.0.2.7' };
  const clock = new FixedClock(at);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv: 'test' },
    { write: (line) => void lines.push(line) },
  );
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const settings = new Map<string, ConfigValue>([
    ['union.auth_alert_phones', encodeAlertPhones(crypto, PHONES)],
  ]);
  const config: SiteAuthMonitorOptions['config'] = {
    async configValue(app, key) {
      const value = app === appId ? settings.get(key) : undefined;
      return value === undefined ? null : { value, version: 1 };
    },
  };
  const probe = vi.fn<SiteAuthProbe['probe']>(async (account) =>
    account.appId === appId ? { kind: 'ok' } : { kind: 'unsupported' },
  );
  const send = vi.fn<JobQueue['send']>(async () => randomUUID());
  const queue = { send };
  const sms = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const alerts = createSiteAuthAlertPort({ db, clock, logger, sms: { send: sms } });
  const plan = vi.fn(alerts.plan);
  const options: SiteAuthMonitorOptions = {
    db,
    clock,
    logger,
    crypto,
    config,
    probe: { probe },
    queue,
    alerts: { ...alerts, plan },
  };
  const append = vi.fn<AuditPort['append']>(async () => undefined);
  const auditWriter = () => ({ append });
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: adminId,
      password_hash: 'fixture-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  return {
    db,
    appId,
    actor,
    clock,
    lines,
    logger,
    crypto,
    settings,
    config,
    send,
    queue,
    plan,
    options,
    auditWriter,
    append,
    monitor: createSiteAuthMonitor(options),
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export function account(h: Harness, patch: Partial<Insertable<DB['union_accounts']>> = {}) {
  return h.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform: 'taobao',
      account_name: 'synthetic site',
      status: 'active',
      auth_status: 'active',
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function stored(h: Harness, id: string) {
  return h.db
    .selectFrom('union_accounts')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function currentCredential(h: Harness, id: string) {
  return h.db
    .selectFrom('union_credentials')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('union_account_id', '=', id)
    .where('is_current', '=', true)
    .executeTakeFirstOrThrow();
}

export function plans(h: Harness, id: string) {
  return h.plan.mock.calls
    .map(([, plan]) => plan)
    .filter((plan) => plan.appId === h.appId && plan.unionAccountId === id);
}

export function outbox(h: Harness) {
  return h.db
    .selectFrom('notify_logs')
    .select(['dedupe_key', 'code', 'channel'])
    .where('app_id', '=', h.appId)
    .orderBy('dedupe_key')
    .execute();
}

export function later(h: Harness, ms: number) {
  return new Date(h.clock.now().getTime() + ms);
}

type QueueCall = Parameters<JobQueue['send']>;

function hourJobs(h: Harness, id: string, expiresAt: Date) {
  const expiresIn = Math.ceil((expiresAt.getTime() - h.clock.now().getTime()) / 1000);
  // The expiry job itself is due at expiresAt. Hour jobs must precede that instant.
  return h.send.mock.calls.filter(
    ([queue, , payload, options]) =>
      queue === 'union-auth' &&
      JSON.stringify(payload).includes(id) &&
      typeof options.delaySeconds === 'number' &&
      options.delaySeconds !== expiresIn,
  );
}

export function expectHourJobs(h: Harness, id: string, expiresAt: Date, hours: readonly number[]) {
  const jobs = hourJobs(h, id, expiresAt).sort((a, b) => a[3].delaySeconds! - b[3].delaySeconds!);
  expect(jobs.map(([, , , options]) => options.delaySeconds)).toEqual(
    hours.map((n) => (expiresAt.getTime() - h.clock.now().getTime() - n * HOUR_MS) / 1000),
  );
  const keys = jobs.map(([, , , options]) => options.singletonKey);
  expect(new Set(keys).size).toBe(jobs.length);
  for (const key of keys) expect(key).toContain(id);
  return jobs;
}

export function received([queue, name, payload]: QueueCall): ReceivedJob {
  return { id: randomUUID(), queue, name, payload, attempt: 1 };
}

interface FactoryProvider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...dependencies: unknown[]) => unknown;
  useValue?: unknown;
}

/** Resolve the registered application service with the same platform tokens as the admin entry. */
export async function adminEntry(h: Harness): Promise<AdminUnionAccounts> {
  const options = { config: () => h.config, auditWriter: h.auditWriter };
  const modulePath = '../../../../apps/api/src/modules/union/union-admin.module.ts';
  // The URL import keeps controller parameter decorators out of the rule-test TS project.
  const { UnionAdminModule } = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as {
    UnionAdminModule: {
      forAdmin(input: typeof options): { providers: readonly unknown[] };
    };
  };
  const { providers } = UnionAdminModule.forAdmin(options);
  const platform = new Map<unknown, unknown>([
    [APP_CONFIG, loadConfig({ APP_ENV: 'test' })],
    [CLOCK, h.clock],
    [DB_TOKEN, h.db],
    [FIELD_CRYPTO, h.crypto],
    [JOB_QUEUE, h.queue],
    [ROOT_LOGGER, h.logger],
  ]);

  async function resolve(token: unknown): Promise<unknown> {
    const provider = providers.find(
      (item): item is FactoryProvider =>
        item !== null && typeof item === 'object' && 'provide' in item && item.provide === token,
    );
    if (provider === undefined) return platform.get(token);
    if (provider.useFactory === undefined) return provider.useValue;
    const dependencies = await Promise.all(
      (provider.inject ?? []).map((entry) => {
        const key =
          entry !== null && typeof entry === 'object' && 'token' in entry ? entry.token : entry;
        return resolve(key);
      }),
    );
    return provider.useFactory(...dependencies);
  }

  const service = await resolve(AdminUnionAccounts);
  expect(service).toBeInstanceOf(AdminUnionAccounts);
  return service as AdminUnionAccounts;
}

export async function renew(h: Harness, service: AdminUnionAccounts, id: string, days: number) {
  const session = await service.start(h.actor, id, {});
  const state = new URL(session.auth_url).searchParams.get('state');
  expect(state).toEqual(expect.any(String));
  const result = await service.callback(h.actor, {
    state: state!,
    code: `fake-site:days:${days}:hour-fixture`,
  });
  expect(result.status).toBe('succeeded');
}
