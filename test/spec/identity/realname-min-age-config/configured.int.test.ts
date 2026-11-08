// B1-02zzg (BR-ID-26, D10-1034 ①): the real-name age line is the app's minor.min_realname_age
// (registered by B1-02zzf: integer 14..18). Reaching N years = the day after the N-th birthday,
// 00:00 +08:00; born 29 February: 1 March in common years. Under the line → 30407, nothing stored.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { close, fixture, open, privateDataAbsent, reset, type Kit } from '../realname/kit.ts';
import { NO_ROW, idOf, matchVendor, newApp, passes, refused } from './kit.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
});
beforeEach(() => {
  if (kit) reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-02zzg#1] 配置 16：满 16 周岁时刻（第 16 个生日次日 00:00 +08:00）前 30407 且不保存，恰到该时刻通过', async () => {
  matchVendor(kit);
  // 2026-09-29 23:59:59.999 +08:00: born 2010-09-29 is 15 years 364 days and a bit.
  kit.clock.set('2026-09-29T15:59:59.999Z');
  const f = await newApp(kit, 16);
  const responses = [
    await refused(kit, f, '2010-09-29'),
    // 14 years: above 08's default line, under the configured one.
    await refused(kit, f, '2012-01-01'),
  ];
  // 2026-09-30 00:00 +08:00: born 2010-09-29 has just reached 16, born a day later has not.
  kit.clock.set('2026-09-29T16:00:00.000Z');
  responses.push(await refused(kit, f, '2010-09-30'));
  expect(kit.vendor).not.toHaveBeenCalled();
  await passes(kit, f, '2010-09-29');
  expect(kit.vendor).toHaveBeenCalledTimes(1);
  expect((await f.rows())[0]?.['verified_at']).toEqual(new Date('2026-09-29T16:00:00.000Z'));
  privateDataAbsent(kit, responses, [idOf('2010-09-29'), idOf('2012-01-01'), idOf('2010-09-30')]);
});

it('[AC-B1-02zzg#4] 按 app 隔离：A 配 16、C 配 17 不影响无配置的 B（按 14），各 app 按自己的值判定', async () => {
  matchVendor(kit);
  // 2026-09-29 23:59 +08:00 (kit NOW): born 2011-01-01 is 15, born 2010-01-01 is 16.
  const a = await newApp(kit, 16);
  const b = await newApp(kit, NO_ROW);
  const c = await newApp(kit, 17);
  // A is read first: its value must not become B's or C's line.
  await refused(kit, a, '2011-01-01');
  await passes(kit, b, '2011-01-01');
  await refused(kit, c, '2010-01-01');
  // Born 2012-09-28: reached 14 at 2026-09-29 00:00 +08:00.
  await passes(kit, await fixture(kit, { appId: b.appId }), '2012-09-28');
  await passes(kit, await fixture(kit, { appId: a.appId }), '2010-01-01');
  await refused(kit, await fixture(kit, { appId: a.appId }), '2012-09-28');
});

it.each([
  // 2026 is a common year: born 2008-02-29 reaches 18 at 2026-03-02 00:00 +08:00 (08's example);
  // the instant before is 1 March 23:59:59.999 +08:00, the substitute birthday itself.
  [18, '2026-03-01T15:59:59.999Z', '2026-03-01T16:00:00.000Z'],
  // 2024 is a leap year: born 2008-02-29 reaches 16 at 2024-03-01 00:00 +08:00.
  [16, '2024-02-29T15:59:59.999Z', '2024-02-29T16:00:00.000Z'],
] as [number, string, string][])(
  '[AC-B1-02zzg#5] 2008-02-29 出生、配置 %i：满周岁时刻前一毫秒（%s）30407，恰到时刻（%s）通过',
  async (age, before, boundary) => {
    matchVendor(kit);
    kit.clock.set(before);
    const f = await newApp(kit, age);
    await refused(kit, f, '2008-02-29');
    expect(kit.vendor).not.toHaveBeenCalled();
    kit.clock.set(boundary);
    await passes(kit, f, '2008-02-29');
    expect(kit.vendor).toHaveBeenCalledTimes(1);
    expect((await f.rows())[0]?.['verified_at']).toEqual(new Date(boundary));
  },
);
