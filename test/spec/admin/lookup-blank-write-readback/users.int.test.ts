// B1-10p rule test (claude-independent, SPEC_REF d5713bf4; FU-ADMIN-WRITE-READBACK-BLANK, D10-1048
// ①): the user detail adminEditUserProfile answers with blanks risk.reason for an account holding
// no risk.* point; who is let in does not change. Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: the save answers the real reason, so the comparison with the
// blanked detail fails in every case; the entitled accounts and the refusals come after it in the
// same case.
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import {
  REASON,
  edit,
  masked,
  member,
  ok,
  rejected,
  setup,
  snapshot,
  stepUp,
  testPhone,
} from '../../identity/admin-profile/kit.ts';
import { normalDetail } from '../../identity/admin-users/kit.ts';
import {
  RISK_POINTS,
  SLOW,
  STEP_UP_NEEDED,
  USER_POINT,
  blankUser,
  editAudits,
  realUser,
  riskyUser,
} from './kit.ts';

const h = useHarness();

const NICKNAME = '小狸';
const DENIED = { reason: 'admin_permission_denied' };

it(
  '[AC-B1-10p#7] adminEditUserProfile 只持 user.phone_change：改昵称、改手机号的响应 risk.reason 为 null，reason_category、union_bindings 与其余字段照常，库里生效、审计照写；对照：加持 risk.* 与超管拿到真实值；只持 risk.* 与 user.lookup 仍 10403',
  async () => {
    const s = await setup(h);
    const writer = await member(s, [USER_POINT]);

    const renamed = await riskyUser(s);
    const nickname = { nickname: NICKNAME, reason: REASON };
    const named = normalDetail(await ok(await edit(s, renamed.id, nickname, { as: writer })));
    const namedReal = await realUser(s, renamed.id);
    expect(namedReal.nickname).toBe(NICKNAME);
    expect(named).toEqual(blankUser(namedReal));
    expect(await editAudits(s, renamed.id)).toEqual([
      expect.objectContaining({ admin_id: writer.who.id }),
    ]);

    const rephoned = await riskyUser(s);
    const phone = testPhone();
    const moved = normalDetail(
      await ok(await edit(s, rephoned.id, { phone, reason: REASON }, { as: writer })),
    );
    const movedReal = await realUser(s, rephoned.id);
    expect(movedReal.phone_masked).toBe(masked(phone));
    expect(moved).toEqual(blankUser(movedReal));

    const holder = await member(s, [USER_POINT, 'risk.freeze']);
    const held = await riskyUser(s);
    const shown = normalDetail(await ok(await edit(s, held.id, nickname, { as: holder })));
    expect(shown).toEqual(await realUser(s, held.id));
    const superTarget = await riskyUser(s);
    const superShown = normalDetail(await ok(await edit(s, superTarget.id, nickname)));
    expect(superShown).toEqual(await realUser(s, superTarget.id));

    const outsider = await member(s, [...RISK_POINTS, 'user.lookup']);
    const refusedTarget = await riskyUser(s);
    const before = await snapshot(h, s.appId);
    const refused = await edit(s, refusedTarget.id, nickname, { as: outsider });
    await rejected(refused, 10403, DENIED);
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
  SLOW,
);

it(
  '[AC-B1-10p#8] 四个 risk.* 点任持其一都拿到真实 risk.reason；其他业务权限点不算，加持 user.lookup、order.view、pii.reveal_phone 等仍置空',
  async () => {
    const s = await setup(h);
    const nickname = { nickname: NICKNAME, reason: REASON };
    const unrelated = await member(s, [
      USER_POINT,
      'user.lookup',
      'user.list',
      'order.view',
      'pii.reveal_phone',
      'fund.view',
    ]);
    const blanked = await riskyUser(s);
    const data = normalDetail(await ok(await edit(s, blanked.id, nickname, { as: unrelated })));
    expect(data).toEqual(blankUser(await realUser(s, blanked.id)));

    for (const point of RISK_POINTS) {
      const holder = await member(s, [USER_POINT, point]);
      const target = await riskyUser(s);
      const shown = normalDetail(await ok(await edit(s, target.id, nickname, { as: holder })));
      expect(shown, point).toEqual(await realUser(s, target.id));
    }
  },
  SLOW,
);

it(
  '[AC-B1-10p#9] 置空不改写操作的动态码：adminEditUserProfile 不带 X-Step-Up-Token 仍 10003、什么都不写；带有效 token 成功且响应置空；同一 token 已消耗，再用仍 10003',
  async () => {
    const s = await setup(h);
    const writer = await member(s, [USER_POINT]);
    const body = { nickname: NICKNAME, reason: REASON };
    const first = await riskyUser(s);
    const untouched = await snapshot(h, s.appId);
    const missing = await edit(s, first.id, body, { as: writer, stepUp: null });
    await rejected(missing, 10003, STEP_UP_NEEDED);
    expect(await snapshot(h, s.appId)).toEqual(untouched);

    const token = await stepUp(s, writer.who, writer.token);
    const data = normalDetail(
      await ok(await edit(s, first.id, body, { as: writer, stepUp: token })),
    );
    expect(data).toEqual(blankUser(await realUser(s, first.id)));

    const second = await riskyUser(s);
    const before = await snapshot(h, s.appId);
    const replay = await edit(s, second.id, body, { as: writer, stepUp: token });
    await rejected(replay, 10003, STEP_UP_NEEDED);
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
  SLOW,
);
