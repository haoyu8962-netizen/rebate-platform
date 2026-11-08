// B1-02zzk (BR-ID-26, D10-1034 ①; review S1): the admin correction's configured age line for
// someone born on 29 February. In a non-leap year the birthday is 1 March, so N years are reached
// on 2 March 00:00 +08:00: configured 18, born 2008-02-29 is refused (30407) through 2026-03-01
// 23:59:59.999 +08:00 and passes from 2026-03-02 00:00 +08:00. A line that took 28 February (or
// 1 March itself) as the day reached would let the correction through a day early.
//
// The admin kit starts at 2026-10-09 and an admin's TOTP steps only move forward, so this case has
// its own app and super admin, first signed in on 2026-02-28; the Clock then only moves forward.
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import { OLD, setup, user, verified, type Setup } from '../admin-realname/kit.ts';
import { born, passes, putAge, ready, refused, type Line } from './kit.ts';

const h = useHarness();

/** 2026-02-28 10:00 +08:00: the new admin's first sign-in. */
const START = '2026-02-28T02:00:00.000Z';
/** 2026-03-01 23:59:59.999 +08:00. */
const EVE = '2026-03-01T15:59:59.999Z';
/** 2026-03-02 00:00 +08:00: born 2008-02-29 reaches 18 (non-leap year, birthday 1 March). */
const REACHED = '2026-03-01T16:00:00.000Z';
/** The user's earlier verification, before every instant of this file. */
const EARLIER = '2025-09-01T02:00:00.000Z';

/** A new app on the admin entry of `s` (age line `age`), its super admin signed in at the Clock. */
async function leapLine(s: Setup, age: unknown): Promise<Line> {
  const appId = `${s.appId}-${randomBytes(4).toString('hex')}`;
  await putAge(s.h, appId, age);
  const who = await seed(s.h, appId, { isSuper: true });
  const session = await signedIn(s, who);
  const target = await user(s.h, appId);
  await verified(s.h, target, OLD, new Date(EARLIER));
  return { s, appId, target, as: { who, token: session.admin_token } };
}

it('[AC-B1-02zzk#1] 配置 18、出生 2008-02-29（非闰年以 3 月 1 日为生日）：2026-03-01 23:59:59（+08:00）仍 30407，2026-03-02 00:00（+08:00）恰好通过', async () => {
  const s = await setup(h);
  s.clock.set(START);
  const line = await leapLine(s, 18);

  // 2026-02-28 10:00: 17, reaching 18 only on 2026-03-02 00:00.
  await refused(line, born('2008-02-29', '101'));

  const timed = await ready(line, EVE, 4);
  // 2026-03-01 23:59:59.999: born 2008-02-29 is still 17; born 2008-02-28 has been 18 since
  // 2026-03-01 00:00, so the line is 18 and not something stricter.
  await refused(timed.line, born('2008-02-29', '101'), timed.tokens[0]!);
  await passes(timed.line, born('2008-02-28', '102'), timed.tokens[1]!);

  // 2026-03-02 00:00: born 2008-02-29 reaches 18; born 2008-03-02 does not.
  s.clock.set(REACHED);
  await refused(timed.line, born('2008-03-02', '103'), timed.tokens[2]!);
  const data = await passes(timed.line, born('2008-02-29', '101'), timed.tokens[3]!);
  expect(new Date(data.verified_at).toISOString()).toBe(REACHED);
  expect(s.vendor).toHaveBeenCalledTimes(2);
});
