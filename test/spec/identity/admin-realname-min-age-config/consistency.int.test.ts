// B1-02zzk (BR-ID-26, D10-1034 ①): the admin correction and the App-side submission (B1-02zzg)
// judge age the same way: at the same instant, under the same minor.min_realname_age, the same
// birth date passes or is refused (30407) on both. The App side runs on the frozen B1-13d / B1-02zzg
// kits (its own test database and Redis), the admin side on the B1-27a kit; only the vendor is
// replaced on both, and it answers match.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { close, fixture, open, reset, type Kit } from '../realname/kit.ts';
import { matchVendor, newApp } from '../realname-min-age-config/kit.ts';
import { JUST_BEFORE, MIDNIGHT, attempt, born, corrector, ready } from './kit.ts';

const h = useHarness();
let database: TestDatabase | undefined;
let server: TestRedis | undefined;
let kit: Kit | undefined;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
}, 180_000);
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

const codeOf = (response: { json<T>(): T }) => response.json<{ code?: unknown }>().code;

it.each([16, 18])(
  '[AC-B1-02zzk#6] 与 App 端一致（配置 %i）：同一时刻、同一出生日期，App 端提交与后台更正给出相同的年龄判定',
  async (age) => {
    expect(kit, 'App-side kit opened').toBeDefined();
    const app = kit!;
    matchVendor(app);
    // Reaches `age` at MIDNIGHT (2026-10-10 00:00 +08:00) / reached it at 2026-10-09 00:00 +08:00.
    const turning = `${2026 - age}-10-09`;
    const turned = `${2026 - age}-10-08`;
    const steps: { at: string; birth: string; expected: number }[] = [
      { at: JUST_BEFORE, birth: turning, expected: 30407 },
      { at: JUST_BEFORE, birth: turned, expected: 0 },
      // 14 since 2026-10-09 00:00 +08:00: past 08's default line, under the configured one.
      { at: JUST_BEFORE, birth: '2012-10-08', expected: 30407 },
      { at: JUST_BEFORE, birth: '2012-10-09', expected: 30407 },
      { at: MIDNIGHT, birth: turning, expected: 0 },
      { at: MIDNIGHT, birth: '2012-10-09', expected: 30407 },
    ];

    app.clock.set(JUST_BEFORE);
    const first = await newApp(app, age);
    const line = await corrector(h, age);
    const timed = await ready(line, JUST_BEFORE, steps.length);

    const appSide: unknown[] = [];
    const adminSide: unknown[] = [];
    for (const [i, step] of steps.entries()) {
      const who = born(step.birth, String(101 + i));
      app.clock.set(step.at);
      const f = i === 0 ? first : await fixture(app, { appId: first.appId });
      appSide.push(codeOf(await f.submit({ name: who.name, id_no: who.idNo })));
      line.s.clock.set(step.at);
      adminSide.push(codeOf(await attempt(timed.line, who, timed.tokens[i]!)));
    }

    const expected = steps.map((step) => step.expected);
    expect(adminSide, 'admin correction vs App-side submission').toEqual(appSide);
    expect({ app: appSide, admin: adminSide }).toEqual({ app: expected, admin: expected });
  },
);
