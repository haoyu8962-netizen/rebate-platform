// B1-02zzg (BR-ID-26, D10-1034 ①): when minor.min_realname_age cannot be had — no row, a value
// outside the registered integer 14..18, or a failing read — the line is 08's default 14, never
// lower. Every case also shows the key is really read (a control app set to 16 refuses a
// 15-year-old at the same instant, or the failing read was reached), so a line that ignores the
// configuration cannot pass these tests.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { close, fixture, open, reset, type Kit } from '../realname/kit.ts';
import {
  NO_ROW,
  configReadFault,
  matchVendor,
  newApp,
  passes,
  refused,
  type ConfigReadFault,
} from './kit.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
let fault: ConfigReadFault | undefined;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
  fault = configReadFault();
});
beforeEach(() => {
  if (kit) reset(kit);
  if (fault) {
    fault.state.appId = null;
    fault.state.hits = 0;
  }
});
afterAll(async () => {
  try {
    fault?.restore();
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-02zzg#2] 无配置行按 08 默认 14：满 14 时刻前 30407，恰到时刻通过；同时刻配 16 的 app 仍拒 15 岁', async () => {
  matchVendor(kit);
  // 2026-09-29 23:59:59.999 +08:00: born 2012-09-29 reaches 14 at 2026-09-30 00:00 +08:00.
  kit.clock.set('2026-09-29T15:59:59.999Z');
  const f = await newApp(kit, NO_ROW);
  const control = await newApp(kit, 16);
  await refused(kit, f, '2012-09-29');
  await refused(kit, f, '2014-01-01');
  kit.clock.set('2026-09-29T16:00:00.000Z');
  await refused(kit, control, '2011-01-01');
  await passes(kit, f, '2012-09-29');
});

// Values the registry would refuse (B1-02zzf: integer, 14..18), written as raw rows.
const DIRTY: [string, unknown][] = [
  ['低于下限 10', 10],
  ['低于下限 13', 13],
  ['零', 0],
  ['负数 -16', -16],
  ['非整数 16.5', 16.5],
  ['非整数 13.5', 13.5],
  ['字符串 "16"', '16'],
  ['字符串 "10"', '10'],
  ['字符串 "abc"', 'abc'],
  ['高于上限 19', 19],
  ['高于上限 100', 100],
  ['JSON null', null],
  ['布尔 true', true],
  ['数组 [16]', [16]],
  ['对象 {"value":16}', { value: 16 }],
];

it.each(DIRTY)(
  '[AC-B1-02zzg#3] 配置非法（%s）按 14、绝不放宽：12 岁与 13 岁末仍 30407，满 14 与 15 岁通过；同时刻配 16 的 app 拒 15 岁',
  async (_label, value) => {
    matchVendor(kit);
    // 2026-09-29 23:59 +08:00 (kit NOW): born 2014-01-01 is 12, 2012-09-29 is 13 (14 tomorrow),
    // 2012-09-28 has been 14 since 00:00 today, 2011-01-01 is 15.
    const f = await newApp(kit, value);
    const control = await newApp(kit, 16);
    await refused(kit, f, '2014-01-01');
    await refused(kit, f, '2012-09-29');
    await passes(kit, f, '2012-09-28');
    await passes(kit, await fixture(kit, { appId: f.appId }), '2011-01-01');
    await refused(kit, control, '2011-01-01');
  },
);

it('[AC-B1-02zzg#6] 读配置失败按 14：已配 16 但读取抛错时 12 岁、13 岁末仍 30407，恰满 14 通过（不回 50001）', async () => {
  expect(fault, 'fault seam installed').toBeDefined();
  const seam = fault!;
  matchVendor(kit);
  const f = await newApp(kit, 16);
  seam.state.appId = f.appId;
  try {
    await refused(kit, f, '2014-01-01');
    await refused(kit, f, '2012-09-29');
    await passes(kit, f, '2012-09-28');
  } finally {
    seam.state.appId = null;
  }
  expect(seam.state.hits, 'the age line was read from minor.min_realname_age').toBeGreaterThan(0);
});
