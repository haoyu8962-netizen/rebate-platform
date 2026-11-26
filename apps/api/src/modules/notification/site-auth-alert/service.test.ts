// B1-22ze r3 (Codex money r2 S1-①): an expired alert's SMS dedupe key carries the instant the caller
// entered expired (plan.enteredAt, the same instant union writes its persistent alert with), not
// this port's own later Clock reading (no database: Kysely runs on a recording driver).
// 错实现下怎么红：expired 段仍用 plan() 自己的 clock.now()（.101）而不看 plan.enteredAt（.100）——
// 首条用例写入的 dedupe_key 末段是 .101，红；没有 enteredAt 时不回落到 Clock（抛错或写 undefined）、
// 或把 enteredAt 也拼进即将到期（d / h 节点）的键，第二条红。
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import type { RootLogger } from '../../platform/index.ts';
import { createSiteAuthAlertPort, siteAuthAlertKey, type SiteAuthAlertPlan } from './service.ts';

const APP = 'unit-app';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const EXPIRES = new Date('2026-11-24T09:29:00.000Z');
const ENTERED = '2026-11-24T09:29:00.100Z';
const PLANNED = '2026-11-24T09:29:00.101Z';

/** The port on a driver that records every statement; the Clock stands at PLANNED. */
function setup() {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push({ sql: compiled.sql, params: compiled.parameters });
      return Promise.resolve({ rows: [{ id: 'row' }] } as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const port = createSiteAuthAlertPort({
    db,
    clock: { now: () => new Date(PLANNED) },
    sms: { send: async () => 'accepted' },
    logger: {} as unknown as RootLogger,
  });
  return { db, port, statements };
}

function expiredPlan(enteredAt: Date | null | undefined): SiteAuthAlertPlan {
  const plan: SiteAuthAlertPlan = {
    appId: APP,
    unionAccountId: ACCOUNT,
    platform: 'taobao',
    authExpiresAt: EXPIRES,
    stage: 'expired',
    code: 'UNION_AUTH_EXPIRED',
    phoneIds: ['p1'],
  };
  return enteredAt === undefined ? plan : { ...plan, enteredAt };
}

it('[B1-22ze][BR-ID-24] 失效短信：plan() 写入的 dedupe_key 末段是调用方传入的进入失效时刻，不是 plan() 自己再读的 Clock', async () => {
  const run = setup();
  const added = await run.db
    .transaction()
    .execute((trx) => run.port.plan(trx, expiredPlan(new Date(ENTERED))));
  expect(added).toBe(1);
  const inserts = run.statements.filter((s) => s.sql.startsWith('insert into "app"."notify_logs"'));
  expect(inserts).toHaveLength(1);
  const keys = inserts[0]!.params.filter(
    (p): p is string => typeof p === 'string' && p.startsWith('union_auth:'),
  );
  // The persistent alert's key ends with the same instant (union alert-log authAlertKey:
  // `<expires ISO>:expired:<enteredAt ISO>`), so both records match on one expired event.
  expect(keys).toEqual([`union_auth:${ACCOUNT}:${EXPIRES.toISOString()}:expired:p1:${ENTERED}`]);
  expect(keys[0]).not.toContain(PLANNED);
  expect(keys[0]!.endsWith(`${EXPIRES.toISOString()}:expired:p1:${ENTERED}`)).toBe(true);
  // planned_at stays the port's own Clock reading.
  expect(inserts[0]!.params.some((p) => p instanceof Date && p.toISOString() === PLANNED)).toBe(
    true,
  );
});

it('[B1-22ze][BR-ID-24] 失效短信键：没有 enteredAt（或为 null）照旧用 Clock；即将到期节点的键不带时刻段', () => {
  const now = new Date(PLANNED);
  const base = `union_auth:${ACCOUNT}:${EXPIRES.toISOString()}`;
  expect(siteAuthAlertKey(expiredPlan(undefined), 'p1', now)).toBe(`${base}:expired:p1:${PLANNED}`);
  expect(siteAuthAlertKey(expiredPlan(null), 'p1', now)).toBe(`${base}:expired:p1:${PLANNED}`);
  expect(siteAuthAlertKey(expiredPlan(new Date(ENTERED)), 'p1', now)).toBe(
    `${base}:expired:p1:${ENTERED}`,
  );
  const expiring: SiteAuthAlertPlan = {
    ...expiredPlan(new Date(ENTERED)),
    stage: 'h6',
    code: 'UNION_AUTH_EXPIRING',
  };
  expect(siteAuthAlertKey(expiring, 'p1', now)).toBe(`${base}:h6:p1`);
});
