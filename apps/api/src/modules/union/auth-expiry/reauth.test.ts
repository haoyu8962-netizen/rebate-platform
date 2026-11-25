// B1-22ze r2 (Codex money r1 S1-④): the re-authorization callback commits the new credential and
// the session before it reads union.auth_alert_hours or sends hour jobs (no database: Kysely runs on
// a scripted driver; the real PostgreSQL behaviour is covered by the rule tests).
// 错实现下怎么红：小时配置在写凭据的事务之前（或之内）读、读失败让 finish 抛错——首条用例里 callback
// 会拒绝、事务不提交、会话被改成 finalize_failed，红；配置读取或入队失败不吞掉（抛给回调）也红；
// 小时任务在提交之前排、或排程的延迟不按注入 Clock 算，第二条红。
// r3（Codex money r2 S1-②）：新授权首次排程不补「提交时已到点、未到期」的最小有效节点（照旧当已过跳过，
// 只排 h1），第三条红；把更大的已到节点也补、或已到点的节点带延迟排，同样红。
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
import { FixedClock, type FieldCrypto, type JobQueue } from '../../platform/index.ts';
import type { UnionAuditWriter } from '../pids/service.ts';
import { JOB_HOUR_ALERT, KEY_ALERT_HOURS } from './hour-alerts.ts';
import { createSiteReauth } from './reauth.ts';

const APP = 'unit-app';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T01:30:00.000Z');

function setup(
  hours: () => Promise<{ value: unknown; version: number } | null>,
  timing: { readonly expiresInMs: number; readonly afterCommitMs: number } = {
    expiresInMs: 24 * HOUR,
    afterCommitMs: 0,
  },
) {
  let committed = false;
  const order: string[] = [];
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const ends = { commit: 0, rollback: 0 };
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      statements.push({ sql: text, params: compiled.parameters });
      if (text.startsWith('select') && text.includes('"admin_union_auth_sessions"')) {
        return Promise.resolve(
          result([
            {
              id: SESSION,
              app_id: APP,
              union_account_id: ACCOUNT,
              created_by: 'admin-1',
              expires_at: new Date(NOW + 600_000),
              used_at: null,
              status: 'pending',
            },
          ]),
        );
      }
      if (text.startsWith('select') && text.includes('"union_accounts"')) {
        return Promise.resolve(
          result([
            {
              platform: 'taobao',
              auth_expires_at: new Date(NOW - HOUR),
              auth_expires_estimated: false,
              auth_status: 'expired',
              alert_stage: 'expired',
              row_version: 7,
            },
          ]),
        );
      }
      if (text.startsWith('update')) {
        order.push(text.includes('"admin_union_auth_sessions"') ? 'update_session' : 'update');
        return Promise.resolve(result([], 1n));
      }
      return Promise.resolve(result([], 1n));
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => {
      ends.commit += 1;
      committed = true;
      order.push('commit');
    },
    rollbackTransaction: async () => {
      ends.rollback += 1;
    },
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
  const sends: Parameters<JobQueue['send']>[] = [];
  const warns: string[] = [];
  const reauth = createSiteReauth({
    db,
    // NOW inside the transaction; afterCommitMs later once it committed (a slow lock or commit).
    clock:
      timing.afterCommitMs === 0
        ? new FixedClock(new Date(NOW))
        : { now: () => new Date(committed ? NOW + timing.afterCommitMs : NOW) },
    crypto: { encrypt: (text: string) => `c:${text.length}` } as unknown as FieldCrypto,
    auditWriter: () => ({ append: async () => undefined }) as unknown as UnionAuditWriter,
    config: {
      configValue: async (_appId: string, key: string) => {
        if (key !== KEY_ALERT_HOURS) return null;
        order.push('read_hours');
        return hours() as never;
      },
    },
    oauth: {
      taobao: {
        authorizeUrl: async () => 'https://example.invalid/authorize',
        exchange: async () => ({
          accessToken: 'access',
          refreshToken: null,
          expiresAt: new Date(NOW + timing.expiresInMs),
        }),
      },
    },
    queue: {
      send: async (...args) => {
        sends.push(args);
        order.push(`send:${args[1]}`);
        return 'job';
      },
    },
    logger: {
      warn: (_fields: unknown, message: string) => {
        warns.push(message);
      },
    } as never,
  });
  return { reauth, order, statements, ends, sends, warns };
}

it('[B1-22ze][BR-ID-24] 重新授权：换得凭据后先提交凭据与会话，小时配置读取失败不阻断授权、会话不标 finalize_failed', async () => {
  const run = setup(async () => {
    throw new Error('statement_timeout');
  });
  const outcome = await run.reauth.callback({ state: 'state-1', code: 'code-1', error: null });
  expect(outcome).toEqual({ sessionId: SESSION, status: 'succeeded' });
  expect(run.ends).toEqual({ commit: 1, rollback: 0 });
  // The config is read only after the commit.
  expect(run.order.indexOf('read_hours')).toBeGreaterThan(run.order.indexOf('commit'));
  // The session is concluded as succeeded, never failed afterwards.
  const sessionUpdates = run.statements.filter(
    (s) => s.sql.startsWith('update') && s.sql.includes('"admin_union_auth_sessions"'),
  );
  expect(sessionUpdates.flatMap((s) => s.params)).toContain('succeeded');
  expect(sessionUpdates.flatMap((s) => s.params)).not.toContain('finalize_failed');
  expect(run.sends).toEqual([]);
  expect(run.warns).toEqual(['union_auth_hour_schedule_failed']);
});

it('[B1-22ze][BR-ID-24] 重新授权：配置可读时小时任务在提交之后排，延迟按注入 Clock 对到节点时刻', async () => {
  const run = setup(async () => ({ value: [6, 1], version: 1 }));
  const outcome = await run.reauth.callback({ state: 'state-1', code: 'code-1', error: null });
  expect(outcome.status).toBe('succeeded');
  const hourSends = run.sends.filter(([, name]) => name === JOB_HOUR_ALERT);
  expect(hourSends.map(([, , p, o]) => [p['hours'], o.delaySeconds, o.trx])).toEqual([
    [6, 18 * 3600, null],
    [1, 23 * 3600, null],
  ]);
  expect(run.order.indexOf(`send:${JOB_HOUR_ALERT}`)).toBeGreaterThan(run.order.indexOf('commit'));
  expect(run.warns).toEqual([]);
});

it('[B1-22ze][BR-ID-24] 重新授权首次排程：提交时已到点、未到期的最小有效节点立即入队，后续节点照节点时刻排', async () => {
  // Total 6 h + 200 ms: h6 is live, due at NOW + 200 ms; the commit ends at NOW + 800 ms.
  const run = setup(async () => ({ value: [6, 1], version: 1 }), {
    expiresInMs: 6 * HOUR + 200,
    afterCommitMs: 800,
  });
  const outcome = await run.reauth.callback({ state: 'state-1', code: 'code-1', error: null });
  expect(outcome.status).toBe('succeeded');
  const hourSends = run.sends.filter(([, name]) => name === JOB_HOUR_ALERT);
  // h6 at once (no delay), h1 delayed to its node: NOW + 5 h + 200 ms, from NOW + 800 ms.
  expect(hourSends.map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([
    [6, undefined],
    [1, Math.ceil((5 * HOUR + 200 - 800) / 1000)],
  ]);
  expect(run.warns).toEqual([]);
});
