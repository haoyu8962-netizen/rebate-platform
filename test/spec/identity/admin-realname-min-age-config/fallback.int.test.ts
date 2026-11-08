// B1-02zzk (BR-ID-26, D10-1034 ①): when minor.min_realname_age cannot be had — no row, a value
// outside the registered integer 14..18, or a failing read — the admin correction's age line is
// 08's default 14, never lower, and a failing read is no 50001 (same reading as the App side,
// B1-02zzg). Every case also shows the key is really read (another app on the same admin entry
// set to 16 refuses a 15-year-old, or the failing read was reached), so a line that ignores the
// configuration cannot pass these tests.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { configReadFault, type ConfigReadFault } from '../realname-min-age-config/kit.ts';
import {
  DIRTY,
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
let fault: ConfigReadFault | undefined;
beforeAll(() => {
  fault = configReadFault();
});
beforeEach(() => {
  if (fault) {
    fault.state.appId = null;
    fault.state.hits = 0;
  }
});
afterAll(() => {
  fault?.restore();
});

it('[AC-B1-02zzk#2] 无配置行按 08 默认 14：12 岁与满 14 时刻前一毫秒 30407，恰到时刻通过；同一入口上配 16 的 app 仍拒 15 岁', async () => {
  const line = await corrector(h, NO_ROW);
  // NOW is 2026-10-09 10:00 +08:00: born 2014-01-01 is 12.
  await refused(line, born('2014-01-01', '101'));
  // Born 2012-10-09 reaches 14 at 2026-10-10 00:00 +08:00.
  const timed = await ready(line, JUST_BEFORE, 2);
  await refused(timed.line, born('2012-10-09', '102'), timed.tokens[0]!);
  line.s.clock.set(MIDNIGHT);
  await passes(timed.line, born('2012-10-09', '102'), timed.tokens[1]!);
  const control = await otherApp(line.s, 16);
  await refused(control, born('2011-01-01', '103'));
});

it.each(DIRTY)(
  '[AC-B1-02zzk#3] 配置非法（%s）按 14、绝不放宽：12 岁与 13 岁仍 30407，满 14 与 15 岁通过；同一入口上配 16 的 app 拒 15 岁',
  async (_label, value) => {
    // NOW is 2026-10-09 10:00 +08:00: born 2014-01-01 is 12, 2012-10-09 is 13 (14 tomorrow),
    // 2012-10-08 has been 14 since 00:00 today, 2011-01-01 is 15.
    const line = await corrector(h, value);
    await refused(line, born('2014-01-01', '101'));
    await refused(line, born('2012-10-09', '102'));
    await passes(line, born('2012-10-08', '103'));
    await passes(line, born('2011-01-01', '104'));
    const control = await otherApp(line.s, 16);
    await refused(control, born('2011-01-01', '105'));
  },
);

it('[AC-B1-02zzk#5] 读配置失败按 14：已配 16 但读取抛错时 12 岁、13 岁仍 30407，满 14 与 15 岁通过（不回 50001）', async () => {
  expect(fault, 'fault seam installed').toBeDefined();
  const seam = fault!;
  const line = await corrector(h, 16);
  seam.state.appId = line.appId;
  try {
    await refused(line, born('2014-01-01', '101'));
    await refused(line, born('2012-10-09', '102'));
    await passes(line, born('2012-10-08', '103'));
    await passes(line, born('2011-01-01', '104'));
  } finally {
    seam.state.appId = null;
  }
  expect(seam.state.hits, 'the age line was read from minor.min_realname_age').toBeGreaterThan(0);
});
