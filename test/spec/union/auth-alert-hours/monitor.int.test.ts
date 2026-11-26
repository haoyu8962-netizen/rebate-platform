import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createSiteAuthMonitor } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import {
  DAY_MS,
  HOUR_MS,
  PHONES,
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
} from './kit.ts';

const db = databaseFixture(createTestDatabase);

it('[AC-B1-22zd#1] 24 小时授权的日节点全部跳过，总时长未知的同到期账户仍提醒 d1', async () => {
  const h = await harness(db(), '2026-11-22T01:00:00.000Z');
  const renewed = h.clock.now();
  const expiry = later(h, DAY_MS);
  const known = await account(h, { auth_renewed_at: renewed, auth_expires_at: expiry });
  const legacy = await account(h, { auth_renewed_at: null, auth_expires_at: expiry });

  await h.monitor.dailyCheck();

  expect(await stored(h, legacy.id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'd1' });
  expect(plans(h, legacy.id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRING', stage: 'd1' }]);
  expect(await stored(h, known.id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
  expect(plans(h, known.id)).toEqual([]);
});

it('[AC-B1-22zd#1] 7 天等于 d7 提前量时跳过，多一分钟的授权仍到 d7', async () => {
  const h = await harness(db(), '2026-11-22T01:00:00.000Z');
  const expiry = later(h, 7 * DAY_MS);
  const exact = await account(h, { auth_renewed_at: h.clock.now(), auth_expires_at: expiry });
  const longer = await account(h, { auth_renewed_at: later(h, -60_000), auth_expires_at: expiry });

  await h.monitor.dailyCheck();

  expect(plans(h, longer.id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRING', stage: 'd7' }]);
  expect(await stored(h, exact.id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
  expect(plans(h, exact.id)).toEqual([]);
});

it('[AC-B1-22zd#3] h6 和 h1 到点各提醒一次，保留日阶段，重投去重，随后巡检仍为 expiring', async () => {
  const h = await harness(db());
  const id = (await account(h)).id;
  const expiry = later(h, DAY_MS);
  await renew(h, await adminEntry(h), id, 1);
  const jobs = expectHourJobs(h, id, expiry, [6, 1]);
  expect(await stored(h, id)).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
  expect(plans(h, id)).toEqual([]);

  for (const [index, hours] of [6, 1].entries()) {
    const stage = `h${hours}`;
    h.clock.set(new Date(expiry.getTime() - hours * HOUR_MS));
    const job = received(jobs[index]!);
    await h.monitor.handle(job);
    expect(plans(h, id).filter((p) => p.stage === stage)).toMatchObject([
      { code: 'UNION_AUTH_EXPIRING', authExpiresAt: expiry },
    ]);
    expect(await stored(h, id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'none' });
    const queued = await outbox(h);
    const current = queued.filter((row) => row.dedupe_key.includes(`:${stage}:`));
    expect(current).toHaveLength(PHONES.length);
    for (const row of current) {
      expect(row).toMatchObject({ code: 'UNION_AUTH_EXPIRING', channel: 'sms' });
      expect(row.dedupe_key).toContain(expiry.toISOString());
    }
    // The outbox uses the persistent alert key. Recreating the handler must still deduplicate.
    await createSiteAuthMonitor(h.options).handle({ ...job, attempt: 2 });
    expect(await outbox(h)).toEqual(queued);
  }

  const queued = await outbox(h);
  h.clock.set('2026-11-23T01:00:00.000Z');
  await h.monitor.dailyCheck();
  expect(await stored(h, id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'none' });
  expect(await outbox(h)).toEqual(queued);
  for (const job of h.send.mock.calls.filter(([, name]) => name === 'alert_log')) {
    await h.monitor.handle(received(job));
  }
  const backendAlerts = h.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['union_account_id'] === id && line['msg'] === 'union_auth_expiring');
  expect(backendAlerts).toMatchObject([{ stage: 'h6' }, { stage: 'h1' }]);
});

it('[AC-B1-22zd#4] 到期时刻变更后，旧授权的 h6 任务到点空转', async () => {
  const h = await harness(db());
  const service = await adminEntry(h);
  const id = (await account(h)).id;
  const oldExpiry = later(h, DAY_MS);
  await renew(h, service, id, 1);
  const oldJobs = expectHourJobs(h, id, oldExpiry, [6, 1]);

  h.clock.advanceMs(HOUR_MS);
  h.send.mockClear();
  const newExpiry = later(h, 2 * DAY_MS);
  await renew(h, service, id, 2);
  const newJobs = expectHourJobs(h, id, newExpiry, [6, 1]);
  expect(newJobs[0]![3].singletonKey).not.toBe(oldJobs[0]![3].singletonKey);
  const renewed = await stored(h, id);

  h.clock.set(new Date(oldExpiry.getTime() - 6 * HOUR_MS));
  await h.monitor.handle(received(oldJobs[0]!));
  expect(await stored(h, id)).toEqual(renewed);
  expect(plans(h, id)).toEqual([]);
});

it('[AC-B1-22zd#4] 小时任务迟至到期时刻交付时直接过期，只计划 EXPIRED', async () => {
  const h = await harness(db());
  const id = (await account(h)).id;
  const expiry = later(h, DAY_MS);
  await renew(h, await adminEntry(h), id, 1);
  const jobs = expectHourJobs(h, id, expiry, [6, 1]);

  h.clock.set(expiry);
  await h.monitor.handle(received(jobs[1]!));
  expect(await stored(h, id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  expect(plans(h, id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRED', stage: 'expired' }]);
});

it('[AC-B1-22zd#5] h1 已计划时，迟到的 h6 不补发', async () => {
  const h = await harness(db());
  const id = (await account(h)).id;
  const expiry = later(h, DAY_MS);
  await renew(h, await adminEntry(h), id, 1);
  const jobs = expectHourJobs(h, id, expiry, [6, 1]);

  h.clock.set(new Date(expiry.getTime() - HOUR_MS));
  await h.monitor.handle(received(jobs[1]!));
  expect(plans(h, id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRING', stage: 'h1' }]);
  const queued = await outbox(h);
  await createSiteAuthMonitor(h.options).handle(received(jobs[0]!));
  expect(plans(h, id).some((p) => p.stage === 'h6')).toBe(false);
  expect(await outbox(h)).toEqual(queued);
});
