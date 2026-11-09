// B1-10o rule test (claude-independent, SPEC_REF 39756e36; CT-24zzd, D10-1048 ①): adminGetUser and
// adminLookupUser show risk.reason only to an account holding a risk.* point (or a super admin).
// Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: nothing is blanked, so the first comparison of every case
// fails; the entitled accounts and the 10403s are compared in the same case, after it.
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import { LIST_POINT, LOOKUP_POINT, RISK_POINTS, SLOW, userCase } from './kit.ts';

const h = useHarness();

it(
  '[AC-B1-10o#1] 只持 user.lookup：adminGetUser、adminLookupUser（按 uid、按完整手机号）的 risk.reason 为 null，reason_category、风控状态与其余字段照常；对照：超管三条路径都拿到真实值',
  async () => {
    const c = await userCase(h);
    const token = await c.token([LOOKUP_POINT]);
    for (const read of [c.readDetail, c.lookupUid, c.lookupPhone]) {
      expect(await read(token)).toEqual(c.blanked);
      expect(await read(c.f.token)).toEqual(c.real);
    }
  },
  SLOW,
);

it(
  '[AC-B1-10o#2] 只持 user.list：adminGetUser 的 risk.reason 为 null，其余字段照常；adminLookupUser 仍 10403（置空不改放行）',
  async () => {
    const c = await userCase(h);
    const token = await c.token([LIST_POINT]);
    expect(await c.readDetail(token)).toEqual(c.blanked);
    await c.refusedLookup(token);
  },
  SLOW,
);

it(
  '[AC-B1-10o#3] 四个 risk.* 点任持其一都拿到真实 risk.reason；其他业务权限点不算，持 user.lookup 加一串非风控点仍置空',
  async () => {
    const c = await userCase(h);
    const lookupOnly = await c.token([LOOKUP_POINT]);
    expect(await c.readDetail(lookupOnly)).toEqual(c.blanked);
    const unrelated = await c.token([
      LOOKUP_POINT,
      'order.view',
      'order.claim',
      'withdraw.review',
      'fund.view',
      'pii.reveal_phone',
    ]);
    expect(await c.readDetail(unrelated)).toEqual(c.blanked);
    expect(await c.lookupUid(unrelated)).toEqual(c.blanked);
    const [freeze, ban, blocklist, appeal] = RISK_POINTS;
    for (const grants of [
      [LOOKUP_POINT, freeze],
      [LIST_POINT, ban],
      [LOOKUP_POINT, blocklist],
      [LIST_POINT, appeal],
    ]) {
      expect(await c.readDetail(await c.token(grants)), grants.join()).toEqual(c.real);
    }
    const holder = await c.token([LOOKUP_POINT, appeal]);
    expect(await c.lookupUid(holder)).toEqual(c.real);
    expect(await c.lookupPhone(holder)).toEqual(c.real);
  },
  SLOW,
);

it(
  '[AC-B1-10o#4] risk.* 点只决定置空、不放行：只持 risk.* 或什么都没有的账号读详情、查找都 10403',
  async () => {
    const c = await userCase(h);
    expect(await c.readDetail(await c.token([LOOKUP_POINT]))).toEqual(c.blanked);
    for (const grants of [[], ['risk.freeze'], [...RISK_POINTS]]) {
      const token = await c.token(grants);
      await c.refusedDetail(token);
      await c.refusedLookup(token);
    }
  },
  SLOW,
);
