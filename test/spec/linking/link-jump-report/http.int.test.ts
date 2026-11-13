import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { accepted, harness, rejected } from './http-kit.ts';
import { CLIENT_AT, INVALID_ITEMS, NOW, allEvents, common, jump, without } from './vectors.ts';

// createTestDatabase uses the isolated database provisioned by the integration global setup.
const h = harness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-06zo#8] 真实 HTTP optional：游客与本人令牌都 200，身份与 deviceId 从服务端取并整理为约定形状', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const event = jump({ ...attempt, user_id: randomUUID(), device_id: 'forged-device' });
  const before = await h.row(attempt);
  h.clearObserved();
  await accepted(
    await h.post(
      owner,
      { events: [event] },
      { authorization: undefined, 'x-device-id': undefined },
    ),
  );
  expect(await h.row(attempt)).toEqual(before);
  expect(h.prepared()).toHaveLength(1);
  expect(h.prepared()[0]?.batch).toMatchObject({
    appId: owner.appId,
    userId: null,
    deviceId: null,
  });
  expect(h.mutations).toEqual([]);

  h.clearObserved();
  await accepted(await h.post(owner, { events: [event] }));
  expect((await h.row(attempt)).jump_reported_at?.toISOString()).toBe(NOW);
  expect(h.prepared()).toHaveLength(1);
  const batch = h.prepared()[0]!.batch;
  expect(batch).toMatchObject({ appId: owner.appId, userId: owner.uid, deviceId: owner.deviceId });
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]).toMatchObject({
    eventId: event['event_id'],
    eventType: 'link_jump',
    clientAt: CLIENT_AT,
  });
  for (const key of ['event_id', 'name', 'client_at', 'user_id', 'device_id']) {
    expect(batch.events[0]?.props).not.toHaveProperty(key);
  }
  // CT-13g specifies X-Device-Id, even when the access token names another device.
  const headerDevice = randomUUID();
  h.clearObserved();
  await accepted(await h.post(owner, { events: [common()] }, { 'x-device-id': headerDevice }));
  expect(h.prepared()[0]?.batch).toMatchObject({ userId: owner.uid, deviceId: headerDevice });
  h.clearObserved();
  await accepted(await h.post(owner, { events: [common()] }, { 'x-device-id': undefined }));
  expect(h.prepared()[0]?.batch).toMatchObject({ userId: owner.uid, deviceId: null });
});

it.each(['requested', 'unknown'] as const)(
  '[AC-B1-06zo#9] 本人 %s 只写本次尝试，时间取 Clock，open 时间、关闭时间与其他业务证据不变',
  async (result) => {
    const owner = await h.user();
    const attempt = await h.attempt(owner);
    const another = await h.attempt(owner, attempt.link_id);
    const original = await h.row(attempt);
    const untouched = await h.row(another);
    const evidence = await h.evidence(owner.appId);
    h.clearObserved();
    await accepted(await h.post(owner, { events: [jump({ ...attempt, result })] }));
    const row = await h.row(attempt);
    expect(row.jump_reported_at?.toISOString()).toBe(NOW);
    expect(row).toMatchObject({
      attempt_id: original.attempt_id,
      app_id: original.app_id,
      user_id: original.user_id,
      link_id: original.link_id,
      opened_at: original.opened_at,
      created_at: original.created_at,
      dismissed_at: original.dismissed_at,
    });
    expect(await h.row(another)).toEqual(untouched);
    expect(await h.evidence(owner.appId)).toEqual(evidence);
    expect(h.mutations.length).toBeGreaterThan(0);
    for (const mutation of h.mutations) {
      expect(JSON.parse(mutation)).toMatchObject({
        kind: 'UpdateQueryNode',
        table: { kind: 'TableNode', table: { identifier: { name: 'link_open_attempts' } } },
      });
    }
  },
);

it('[AC-B1-06zo#10] failed 不抢首次时间，后续复制口令步骤的 requested 才记；已记后 failed 不改', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const before = await h.row(attempt);
  await accepted(
    await h.post(owner, {
      events: [jump({ ...attempt, result: 'failed', failure_reason: 'step_failed' })],
    }),
  );
  expect(await h.row(attempt)).toEqual(before);
  h.clock.advanceMs(5_000);
  const firstAt = h.clock.now().toISOString();
  await accepted(
    await h.post(owner, {
      events: [jump({ ...attempt, union_platform: 'taobao', step: 'copy_tpwd' })],
    }),
  );
  const written = await h.row(attempt);
  expect(written.jump_reported_at?.toISOString()).toBe(firstAt);
  h.clock.advanceMs(5_000);
  await accepted(
    await h.post(owner, {
      events: [jump({ ...attempt, result: 'failed', failure_reason: 'step_failed' })],
    }),
  );
  expect(await h.row(attempt)).toEqual(written);
});

it('[AC-B1-06zo#11] 无令牌、冒用本人字段、别人的尝试、未知或非法编号、错 link 均只是埋点，dropped_count=0', async () => {
  const owner = await h.user();
  const stranger = await h.user(owner.appId);
  const otherApp = await h.user();
  const attempt = await h.attempt(owner);
  const foreign = await h.attempt(otherApp);
  const differentLink = await h.attempt(owner);
  const original = await h.row(attempt);
  const foreignBefore = await h.row(foreign);
  await accepted(await h.post(stranger, { events: [jump({ ...attempt, user_id: owner.uid })] }));
  await accepted(
    await h.post(
      owner,
      { events: [jump({ ...attempt, user_id: owner.uid })] },
      { authorization: undefined },
    ),
  );
  const analytics = [
    without(jump(attempt), 'attempt_id'),
    jump({ ...attempt, attempt_id: randomUUID() }),
    jump({ ...attempt, attempt_id: 'not-a-uuid' }),
    jump({ ...attempt, attempt_id: '' }),
    jump({ ...attempt, link_id: differentLink.link_id }),
    jump({ ...attempt, link_id: 'not-a-uuid' }),
    jump(foreign),
    {
      ...common('link_jump'),
      phase: 'startup',
      union_platform: 'taobao',
      step: 'sdk',
      result: 'failed',
      failure_reason: 'sdk_init_failed',
      sdk_open_by: 'url',
    },
  ];
  await accepted(await h.post(owner, { events: analytics }));
  expect(await h.row(attempt)).toEqual(original);
  expect(await h.row(foreign)).toEqual(foreignBefore);
  expect((await h.row(differentLink)).jump_reported_at).toBeNull();
});

it('[AC-B1-06zo#12] 认尝试发起人而非 link 分享者；new_link_id 对应的尝试不能拿原 link 上报', async () => {
  const owner = await h.user();
  const sharer = await h.user(owner.appId);
  const shared = await h.attempt(sharer);
  const openedByOwner = await h.attempt(owner, shared.link_id);
  await accepted(await h.post(owner, { events: [jump(openedByOwner)] }));
  expect((await h.row(openedByOwner)).jump_reported_at?.toISOString()).toBe(NOW);
  expect((await h.row(shared)).jump_reported_at).toBeNull();

  const original = await h.attempt(owner);
  const renewed = await h.attempt(owner);
  await accepted(
    await h.post(owner, { events: [jump({ ...renewed, link_id: original.link_id })] }),
  );
  expect((await h.row(renewed)).jump_reported_at).toBeNull();
  await accepted(await h.post(owner, { events: [jump(renewed)] }));
  expect((await h.row(renewed)).jump_reported_at?.toISOString()).toBe(NOW);
  expect((await h.row(original)).jump_reported_at).toBeNull();
});

it('[AC-B1-06zo#13] 同批多步、同 event_id 重发、新 event_id 后续步骤均不改首次时间，也不重复 UPDATE', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const first = jump({ ...attempt, result: 'unknown' });
  await accepted(await h.post(owner, { events: [first, { ...first }, jump(attempt)] }));
  const saved = await h.row(attempt);
  expect(saved.jump_reported_at?.toISOString()).toBe(NOW);
  const tuple = () =>
    h
      .db()
      .selectFrom('link_open_attempts')
      .select([sql<string>`xmin::text`.as('xmin'), sql<string>`ctid::text`.as('ctid')])
      .where('attempt_id', '=', attempt.attempt_id)
      .executeTakeFirstOrThrow();
  const physical = await tuple();
  h.clock.advanceMs(60_000);
  await accepted(await h.post(owner, { events: [first] }));
  await accepted(await h.post(owner, { events: [jump({ ...attempt, step: 'scheme' })] }));
  expect(await h.row(attempt)).toEqual(saved);
  expect(await tuple()).toEqual(physical);
});

it('[AC-B1-06zo#14] 同 link 不同尝试与其他 link 各记各的，迟到旧上报不污染新的尝试', async () => {
  const owner = await h.user();
  const old = await h.attempt(owner);
  const newer = await h.attempt(owner, old.link_id);
  const otherLink = await h.attempt(owner);
  await accepted(await h.post(owner, { events: [jump(newer)] }));
  const newerRow = await h.row(newer);
  expect(newerRow.jump_reported_at?.toISOString()).toBe(NOW);
  expect((await h.row(old)).jump_reported_at).toBeNull();
  h.clock.advanceMs(30_000);
  const otherAt = h.clock.now().toISOString();
  await accepted(await h.post(owner, { events: [jump(otherLink)] }));
  h.clock.advanceMs(30_000);
  const oldAt = h.clock.now().toISOString();
  await accepted(await h.post(owner, { events: [jump(old)] }));
  expect((await h.row(old)).jump_reported_at?.toISOString()).toBe(oldAt);
  expect((await h.row(otherLink)).jump_reported_at?.toISOString()).toBe(otherAt);
  expect(await h.row(newer)).toEqual(newerRow);
});

it('[AC-B1-06zo#15] 并发同尝试报告全部受理，只发生一次逻辑写入，之后重发仍无错误或改时', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const event = jump(attempt);
  const before = await h.row(attempt);
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      h.post(owner, {
        events: [index % 2 === 0 ? event : jump({ ...attempt, result: 'unknown' })],
      }),
    ),
  );
  for (const response of responses) await accepted(response);
  const row = await h.row(attempt);
  expect(row.jump_reported_at?.toISOString()).toBe(NOW);
  // A writer may leave row_version untouched or bump it once, never once per duplicate.
  expect([before.row_version, before.row_version + 1]).toContain(row.row_version);
  h.clock.advanceMs(10_000);
  await accepted(await h.post(owner, { events: [event] }));
  expect(await h.row(attempt)).toEqual(row);
});

it('[AC-B1-06zo#16] 混合批中坏事件准确计数且不阻断前后有效写入；全坏、空批、100 条和重复事件均 200', async () => {
  const owner = await h.user();
  const first = await h.attempt(owner);
  const last = await h.attempt(owner);
  const invalidAttempt = await h.attempt(owner);
  const invalid = [
    ...INVALID_ITEMS,
    without(jump(invalidAttempt), 'session_id'),
    jump({ ...invalidAttempt, union_platform: 'taobao', step: 'sdk' }),
  ];
  await accepted(
    await h.post(owner, { events: [jump(first), ...invalid, jump(last)] }),
    invalid.length,
  );
  expect((await h.row(first)).jump_reported_at?.toISOString()).toBe(NOW);
  expect((await h.row(last)).jump_reported_at?.toISOString()).toBe(NOW);
  expect((await h.row(invalidAttempt)).jump_reported_at).toBeNull();
  await accepted(await h.post(owner, { events: INVALID_ITEMS }), INVALID_ITEMS.length);
  await accepted(await h.post(owner, { events: [] }));
  await accepted(await h.post(owner, { events: Array.from({ length: 100 }, () => common()) }));
  const repeated = jump(first);
  await accepted(await h.post(owner, { events: [repeated, repeated] }));
});

it('[AC-B1-06zo#17] 非对象、无 events、events 非数组、101 条与顶层额外字段整批 20001，合法前缀不写入', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const before = await h.row(attempt);
  const malformed = [
    null,
    [],
    'batch',
    {},
    { events: null },
    { events: {} },
    { events: 'bad' },
    { events: [jump(attempt)], unexpected: true },
    { events: [jump(attempt), ...Array.from({ length: 100 }, () => common())] },
  ];
  for (const body of malformed) {
    await rejected(await h.post(owner, body), 400, 20001);
    expect(await h.row(attempt)).toEqual(before);
  }
});

it('[AC-B1-06zo#18] 最低版本闸门 10405、无效令牌 10002、令牌 app 不符 10403 均先拒绝且不写尝试', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  await h
    .db()
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: owner.appId,
      platform: 'ios',
      channel: 'appstore',
      latest_version: '2.0.0',
      min_supported_version: '2.0.0',
      update_title: 'synthetic',
      update_notes: 'synthetic',
      store_url: 'https://example.test/app',
      default_store: 'appstore',
      store_listings: JSON.stringify([]),
    })
    .execute();
  const before = await h.row(attempt);
  const body = { events: [jump(attempt)] };
  await rejected(await h.post(owner, body, { 'x-app-version': '1.0.0' }), 403, 10405);
  await rejected(await h.post(owner, body, { authorization: 'Bearer invalid' }), 401, 10002);
  await rejected(await h.post(owner, body, { 'x-app-id': 'different-app' }), 403, 10403);
  expect(await h.row(attempt)).toEqual(before);
  await accepted(await h.post(owner, body));
  expect((await h.row(attempt)).jump_reported_at?.toISOString()).toBe(NOW);
});

it('[AC-B1-06zo#19] 其他全部已登记事件收下且不写库，不承诺 saved，也不生成业务事件或修改点击证据', async () => {
  const owner = await h.user();
  const attempt = await h.attempt(owner);
  const before = await h.row(attempt);
  const evidence = await h.evidence(owner.appId);
  h.clearObserved();
  await accepted(
    await h.post(owner, { events: allEvents().filter((event) => event['name'] !== 'link_jump') }),
  );
  expect(await h.evidence(owner.appId)).toEqual(evidence);
  expect(await h.row(attempt)).toEqual(before);
  expect(h.mutations).toEqual([]);
});
