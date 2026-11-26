import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createSiteAuthAlertPort,
  type TemplateSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { createSiteAuthMonitor } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { account, EXPIRES, harness, jobs, logs, notifications, PHONES, stored } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const failureAt of ['plan', 'enqueue'] as const) {
  it(`[AC-S1-64#30] ${failureAt} 失败回滚状态、阶段和 notify_logs，恢复后可重试一次`, async () => {
    const h = harness(database());
    const a = await account(h);
    const real = createSiteAuthAlertPort({
      db: h.db,
      clock: h.clock,
      logger: h.logger,
      sms: { send: async () => 'accepted' },
    });
    const plan = vi.fn(async (...args: Parameters<typeof real.plan>) => {
      const added = await real.plan(...args);
      if (failureAt === 'plan' && args[1].unionAccountId === a.id)
        throw new Error('synthetic-plan-failure');
      return added;
    });
    h.send.mockImplementation(async (_queue, _name, payload, options) => {
      if (options.trx !== null && failureAt === 'enqueue' && JSON.stringify(payload).includes(a.id))
        throw new Error('synthetic-enqueue-failure');
      return randomUUID();
    });
    const monitor = createSiteAuthMonitor({
      ...h.options,
      alerts: { plan, deliver: (...args) => real.deliver(...args) },
    });
    // Failure may propagate or be caught for the next account; only durable effects matter.
    await monitor.dailyCheck().catch(() => undefined);
    if (failureAt === 'plan') {
      expect(plan.mock.calls.some(([, p]) => p.unionAccountId === a.id)).toBe(true);
    } else {
      expect(jobs(h, a.id).some(([, , , o]) => o.trx !== null)).toBe(true);
    }
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: a.auth_status,
      alert_stage: a.alert_stage,
    });
    expect(await notifications(h.db, h.appId)).toEqual([]);
    h.send.mockResolvedValue(randomUUID());
    const repaired = createSiteAuthMonitor({ ...h.options, alerts: real });
    await repaired.dailyCheck();
    expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'd14' });
    expect(await notifications(h.db, h.appId)).toHaveLength(2);
  });
}

it('[AC-S1-64#31] 状态、阶段、短信登记在同一事务，deliver 任务提交后按至少一次交付不重发', async () => {
  const h = harness(database());
  const a = await account(h);
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const real = createSiteAuthAlertPort({
    db: h.db,
    clock: h.clock,
    logger: h.logger,
    sms: { send },
  });
  const plan = vi.fn((...args: Parameters<typeof real.plan>) => real.plan(...args));
  const monitor = createSiteAuthMonitor({
    ...h.options,
    alerts: { plan, deliver: (...args) => real.deliver(...args) },
  });
  await monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'd14' });
  expect(await notifications(h.db, h.appId)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
  const deliveryJobs = jobs(h, a.id).filter(([, , , o]) => o.trx !== null);
  expect(deliveryJobs.length).toBeGreaterThan(0);
  const planTrx = plan.mock.calls.find(([, p]) => p.unionAccountId === a.id)?.[0];
  expect(planTrx?.isTransaction).toBe(true);
  expect(deliveryJobs.some(([, , , o]) => o.trx === planTrx)).toBe(true);
  for (const [queue, name, payload] of deliveryJobs) {
    const job = { id: randomUUID(), queue, name, payload, attempt: 1 };
    await monitor.handle(job);
    await monitor.handle({ ...job, attempt: 2 });
  }
  await monitor.deliverAlerts(h.appId, a.id);
  expect(send.mock.calls.map(([m]) => m.phone).sort()).toEqual([...PHONES].sort());
  expect((await notifications(h.db, h.appId)).map((r) => r.status)).toEqual(['success', 'success']);
});

it('[AC-S1-64#32] 短信故障不丢后台告警，不回滚 expired，失败记录不自动重发', async () => {
  const h = harness(database(), EXPIRES);
  const a = await account(h);
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'rejected');
  const real = createSiteAuthAlertPort({
    db: h.db,
    clock: h.clock,
    logger: h.logger,
    sms: { send },
  });
  const monitor = createSiteAuthMonitor({ ...h.options, alerts: real });
  await monitor.expiryDue(h.appId, a.id, EXPIRES);
  await monitor.deliverAlerts(h.appId, a.id);
  await monitor.expiryDue(h.appId, a.id, EXPIRES);
  await monitor.deliverAlerts(h.appId, a.id);
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  for (const [queue, name, payload] of jobs(h, a.id).filter(([, n]) => n === 'alert_log')) {
    await monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
  }
  expect(logs(h, 'union_auth_expired')).toHaveLength(1);
  expect((await notifications(h.db, h.appId)).map((r) => r.status)).toEqual(['failed', 'failed']);
  expect(send).toHaveBeenCalledTimes(2);
});

it('[AC-S1-64#33] 到期任务与调用失效并发，持久层每号只有一份 EXPIRED', async () => {
  const h = harness(database(), EXPIRES);
  const a = await account(h);
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const alerts = createSiteAuthAlertPort({
    db: h.db,
    clock: h.clock,
    logger: h.logger,
    sms: { send },
  });
  const monitor = createSiteAuthMonitor({ ...h.options, alerts });
  await Promise.all([
    monitor.expiryDue(h.appId, a.id, EXPIRES),
    monitor.reportAuthFailure({
      appId: h.appId,
      unionAccountId: a.id,
      platform: 'taobao',
      error: 'invalid',
    }),
  ]);
  expect(await notifications(h.db, h.appId)).toHaveLength(2);
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  await monitor.deliverAlerts(h.appId, a.id);
  expect(send).toHaveBeenCalledTimes(2);
});

it('[AC-S1-65#5] 探测失效恢复后真正到期再次逐号登记 EXPIRED，同一次失效重跑不重复', async () => {
  const enteredAt = '2026-11-20T01:00:00.000Z';
  const h = harness(database(), enteredAt);
  const a = await account(h);
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const alerts = createSiteAuthAlertPort({
    db: h.db,
    clock: h.clock,
    logger: h.logger,
    sms: { send },
  });
  const monitor = createSiteAuthMonitor({ ...h.options, alerts });
  const keys = (at: string) =>
    PHONES.map(
      (phone) =>
        `union_auth:${a.id}:${EXPIRES}:expired:${h.crypto.blindIndex(phone, 'union.auth_alert_phones')}:${at}`,
    ).sort();

  h.probe.mockResolvedValue({ kind: 'auth_invalid', error: 'classified-invalid' });
  await monitor.dailyCheck();
  h.clock.advanceMs(60_000);
  await monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  const first = await notifications(h.db, h.appId);
  expect(first.map((row) => row.dedupe_key).sort()).toEqual(keys(enteredAt));
  for (const row of first)
    expect(row).toMatchObject({
      code: 'UNION_AUTH_EXPIRED',
      status: 'queued',
      planned_at: new Date(enteredAt),
    });
  await monitor.deliverAlerts(h.appId, a.id);
  await monitor.deliverAlerts(h.appId, a.id);
  expect(send.mock.calls.map(([m]) => [m.phone, m.template]).sort()).toEqual(
    PHONES.map((phone) => [phone, 'UNION_AUTH_EXPIRED']).sort(),
  );
  const delivered = await notifications(h.db, h.appId);
  expect(delivered.map((row) => row.status)).toEqual(['success', 'success']);

  h.clock.advanceMs(60_000);
  h.probe.mockResolvedValue({ kind: 'ok' });
  await monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
  expect(await notifications(h.db, h.appId)).toEqual(delivered);

  h.clock.set(EXPIRES);
  await monitor.expiryDue(h.appId, a.id, EXPIRES);
  h.clock.advanceMs(60_000);
  await monitor.expiryDue(h.appId, a.id, EXPIRES);
  await monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  const second = await notifications(h.db, h.appId);
  expect(second.map((row) => row.dedupe_key).sort()).toEqual(
    [...keys(enteredAt), ...keys(EXPIRES)].sort(),
  );
  expect(second.filter((row) => keys(enteredAt).includes(row.dedupe_key))).toEqual(delivered);
  for (const row of second.filter((row) => keys(EXPIRES).includes(row.dedupe_key)))
    expect(row).toMatchObject({
      code: 'UNION_AUTH_EXPIRED',
      status: 'queued',
      planned_at: new Date(EXPIRES),
    });
  await monitor.deliverAlerts(h.appId, a.id);
  await monitor.deliverAlerts(h.appId, a.id);
  expect(send.mock.calls.map(([m]) => [m.phone, m.template]).sort()).toEqual(
    [...PHONES, ...PHONES].map((phone) => [phone, 'UNION_AUTH_EXPIRED']).sort(),
  );
  expect((await notifications(h.db, h.appId)).map((row) => row.status)).toEqual([
    'success',
    'success',
    'success',
    'success',
  ]);
});
