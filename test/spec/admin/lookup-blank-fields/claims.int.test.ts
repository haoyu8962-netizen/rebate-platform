// B1-10o rule test (claude-independent, SPEC_REF 39756e36; CT-24zzd, D10-1048 ②): adminGetClaim
// blanks the claim's `reason` for an account that came in through user.lookup with user_id and does
// not hold order.claim. Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: nothing is blanked, so the first comparison of every case
// fails; the entitled accounts and the 10403s are compared in the same case, after it.
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import { detail, rejected } from '../../orders/claims-admin-read/kit.ts';
import {
  DENIED,
  LOOKUP_POINT,
  ORDER_CLAIM,
  ORDER_VIEW,
  RISK_POINTS,
  SLOW,
  claimCase,
} from './kit.ts';

const h = useHarness();

it(
  '[AC-B1-10o#8] 只持 user.lookup 带 user_id：reason 为 null，items[].reject_reason、matches、evidence_links 照常；对照：持 order.claim（含同时持 user.lookup）、超管带或不带 user_id 都拿到真实值',
  async () => {
    const c = await claimCase(h);
    const query = { user_id: c.s.userId };
    const lookupOnly = await c.token([LOOKUP_POINT]);
    expect(await detail(await c.read(lookupOnly, query))).toEqual(c.blanked);

    const reviewer = await c.token([ORDER_CLAIM]);
    expect(await detail(await c.read(reviewer, query))).toEqual(c.real);
    const both = await c.token([ORDER_CLAIM, LOOKUP_POINT]);
    expect(await detail(await c.read(both, query))).toEqual(c.real);
    expect(await detail(await c.read(both, {}))).toEqual(c.real);
    const superAdmin = await c.token([], true);
    expect(await detail(await c.read(superAdmin, query))).toEqual(c.real);
    expect(await detail(await c.read(superAdmin, {}))).toEqual(c.real);
  },
  SLOW,
);

it(
  '[AC-B1-10o#9] 只有 order.claim 算数：持 user.lookup 加 order.view、风控与资金权限点带 user_id 仍置空',
  async () => {
    const c = await claimCase(h);
    const query = { user_id: c.s.userId };
    for (const grants of [
      [LOOKUP_POINT, ORDER_VIEW],
      [LOOKUP_POINT, ...RISK_POINTS, 'fund.view', 'withdraw.review'],
    ]) {
      const token = await c.token(grants);
      expect(await detail(await c.read(token, query)), grants.join()).toEqual(c.blanked);
    }
  },
  SLOW,
);

it(
  '[AC-B1-10o#10] 权限点只决定置空、不放行：没有 order.claim 与 user.lookup 的账号带 user_id 仍 10403；只持 user.lookup 不带 user_id 也 10403',
  async () => {
    const c = await claimCase(h);
    const query = { user_id: c.s.userId };
    const lookupOnly = await c.token([LOOKUP_POINT]);
    expect(await detail(await c.read(lookupOnly, query))).toEqual(c.blanked);
    await rejected(await c.read(lookupOnly, {}), 10403, DENIED);
    for (const grants of [[], [ORDER_VIEW], ['risk.freeze']]) {
      const token = await c.token(grants);
      await rejected(await c.read(token, query), 10403, DENIED);
    }
  },
  SLOW,
);
