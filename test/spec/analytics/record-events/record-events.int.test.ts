// CT-13g §9 / D10-1488; local AC labels identify this task's assertions, not additional BRs.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordEvents } from '../../../../apps/api/src/modules/analytics/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  batch,
  CLIENT_AT,
  close,
  event,
  keys,
  open,
  rows,
  SERVER_AT,
  TIMEOUT,
  user,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-CT-13g#1] 空批返回两个零，不写任何行', async () => {
  const input = batch([]);
  expect(await recordEvents(h.db, input)).toEqual({ accepted: 0, duplicates: 0 });
  expect(await rows(h.db, input.appId)).toEqual([]);
  expect(await keys(h.db, input.appId)).toEqual([]);
});

it('[AC-CT-13g#2] 批内按类型和 ID 去重；相同 ID 不同类型、相同类型不同 ID 都接受，首条内容保留', async () => {
  const first = event({ props: { winner: true } });
  const second = event({ eventId: first.eventId, eventType: 'click' });
  const third = event();
  const input = batch([first, { ...first, props: { winner: false } }, second, third, second]);
  expect(await recordEvents(h.db, input)).toEqual({ accepted: 3, duplicates: 2 });
  const stored = await rows(h.other, input.appId);
  expect(stored).toHaveLength(3);
  expect(stored.map((row) => [row.event_type, row.event_id]).sort()).toEqual(
    [first, second, third].map((item) => [item.eventType, item.eventId]).sort(),
  );
  expect(
    stored.find((row) => row.event_id === first.eventId && row.event_type === first.eventType)
      ?.props,
  ).toEqual({ winner: true });
  expect(
    (await keys(h.other, input.appId)).map((row) => [row.event_type, row.event_id]).sort(),
  ).toEqual(stored.map((row) => [row.event_type, row.event_id]).sort());
});

it('[AC-CT-13g#3] 跨批跨日重试不改原行，混合新旧批次分别计数', async () => {
  const first = event();
  const input = batch([first]);
  expect(await recordEvents(h.db, input)).toEqual({ accepted: 1, duplicates: 0 });
  const original = await rows(h.db, input.appId);
  const originalKeys = await keys(h.db, input.appId);
  const replay = {
    ...input,
    clock: new FixedClock('2032-06-17T00:00:00.000Z'),
    deviceId: randomUUID(),
    events: [{ ...first, props: { changed: true }, clientAt: SERVER_AT }],
  };
  expect(await recordEvents(h.other, replay)).toEqual({ accepted: 0, duplicates: 1 });
  expect(await rows(h.db, input.appId)).toEqual(original);
  expect(await keys(h.db, input.appId)).toEqual(originalKeys);
  expect(await recordEvents(h.other, { ...input, events: [first, event(), first] })).toEqual({
    accepted: 1,
    duplicates: 2,
  });
  expect(await rows(h.db, input.appId)).toHaveLength(2);
  expect(await keys(h.db, input.appId)).toHaveLength(2);
});

it('[AC-CT-13g#5] 存储所有字段且 server_at 取每次调用注入的 Clock，身份只取服务端参数', async () => {
  const item = event({
    props: {
      user_id: randomUUID(),
      device_id: randomUUID(),
      app_id: 'untrusted',
      server_at: '2000-01-01T00:00:00.000Z',
      nested: { values: [1, true, null, '中文'] },
    },
  });
  const input = batch([item]);
  const userId = await user(h.db, input.appId);
  const deviceId = randomUUID();
  const clock = new FixedClock(SERVER_AT);
  expect(await recordEvents(h.db, { ...input, userId, deviceId, clock })).toEqual({
    accepted: 1,
    duplicates: 0,
  });
  expect(await rows(h.other, input.appId)).toEqual([
    {
      app_id: input.appId,
      event_id: item.eventId,
      event_type: item.eventType,
      name: item.eventType,
      props: item.props,
      user_id: userId,
      device_id: deviceId,
      client_at: new Date(CLIENT_AT),
      server_at: new Date(SERVER_AT),
    },
  ]);
  clock.set('2032-06-18T01:02:03.456Z');
  const anonymous = event({ props: item.props });
  expect(await recordEvents(h.db, { ...input, clock, events: [anonymous] })).toEqual({
    accepted: 1,
    duplicates: 0,
  });
  expect(
    (await rows(h.db, input.appId)).find((row) => row.event_id === anonymous.eventId),
  ).toMatchObject({ user_id: null, device_id: null, server_at: clock.now(), props: item.props });
});

it('[AC-CT-13g#6] 并发两连接上报同一事件，只能一个接受、一个重复，内容来自胜者', async () => {
  const item = event();
  const input = batch([item]);
  const results = await Promise.all([
    recordEvents(h.db, { ...input, events: [{ ...item, props: { writer: 'left' } }] }),
    recordEvents(h.other, { ...input, events: [{ ...item, props: { writer: 'right' } }] }),
  ]);
  expect(results.map((result) => result.accepted).sort()).toEqual([0, 1]);
  expect(results.map((result) => result.duplicates).sort()).toEqual([0, 1]);
  for (const result of results) expect(result.accepted + result.duplicates).toBe(1);
  const stored = await rows(h.db, input.appId);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.props).toEqual({ writer: results[0]?.accepted === 1 ? 'left' : 'right' });
  expect(await keys(h.db, input.appId)).toHaveLength(1);
});

it('[AC-CT-13g#14] 写入层不重复执行事件目录校验，匿名设备由调用方给，props 不能冒充用户', async () => {
  // Deliberately absent from specs/events.yaml: validation belongs to the receiving endpoint.
  const item = event({
    eventType: 'ct13g_validated_extension',
    props: { user_id: randomUUID(), device_id: randomUUID(), extension: { enabled: true } },
  });
  const input = batch([item]);
  const deviceId = randomUUID();
  expect(await recordEvents(h.db, { ...input, deviceId })).toEqual({
    accepted: 1,
    duplicates: 0,
  });
  expect(await rows(h.other, input.appId)).toEqual([
    {
      app_id: input.appId,
      event_id: item.eventId,
      event_type: item.eventType,
      name: item.eventType,
      props: item.props,
      user_id: null,
      device_id: deviceId,
      client_at: new Date(CLIENT_AT),
      server_at: new Date(SERVER_AT),
    },
  ]);
});
