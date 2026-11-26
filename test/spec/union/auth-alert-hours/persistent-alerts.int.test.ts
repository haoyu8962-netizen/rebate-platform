import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { JobPayload, JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createQueueRuntime,
  QUEUE_CATALOG,
  type QueueRuntimeOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  createSiteAuthMonitor,
  encodeAlertPhones,
  type SiteAuthMonitor,
} from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import {
  DAY_MS,
  HOUR_MS,
  HOURS_KEY,
  PHONES,
  account,
  adminEntry,
  databaseFixture,
  expectHourJobs,
  harness,
  later,
  outbox,
  received,
  renew,
  stored,
  type Harness,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);
const workerDb = databaseFixture(createTestDatabase);
const QUEUE = 'union-auth';
const LOG_JOB = 'alert_log';
const ALERT_MESSAGES = [
  'union_auth_expiring',
  'union_auth_expired',
  'union_auth_alert_phones_missing',
];

interface AlertRecord {
  id: string;
  app_id: string;
  union_account_id: string;
  platform: string;
  stage: string;
  alert_key: string;
  auth_expires_at: Date | null;
  entered_at: Date | null;
  phones_configured: boolean;
  cause: string | null;
  created_at: Date;
}

async function alertsFor(h: Harness, id: string) {
  const exists = await sql<{ present: boolean }>`
    SELECT to_regclass('app.union_auth_alerts') IS NOT NULL AS present
  `.execute(h.db);
  expect(exists.rows[0]?.present, 'app.union_auth_alerts 已迁移').toBe(true);
  // Keep the red phase independent of the generated DB types.
  return (
    await sql<AlertRecord>`
      SELECT * FROM app.union_auth_alerts
      WHERE app_id = ${h.appId} AND union_account_id = ${id}
      ORDER BY created_at, id
    `.execute(h.db)
  ).rows;
}

async function logJobs(h: Harness, id: string) {
  return (
    await sql<{ id: string; payload: JobPayload; state: string; retry_count: number }>`
      SELECT id, data -> 'payload' AS payload, state::text AS state, retry_count
      FROM pgboss.job
      WHERE name = ${QUEUE} AND data ->> 'name' = ${LOG_JOB}
        AND data -> 'payload' ->> 'app_id' = ${h.appId}
        AND data -> 'payload' ->> 'union_account_id' = ${id}
      ORDER BY id
    `.execute(h.db)
  ).rows;
}

function emitted(h: Harness, id: string) {
  return h.lines
    .map((line) => JSON.parse(line) as { msg: string; union_account_id?: string })
    .filter((line) => line.union_account_id === id && ALERT_MESSAGES.includes(line.msg));
}

function daily(h: Harness, monitor: SiteAuthMonitor) {
  return monitor.handle({
    id: randomUUID(),
    queue: QUEUE,
    name: 'daily_check',
    payload: { app_id: h.appId },
    attempt: 1,
  });
}

async function hourSetup(h: Harness) {
  const expiry = later(h, DAY_MS);
  const { id } = await account(h, {
    auth_expires_at: expiry,
    auth_renewed_at: h.clock.now(),
  });
  await daily(h, h.monitor);
  const [h6, h1] = expectHourJobs(h, id, expiry, [6, 1]);
  h.clock.set(new Date(expiry.getTime() - 6 * HOUR_MS));
  return { id, expiry, h6: received(h6!), h1: received(h1!) };
}

async function withProducer(
  h: Harness,
  run: (queue: JobQueue) => Promise<void>,
  queueOptions: Pick<QueueRuntimeOptions, 'catalog' | 'plan'> = {},
) {
  const queue = createQueueRuntime({ entry: 'api', db: h.db, logger: h.logger, ...queueOptions });
  await queue.start();
  try {
    await run(queue);
  } finally {
    await queue.stop();
  }
}

function interruptedTransaction(h: Harness, boundary: 'before' | 'after', fault: Error) {
  function instrument(db: Kysely<DB>): Kysely<DB> {
    const withSchema = db.withSchema.bind(db);
    vi.spyOn(db, 'withSchema').mockImplementation((schema) => instrument(withSchema(schema)));

    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(() => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      return Object.assign(builder, {
        async execute<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
          await execute(async (trx) => {
            const value = await work(trx);
            if (boundary === 'before') throw fault;
            return value;
          });
          throw fault;
        },
      });
    });
    return db;
  }

  return instrument(h.db.withSchema('app'));
}

it.each([false, true])(
  '[AC-B1-22zd#14] h6 提交前故障全部回滚，重投告警和日志任务各一条（配置手机号 %s）',
  async (phonesConfigured) => {
    const h = await harness(db());
    if (!phonesConfigured) h.settings.delete('union.auth_alert_phones');
    const { id, expiry, h6 } = await hourSetup(h);
    const fault = new Error('synthetic failure before commit');
    await withProducer(h, async (queue) => {
      const monitor = createSiteAuthMonitor({
        ...h.options,
        queue,
        db: interruptedTransaction(h, 'before', fault),
      });

      await expect(monitor.handle(h6)).rejects.toThrow(fault.message);
      expect(await stored(h, id)).toMatchObject({
        auth_status: 'active',
        hour_alert_key: null,
        alert_stage: 'none',
      });
      expect(await alertsFor(h, id)).toEqual([]);
      expect(await outbox(h)).toEqual([]);
      expect(await logJobs(h, id)).toEqual([]);
      expect(emitted(h, id)).toEqual([]);

      await createSiteAuthMonitor({ ...h.options, queue }).handle({ ...h6, attempt: 2 });
      const facts = await alertsFor(h, id);
      expect(facts).toMatchObject([
        {
          id: expect.any(String),
          app_id: h.appId,
          union_account_id: id,
          platform: 'taobao',
          stage: 'h6',
          auth_expires_at: expiry,
          entered_at: null,
          phones_configured: phonesConfigured,
          cause: null,
          created_at: h.clock.now(),
        },
      ]);
      expect(facts[0]!.alert_key).toContain(expiry.toISOString());
      expect(facts[0]!.alert_key).toContain('h6');
      expect(await logJobs(h, id)).toMatchObject([
        { payload: { app_id: h.appId, union_account_id: id, alert_id: facts[0]!.id } },
      ]);
      expect(await stored(h, id)).toMatchObject({
        auth_status: 'expiring',
        hour_alert_key: expect.any(String),
        alert_stage: 'none',
      });
      expect(await outbox(h)).toHaveLength(phonesConfigured ? PHONES.length : 0);
      expect(emitted(h, id)).toEqual([]);
    });
  },
);

it('[AC-B1-22zd#15] 有手机号时提交成功但回执丢失，重投保留已提交的告警、短信和任务', async () => {
  const h = await harness(db());
  const { id, expiry, h6 } = await hourSetup(h);
  const fault = new Error('synthetic lost commit acknowledgement');
  await withProducer(h, async (queue) => {
    const monitor = createSiteAuthMonitor({
      ...h.options,
      queue,
      db: interruptedTransaction(h, 'after', fault),
    });

    await expect(monitor.handle(h6)).rejects.toThrow(fault.message);
    const facts = await alertsFor(h, id);
    expect(facts).toMatchObject([
      { stage: 'h6', auth_expires_at: expiry, phones_configured: true, created_at: h.clock.now() },
    ]);
    const jobs = await logJobs(h, id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({
      app_id: h.appId,
      union_account_id: id,
      alert_id: facts[0]!.id,
    });
    const notices = await outbox(h);
    expect(notices).toHaveLength(PHONES.length);
    const state = await stored(h, id);
    expect(state).toMatchObject({ auth_status: 'expiring', hour_alert_key: expect.any(String) });
    expect(emitted(h, id)).toEqual([]);

    await createSiteAuthMonitor({ ...h.options, queue }).handle({ ...h6, attempt: 2 });

    expect(await alertsFor(h, id)).toEqual(facts);
    expect(await logJobs(h, id)).toEqual(jobs);
    expect(await outbox(h)).toEqual(notices);
    expect(await stored(h, id)).toEqual(state);
    expect(emitted(h, id)).toEqual([]);
  });
});

it('[AC-B1-22zd#16] 小时节点并发与重投去重，h1 和重新授权后的 h6 各自另记', async () => {
  const h = await harness(db());
  const { id, expiry, h6, h1 } = await hourSetup(h);
  await withProducer(h, async (queue) => {
    const monitor = createSiteAuthMonitor({ ...h.options, queue });
    const other = createSiteAuthMonitor({ ...h.options, queue });
    const duplicate = { ...h6, id: randomUUID() };
    await Promise.all([monitor.handle(h6), other.handle(duplicate), daily(h, other)]);
    await other.handle({ ...h6, attempt: 2 });
    const first = await alertsFor(h, id);
    expect(first).toMatchObject([{ stage: 'h6', auth_expires_at: expiry }]);
    expect(await logJobs(h, id)).toHaveLength(1);

    h.clock.set(new Date(expiry.getTime() - HOUR_MS));
    await monitor.handle(h1);
    await other.handle({ ...h1, attempt: 2 });

    h.send.mockClear();
    const newExpiry = later(h, DAY_MS);
    await renew(h, await adminEntry(h), id, 1);
    const [nextH6] = expectHourJobs(h, id, newExpiry, [6, 1]);
    h.clock.set(new Date(newExpiry.getTime() - 6 * HOUR_MS));
    await monitor.handle(received(nextH6!));

    const facts = await alertsFor(h, id);
    expect(facts).toMatchObject([
      first[0]!,
      { stage: 'h1', auth_expires_at: expiry },
      { stage: 'h6', auth_expires_at: newExpiry },
    ]);
    expect(new Set(facts.map((fact) => fact.alert_key)).size).toBe(3);
    expect((await logJobs(h, id)).map((job) => job.payload['alert_id']).sort()).toEqual(
      facts.map((fact) => fact.id).sort(),
    );
  });
});

it('[AC-B1-22zd#17] 持久告警已存在时插入冲突不再排日志任务', async () => {
  const h = await harness(db());
  h.settings.delete('union.auth_alert_phones');
  const { id, h6 } = await hourSetup(h);
  await withProducer(h, async (queue) => {
    const send = vi.fn<JobQueue['send']>((...args) => queue.send(...args));
    const monitor = createSiteAuthMonitor({ ...h.options, queue: { send } });
    await monitor.handle(h6);
    const facts = await alertsFor(h, id);
    const jobs = await logJobs(h, id);
    expect(facts).toHaveLength(1);
    expect(jobs).toHaveLength(1);

    // Seed a stale account marker so the second execution must meet the existing fact.
    await sql`
      UPDATE app.union_accounts SET hour_alert_key = NULL
      WHERE app_id = ${h.appId} AND id = ${id}
    `.execute(h.db);
    send.mockClear();
    await monitor.handle({ ...h6, attempt: 2 });

    expect(await alertsFor(h, id)).toEqual(facts);
    expect(await logJobs(h, id)).toEqual(jobs);
    expect(send.mock.calls.filter(([, name]) => name === LOG_JOB)).toEqual([]);
  });
});

it.each(['短信登记', '日志入队'] as const)(
  '[AC-B1-22zd#18] 日节点的%s失败时告警、日阶段、短信和日志任务一起回滚',
  async (failureAt) => {
    const h = await harness(db());
    h.settings.set(HOURS_KEY, []);
    const expiry = later(h, 14 * DAY_MS);
    const { id } = await account(h, {
      auth_expires_at: expiry,
      auth_renewed_at: later(h, -30 * DAY_MS),
    });
    await withProducer(h, async (queue) => {
      let faultHit = false;
      const fail = () => {
        faultHit = true;
        throw new Error('synthetic day-alert write failure');
      };
      const monitor = createSiteAuthMonitor({
        ...h.options,
        alerts: {
          ...h.options.alerts,
          async plan(trx, plan) {
            const count = await h.plan(trx, plan);
            if (failureAt === '短信登记') fail();
            return count;
          },
        },
        queue: {
          async send(...args) {
            const jobId = await queue.send(...args);
            if (failureAt === '日志入队' && args[1] === LOG_JOB) fail();
            return jobId;
          },
        },
      });
      await daily(h, monitor);

      expect(faultHit).toBe(true);
      expect(await stored(h, id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
      expect(await alertsFor(h, id)).toEqual([]);
      expect(await outbox(h)).toEqual([]);
      expect(await logJobs(h, id)).toEqual([]);
      expect(emitted(h, id)).toEqual([]);

      await daily(h, createSiteAuthMonitor({ ...h.options, queue }));

      expect(await stored(h, id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'd14' });
      const facts = await alertsFor(h, id);
      expect(facts).toMatchObject([
        {
          stage: 'd14',
          auth_expires_at: expiry,
          entered_at: null,
          cause: null,
          created_at: h.clock.now(),
          phones_configured: true,
        },
      ]);
      expect(facts[0]!.alert_key).toContain(expiry.toISOString());
      expect(await outbox(h)).toHaveLength(PHONES.length);
      expect(await logJobs(h, id)).toHaveLength(1);
      const rows = await (await adminEntry(h)).list(h.appId);
      expect(rows).toMatchObject([
        { union_account_id: id, auth_status: 'expiring', alert_phones_configured: true },
      ]);
      expect(Object.keys(rows[0]!).filter((key) => key.includes('alert'))).toEqual([
        'alert_phones_configured',
      ]);
    });
  },
);

it('[AC-B1-22zd#19] 同一到期时刻恢复后再次失效，两条告警按进入失效时刻区分', async () => {
  const h = await harness(db());
  h.settings.set(HOURS_KEY, []);
  const expiry = later(h, 30 * DAY_MS);
  const { id } = await account(h, { auth_expires_at: expiry });
  const enteredAt = h.clock.now();
  const failure = {
    appId: h.appId,
    unionAccountId: id,
    platform: 'taobao' as const,
    error: 'invalid',
  };
  await withProducer(h, async (queue) => {
    const monitor = createSiteAuthMonitor({ ...h.options, queue });
    await monitor.reportAuthFailure(failure);
    await monitor.reportAuthFailure(failure);
    const first = await alertsFor(h, id);
    expect(first).toMatchObject([
      {
        stage: 'expired',
        cause: 'call',
        auth_expires_at: expiry,
        entered_at: enteredAt,
        created_at: enteredAt,
      },
    ]);

    h.clock.advanceMs(60_000);
    await daily(h, monitor);
    expect(await stored(h, id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
    h.clock.set(expiry);
    await monitor.expiryDue(h.appId, id, expiry.toISOString());
    h.clock.advanceMs(60_000);
    await monitor.expiryDue(h.appId, id, expiry.toISOString());

    const facts = await alertsFor(h, id);
    expect(facts).toMatchObject([
      first[0]!,
      {
        stage: 'expired',
        cause: 'time',
        auth_expires_at: expiry,
        entered_at: expiry,
        created_at: expiry,
      },
    ]);
    expect(facts[0]!.alert_key).toContain(enteredAt.toISOString());
    expect(facts[1]!.alert_key).toContain(expiry.toISOString());
    expect(facts[0]!.alert_key).not.toEqual(facts[1]!.alert_key);
    expect((await logJobs(h, id)).map((job) => job.payload['alert_id']).sort()).toEqual(
      facts.map((fact) => fact.id).sort(),
    );
    expect(await outbox(h)).toHaveLength(2 * PHONES.length);
  });
});

it('[AC-B1-22zd#22] 重新授权后的 d14 按新到期时刻另记告警并排日志任务', async () => {
  const h = await harness(db());
  h.settings.set(HOURS_KEY, []);
  const firstExpiry = later(h, 14 * DAY_MS);
  const { id } = await account(h, {
    auth_expires_at: firstExpiry,
    auth_renewed_at: later(h, -30 * DAY_MS),
  });
  await withProducer(h, async (queue) => {
    const monitor = createSiteAuthMonitor({ ...h.options, queue });
    await daily(h, monitor);
    const first = await alertsFor(h, id);
    expect(first).toMatchObject([{ stage: 'd14', auth_expires_at: firstExpiry }]);
    expect(first[0]!.alert_key).toContain(firstExpiry.toISOString());

    const newExpiry = later(h, 365 * DAY_MS);
    await renew(h, await adminEntry(h), id, 365);
    h.clock.set(new Date(newExpiry.getTime() - 14 * DAY_MS));
    await daily(h, monitor);

    const facts = await alertsFor(h, id);
    expect(facts).toMatchObject([first[0]!, { stage: 'd14', auth_expires_at: newExpiry }]);
    expect(facts[1]!.alert_key).toContain(newExpiry.toISOString());
    expect(facts[1]!.alert_key).not.toBe(first[0]!.alert_key);
    expect((await logJobs(h, id)).map((job) => job.payload['alert_id']).sort()).toEqual(
      facts.map((fact) => fact.id).sort(),
    );
  });
});

it('[AC-B1-22zd#20] 告警表只追加，应用角色只可插入和读取，列只记录告警事实', async () => {
  const h = await harness(db());
  const columns = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'union_auth_alerts'
    ORDER BY column_name
  `.execute(h.db);
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    'alert_key',
    'app_id',
    'auth_expires_at',
    'cause',
    'created_at',
    'entered_at',
    'id',
    'phones_configured',
    'platform',
    'stage',
    'union_account_id',
  ]);

  const grants = await sql<{ privilege: string }>`
    SELECT privilege
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(privilege)
    WHERE has_table_privilege('couli_app', 'app.union_auth_alerts', privilege)
    ORDER BY privilege
  `.execute(h.db);
  expect(grants.rows.map((row) => row.privilege)).toEqual(['INSERT', 'SELECT']);

  const indexes = await sql<{ columns: string[] }>`
    SELECT ARRAY(
      SELECT pg_get_indexdef(i.indexrelid, n, false)
      FROM generate_series(1, i.indnkeyatts) n ORDER BY n
    ) AS columns
    FROM pg_index i
    WHERE i.indrelid = 'app.union_auth_alerts'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
  `.execute(h.db);
  expect(indexes.rows.map((row) => [...row.columns].sort())).toContainEqual([
    'alert_key',
    'app_id',
    'stage',
    'union_account_id',
  ]);

  const guards = await sql<{ enabled: string }>`
    SELECT t.tgenabled AS enabled
    FROM pg_trigger t
    WHERE t.tgrelid = 'app.union_auth_alerts'::regclass
      AND t.tgfoid = 'app.reject_update_delete()'::regprocedure
      AND (t.tgtype & 27) = 27
      AND NOT t.tgisinternal
  `.execute(h.db);
  expect(guards.rows.some((row) => ['O', 'A'].includes(row.enabled))).toBe(true);
  const update = sql`UPDATE app.union_auth_alerts SET cause = NULL`;
  await expect(update.execute(h.db)).rejects.toMatchObject({ code: '42501' });
  await expect(sql`DELETE FROM app.union_auth_alerts`.execute(h.db)).rejects.toMatchObject({
    code: '42501',
  });
});

it('[AC-B1-22zd#21] 日志端两次失败后由队列重投，告警记录保持原样', async () => {
  const h = await harness(workerDb());
  h.settings.delete('union.auth_alert_phones');
  const { id, expiry, h6 } = await hourSetup(h);
  const queueSpecs = QUEUE_CATALOG.filter((spec) => [QUEUE, `${QUEUE}.dead`].includes(spec.name));
  const shortDelay = { retryDelaySeconds: 1, retryDelayMaxSeconds: null, retryBackoff: false };
  const queueOptions = {
    catalog: queueSpecs.map((spec) => (spec.name === QUEUE ? { ...spec, ...shortDelay } : spec)),
    plan: {
      api: [],
      admin: [],
      stream: [],
      payout: [],
      worker: [{ queue: QUEUE, concurrency: 1, pollingIntervalSeconds: 0.5 }],
    },
  };
  await withProducer(
    h,
    async (queue) => {
      await createSiteAuthMonitor({ ...h.options, queue }).handle(h6);
    },
    queueOptions,
  );
  expect(emitted(h, id)).toEqual([]);
  const jobs = await logJobs(h, id);
  expect(jobs).toHaveLength(1);
  const job = jobs[0]!;
  const facts = await alertsFor(h, id);
  const expected = { stage: 'h6', auth_expires_at: expiry, phones_configured: false };
  expect(facts).toMatchObject([expected]);
  expect(job.payload).toEqual({ app_id: h.appId, union_account_id: id, alert_id: facts[0]!.id });

  h.settings.set('union.auth_alert_phones', encodeAlertPhones(h.crypto, PHONES));
  const failures: { attempt: number; message: string; records: AlertRecord[] }[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    {
      write(line) {
        const event = JSON.parse(line) as { msg: string; union_account_id?: string };
        const isAlert = event.msg === 'union_auth_expiring' && event.union_account_id === id;
        if (isAlert && failures.length < 2) {
          throw new Error('synthetic alert log sink failure');
        }
        h.lines.push(line);
      },
    },
  );
  const worker = createQueueRuntime({
    entry: 'worker',
    db: h.db,
    logger: h.logger,
    ...queueOptions,
  });
  const monitor = createSiteAuthMonitor({ ...h.options, queue: worker, logger });
  worker.register(QUEUE, async (job) => {
    try {
      await monitor.handle(job);
    } catch (error) {
      if (job.name === LOG_JOB && error instanceof Error) {
        failures.push({
          attempt: job.attempt,
          message: error.message,
          records: await alertsFor(h, id),
        });
      }
      throw error;
    }
  });

  await worker.start();
  try {
    const state = async () => (await logJobs(h, id))[0]?.state;
    await expect.poll(state, { timeout: 12_000, interval: 50 }).toBe('completed');
    expect(await logJobs(h, id)).toMatchObject([
      { id: job.id, state: 'completed', retry_count: 2 },
    ]);

    expect(failures).toEqual(
      [1, 2].map((attempt) => ({
        attempt,
        message: 'synthetic alert log sink failure',
        records: facts,
      })),
    );
    expect(emitted(h, id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          msg: 'union_auth_expiring',
          level: 40,
          app_id: h.appId,
          platform: 'taobao',
          union_account_id: id,
          stage: 'h6',
          auth_expires_at: expiry.toISOString(),
          phones_configured: false,
        }),
        expect.objectContaining({
          msg: 'union_auth_alert_phones_missing',
          level: 40,
          app_id: h.appId,
          platform: 'taobao',
          union_account_id: id,
          stage: 'h6',
        }),
      ]),
    );
    expect(await alertsFor(h, id)).toEqual(facts);
    expect(await outbox(h)).toEqual([]);
  } finally {
    await worker.stop();
  }
});
