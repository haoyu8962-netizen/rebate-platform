// CT-13h / D10-1557, D10-1580: task-local AC labels, no additional business rules.
// Exercise the production HTTP assembly, then read PostgreSQL; never call recordEvents here.
// The integration global setup provides the admin database URL; provisioning stays in *.int.test.ts.
import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { accepted, harness } from '../../linking/link-jump-report/http-kit.ts';
import { CLIENT_AT, NOW, common, jump, without } from '../../linking/link-jump-report/vectors.ts';
import { keys, rows } from '../record-events/kit.ts';

const h = harness({ createTestDatabase, acquireTestRedis });
const commonProps = {
  session_id: 'synthetic-session',
  platform: 'ios',
  app_version: '2.0.0',
  page: 'ProductDetail',
};

it.each(['authenticated', 'anonymous'] as const)(
  '[AC-CT-13h#1] %s：HTTP 合规事件落库，身份取令牌与请求头，时间取注入 Clock',
  async (mode) => {
    const owner = await h.user();
    const headerDevice = randomUUID();
    const event = {
      ...common('external_page_nav_host'),
      registered_domain: 'example.test',
      frame: 'main',
      hit: false,
      user_id: randomUUID(),
      device_id: randomUUID(),
      app_id: 'forged-body-app',
      server_at: '2000-01-01T00:00:00.000Z',
    };
    h.clock.advanceMs(12_345);
    await accepted(
      await h.post(
        owner,
        { events: [event] },
        {
          'x-device-id': headerDevice,
          ...(mode === 'anonymous' ? { authorization: undefined } : {}),
        },
      ),
    );
    expect(await rows(h.db(), owner.appId)).toEqual([
      {
        app_id: owner.appId,
        event_id: event.event_id,
        event_type: 'external_page_nav_host',
        name: 'external_page_nav_host',
        props: {
          ...commonProps,
          registered_domain: 'example.test',
          frame: 'main',
          hit: false,
        },
        user_id: mode === 'authenticated' ? owner.uid : null,
        device_id: headerDevice,
        client_at: new Date(CLIENT_AT),
        server_at: h.clock.now(),
      },
    ]);
    expect(await keys(h.db(), owner.appId)).toMatchObject([
      { app_id: owner.appId, event_type: event.name, event_id: event.event_id },
    ]);
  },
);

it('[AC-CT-13h#2] 混合批只存校验通过的事件，坏事件不占去重键，修正后仍可落库', async () => {
  const owner = await h.user();
  const first = common();
  const corrected = common('click');
  const last = common('app_launch');
  const bad = [
    without(corrected, 'session_id'),
    { ...common(), name: 'unregistered_event' },
    { ...common(), client_at: 'not-a-time' },
    jump({ result: 'failed' }),
  ];
  await accepted(await h.post(owner, { events: [first, ...bad, last] }), bad.length);
  expect((await rows(h.db(), owner.appId)).map((row) => row.event_id).sort()).toEqual(
    [first.event_id, last.event_id].sort(),
  );
  expect((await keys(h.db(), owner.appId)).map((row) => row.event_id).sort()).toEqual(
    [first.event_id, last.event_id].sort(),
  );
  await accepted(await h.post(owner, { events: [corrected] }));
  expect((await rows(h.db(), owner.appId)).map((row) => row.event_id).sort()).toEqual(
    [first.event_id, corrected.event_id, last.event_id].sort(),
  );
  expect(await keys(h.db(), owner.appId)).toHaveLength(3);
});

it('[AC-CT-13h#3] 批内重复只落一次且不算 dropped，同 ID 不同类型与同类型不同 ID 都落库', async () => {
  const owner = await h.user();
  const first = common();
  const otherType = { ...first, name: 'click' };
  const otherId = common();
  await accepted(
    await h.post(owner, {
      events: [first, { ...first, page: 'Duplicate' }, otherType, otherId, otherType],
    }),
  );
  const stored = await rows(h.db(), owner.appId);
  expect(stored).toHaveLength(3);
  expect(stored.map((row) => [row.event_type, row.event_id]).sort()).toEqual(
    [first, otherType, otherId].map((event) => [event.name, event.event_id]).sort(),
  );
  expect(stored.map((row) => row.props)).toEqual([commonProps, commonProps, commonProps]);
  expect(
    (await keys(h.db(), owner.appId)).map((row) => [row.event_type, row.event_id]).sort(),
  ).toEqual(stored.map((row) => [row.event_type, row.event_id]).sort());
});

it('[AC-CT-13h#4] 跨请求跨日重发不改原事件；混合新旧事件仍成功，重复不计 dropped', async () => {
  const owner = await h.user();
  const first = common();
  await accepted(await h.post(owner, { events: [first] }));
  const original = await rows(h.db(), owner.appId);
  // Keep the missing-wire failure an assertion, even before the replay comparison.
  expect(original).toHaveLength(1);
  const originalKeys = await keys(h.db(), owner.appId);
  h.clock.advanceMs(86_400_000);
  const replay = { ...first, page: 'Changed', client_at: '2026-11-15T01:00:00.000Z' };
  const fresh = common('click');
  const headerDevice = randomUUID();
  await accepted(
    await h.post(
      owner,
      { events: [replay, fresh] },
      {
        authorization: undefined,
        'x-device-id': headerDevice,
      },
    ),
  );
  const stored = await rows(h.db(), owner.appId);
  expect(stored).toHaveLength(2);
  expect(stored.filter((row) => row.event_id === first.event_id)).toEqual(original);
  expect(stored.find((row) => row.event_id === fresh.event_id)).toMatchObject({
    user_id: null,
    device_id: headerDevice,
    server_at: h.clock.now(),
  });
  const dedup = await keys(h.db(), owner.appId);
  expect(dedup).toHaveLength(2);
  expect(dedup.filter((row) => row.event_id === first.event_id)).toEqual(originalKeys);
});

it('[AC-CT-13h#5] 并发 HTTP 重发同一事件均按契约成功，事件与去重记录各一行', async () => {
  const owner = await h.user();
  const event = common();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => h.post(owner, { events: [event] })),
  );
  for (const response of responses) await accepted(response);
  expect(await rows(h.db(), owner.appId)).toMatchObject([
    { event_id: event.event_id, event_type: event.name, props: commonProps },
  ]);
  expect(await keys(h.db(), owner.appId)).toMatchObject([
    { event_id: event.event_id, event_type: event.name },
  ]);
});

it.each(['requested', 'unknown'] as const)(
  '[AC-CT-13h#6] link_jump %s 同时落埋点与原尝试首次时间，重发不改两者',
  async (result) => {
    const owner = await h.user();
    const attempt = await h.attempt(owner);
    const untouched = await h.attempt(owner, attempt.link_id);
    const untouchedBefore = await h.row(untouched);
    const event = jump({ ...attempt, result });
    await accepted(await h.post(owner, { events: [event] }));
    const stored = await rows(h.db(), owner.appId);
    expect(stored).toEqual([
      {
        app_id: owner.appId,
        event_id: event.event_id,
        event_type: 'link_jump',
        name: 'link_jump',
        user_id: owner.uid,
        device_id: owner.deviceId,
        client_at: new Date(CLIENT_AT),
        server_at: new Date(NOW),
        props: {
          ...commonProps,
          ...attempt,
          phase: 'purchase',
          union_platform: 'jd',
          step: 'h5',
          result,
          duration_ms: 120,
          installed: 'unknown',
        },
      },
    ]);
    const reported = await h.row(attempt);
    expect(reported.jump_reported_at).toEqual(new Date(NOW));
    expect(await h.row(untouched)).toEqual(untouchedBefore);
    h.clock.advanceMs(5_000);
    await accepted(await h.post(owner, { events: [event] }));
    expect(await rows(h.db(), owner.appId)).toEqual(stored);
    expect(await keys(h.db(), owner.appId)).toHaveLength(1);
    expect(await h.row(attempt)).toEqual(reported);
  },
);

it('[AC-CT-13h#7] 不参与尝试标记的合规 link_jump 仍落库：失败、匿名和缺 attempt_id', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const before = await h.row(attempt);
  const failed = jump({ ...attempt, result: 'failed', failure_reason: 'step_failed' });
  const anonymous = jump(attempt);
  const missingAttempt = without(jump(attempt), 'attempt_id');
  await accepted(await h.post(owner, { events: [failed, missingAttempt] }));
  await accepted(await h.post(owner, { events: [anonymous] }, { authorization: undefined }));
  const stored = await rows(h.db(), owner.appId);
  expect(stored.map((row) => row.event_id).sort()).toEqual(
    [failed.event_id, anonymous.event_id, missingAttempt['event_id']].sort(),
  );
  expect(stored.find((row) => row.event_id === anonymous.event_id)).toMatchObject({
    user_id: null,
    device_id: owner.deviceId,
  });
  expect(await keys(h.db(), owner.appId)).toHaveLength(3);
  expect(await h.row(attempt)).toEqual(before);
});
