// CT-13g §9 / D10-1489: only non-null -> null user_id; every other event column is immutable.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  detachUserEvents,
  recordEvents,
} from '../../../../apps/api/src/modules/analytics/index.ts';
import { batch, close, keys, open, rows, seed, TIMEOUT, user, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-CT-13g#10] 清空目标用户所有事件的 user_id，保留其它用户、匿名行及所有其它字段和去重行；重跑为零', async () => {
  const { appId } = batch([]);
  const userId = await user(h.db, appId);
  const otherUserId = await user(h.db, appId);
  const deviceId = randomUUID();
  await seed(h.db, appId, userId, deviceId);
  await seed(h.db, appId, userId, null);
  await seed(h.db, appId, otherUserId, deviceId);
  await seed(h.db, appId, null, deviceId);
  const before = await rows(h.db, appId);
  const beforeKeys = await keys(h.db, appId);
  expect(await detachUserEvents(h.db, { appId, userId })).toBe(2);
  const expected = before.map((row) => (row.user_id === userId ? { ...row, user_id: null } : row));
  expect(await rows(h.other, appId)).toEqual(expected);
  expect(await keys(h.other, appId)).toEqual(beforeKeys);
  expect(await detachUserEvents(h.other, { appId, userId })).toBe(0);
  expect(await rows(h.db, appId)).toEqual(expected);
  expect(await keys(h.db, appId)).toEqual(beforeKeys);
});

it('[AC-CT-13g#11] 用错误 app 调用不得解除另一 app 的同一 user_id，也不得解除本 app 的其他用户', async () => {
  const left = batch([]).appId;
  const right = batch([]).appId;
  const userId = await user(h.db, left);
  const rightUserId = await user(h.db, right);
  await seed(h.db, left, userId, randomUUID());
  await seed(h.db, right, rightUserId, randomUUID());
  const beforeLeft = await rows(h.db, left);
  const beforeRight = await rows(h.db, right);
  const leftKeys = await keys(h.db, left);
  const rightKeys = await keys(h.db, right);
  expect(await detachUserEvents(h.db, { appId: right, userId })).toBe(0);
  expect(await rows(h.other, left)).toEqual(beforeLeft);
  expect(await rows(h.other, right)).toEqual(beforeRight);
  expect(await keys(h.other, left)).toEqual(leftKeys);
  expect(await keys(h.other, right)).toEqual(rightKeys);
  expect(await detachUserEvents(h.db, { appId: left, userId })).toBe(1);
  expect(await rows(h.other, right)).toEqual(beforeRight);
});

it('[AC-CT-13g#12] 没有该用户事件返回零，不更改匿名事件', async () => {
  const { appId } = batch([]);
  const userId = await user(h.db, appId);
  await seed(h.db, appId, null, randomUUID());
  const before = await rows(h.db, appId);
  expect(await detachUserEvents(h.db, { appId, userId })).toBe(0);
  expect(await rows(h.other, appId)).toEqual(before);
  expect(await detachUserEvents(h.db, { appId: batch([]).appId, userId })).toBe(0);
});

it('[AC-CT-13g#13] 解除关联后事件重试仍被去重，不重新挂回用户', async () => {
  const input = batch([]);
  const userId = await user(h.db, input.appId);
  const deviceId = randomUUID();
  const item = await seed(h.db, input.appId, userId, deviceId);
  expect(await detachUserEvents(h.db, { appId: input.appId, userId })).toBe(1);
  const detached = await rows(h.db, input.appId);
  const beforeKeys = await keys(h.db, input.appId);
  expect(await recordEvents(h.other, { ...input, userId, deviceId, events: [item] })).toEqual({
    accepted: 0,
    duplicates: 1,
  });
  expect(await rows(h.db, input.appId)).toEqual(detached);
  expect(await keys(h.db, input.appId)).toEqual(beforeKeys);
  expect(detached[0]?.user_id).toBeNull();
});
