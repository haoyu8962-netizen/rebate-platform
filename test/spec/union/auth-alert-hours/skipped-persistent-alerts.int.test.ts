import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
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
  received,
  renew,
  stored,
  type Harness,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);

async function expectNoHourAlert(h: Harness, id: string, job: ReturnType<typeof received>) {
  const table = await sql<{ present: boolean }>`
    SELECT to_regclass('app.union_auth_alerts') IS NOT NULL AS present
  `.execute(h.db);
  expect(table.rows[0]?.present, 'app.union_auth_alerts 已迁移').toBe(true);
  const readAlerts = () =>
    sql<{ id: string }>`
      SELECT id FROM app.union_auth_alerts
      WHERE app_id = ${h.appId} AND union_account_id = ${id}
      ORDER BY id
    `.execute(h.db);
  const before = (await readAlerts()).rows;
  const sentBefore = h.send.mock.calls.length;

  await h.monitor.handle(job);

  expect((await readAlerts()).rows).toEqual(before);
  const logJobs = h.send.mock.calls.slice(sentBefore).filter(([, name]) => name === 'alert_log');
  expect(logJobs).toEqual([]);
}

it.each([
  {
    scenario: '新授权恰好 24 小时，旧 h24 等于新授权总时长',
    oldDays: 2,
    elapsedHours: 24,
    newDays: 1,
    lead: 24,
  },
  {
    scenario: '重新授权改变到期时刻，旧 h6 已失效',
    oldDays: 1,
    elapsedHours: 1,
    newDays: 2,
    lead: 6,
  },
])(
  '[AC-B1-22zd#23] $scenario，小时任务不写告警也不排日志任务',
  async ({ oldDays, elapsedHours, newDays, lead }) => {
    const h = await harness(db());
    const hours = lead === 24 ? [24, 6, 1] : [6, 1];
    h.settings.set(HOURS_KEY, hours);
    const { id } = await account(h);
    const service = await adminEntry(h);
    const oldExpiry = later(h, oldDays * DAY_MS);
    await renew(h, service, id, oldDays);
    const [oldJob] = expectHourJobs(h, id, oldExpiry, hours);

    h.clock.advanceMs(elapsedHours * HOUR_MS);
    const newExpiry = later(h, newDays * DAY_MS);
    await renew(h, service, id, newDays);
    expect(await stored(h, id)).toMatchObject({
      auth_expires_at: newExpiry,
      auth_renewed_at: h.clock.now(),
    });

    h.clock.set(new Date(oldExpiry.getTime() - lead * HOUR_MS));
    await expectNoHourAlert(h, id, received(oldJob!));
  },
);

it.each(['刷新返回新有效期', '巡检补排'] as const)(
  '[AC-B1-22zd#24] %s后授权总时长恰好 6 小时，旧 h6 到点不写告警也不排日志任务',
  async (source) => {
    const h = await harness(db());
    const refreshed = source === '刷新返回新有效期';
    if (refreshed) h.settings.set('attr.jd.user_key_mode', 'private_position');
    const expiry = later(h, 7 * HOUR_MS);
    const { id } = await account(h, {
      platform: refreshed ? 'jd' : 'taobao',
      auth_renewed_at: h.clock.now(),
      auth_expires_at: expiry,
    });
    await h.monitor.dailyCheck();
    const [h6] = expectHourJobs(h, id, expiry, [6, 1]);

    h.clock.advanceMs(HOUR_MS);
    h.send.mockClear();
    const authorizationPatch = refreshed
      ? { auth_expires_at: later(h, 2 * DAY_MS) }
      : { auth_renewed_at: h.clock.now() };
    await h.db
      .updateTable('union_accounts')
      .set(authorizationPatch)
      .where('app_id', '=', h.appId)
      .where('id', '=', id)
      .execute();
    if (refreshed) {
      h.settings.set('union.auth_probe_cron', '0 12 * * *');
      await createSiteAuthMonitor({
        ...h.options,
        refresher: {
          async refresh(input) {
            return input.unionAccountId === id
              ? { ok: true, expiresAt: expiry }
              : { ok: false, error: 'synthetic-unavailable' };
          },
        },
      }).dailyCheck();
    } else {
      await h.monitor.dailyCheck();
    }
    expect(await stored(h, id)).toMatchObject({
      auth_expires_at: expiry,
      auth_renewed_at: h.clock.now(),
    });
    expectHourJobs(h, id, expiry, [1]);

    await expectNoHourAlert(h, id, received(h6!));
  },
);

it.each(['授权已被联盟判为失效', '更小的 h1 已发出'] as const)(
  '[AC-B1-22zd#25] %s，旧 h6 不写告警也不排日志任务',
  async (scenario) => {
    const h = await harness(db());
    const { id } = await account(h);
    const expiry = later(h, DAY_MS);
    await renew(h, await adminEntry(h), id, 1);
    const [h6, h1] = expectHourJobs(h, id, expiry, [6, 1]);

    if (scenario === '授权已被联盟判为失效') {
      await h.monitor.reportAuthFailure({
        appId: h.appId,
        unionAccountId: id,
        platform: 'taobao',
        error: 'synthetic-auth-invalid',
      });
      expect(await stored(h, id)).toMatchObject({ auth_status: 'expired' });
      h.clock.set(new Date(expiry.getTime() - 6 * HOUR_MS));
    } else {
      h.clock.set(new Date(expiry.getTime() - HOUR_MS));
      await h.monitor.handle(received(h1!));
      expect(await stored(h, id)).toMatchObject({ auth_status: 'expiring' });
    }

    await expectNoHourAlert(h, id, received(h6!));
  },
);
