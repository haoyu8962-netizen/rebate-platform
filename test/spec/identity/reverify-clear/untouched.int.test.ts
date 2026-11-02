// B1-02zw · what must not unbind or clear (contract adminEditUserProfile: a nickname-only edit, and a
// phone edit of an account without the flag, neither unbind nor clear anything; task §9 #3: a phone
// equal to the current one after normalisation is not edited; a refused save writes nothing;
// BR-WDR-01 细则: 只核实身份、不改号的不清除标记). Today's code is green on each first half, so every
// case ends with a control: a real phone change of the same account, or of a flagged peer.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  SEED_WORD,
  blocked,
  devices,
  edit,
  ok,
  rejected,
  sessionsOf,
  testPhone,
  user,
  type EditBody,
  type User,
} from '../admin-profile/kit.ts';
import {
  TOKEN,
  account,
  expectCleared,
  guarded,
  phoneChangeClears,
  providersOf,
  reverified,
  scene,
  world,
  type Scene,
} from './kit.ts';

const h = useHarness();

const spaced = (p: string) => `+86 ${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`;

/** A flagged account with something to unbind, an Apple token included. */
async function flagged(s: Scene): Promise<User> {
  const target = await account(s, {
    bound: ['apple', 'huawei', 'wechat'],
    trusted: ['wechat'],
    realname: true,
    token: TOKEN,
    failures: 2,
  });
  await reverified(s, target, 'self');
  await devices(h, s.clock, target, 2);
  return target;
}

it('[AC-B1-02zw#8] 只改昵称：不解绑、不清标记、不写作业、不吊销会话；之后真改号才清', async () => {
  const s = await scene(h);
  const target = await flagged(s);
  const before = await guarded(s, target);
  const sessions = await sessionsOf(h, target);
  await ok(await edit(s, target.id, { nickname: '小狸', reason: REASON }));
  expect(await guarded(s, target)).toEqual(before);
  expect(await sessionsOf(h, target)).toEqual(sessions);
  expect(s.sent).toEqual([]);
  await phoneChangeClears(s, target);
});

it('[AC-B1-02zw#9] 账号无标记时改手机号：不解绑、已加验设备不动、不写作业；同一请求路径上有标记的账号才清', async () => {
  const s = await scene(h);
  const target = await account(s, {
    bound: ['apple', 'huawei'],
    token: TOKEN,
    flagged: false,
  });
  await reverified(s, target, 'admin');
  const before = await guarded(s, target);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await guarded(s, target)).toEqual(before);
  expect(s.sent).toEqual([]);
  const peer = await account(s, { bound: ['huawei'] });
  await phoneChangeClears(s, peer);
  expect(await providersOf(s, peer)).toEqual([]);
});

it.each([
  { name: '只提交原号', body: (phone: string): EditBody => ({ phone: spaced(phone) }) },
  {
    name: '原号加新昵称',
    body: (phone: string): EditBody => ({ phone: spaced(phone), nickname: '小狸' }),
  },
])(
  '[AC-B1-02zw#10] 手机号规范化后等于原号（$name）：视为未改，不解绑、不清标记、不写作业；之后真改号才清',
  async ({ body }) => {
    const s = await scene(h);
    const target = await flagged(s);
    const before = await guarded(s, target);
    const sessions = await sessionsOf(h, target);
    await ok(await edit(s, target.id, { ...body(target.phone!), reason: REASON }));
    expect(await guarded(s, target)).toEqual(before);
    expect(await sessionsOf(h, target)).toEqual(sessions);
    expect(s.sent).toEqual([]);
    await phoneChangeClears(s, target);
  },
);

interface Refusal {
  name: string;
  body: (s: Scene) => Promise<EditBody>;
  code: number;
  data?: object;
}

const REFUSALS: Refusal[] = [
  {
    name: '号码不合规 20001',
    body: async () => ({ phone: '12345' }),
    code: 20001,
    data: { fields: ['phone'], reason: 'phone_invalid' },
  },
  {
    name: '新号在黑名单 44001',
    body: async (s) => {
      const next = testPhone();
      await blocked(h, s.clock, s.appId, next);
      return { phone: next };
    },
    code: 44001,
  },
  {
    name: '新号已被占用 30411',
    body: async (s) => ({ phone: (await user(h, s.appId)).phone }),
    code: 30411,
  },
  {
    name: '同时提交的昵称不过审 20001',
    body: async () => ({ phone: testPhone(), nickname: `小${SEED_WORD}狸` }),
    code: 20001,
    data: { fields: ['nickname'], reason: 'nickname_sensitive' },
  },
];

it.each(REFUSALS)(
  '[AC-B1-02zw#11] 保存被拒（$name）：什么都不写，绑定、标记、作业都不动；之后改成合规号码才清',
  async ({ body, code, data }) => {
    const s = await scene(h);
    const target = await flagged(s);
    const payload = await body(s);
    const before = await world(s);
    await rejected(await edit(s, target.id, { ...payload, reason: REASON }), code, data);
    expect(await world(s)).toEqual(before);
    expect(s.sent).toEqual([]);
    await phoneChangeClears(s, target);
    await expectCleared(s, target);
  },
);
