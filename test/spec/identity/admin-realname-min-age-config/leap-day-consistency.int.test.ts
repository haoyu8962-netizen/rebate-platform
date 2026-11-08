// B1-02zzk (BR-ID-26, D10-1034 ①; review S1): for someone born on 29 February the admin
// correction and the App-side submission (B1-02zzg) judge age the same way. Configured 18, at
// 2026-03-01 23:59:59.999 and 2026-03-02 00:00 (+08:00), born 2008-02-29 is judged like born
// 2008-03-01 (non-leap year: birthday 1 March, 18 reached on 2 March 00:00), on both sides.
//
// The App side runs on the frozen B1-13d / B1-02zzg kits (its own test database and Redis), the
// admin side on the B1-27a kit; only the vendor is replaced on both, and it answers match. The
// admin kit starts at 2026-10-09 and an admin's TOTP steps only move forward, so the admin side has
// its own app and super admin, first signed in on 2026-02-28; the Clocks then only move forward.
import { randomBytes } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import { OLD, setup, user, verified } from '../admin-realname/kit.ts';
import { close, fixture, open, reset, type Kit } from '../realname/kit.ts';
import { matchVendor, newApp } from '../realname-min-age-config/kit.ts';
import { attempt, born, putAge, ready, type Line } from './kit.ts';

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

/** 2026-02-28 10:00 +08:00: the admin's first sign-in. */
const START = '2026-02-28T02:00:00.000Z';
/** 2026-03-01 23:59:59.999 +08:00. */
const EVE = '2026-03-01T15:59:59.999Z';
/** 2026-03-02 00:00 +08:00. */
const REACHED = '2026-03-01T16:00:00.000Z';
/** The admin side's earlier verification, before every instant of this file. */
const EARLIER = '2025-09-01T02:00:00.000Z';

const codeOf = (response: { json<T>(): T }) => response.json<{ code?: unknown }>().code;

it('[AC-B1-02zzk#6] 与 App 端一致（配置 18、2 月 29 日出生）：2026-03-01 23:59:59 与 2026-03-02 00:00（+08:00）App 端提交与后台更正给出相同判定，2008-02-29 同 2008-03-01', async () => {
  expect(kit, 'App-side kit opened').toBeDefined();
  const app = kit!;
  matchVendor(app);
  const steps: { at: string; birth: string; expected: number }[] = [
    { at: EVE, birth: '2008-02-29', expected: 30407 },
    { at: EVE, birth: '2008-03-01', expected: 30407 },
    // 18 since 2026-03-01 00:00 +08:00.
    { at: EVE, birth: '2008-02-28', expected: 0 },
    { at: REACHED, birth: '2008-02-29', expected: 0 },
    { at: REACHED, birth: '2008-03-01', expected: 0 },
    { at: REACHED, birth: '2008-03-02', expected: 30407 },
  ];

  app.clock.set(EVE);
  const first = await newApp(app, 18);

  const s = await setup(h);
  s.clock.set(START);
  const appId = `${s.appId}-${randomBytes(4).toString('hex')}`;
  await putAge(h, appId, 18);
  const who = await seed(h, appId, { isSuper: true });
  const session = await signedIn(s, who);
  const target = await user(h, appId);
  await verified(h, target, OLD, new Date(EARLIER));
  const line: Line = { s, appId, target, as: { who, token: session.admin_token } };
  const timed = await ready(line, EVE, steps.length);

  const appSide: unknown[] = [];
  const adminSide: unknown[] = [];
  for (const [i, step] of steps.entries()) {
    const person = born(step.birth, String(101 + i));
    app.clock.set(step.at);
    const f = i === 0 ? first : await fixture(app, { appId: first.appId });
    appSide.push(codeOf(await f.submit({ name: person.name, id_no: person.idNo })));
    s.clock.set(step.at);
    adminSide.push(codeOf(await attempt(timed.line, person, timed.tokens[i]!)));
  }

  const expected = steps.map((step) => step.expected);
  expect(adminSide, 'admin correction vs App-side submission').toEqual(appSide);
  expect({ app: appSide, admin: adminSide }).toEqual({ app: expected, admin: expected });
});
