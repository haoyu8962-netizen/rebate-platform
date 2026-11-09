// B1-10o rule test (claude-independent, SPEC_REF 39756e36; 编排 18:53, written like [AC-B2-09zg#10]):
// AdminActor.permissions is read only for blanking. A controller that gets no `permissions`
// (undefined) from a non-super actor treats the account as holding no point and blanks the internal
// fields; a super admin holds every point and is not blanked. Top-level it() only (规划/11 §4.3).
//
// Each controller is built directly with a guard double (lets the call through, hands over the
// actor) and the entry's real read service: PostgreSQL as couli_app. Only detail / lookup are called:
// their signatures are the same before and after the implementation.
//
// Red on the code before this task: the controllers blank nothing, so the actor without
// `permissions` reads the real values and the first comparison fails.
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import {
  LOOKUP_POINT,
  ORDER_CLAIM,
  ORDER_VIEW,
  SLOW,
  claimCase,
  claimControllerRead,
  orderCase,
  orderControllerRead,
  userCase,
  userControllerReads,
} from './kit.ts';

const h = useHarness();

it(
  '[AC-B1-10o#11] 订单详情（控制器直调）：actor 不带 permissions 且不是超管 → last_hold_note、commission_rate_bp、commission_split.reserve_bp 置空；对照：超管不带 permissions、带 permissions=[order.view] 的账号拿到真实值，permissions=[user.lookup] 仍置空',
  async () => {
    const c = await orderCase(h);
    const read = await orderControllerRead(c);
    expect(await read({ isSuper: false })).toEqual(c.blanked);
    expect(await read({ isSuper: true })).toEqual(c.real);
    expect(await read({ isSuper: true, permissions: [] })).toEqual(c.real);
    expect(await read({ isSuper: false, permissions: [ORDER_VIEW] })).toEqual(c.real);
    expect(await read({ isSuper: false, permissions: [LOOKUP_POINT] })).toEqual(c.blanked);
  },
  SLOW,
);

it(
  '[AC-B1-10o#12] 找回详情（控制器直调）：actor 不带 permissions 且不是超管 → reason 置空；对照：超管不带 permissions、带 permissions=[order.claim] 的账号拿到真实值，permissions=[user.lookup] 仍置空',
  async () => {
    const c = await claimCase(h);
    const read = await claimControllerRead(c);
    expect(await read({ isSuper: false })).toEqual(c.blanked);
    expect(await read({ isSuper: true })).toEqual(c.real);
    expect(await read({ isSuper: true, permissions: [] })).toEqual(c.real);
    expect(await read({ isSuper: false, permissions: [ORDER_CLAIM] })).toEqual(c.real);
    expect(await read({ isSuper: false, permissions: [LOOKUP_POINT] })).toEqual(c.blanked);
  },
  SLOW,
);

it(
  '[AC-B1-10o#13] 用户 lookup 与详情（控制器直调）：actor 不带 permissions 且不是超管 → risk.reason 置空；对照：超管不带 permissions、带 permissions=[risk.appeal] 的账号拿到真实值，permissions=[user.lookup] 仍置空',
  async () => {
    const c = await userCase(h);
    const reads = await userControllerReads(c);
    for (const read of [reads.lookup, reads.detail]) {
      expect(await read({ isSuper: false })).toEqual(c.blanked);
      expect(await read({ isSuper: true })).toEqual(c.real);
      expect(await read({ isSuper: true, permissions: [] })).toEqual(c.real);
      expect(await read({ isSuper: false, permissions: ['risk.appeal'] })).toEqual(c.real);
      expect(await read({ isSuper: false, permissions: [LOOKUP_POINT] })).toEqual(c.blanked);
    }
  },
  SLOW,
);
