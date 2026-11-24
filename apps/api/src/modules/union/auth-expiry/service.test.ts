// B1-22zd r2 (Codex money r1): the hour alert paths of the site auth monitor without a database.
// Kysely runs on a scripted driver: every select of app.union_accounts answers the one seeded row,
// updates are recorded, and the transaction ends are counted. The real PostgreSQL behaviour is
// covered by the rule tests in test/spec/union/auth-alert-hours.
// 错实现下怎么红：
// - 无手机号时仍按 updated_at（或别的通用写入）判断节点做过：首条用例里账户行已被巡检写过、键为空，
//   必须记告警并写 hour_alert_key；键等于本节点时不得再写、不得再记；h6 之后的 h1 必须照记。
// - 5 分钟自愈不补小时任务、或不补「已到点未处理」的最小节点、或连更大的已到节点一起补：第二条红。
// - 续期成功后在续期事务里排小时任务（入队失败整笔回滚）、或排超过队列最大延迟的节点：第三条红。
// r3（Codex money r2）：
// - 无手机号时告警行仍在提交之后才记（提交成功但结果没回来就丢，重投又因键已写跳过）：第四条里
//   提交抛错后没有告警行、或告警行排在提交之后，红。
// - hour_alert_key 只按「等于本节点」判断：第五条里已处理 h1 后改配置为 [6]，h6 任务或自愈仍补发 h6，红。
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
import {
  FixedClock,
  type FieldCrypto,
  type JobQueue,
  type RootLogger,
} from '../../platform/index.ts';
import { JOB_HOUR_ALERT, KEY_ALERT_HOURS, hourAlertMark } from './hour-alerts.ts';
import { createSiteAuthMonitor } from './service.ts';

const APP = 'unit-app';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Authorized 2026-11-24 09:30 +08:00 for 24 hours (h6 03:30, h1 08:30, daily check 09:00 +08:00).
const RENEWED = Date.parse('2026-11-24T01:30:00.000Z');
const EXPIRES = RENEWED + DAY;

interface Row {
  id: string;
  app_id: string;
  platform: string;
  auth_status: string;
  auth_expires_at: Date | null;
  alert_stage: string;
  auth_renewed_at: Date | null;
  row_version: number;
  hour_alert_key: string | null;
}

function seedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ACCOUNT,
    app_id: APP,
    platform: 'taobao',
    auth_status: 'expiring',
    auth_expires_at: new Date(EXPIRES),
    alert_stage: 'none',
    auth_renewed_at: new Date(RENEWED),
    row_version: 3,
    hour_alert_key: null,
    ...overrides,
  };
}

function setup(
  row: Row,
  at: number,
  options: {
    appIds?: boolean;
    failHourSend?: boolean;
    /** The commit reaches the database but its result never comes back (the call throws). */
    failCommit?: boolean;
    hours?: number[];
  } = {},
) {
  /** Commits and log lines in the order they happened. */
  const order: string[] = [];
  const updates: { sql: string; params: readonly unknown[] }[] = [];
  const ends = { commit: 0, rollback: 0 };
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      if (text.startsWith('select distinct')) {
        return Promise.resolve(result(options.appIds === true ? [{ app_id: APP }] : []));
      }
      if (text.startsWith('select') && text.includes('"app"."union_accounts"')) {
        return Promise.resolve(result([{ ...row }]));
      }
      if (text.startsWith('update "app"."union_accounts"')) {
        updates.push({ sql: text, params: compiled.parameters });
        return Promise.resolve(result([], 1n));
      }
      return Promise.resolve(result([]));
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
      order.push('commit');
      if (options.failCommit === true) throw new Error('connection_lost');
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
  const queue: JobQueue = {
    send: async (...args) => {
      sends.push(args);
      const [, name, , sendOptions] = args;
      // The platform queue's own limit (validation.ts: delaySeconds 0..2 592 000).
      if ((sendOptions.delaySeconds ?? 0) > 2_592_000) throw new Error('invalid_option');
      if (name === JOB_HOUR_ALERT && options.failHourSend === true) throw new Error('timeout');
      return 'job';
    },
  };
  const lines: [string, string][] = [];
  const log =
    (level: string) =>
    (_fields: unknown, message: string): void => {
      lines.push([level, message]);
      order.push(message);
    };
  const logger = {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  } as unknown as RootLogger;
  const clock = new FixedClock(new Date(at));
  let refreshed: number | null = null;
  const monitor = createSiteAuthMonitor({
    db,
    clock,
    queue,
    logger,
    crypto: {} as FieldCrypto,
    config: {
      configValue: async (_appId: string, key: string) =>
        key === KEY_ALERT_HOURS && options.hours !== undefined
          ? { value: options.hours, version: 1 }
          : null,
    },
    probe: { probe: async () => ({ kind: 'unsupported' }) },
    refresher: {
      refresh: async () =>
        refreshed === null
          ? { ok: false, error: 'none' }
          : { ok: true, expiresAt: new Date(refreshed) },
    },
    alerts: { plan: async () => 0, deliver: async () => undefined },
  });
  return {
    monitor,
    updates,
    ends,
    sends,
    lines,
    order,
    refreshTo: (ms: number) => {
      refreshed = ms;
    },
  };
}

function hourJob(hours: number) {
  return {
    id: 'job-1',
    queue: 'union-auth',
    name: JOB_HOUR_ALERT,
    attempt: 1,
    payload: {
      app_id: APP,
      union_account_id: ACCOUNT,
      hours,
      expires_ms: EXPIRES,
      renewed_ms: RENEWED,
    },
  };
}

const hourSends = (sends: Parameters<JobQueue['send']>[]) =>
  sends.filter(([, name]) => name === JOB_HOUR_ALERT);

it('[B1-22zd][BR-ID-24] 无手机号：小时节点按 hour_alert_key 去重——键为空时记告警并写键；同节点重投不再写不再记；h6 之后 h1 照记', async () => {
  // The daily check already put the account into expiring at h6 (status written, key untouched).
  const first = setup(seedRow(), EXPIRES - 6 * HOUR + 60_000);
  await first.monitor.handle(hourJob(6));
  expect(first.updates).toHaveLength(1);
  expect(first.updates[0]!.sql).toContain('"hour_alert_key" = $');
  expect(first.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  expect(first.lines).toContainEqual(['warn', 'union_auth_expiring']);
  expect(first.ends).toEqual({ commit: 1, rollback: 0 });

  const repeat = setup(
    seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }),
    EXPIRES - 6 * HOUR + 120_000,
  );
  await repeat.monitor.handle(hourJob(6));
  expect(repeat.updates).toEqual([]);
  expect(repeat.lines).not.toContainEqual(['warn', 'union_auth_expiring']);

  const next = setup(
    seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }),
    EXPIRES - HOUR + 60_000,
  );
  await next.monitor.handle(hourJob(1));
  expect(next.updates).toHaveLength(1);
  expect(next.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 1));
  expect(next.lines).toContainEqual(['warn', 'union_auth_expiring']);
  // The status is already expiring: only the key is written, never alert_stage.
  expect(next.updates[0]!.sql).not.toContain('"alert_stage"');
  expect(next.updates[0]!.sql).not.toContain('"auth_status"');
});

it('[B1-22zd][BR-ID-24] 5 分钟自愈补小时任务：入队丢了的已到点节点立即发、未到点的按延迟排；已处理的不再补，更大的已到节点不补', async () => {
  // 03:40 +08:00: h6 due 10 minutes ago, its job lost (key empty); h1 at 08:30 before the 09:00 check.
  const at = EXPIRES - 6 * HOUR + 600_000;
  const lost = setup(seedRow(), at);
  await lost.monitor.heal();
  expect(hourSends(lost.sends).map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([
    [6, undefined],
    [1, Math.ceil((EXPIRES - HOUR - at) / 1000)],
  ]);

  const handled = setup(seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }), at);
  await handled.monitor.heal();
  expect(hourSends(handled.sends).map(([, , p]) => p['hours'])).toEqual([1]);

  // 08:40 +08:00, nothing handled: only h1 at once, h6 never late.
  const late = setup(seedRow(), EXPIRES - HOUR + 600_000);
  await late.monitor.heal();
  expect(hourSends(late.sends).map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([
    [1, undefined],
  ]);

  // Expired accounts and pdd (reauth_mode none) get no hour job.
  const expired = setup(seedRow({ auth_status: 'expired' }), at);
  await expired.monitor.heal();
  expect(hourSends(expired.sends)).toEqual([]);
  const pdd = setup(seedRow({ platform: 'pdd' }), at);
  await pdd.monitor.heal();
  expect(hourSends(pdd.sends)).toEqual([]);
});

it('[B1-22zd][BR-ID-24] 续期成功后小时任务在提交后尽力排：入队失败不回滚续期；超过队列最大延迟的节点不排', async () => {
  const now = Date.parse('2026-11-24T02:00:00.000Z');
  // Two days left (≤ 7: the refresher is tried), alert d7 already sent.
  const row = seedRow({
    auth_expires_at: new Date(now + 2 * DAY),
    auth_renewed_at: new Date(now - 28 * DAY),
    alert_stage: 'd7',
  });

  const failing = setup(row, now, { appIds: true, failHourSend: true });
  failing.refreshTo(now + 20 * DAY);
  await failing.monitor.dailyCheck();
  expect(failing.ends.rollback).toBe(0);
  expect(failing.lines).toContainEqual(['info', 'union_auth_refreshed']);
  expect(failing.lines).toContainEqual(['warn', 'union_auth_hour_schedule_failed']);
  const renewal = failing.updates.find((u) => u.sql.includes('"auth_expires_at" = $'));
  expect(renewal?.params).toContainEqual(new Date(now + 20 * DAY));
  // Sent outside the renewal transaction.
  expect(hourSends(failing.sends).length).toBeGreaterThan(0);
  expect(hourSends(failing.sends).every(([, , , o]) => o.trx === null)).toBe(true);

  const long = setup(row, now, { appIds: true });
  long.refreshTo(now + 90 * DAY);
  await long.monitor.dailyCheck();
  expect(long.ends.rollback).toBe(0);
  expect(long.lines).toContainEqual(['info', 'union_auth_refreshed']);
  expect(long.lines).not.toContainEqual(['warn', 'union_auth_hour_schedule_failed']);
  expect(hourSends(long.sends)).toEqual([]);
});

it('[B1-22zd][BR-ID-24] 无手机号：小时节点的后台告警行在写键的事务提交之前记——提交结果丢了也不丢告警；重投因键已写而跳过', async () => {
  const at = EXPIRES - 6 * HOUR + 60_000;
  const lost = setup(seedRow(), at, { failCommit: true });
  await expect(lost.monitor.handle(hourJob(6))).rejects.toThrow('connection_lost');
  // The mark went into the committed update …
  expect(lost.updates).toHaveLength(1);
  expect(lost.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  // … and the alert line was already written, before the commit.
  expect(lost.lines).toContainEqual(['warn', 'union_auth_expiring']);
  expect(lost.order.indexOf('union_auth_expiring')).toBeGreaterThanOrEqual(0);
  expect(lost.order.indexOf('union_auth_expiring')).toBeLessThan(lost.order.indexOf('commit'));

  // The redelivered job finds the committed mark: nothing more (the one line above is the alert).
  const again = setup(seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }), at + 60_000);
  await again.monitor.handle(hourJob(6));
  expect(again.updates).toEqual([]);
  expect(again.lines).not.toContainEqual(['warn', 'union_auth_expiring']);
});

it('[B1-22zd][BR-ID-24] 已处理更小节点后不补发更大的：h1 已发、配置改为 [6]，h6 任务不记不写、自愈不补 h6；别的到期时刻的键不算', async () => {
  const at = EXPIRES - HOUR + 300_000;
  const handledH1 = seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 1) });

  const job = setup(handledH1, at, { hours: [6] });
  await job.monitor.handle(hourJob(6));
  expect(job.updates).toEqual([]);
  expect(job.lines).not.toContainEqual(['warn', 'union_auth_expiring']);

  const heal = setup(handledH1, at, { hours: [6] });
  await heal.monitor.heal();
  expect(hourSends(heal.sends)).toEqual([]);

  // A key of the previous authorization says nothing about this one: h6 goes out.
  const stale = seedRow({ hour_alert_key: hourAlertMark(EXPIRES - DAY, 1) });
  const fresh = setup(stale, at, { hours: [6] });
  await fresh.monitor.handle(hourJob(6));
  expect(fresh.updates).toHaveLength(1);
  expect(fresh.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  expect(fresh.lines).toContainEqual(['warn', 'union_auth_expiring']);
});
