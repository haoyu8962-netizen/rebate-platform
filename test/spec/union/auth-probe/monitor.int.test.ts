import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { sql } from 'kysely';
import { createSiteAuthMonitor } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { account, EXPIRES, harness, jobs, logs, NOW, PHONES, plans, stored } from './kit.ts';

const database = databaseFixture(createTestDatabase);

async function activeBinding(h: ReturnType<typeof harness>, unionAccountId: string) {
  const userId = randomUUID();
  await h.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: h.appId,
      nickname: '合成用户',
      avatar: 'https://example.test/avatar',
      invite_code: 'probe001',
      attr_code: 'probe001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
  await h.db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      user_id: userId,
      platform: 'taobao',
      union_account_id: unionAccountId,
      relation_id: `synthetic-${userId}`,
      status: 'active',
      bound_at: h.clock.now(),
      row_version: 7,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
  return () =>
    h.db
      .selectFrom('union_bindings')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('union_account_id', '=', unionAccountId)
      .orderBy('id')
      .execute();
}

it('[AC-S1-64#15] 改节点不倒退已发阶段，提前续期后按新到期时间重新提醒', async () => {
  const h = harness(database());
  const a = await account(h, { alert_stage: 'd7', auth_status: 'expiring' });
  h.settings.set('union.auth_alert_days', [30, 14, 7, 1]);
  await h.monitor.dailyCheck();
  expect((await stored(h, a.id)).alert_stage).toBe('d7');
  expect(plans(h)).toEqual([]);
  // Reauthorization is B1-22c: represent its committed result, do not implement its flow here.
  await h.db
    .updateTable('union_accounts')
    .set({
      auth_expires_at: '2027-01-30T00:00:00+08:00',
      auth_status: 'active',
      alert_stage: 'none',
      auth_renewed_at: h.clock.now(),
    })
    .where('app_id', '=', h.appId)
    .where('id', '=', a.id)
    .execute();
  h.settings.delete('union.auth_alert_days');
  h.clock.set('2027-01-16T01:00:00Z');
  await h.monitor.dailyCheck();
  expect(plans(h).map((p) => [p.stage, p.authExpiresAt])).toEqual([
    ['d14', new Date('2027-01-29T16:00:00.000Z')],
  ]);
});

for (const status of ['expiring', 'expired']) {
  it(`[AC-S1-64#16] 非授权错误保留原有 ${status} 状态和阶段，不误恢复`, async () => {
    const h = harness(database());
    const stage = status === 'expired' ? 'expired' : 'd14';
    const a = await account(h, { auth_status: status, alert_stage: stage });
    h.probe.mockResolvedValue({ kind: 'transient', error: 'timeout' });
    await h.monitor.dailyCheck();
    h.clock.advanceMs(1_800_000);
    await h.monitor.probeRetry(h.appId, a.id);
    expect(await stored(h, a.id)).toMatchObject({ auth_status: status, alert_stage: stage });
    expect(plans(h)).toEqual([]);
  });
}

it('[AC-S1-64#17] deliverAlerts 取当前整组号码并规范化 HMAC，不把密文或原始号码记日志', async () => {
  const h = harness(database());
  const a = await account(h);
  await h.monitor.deliverAlerts(h.appId, a.id);
  expect(h.deliver).toHaveBeenCalledWith(
    h.appId,
    a.id,
    PHONES.map((phone) => ({
      phone,
      phoneId: h.crypto.blindIndex(phone, 'union.auth_alert_phones'),
    })),
  );
  for (const phone of PHONES) expect(h.lines.join('')).not.toContain(phone);
});

it('[AC-S1-64#1] 08:59 属前一巡检日；09:00 命中 d14，随后 d7、d1、到期各提醒一次', async () => {
  const h = harness(database(), '2026-12-16T00:59:00.000Z');
  const a = await account(h);
  await h.monitor.dailyCheck();
  expect(plans(h)).toEqual([]);
  expect((await stored(h, a.id)).auth_status).toBe('active');
  for (const [time, stage, status] of [
    [NOW, 'd14', 'expiring'],
    ['2026-12-23T01:00:00.000Z', 'd7', 'expiring'],
    ['2026-12-29T01:00:00.000Z', 'd1', 'expiring'],
    [EXPIRES, 'expired', 'expired'],
  ] as const) {
    h.clock.set(time);
    await h.monitor.dailyCheck();
    await h.monitor.dailyCheck();
    expect(await stored(h, a.id)).toMatchObject({ alert_stage: stage, auth_status: status });
  }
  expect(plans(h).map((p) => [p.stage, p.code, p.phoneIds.length])).toEqual([
    ['d14', 'UNION_AUTH_EXPIRING', 2],
    ['d7', 'UNION_AUTH_EXPIRING', 2],
    ['d1', 'UNION_AUTH_EXPIRING', 2],
    ['expired', 'UNION_AUTH_EXPIRED', 2],
  ]);
  for (const [queue, name, payload] of jobs(h, a.id).filter(([, n]) => n === 'alert_log')) {
    await h.monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
  }
  expect(logs(h, 'union_auth_expiring')).toHaveLength(3);
  expect(logs(h, 'union_auth_expired')).toEqual([
    expect.objectContaining({
      level: 50,
      platform: 'taobao',
      union_account_id: a.id,
      stage: 'expired',
      auth_expires_at: EXPIRES,
      phones_configured: true,
      cause: 'time',
    }),
  ]);
});

for (const [days, at, stage] of [
  [[30, 7, 30, 1], '2026-12-01T01:00:00Z', 'd30'],
  [[30, 7, 1], '2026-12-25T01:00:00Z', 'd7'],
  [[999, 1], '2026-12-16T01:00:00Z', 'd999'],
  [[14, 7, 1], '2026-12-29T01:00:00Z', 'd1'],
] as const) {
  it(`[AC-S1-64#2] 自定义节点 ${JSON.stringify(days)}，跳过节点只登记 ${stage}`, async () => {
    const h = harness(database(), at);
    h.settings.set('union.auth_alert_days', [...days]);
    const a = await account(h);
    await h.monitor.dailyCheck();
    await h.monitor.dailyCheck();
    expect(plans(h).map((p) => p.stage)).toEqual([stage]);
    expect((await stored(h, a.id)).alert_stage).toBe(stage);
  });
}

for (const invalid of [null, [], [0], [1000], [-1], [1.5], ['7'], '14,7,1', [14, 0]]) {
  it(`[AC-S1-64#3] 不合法节点 ${JSON.stringify(invalid)} 用默认 14/7/1`, async () => {
    const h = harness(database());
    h.settings.set('union.auth_alert_days', invalid);
    await account(h);
    await h.monitor.dailyCheck();
    expect(plans(h).map((p) => p.stage)).toEqual(['d14']);
  });
}

it('[AC-S1-64#4] 自定义 10:15 巡检以前属前日，跨闰日按 +08 日历差计算', async () => {
  const h = harness(database(), '2028-02-29T02:14:59.999Z');
  h.settings.set('union.auth_probe_cron', '15 10 * * *');
  h.settings.set('union.auth_alert_days', [1]);
  await account(h, { auth_expires_at: '2028-02-29T16:00:00Z' });
  await h.monitor.dailyCheck();
  expect(plans(h)).toEqual([]);
  h.clock.advanceMs(1);
  await h.monitor.dailyCheck();
  expect(plans(h).map((p) => p.stage)).toEqual(['d1']);
});

for (const cron of [null, '*/5 * * * *', '0 24 * * *', '60 9 * * *', '0 9 * * 1']) {
  it(`[AC-S1-64#5] 巡检配置 ${String(cron)} 回退 09:00 且同实例只警告一次`, async () => {
    const h = harness(database(), '2026-12-16T00:59:59.999Z');
    h.settings.set('union.auth_probe_cron', cron);
    await account(h);
    await h.monitor.dailyCheck();
    expect(plans(h)).toEqual([]);
    h.clock.advanceMs(1);
    await h.monitor.dailyCheck();
    await h.monitor.dailyCheck();
    expect(plans(h).map((p) => p.stage)).toEqual(['d14']);
    const warnings = h.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.level === 40 && JSON.stringify(line).includes('auth_probe_cron'));
    expect(warnings).toHaveLength(1);
  });
}

it('[AC-S1-64#6] 每个平台每账号每次一次探测，成功清除旧错误，全部 app 都巡检', async () => {
  const h = harness(database());
  const otherApp = `auth-probe-${randomUUID()}`;
  const rows = [];
  for (const appId of [h.appId, otherApp]) {
    for (const platform of ['taobao', 'jd', 'pdd'] as const) {
      rows.push(
        await account(h, {
          app_id: appId,
          platform,
          auth_expires_at: null,
          last_probe_ok: false,
          last_probe_error: 'old-timeout',
        }),
      );
    }
  }
  h.probe.mockResolvedValue({ kind: 'ok' });
  await h.monitor.dailyCheck();
  for (const row of rows) {
    expect(h.probe.mock.calls.filter(([a]) => a.unionAccountId === row.id)).toEqual([
      [
        {
          appId: row.app_id,
          platform: row.platform,
          unionAccountId: row.id,
        },
      ],
    ]);
    expect(await stored({ ...h, appId: row.app_id }, row.id)).toMatchObject({
      last_probe_at: h.clock.now(),
      last_probe_ok: true,
      last_probe_error: null,
    });
  }
});

it('[AC-S1-64#7] unsupported 不写探测字段，仍按到期日提醒', async () => {
  const h = harness(database());
  const old = new Date('2026-12-15T01:00:00Z');
  const a = await account(h, { last_probe_at: old, last_probe_ok: false, last_probe_error: 'old' });
  h.probe.mockResolvedValue({ kind: 'unsupported' });
  await h.monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({
    last_probe_at: old,
    last_probe_ok: false,
    last_probe_error: 'old',
    alert_stage: 'd14',
  });
  expect(plans(h).map((p) => p.stage)).toEqual(['d14']);
});

for (const error of ['timeout', 'rate-limit']) {
  it(`[AC-S1-64#8] ${error} 30 分钟后重试一次，仍失败只后台告警，不改状态或短信`, async () => {
    const h = harness(database());
    const a = await account(h, {
      auth_status: 'active',
      auth_expires_at: '2027-01-30T00:00:00+08:00',
    });
    h.probe.mockResolvedValue({ kind: 'transient', error });
    await h.monitor.dailyCheck();
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: 'active',
      alert_stage: 'none',
      last_probe_at: h.clock.now(),
      last_probe_ok: false,
      last_probe_error: error,
    });
    expect(plans(h)).toEqual([]);
    const retries = jobs(h, a.id).filter(([, , , o]) => o.delaySeconds === 1800);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.[0]).toBe('union-auth');
    expect(retries[0]?.[3].singletonKey).toEqual(expect.any(String));
    h.clock.advanceMs(1_800_000);
    const before = jobs(h, a.id).length;
    await h.monitor.probeRetry(h.appId, a.id);
    expect(jobs(h, a.id)).toHaveLength(before);
    expect(plans(h)).toEqual([]);
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: 'active',
      last_probe_at: h.clock.now(),
      last_probe_ok: false,
      last_probe_error: error,
    });
    expect(logs(h, 'union_auth_probe_failed')).toEqual([
      expect.objectContaining({
        level: 40,
        union_account_id: a.id,
        platform: 'taobao',
      }),
    ]);
  });
}

for (const outcome of ['ok', 'auth_invalid'] as const) {
  it(`[AC-S1-64#9] 非授权类失败的重试返回 ${outcome} 按结果更新并不再排重试`, async () => {
    const h = harness(database());
    const a = await account(h, { auth_expires_at: '2027-02-01T00:00:00Z' });
    h.probe.mockResolvedValue({ kind: 'transient', error: 'timeout' });
    await h.monitor.dailyCheck();
    h.clock.advanceMs(1_800_000);
    h.probe.mockResolvedValue(
      outcome === 'ok' ? { kind: 'ok' } : { kind: 'auth_invalid', error: 'invalid' },
    );
    await h.monitor.probeRetry(h.appId, a.id);
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: outcome === 'ok' ? 'active' : 'expired',
      last_probe_ok: outcome === 'ok',
      last_probe_error: outcome === 'ok' ? null : 'invalid',
    });
    expect(jobs(h, a.id).filter(([, , , o]) => o.delaySeconds === 1800)).toHaveLength(1);
    expect(plans(h).map((p) => p.stage)).toEqual(outcome === 'ok' ? [] : ['expired']);
  });
}

for (const expiresAt of ['2027-02-01T00:00:00Z', null]) {
  it(`[AC-S1-65#1] 探测授权失效立即 expired，空到期时间也只靠探测（${expiresAt}）`, async () => {
    const h = harness(database());
    const a = await account(h, { auth_expires_at: expiresAt });
    const bindings = await activeBinding(h, a.id);
    const before = await bindings();
    h.probe.mockResolvedValue({ kind: 'auth_invalid', error: 'classified-invalid' });
    await h.monitor.dailyCheck();
    await h.monitor.dailyCheck();
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: 'expired',
      alert_stage: 'expired',
      last_probe_at: h.clock.now(),
      last_probe_ok: false,
      last_probe_error: 'classified-invalid',
    });
    expect(plans(h).map((p) => p.code)).toEqual(['UNION_AUTH_EXPIRED']);
    for (const [queue, name, payload] of jobs(h, a.id).filter(([, n]) => n === 'alert_log')) {
      await h.monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
    }
    expect(logs(h, 'union_auth_expired')).toEqual([expect.objectContaining({ cause: 'probe' })]);
    expect(await bindings()).toEqual(before);
  });
}

it('[AC-S1-65#2] 任一联盟调用失效立即置位，不写 last_probe，账号/app 隔离且不重发', async () => {
  const h = harness(database());
  const a = await account(h);
  const other = await account(h, { platform: 'jd' });
  const bindings = await activeBinding(h, a.id);
  const before = await bindings();
  const failure = {
    appId: h.appId,
    platform: 'taobao' as const,
    unionAccountId: a.id,
    error: 'invalid',
  };
  await h.monitor.reportAuthFailure({ ...failure, appId: 'other-tenant' });
  await h.monitor.reportAuthFailure({ ...failure, platform: 'pdd' });
  expect(await stored(h, a.id)).toEqual(a);
  await h.monitor.reportAuthFailure(failure);
  await h.monitor.reportAuthFailure(failure);
  expect(await stored(h, a.id)).toMatchObject({
    auth_status: 'expired',
    alert_stage: 'expired',
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
  });
  expect(await stored(h, other.id)).toEqual(other);
  expect(plans(h)).toHaveLength(1);
  for (const [queue, name, payload] of jobs(h, a.id).filter(([, n]) => n === 'alert_log')) {
    await h.monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
  }
  expect(logs(h, 'union_auth_expired')).toEqual([expect.objectContaining({ cause: 'call' })]);
  expect(h.probe).not.toHaveBeenCalled();
  expect(await bindings()).toEqual(before);
});

for (const [expiry, status, stage] of [
  [null, 'active', 'none'],
  ['2027-03-01T00:00:00Z', 'active', 'none'],
  [EXPIRES, 'expiring', 'd14'],
  ['2026-12-20T00:00:00Z', 'expiring', 'd7'],
  ['2026-12-17T00:00:00Z', 'expiring', 'd1'],
] as const) {
  it(`[AC-S1-65#3] 到期时间 ${expiry} 未到期误判失效探测成功恢复 ${status}/${stage}，不补发已过节点`, async () => {
    const h = harness(database());
    const a = await account(h, {
      auth_status: 'expired',
      alert_stage: 'expired',
      auth_expires_at: expiry,
    });
    await h.monitor.dailyCheck();
    await h.monitor.dailyCheck();
    expect(await stored(h, a.id)).toMatchObject({ auth_status: status, alert_stage: stage });
    expect(plans(h)).toEqual([]);
  });
}

it('[AC-S1-65#4] 已到期即 expired，不探测也不刷新，即使端口预设超时', async () => {
  const h = harness(database(), EXPIRES);
  const a = await account(h);
  const bindings = await activeBinding(h, a.id);
  const before = await bindings();
  h.probe.mockResolvedValue({ kind: 'transient', error: 'timeout' });
  const monitor = createSiteAuthMonitor({ ...h.options, refresher: { refresh: h.refresh } });
  await monitor.dailyCheck();
  await monitor.probeRetry(h.appId, a.id);
  expect(h.probe.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toEqual([]);
  expect(h.refresh.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toEqual([]);
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  expect(plans(h).map((p) => p.stage)).toEqual(['expired']);
  expect(await bindings()).toEqual(before);
});

it('[AC-S1-64#10] 当天巡检后到期，任务延迟到精确时刻，重复执行只登记一次', async () => {
  const h = harness(database());
  const expiry = '2026-12-16T02:00:00.000Z';
  const a = await account(h, { auth_expires_at: expiry });
  const bindings = await activeBinding(h, a.id);
  const before = await bindings();
  await h.monitor.dailyCheck();
  const due = jobs(h, a.id).filter(([, , , o]) => o.delaySeconds === 3600);
  expect(due).toHaveLength(1);
  expect(due[0]?.[3].singletonKey).toContain(a.id);
  expect(JSON.stringify(due[0]?.slice(0, 3))).toContain(expiry);
  await h.monitor.expiryDue(h.appId, a.id, expiry);
  expect((await stored(h, a.id)).auth_status).toBe('expiring');
  h.clock.set(expiry);
  await h.monitor.expiryDue(h.appId, a.id, expiry);
  await h.monitor.expiryDue(h.appId, a.id, expiry);
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
  expect(plans(h).filter((p) => p.code === 'UNION_AUTH_EXPIRED')).toHaveLength(1);
  expect(await bindings()).toEqual(before);
});

it('[AC-S1-64#11] 旧到期任务在重新授权后失效，跨 app 任务不能动账号', async () => {
  const h = harness(database(), EXPIRES);
  const a = await account(h, { auth_expires_at: '2027-03-30T00:00:00Z' });
  await h.monitor.expiryDue(h.appId, a.id, EXPIRES);
  await h.monitor.expiryDue('other-app', a.id, '2027-03-30T00:00:00.000Z');
  expect(await stored(h, a.id)).toEqual(a);
  expect(plans(h)).toEqual([]);
});

for (const [expiresAt, estimated] of [
  ['2027-04-01T00:00:00.000Z', false],
  [null, true],
] as const) {
  it(`[AC-S1-64#12] ≤7 天先刷新，成功重算且系统续期，估算=${estimated}`, async () => {
    const h = harness(database(), '2026-12-23T01:00:00.000Z');
    const a = await account(h, { auth_status: 'expiring', alert_stage: 'd14' });
    h.refresh.mockResolvedValue({
      ok: true,
      expiresAt: expiresAt === null ? null : new Date(expiresAt),
    });
    const monitor = createSiteAuthMonitor({ ...h.options, refresher: { refresh: h.refresh } });
    await monitor.dailyCheck();
    expect(h.refresh.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toHaveLength(1);
    expect(await stored(h, a.id)).toMatchObject({
      auth_status: 'active',
      alert_stage: 'none',
      auth_expires_at: new Date(expiresAt ?? '2027-03-23T01:00:00.000Z'),
      auth_renewed_at: h.clock.now(),
      auth_renewed_by: null,
    });
    const extension = await sql<{ auth_expires_estimated: boolean }>`select auth_expires_estimated
      from app.union_accounts where app_id = ${h.appId} and id = ${a.id}`.execute(h.db);
    expect(extension.rows[0]?.auth_expires_estimated).toBe(estimated);
    expect(plans(h)).toEqual([]);
  });
}

it('[AC-S1-64#13] 刷新失败仍 d7 提醒；大于7天以及无 refresher 都不调用刷新', async () => {
  const h = harness(database(), '2026-12-22T01:00:00.000Z');
  const a = await account(h, { alert_stage: 'd14', auth_status: 'expiring' });
  const monitor = createSiteAuthMonitor({ ...h.options, refresher: { refresh: h.refresh } });
  await monitor.dailyCheck();
  expect(h.refresh.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toEqual([]);
  h.clock.set('2026-12-23T01:00:00Z');
  await monitor.dailyCheck();
  expect(plans(h).map((p) => p.stage)).toEqual(['d7']);
  expect((await stored(h, a.id)).auth_expires_at).toEqual(new Date(EXPIRES));
  await h.monitor.dailyCheck();
  expect(h.refresh.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toHaveLength(1);
});

it('[AC-S1-64#14] 未配置号码只后台告警且阶段前移，后来配号不补发该节点', async () => {
  const h = harness(database());
  h.settings.delete('union.auth_alert_phones');
  const a = await account(h);
  await h.monitor.dailyCheck();
  expect(await stored(h, a.id)).toMatchObject({ alert_stage: 'd14', auth_status: 'expiring' });
  expect(plans(h)).toEqual([]);
  for (const [queue, name, payload] of jobs(h, a.id).filter(([, n]) => n === 'alert_log')) {
    await h.monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
  }
  expect(logs(h, 'union_auth_alert_phones_missing')).toHaveLength(1);
  expect(logs(h, 'union_auth_expiring')).toEqual([
    expect.objectContaining({
      level: 40,
      phones_configured: false,
      stage: 'd14',
      union_account_id: a.id,
    }),
  ]);
  h.settings.set('union.auth_alert_phones', {
    cipher: h.crypto.encrypt(JSON.stringify(PHONES), 'union.auth_alert_phones'),
  });
  await h.monitor.dailyCheck();
  expect(plans(h)).toEqual([]);
});
