// B1-10n: the permission points and step-up tier of the import operations through the real admin
// entry (contracts/openapi.yaml, specs/permissions.yaml; 08 BR-ATTR-26 细则「渠道单导入」): rights,
// punish, list and detail need order.claim and no step-up; channel needs order.claim and
// risk.blocklist and one totp token for the whole file. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ANSWER,
  DENIED,
  GRANTS,
  STEP_UP_REQUIRED,
  accepted,
  allowed,
  arrange,
  refused,
  setup,
  type Action,
} from './kit.ts';

const h = useHarness();

it.each(ACTIONS)(
  '[AC-B1-10n#3] %s 没带 admin_token → 10001，什么都不写',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act({ caller: null }), 10001);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

const WRONG_POINTS: readonly (readonly [Action, readonly string[]])[] = [
  ['rights', ['order.view', 'order.hold', 'order.assign', 'risk.blocklist']],
  ['punish', ['order.view', 'order.hold', 'order.assign', 'risk.blocklist']],
  ['channel', ['order.claim']],
  ['channel', ['risk.blocklist']],
  ['list', ['order.view', 'order.hold', 'risk.blocklist']],
  ['detail', ['order.view', 'order.hold', 'risk.blocklist']],
];

it.each(WRONG_POINTS)(
  '[AC-B1-10n#4] %s 只有 %j（带有效动态码也一样）→ 10403 admin_permission_denied，什么都不写',
  async (action, grants) => {
    const s = await setup(h, { grants });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act({ stepUp: await s.stepUp(s.admin) }), 10403, DENIED);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

it.each(ACTIONS.filter((action) => action !== 'channel'))(
  '[AC-B1-10n#5] %s 只持 order.claim、不带动态码 → 放行（维权单、违规单与读取都没有 step-up）',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    await accepted(await act(), ANSWER[action]);
  },
  120_000,
);

it('[AC-B1-10n#6] channel 同时持 order.claim 与 risk.blocklist、动态码档 token 有效 → 放行', async () => {
  const s = await setup(h, { grants: GRANTS.channel });
  const act = await arrange(s, 'channel');
  await accepted(await act(await allowed(s, 'channel')), ANSWER.channel);
}, 120_000);

it.each([
  ['没带 X-Step-Up-Token', undefined],
  ['X-Step-Up-Token 无效', 'not-an-issued-step-up-token'],
] as const)(
  '[AC-B1-10n#7] channel %s → 10003 tier=totp，不留任务、审计与作业',
  async (_label, token) => {
    const s = await setup(h, { grants: GRANTS.channel });
    const act = await arrange(s, 'channel');
    const before = await s.state();
    await refused(await act(token === undefined ? {} : { stepUp: token }), 10003, STEP_UP_REQUIRED);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

it('[AC-B1-10n#8] channel 的动态码 token 成功后已消耗：同一个再用 → 10003', async () => {
  const s = await setup(h, { grants: GRANTS.channel });
  const act = await arrange(s, 'channel');
  const token = await s.stepUp(s.admin);
  await accepted(await act({ stepUp: token }), ANSWER.channel);
  await refused(await act({ stepUp: token }), 10003, STEP_UP_REQUIRED);
}, 120_000);

it('[AC-B1-10n#9] 别的账号的动态码 token 不算数：channel → 10003，什么都不写', async () => {
  const s = await setup(h, { grants: GRANTS.channel });
  const act = await arrange(s, 'channel');
  const other = await s.caller(GRANTS.channel);
  const before = await s.state();
  await refused(await act({ stepUp: await s.stepUp(other) }), 10003, STEP_UP_REQUIRED);
  expect(await s.state()).toEqual(before);
}, 120_000);

it.each(ACTIONS)(
  '[AC-B1-10n#10] 超管不勾权限点也可以 %s（channel 照旧要动态码）',
  async (action) => {
    const s = await setup(h, { isSuper: true });
    const act = await arrange(s, action);
    await accepted(await act(await allowed(s, action)), ANSWER[action]);
  },
  120_000,
);
