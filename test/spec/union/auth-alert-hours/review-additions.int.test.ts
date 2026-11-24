import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createSiteAuthMonitor } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import {
  DAY_MS,
  HOUR_MS,
  HOURS_KEY,
  account,
  adminEntry,
  databaseFixture,
  expectHourJobs,
  harness,
  later,
  outbox,
  plans,
  received,
  renew,
  stored,
  type Harness,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);

async function expectSkippedHourJob(h: Harness, id: string, job: ReturnType<typeof received>) {
  const before = await stored(h, id);
  const planned = plans(h, id);
  const queued = await outbox(h);

  await h.monitor.handle(job);

  expect(await stored(h, id)).toEqual(before);
  expect(plans(h, id)).toEqual(planned);
  expect(await outbox(h)).toEqual(queued);
}

async function queueH6BeforeShortAuthorization(h: Harness, platform: 'taobao' | 'jd') {
  const expiry = later(h, 7 * HOUR_MS);
  const { id } = await account(h, {
    platform,
    auth_renewed_at: h.clock.now(),
    auth_expires_at: expiry,
  });
  await h.monitor.dailyCheck();
  const [h6] = expectHourJobs(h, id, expiry, [6, 1]);
  // At the h6 due time a new authorization ending at the same expiry lasts exactly six hours.
  h.clock.advanceMs(HOUR_MS);
  h.send.mockClear();
  return { id, expiry, h6: received(h6!) };
}

it('[AC-B1-22zd#9] 回调的新授权恰好 24 小时，跳过 h24，旧 h24 任务到点空转', async () => {
  const h = await harness(db());
  h.settings.set(HOURS_KEY, [24, 6, 1]);
  const service = await adminEntry(h);
  const { id } = await account(h);
  const expiry = later(h, 2 * DAY_MS);
  await renew(h, service, id, 2);
  const [h24] = expectHourJobs(h, id, expiry, [24, 6, 1]);

  h.clock.advanceMs(DAY_MS);
  h.send.mockClear();
  await renew(h, service, id, 1);

  expect(await stored(h, id)).toMatchObject({
    auth_renewed_at: h.clock.now(),
    auth_expires_at: expiry,
    auth_status: 'active',
  });
  expectHourJobs(h, id, expiry, [6, 1]);
  await expectSkippedHourJob(h, id, received(h24!));
});

it('[AC-B1-22zd#10] 刷新后的授权恰好 6 小时，只排 h1，先前排好的 h6 到点空转', async () => {
  const h = await harness(db());
  h.settings.set('attr.jd.user_key_mode', 'private_position');
  const { id, expiry, h6 } = await queueH6BeforeShortAuthorization(h, 'jd');
  const oldExpiry = later(h, 2 * DAY_MS);
  await h.db
    .updateTable('union_accounts')
    .set({ auth_expires_at: oldExpiry })
    .where('app_id', '=', h.appId)
    .where('id', '=', id)
    .execute();
  // The next check is before h1. This run can enqueue h1 via refresh, outside the backfill window.
  h.settings.set('union.auth_probe_cron', '0 12 * * *');
  const monitor = createSiteAuthMonitor({
    ...h.options,
    refresher: {
      async refresh(input) {
        return input.unionAccountId === id
          ? { ok: true, expiresAt: expiry }
          : { ok: false, error: 'synthetic-unavailable' };
      },
    },
  });
  await monitor.dailyCheck();

  expect(await stored(h, id)).toMatchObject({
    auth_renewed_at: h.clock.now(),
    auth_expires_at: expiry,
  });
  expectHourJobs(h, id, expiry, [1]);
  await expectSkippedHourJob(h, id, h6);
});

it('[AC-B1-22zd#11] 巡检补排遇到 6 小时授权只排 h1，先前排好的 h6 到点空转', async () => {
  const h = await harness(db());
  const { id, expiry, h6 } = await queueH6BeforeShortAuthorization(h, 'taobao');
  await h.db
    .updateTable('union_accounts')
    .set({ auth_renewed_at: h.clock.now() })
    .where('app_id', '=', h.appId)
    .where('id', '=', id)
    .execute();

  await h.monitor.dailyCheck();

  expectHourJobs(h, id, expiry, [1]);
  await expectSkippedHourJob(h, id, h6);
});

it('[AC-B1-22zd#12] 未配置告警手机号时 h6 照常进入 expiring，重投只保留一条后台告警', async () => {
  const h = await harness(db());
  h.settings.delete('union.auth_alert_phones');
  const { id } = await account(h);
  const expiry = later(h, DAY_MS);
  await renew(h, await adminEntry(h), id, 1);
  const [h6] = expectHourJobs(h, id, expiry, [6, 1]);
  const job = received(h6!);
  const backendAlerts = () =>
    h.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['union_account_id'] === id && line['msg'] === 'union_auth_expiring');

  h.clock.set(new Date(expiry.getTime() - 6 * HOUR_MS));
  await h.monitor.handle(job);
  expect(await stored(h, id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'none' });
  const firstAlerts = backendAlerts();
  expect(firstAlerts).toMatchObject([{ app_id: h.appId, stage: 'h6', phones_configured: false }]);

  await createSiteAuthMonitor(h.options).handle({ ...job, attempt: 2 });
  expect(backendAlerts()).toEqual(firstAlerts);
  expect(plans(h, id).flatMap((plan) => plan.phoneIds)).toEqual([]);
  expect((await outbox(h)).filter((row) => row.channel === 'sms')).toEqual([]);
});

it('[AC-B1-22zd#13] 联盟调用已判授权失效，未到期的 h6 任务不恢复状态也不计划提醒', async () => {
  const h = await harness(db());
  const { id } = await account(h);
  const expiry = later(h, DAY_MS);
  await renew(h, await adminEntry(h), id, 1);
  const [h6] = expectHourJobs(h, id, expiry, [6, 1]);

  await h.monitor.reportAuthFailure({
    appId: h.appId,
    unionAccountId: id,
    platform: 'taobao',
    error: 'synthetic-auth-invalid',
  });
  expect(await stored(h, id)).toMatchObject({
    auth_status: 'expired',
    alert_stage: 'expired',
    auth_expires_at: expiry,
  });
  expect(plans(h, id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRED', stage: 'expired' }]);

  h.clock.set(new Date(expiry.getTime() - 6 * HOUR_MS));
  await expectSkippedHourJob(h, id, received(h6!));
});
