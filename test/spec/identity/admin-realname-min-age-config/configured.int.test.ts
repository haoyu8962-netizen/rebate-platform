// B1-02zzk (BR-ID-26, D10-1034 ①): the age line of the admin real-name correction
// (adminCorrectUserRealname, BR-ID-25 细则「实名更正」 step 30407) is the app's
// minor.min_realname_age (registered by B1-02zzf: integer 14..18), as for the App-side submission.
// Reaching N years = the day after the N-th birthday, 00:00 +08:00. Under the line → 30407: no
// vendor call, the stored real name is not written over and the new identity is not kept.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { withdrawal } from '../admin-realname/kit.ts';
import {
  JUST_BEFORE,
  MIDNIGHT,
  NO_ROW,
  born,
  corrector,
  otherApp,
  passes,
  ready,
  refused,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-02zzk#1] 配置 16：更正为 15 岁、14 岁的身份 → 30407，不调供应商、不覆盖、不留存；满 16 周岁时刻（第 16 个生日次日 00:00 +08:00）前一毫秒仍 30407，恰到该时刻通过', async () => {
  const line = await corrector(h, 16);
  // A paid-out withdrawal: a correction that went through would keep the old identity (B1-27e).
  await withdrawal(h.db, line.s.clock, line.target, 'PAID_API');
  // NOW is 2026-10-09 10:00 +08:00: born 2011-01-01 is 15; born 2012-10-08 has been 14 since 00:00
  // today, above 08's default line and under the configured one.
  await refused(line, born('2011-01-01', '101'));
  await refused(line, born('2012-10-08', '102'));

  // Born 2010-10-09 reaches 16 at 2026-10-10 00:00 +08:00; born a day later does not.
  const timed = await ready(line, JUST_BEFORE, 3);
  await refused(timed.line, born('2010-10-09', '103'), timed.tokens[0]!);
  line.s.clock.set(MIDNIGHT);
  await refused(timed.line, born('2010-10-10', '104'), timed.tokens[1]!);
  expect(line.s.vendor).not.toHaveBeenCalled();
  const data = await passes(timed.line, born('2010-10-09', '103'), timed.tokens[2]!);
  expect(line.s.vendor).toHaveBeenCalledTimes(1);
  expect(new Date(data.verified_at).toISOString()).toBe(MIDNIGHT);
});

it('[AC-B1-02zzk#4] 按 app 隔离：同一后台入口上 A 配 16、C 配 17 不影响无配置的 B（按 14），各 app 按自己的值判定', async () => {
  // NOW is 2026-10-09 10:00 +08:00: born 2011-01-01 is 15, 2010-01-01 is 16, 2009-01-01 is 17,
  // 2012-10-08 has been 14 since 00:00 today.
  const a = await corrector(h, 16);
  const b = await otherApp(a.s, NO_ROW);
  const c = await otherApp(a.s, 17);
  // A is read first: its value must not become B's or C's line.
  await refused(a, born('2011-01-01', '101'));
  await passes(b, born('2011-01-01', '101'));
  await refused(c, born('2010-01-01', '102'));
  await passes(b, born('2012-10-08', '103'));
  await passes(a, born('2010-01-01', '102'));
  await refused(a, born('2012-10-08', '103'));
  await passes(c, born('2009-01-01', '104'));
  await refused(c, born('2011-01-01', '105'));
});
