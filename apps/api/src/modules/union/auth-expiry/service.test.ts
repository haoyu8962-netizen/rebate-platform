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
// B1-22ze（持久告警）：
// - 告警行仍由监控直接写（提交前或提交后），或告警记录 / alert_log 任务不在写键的同一事务里
//   （trx 为 null、排在提交之后）：第一、四条红（它们要求监控本身不写告警行，记录与任务都在提交前、
//   带同一事务）。
// - 插入冲突（记录已在）仍排 alert_log：第六条红。
// - alert_log 任务不按记录拼行（字段取当前配置而非记录、漏 phones_missing、级别错）：第七条红。
// B1-22ze r2（Codex money r1）：
// - S1-③ 小时任务在取账户行锁之前读 Clock（等锁跨过到期仍按旧时间判）：倒数第二条里会记 h1 告警、
//   写 hour_alert_key、不进 expired，红。
// - S1-① 进入失效的时刻不交给短信计划（plan 里没有 enteredAt，或与告警记录的 entered_at 不是同一个值）：
//   最末一条红。
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
import { JOB_ALERT_LOG } from './alert-log.ts';
import { JOB_HOUR_ALERT, KEY_ALERT_HOURS, hourAlertMark } from './hour-alerts.ts';
import { createSiteAuthMonitor, type SiteAuthAlertPlanInput } from './service.ts';

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
    /** The union_auth_alerts row already exists: the insert conflicts and returns nothing. */
    alertExists?: boolean;
    /** Time that passes while waiting for the account row lock (SELECT … FOR UPDATE). */
    lockWaitMs?: number;
    /** Alert phones configured (the cipher double keeps the list as plain JSON). */
    phones?: string[];
  } = {},
) {
  /** Commits and log lines in the order they happened. */
  const order: string[] = [];
  const updates: { sql: string; params: readonly unknown[] }[] = [];
  const ends = { commit: 0, rollback: 0 };
  /** Rows the monitor inserted into app.union_auth_alerts (RETURNING answered unless it exists). */
  const alertRows: Record<string, unknown>[] = [];
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      if (text.startsWith('select distinct')) {
        return Promise.resolve(result(options.appIds === true ? [{ app_id: APP }] : []));
      }
      if (text.startsWith('select') && text.includes('"app"."union_accounts"')) {
        if (text.includes('for update') && options.lockWaitMs !== undefined) {
          clock.advanceMs(options.lockWaitMs);
        }
        return Promise.resolve(result([{ ...row }]));
      }
      if (text.includes('INSERT INTO app.union_auth_alerts')) {
        const names = ['id', 'app_id', 'union_account_id', 'platform', 'stage', 'alert_key'];
        const more = ['auth_expires_at', 'entered_at', 'phones_configured', 'cause', 'created_at'];
        const record = Object.fromEntries(
          [...names, ...more].map((name, i) => [name, compiled.parameters[i]]),
        );
        order.push('insert_alert');
        if (options.alertExists === true) return Promise.resolve(result([], 0n));
        alertRows.push(record);
        return Promise.resolve(result([record], 1n));
      }
      if (text.includes('FROM app.union_auth_alerts')) {
        const id = compiled.parameters[2];
        return Promise.resolve(result(alertRows.filter((r) => r['id'] === id)));
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
      order.push(`send:${name}`);
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
  const plans: SiteAuthAlertPlanInput[] = [];
  let refreshed: number | null = null;
  const monitor = createSiteAuthMonitor({
    db,
    clock,
    queue,
    logger,
    crypto: {
      decrypt: (cipher: string) => cipher,
      blindIndex: (value: string) => `id-${value}`,
    } as unknown as FieldCrypto,
    config: {
      configValue: async (_appId: string, key: string) =>
        key === KEY_ALERT_HOURS && options.hours !== undefined
          ? { value: options.hours, version: 1 }
          : key === 'union.auth_alert_phones' && options.phones !== undefined
            ? { value: { cipher: JSON.stringify(options.phones) }, version: 1 }
            : null,
    },
    probe: { probe: async () => ({ kind: 'unsupported' }) },
    refresher: {
      refresh: async () =>
        refreshed === null
          ? { ok: false, error: 'none' }
          : { ok: true, expiresAt: new Date(refreshed) },
    },
    alerts: {
      plan: async (_trx, plan) => {
        plans.push(plan);
        order.push('plan');
        return plan.phoneIds.length;
      },
      deliver: async () => undefined,
    },
  });
  return {
    monitor,
    updates,
    ends,
    sends,
    lines,
    order,
    alertRows,
    plans,
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
const logSends = (sends: Parameters<JobQueue['send']>[]) =>
  sends.filter(([, name]) => name === JOB_ALERT_LOG);

it('[B1-22zd][BR-ID-24] 无手机号：小时节点按 hour_alert_key 去重——键为空时记告警并写键；同节点重投不再写不再记；h6 之后 h1 照记', async () => {
  const recorded = (run: ReturnType<typeof setup>) => logSends(run.sends).length === 1;
  // The daily check already put the account into expiring at h6 (status written, key untouched).
  const first = setup(seedRow(), EXPIRES - 6 * HOUR + 60_000);
  await first.monitor.handle(hourJob(6));
  expect(first.updates).toHaveLength(1);
  expect(first.updates[0]!.sql).toContain('"hour_alert_key" = $');
  expect(first.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  expect(recorded(first)).toBe(true);
  expect(first.alertRows).toMatchObject([{ stage: 'h6', phones_configured: false, cause: null }]);
  // The monitor itself writes no alert line: the alert_log job does.
  expect(first.lines).not.toContainEqual(['warn', 'union_auth_expiring']);
  expect(first.ends).toEqual({ commit: 1, rollback: 0 });

  const repeat = setup(
    seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }),
    EXPIRES - 6 * HOUR + 120_000,
  );
  await repeat.monitor.handle(hourJob(6));
  expect(repeat.updates).toEqual([]);
  expect(repeat.alertRows).toEqual([]);
  expect(logSends(repeat.sends)).toEqual([]);

  const next = setup(
    seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }),
    EXPIRES - HOUR + 60_000,
  );
  await next.monitor.handle(hourJob(1));
  expect(next.updates).toHaveLength(1);
  expect(next.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 1));
  expect(recorded(next)).toBe(true);
  expect(next.alertRows).toMatchObject([{ stage: 'h1' }]);
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

it('[B1-22ze][BR-ID-24] 小时节点的告警记录与 alert_log 任务和键在同一事务、提交之前；监控不写告警行；提交结果丢了重投因键已写而跳过', async () => {
  const at = EXPIRES - 6 * HOUR + 60_000;
  const lost = setup(seedRow(), at, { failCommit: true });
  await expect(lost.monitor.handle(hourJob(6))).rejects.toThrow('connection_lost');
  // The mark went into the committed update …
  expect(lost.updates).toHaveLength(1);
  expect(lost.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  // … with the alert record and its alert_log job on the same transaction, before the commit.
  const commit = lost.order.indexOf('commit');
  expect(lost.order.indexOf('insert_alert')).toBeGreaterThanOrEqual(0);
  expect(lost.order.indexOf('insert_alert')).toBeLessThan(commit);
  expect(lost.order.indexOf(`send:${JOB_ALERT_LOG}`)).toBeLessThan(commit);
  expect(lost.order.indexOf(`send:${JOB_ALERT_LOG}`)).toBeGreaterThan(
    lost.order.indexOf('insert_alert'),
  );
  const [log] = logSends(lost.sends);
  expect(log![3].trx).not.toBeNull();
  expect(log![2]).toEqual({
    app_id: APP,
    union_account_id: ACCOUNT,
    alert_id: lost.alertRows[0]!['id'],
  });
  expect(log![3].singletonKey).toContain(String(lost.alertRows[0]!['id']));
  expect(lost.lines.filter(([, m]) => m.startsWith('union_auth_ex'))).toEqual([]);

  // The redelivered job finds the committed mark: nothing more.
  const again = setup(seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 6) }), at + 60_000);
  await again.monitor.handle(hourJob(6));
  expect(again.updates).toEqual([]);
  expect(again.alertRows).toEqual([]);
  expect(logSends(again.sends)).toEqual([]);
});

it('[B1-22zd][BR-ID-24] 已处理更小节点后不补发更大的：h1 已发、配置改为 [6]，h6 任务不记不写、自愈不补 h6；别的到期时刻的键不算', async () => {
  const at = EXPIRES - HOUR + 300_000;
  const handledH1 = seedRow({ hour_alert_key: hourAlertMark(EXPIRES, 1) });

  const job = setup(handledH1, at, { hours: [6] });
  await job.monitor.handle(hourJob(6));
  expect(job.updates).toEqual([]);
  expect(job.alertRows).toEqual([]);
  expect(logSends(job.sends)).toEqual([]);

  const heal = setup(handledH1, at, { hours: [6] });
  await heal.monitor.heal();
  expect(hourSends(heal.sends)).toEqual([]);

  // A key of the previous authorization says nothing about this one: h6 goes out.
  const stale = seedRow({ hour_alert_key: hourAlertMark(EXPIRES - DAY, 1) });
  const fresh = setup(stale, at, { hours: [6] });
  await fresh.monitor.handle(hourJob(6));
  expect(fresh.updates).toHaveLength(1);
  expect(fresh.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  expect(fresh.alertRows).toMatchObject([{ stage: 'h6' }]);
  expect(logSends(fresh.sends)).toHaveLength(1);
});

it('[B1-22ze][BR-ID-24] 告警记录已在（插入冲突）时不排 alert_log；键照写', async () => {
  const conflict = setup(seedRow(), EXPIRES - 6 * HOUR + 60_000, { alertExists: true });
  await conflict.monitor.handle(hourJob(6));
  expect(conflict.order).toContain('insert_alert');
  expect(conflict.updates[0]!.params).toContain(hourAlertMark(EXPIRES, 6));
  expect(logSends(conflict.sends)).toEqual([]);
  expect(conflict.ends).toEqual({ commit: 1, rollback: 0 });
});

it('[B1-22ze][BR-ID-24] alert_log 任务读记录打行（无手机号：先 phones_missing 再 expiring）；记录不存在只记一条 warn、不抛', async () => {
  const run = setup(seedRow(), EXPIRES - 6 * HOUR + 60_000);
  await run.monitor.handle(hourJob(6));
  const [log] = logSends(run.sends);
  await run.monitor.handle({
    id: 'job-2',
    queue: 'union-auth',
    name: JOB_ALERT_LOG,
    attempt: 1,
    payload: log![2],
  });
  expect(run.lines.slice(-2)).toEqual([
    ['warn', 'union_auth_alert_phones_missing'],
    ['warn', 'union_auth_expiring'],
  ]);

  const missing = setup(seedRow(), EXPIRES - 6 * HOUR + 60_000);
  await missing.monitor.handle({
    id: 'job-3',
    queue: 'union-auth',
    name: JOB_ALERT_LOG,
    attempt: 1,
    payload: { app_id: APP, union_account_id: ACCOUNT, alert_id: 'absent' },
  });
  expect(missing.lines).toEqual([['warn', 'union_auth_alert_log_missing']]);
});

it('[B1-22ze][BR-ID-24] 小时任务取得行锁后才读 Clock：等锁跨过到期时刻 → 进 expired（只 EXPIRED），不记 h1、不写 hour_alert_key', async () => {
  // Picked up 100 ms before the expiry; the row lock is granted 200 ms later (100 ms past it).
  const late = setup(seedRow(), EXPIRES - 100, { lockWaitMs: 200, phones: ['13800138000'] });
  await late.monitor.handle(hourJob(1));
  expect(late.updates).toHaveLength(1);
  expect(late.updates[0]!.sql).toContain('"auth_status" = $');
  expect(late.updates[0]!.sql).toContain('"alert_stage" = $');
  expect(late.updates[0]!.params).toContain('expired');
  expect(late.updates[0]!.sql).not.toContain('"hour_alert_key"');
  expect(late.alertRows).toMatchObject([{ stage: 'expired', cause: 'time' }]);
  expect(late.alertRows[0]!['entered_at']).toEqual(new Date(EXPIRES + 100));
  expect(late.plans.map((p) => [p.stage, p.code])).toEqual([['expired', 'UNION_AUTH_EXPIRED']]);

  // Lock granted before the expiry: h1 as before.
  const onTime = setup(seedRow(), EXPIRES - 300, { lockWaitMs: 200, phones: ['13800138000'] });
  await onTime.monitor.handle(hourJob(1));
  expect(onTime.alertRows).toMatchObject([{ stage: 'h1', entered_at: null }]);
  expect(onTime.plans.map((p) => [p.stage, p.code, p.enteredAt])).toEqual([
    ['h1', 'UNION_AUTH_EXPIRING', null],
  ]);
});

it('[B1-22ze][BR-ID-24] 进入失效的时刻只取一次：告警记录的 entered_at 与 alert_key、短信计划的 enteredAt 是同一个值', async () => {
  const run = setup(seedRow(), EXPIRES + 5_000, { phones: ['13800138000', '13900139000'] });
  await run.monitor.expiryDue(APP, ACCOUNT, new Date(EXPIRES).toISOString());
  expect(run.alertRows).toHaveLength(1);
  const entered = run.alertRows[0]!['entered_at'] as Date;
  expect(entered).toEqual(new Date(EXPIRES + 5_000));
  expect(String(run.alertRows[0]!['alert_key'])).toContain(entered.toISOString());
  expect(run.plans).toHaveLength(1);
  expect(run.plans[0]!.code).toBe('UNION_AUTH_EXPIRED');
  expect(run.plans[0]!.enteredAt).toEqual(entered);
  // Planned on the same transaction, before the commit.
  expect(run.order.indexOf('plan')).toBeLessThan(run.order.indexOf('commit'));
});
