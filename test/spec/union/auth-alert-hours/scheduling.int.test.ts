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
  plans,
  received,
  renew,
  stored,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);

it('[AC-B1-22zd#2] 回调成功和手工换凭据都按各自到期时刻排默认 6、1 小时的单例任务', async () => {
  const h = await harness(db());
  h.settings.set('attr.jd.user_key_mode', 'private_position');
  const service = await adminEntry(h);
  const taobao = await account(h);
  const jd = await account(h, { platform: 'jd' });
  const taobaoExpiry = later(h, DAY_MS);
  const jdExpiry = later(h, DAY_MS);
  await renew(h, service, taobao.id, 1);
  const entered = await service.putCredential(h.actor, jd.id, {
    credential: 'synthetic-jd-key',
    expires_at: jdExpiry.toISOString(),
  });

  expect((await stored(h, taobao.id)).auth_expires_at).toEqual(taobaoExpiry);
  expect(entered).toMatchObject({
    auth_expires_at: jdExpiry.toISOString(),
    auth_status: 'active',
  });
  expectHourJobs(h, taobao.id, taobaoExpiry, [6, 1]);
  expectHourJobs(h, jd.id, jdExpiry, [6, 1]);
});

it.each([0, 721, 1.5, '6'])(
  '[AC-B1-22zd#2] 配置含非法值 %s 时整组回退到默认值',
  async (invalid) => {
    const h = await harness(db());
    h.settings.set(HOURS_KEY, [3, invalid]);
    const id = (await account(h)).id;
    await renew(h, await adminEntry(h), id, 1);
    expectHourJobs(h, id, later(h, DAY_MS), [6, 1]);
  },
);

it('[AC-B1-22zd#2] 自定义 [3] 只排 3 小时节点，重复值合并且 720 小时可用，空数组关闭', async () => {
  const h = await harness(db());
  const service = await adminEntry(h);
  const custom = await account(h);
  const duplicates = await account(h);
  const disabled = await account(h);
  h.settings.set(HOURS_KEY, [3]);
  await renew(h, service, custom.id, 1);
  h.settings.set(HOURS_KEY, [1, 720, 1]);
  await renew(h, service, duplicates.id, 31);
  h.settings.set(HOURS_KEY, []);
  await renew(h, service, disabled.id, 1);

  expectHourJobs(h, disabled.id, later(h, DAY_MS), []);
  expectHourJobs(h, custom.id, later(h, DAY_MS), [3]);
  expectHourJobs(h, duplicates.id, later(h, 31 * DAY_MS), [720]);
});

it('[AC-B1-22zd#2] 手工录入的小时节点严格小于授权总时长，恰好 1 小时不排任何节点', async () => {
  const h = await harness(db());
  h.settings.set('attr.jd.user_key_mode', 'private_position');
  const service = await adminEntry(h);
  const exactly = await account(h, { platform: 'jd' });
  const longer = await account(h, { platform: 'jd' });
  const oneHour = later(h, HOUR_MS);
  const overOneHour = later(h, HOUR_MS + 60_000);
  await service.putCredential(h.actor, exactly.id, {
    credential: 'synthetic-exact-hour',
    expires_at: oneHour.toISOString(),
  });
  await service.putCredential(h.actor, longer.id, {
    credential: 'synthetic-over-hour',
    expires_at: overOneHour.toISOString(),
  });

  expectHourJobs(h, exactly.id, oneHour, []);
  expectHourJobs(h, longer.id, overOneHour, [1]);
});

it('[AC-B1-22zd#2] 已有刷新端口成功返回新到期时刻后，小时节点按新授权重排', async () => {
  const h = await harness(db());
  h.settings.set('attr.jd.user_key_mode', 'private_position');
  const oldExpiry = later(h, 2 * DAY_MS);
  const expiry = later(h, 90 * DAY_MS);
  const row = await account(h, {
    platform: 'jd',
    auth_renewed_at: later(h, -60 * DAY_MS),
    auth_expires_at: oldExpiry,
  });
  const monitor = createSiteAuthMonitor({
    ...h.options,
    refresher: {
      async refresh(input) {
        return input.unionAccountId === row.id
          ? { ok: true, expiresAt: expiry }
          : { ok: false, error: 'synthetic-unavailable' };
      },
    },
  });
  await monitor.dailyCheck();

  expect(await stored(h, row.id)).toMatchObject({
    auth_expires_at: expiry,
    auth_renewed_at: h.clock.now(),
  });
  expectHourJobs(h, row.id, expiry, []);

  h.send.mockClear();
  h.clock.set(new Date(expiry.getTime() - DAY_MS));
  await h.monitor.dailyCheck();
  expectHourJobs(h, row.id, expiry, [6, 1]);
});

it('[AC-B1-22zd#2] 超过 30 天未排的小时节点在进入窗口后由每日巡检按到点时刻补排', async () => {
  const h = await harness(db(), '2026-11-23T01:00:00.000Z');
  h.settings.set(HOURS_KEY, [1]);
  const id = (await account(h)).id;
  const expiry = later(h, 31 * DAY_MS);
  await renew(h, await adminEntry(h), id, 31);
  expectHourJobs(h, id, expiry, []);

  // 巡检时距到期还有 24 小时，h1 在 23 小时后，早于下一次巡检。
  h.send.mockClear();
  h.clock.set(later(h, 30 * DAY_MS));
  await h.monitor.dailyCheck();
  expectHourJobs(h, id, expiry, [1]);
});

it('[AC-B1-22zd#5] 巡检只补排下次巡检前的小时节点，处理后已发的 d1 阶段保持不变', async () => {
  const h = await harness(db(), '2026-11-23T01:00:00.000Z');
  const expiry = later(h, 28 * HOUR_MS);
  const row = await account(h, {
    auth_renewed_at: later(h, -2 * DAY_MS),
    auth_expires_at: expiry,
    auth_status: 'expiring',
    alert_stage: 'd1',
  });
  // h6 在 22 小时后，h1 在 27 小时后。下一次 09:00 巡检在 24 小时后。
  await h.monitor.dailyCheck();
  const jobs = expectHourJobs(h, row.id, expiry, [6]);
  h.clock.set(new Date(expiry.getTime() - 6 * HOUR_MS));
  await h.monitor.handle(received(jobs[0]!));
  expect(plans(h, row.id)).toMatchObject([{ code: 'UNION_AUTH_EXPIRING', stage: 'h6' }]);
  expect(await stored(h, row.id)).toMatchObject({ auth_status: 'expiring', alert_stage: 'd1' });
});
