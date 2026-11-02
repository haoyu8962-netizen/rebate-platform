// B1-02zz §9 #3, #4, #7 · which devices are this user's (contract adminListUserDevices; D10-571 ⑨,
// D10-585): one a session of this user was bound to, revoked sessions included, and the device
// itself not revoked. devices.user_id decides nothing: devices are shared per install and nothing
// writes it. An unknown user_id, or one of another app, is 20001 [user_id].
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NOT_UUIDS,
  REVOKED,
  device,
  ids,
  list,
  minutesAgo,
  normal,
  owned,
  pageOf,
  readOnly,
  rejected,
  revoke,
  row,
  sessionOn,
  setup,
  user,
} from './kit.ts';

const h = useHarness();

const UNKNOWN_USER = { fields: ['user_id'] };

it('[AC-B1-02zz#10] 用户的设备看 sessions：活会话、只有已吊销会话、两种都有的设备都列出', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const live = await owned(s, target, { lastSeenAt: minutesAgo(s, 1) });
  const ended = await owned(s, target, { lastSeenAt: minutesAgo(s, 2) }, REVOKED);
  const both = await owned(s, target, { lastSeenAt: minutesAgo(s, 3) }, REVOKED);
  await sessionOn(s, target, both);
  const page = await pageOf(s, target);
  expect(page.items.map(normal)).toEqual([row(live), row(ended), row(both)]);
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 3 });
});

it.each([
  { case: '两个账号的会话都活着', session: {} },
  { case: '先用的账号会话已吊销、设备之后由别的账号在用', session: REVOKED },
])('[AC-B1-02zz#11] 同一台设备两个账号都用过（$case）：两边都列出', async ({ session }) => {
  const s = await setup(h);
  const first = await user(h, s.appId);
  const second = await user(h, s.appId);
  const shared = await owned(s, first, {}, session);
  await sessionOn(s, second, shared);
  for (const owner of [first, second]) {
    const page = await pageOf(s, owner);
    expect(page.items.map(normal)).toEqual([row(shared)]);
    expect(page.total).toBe(1);
  }
});

it('[AC-B1-02zz#12] 不列：别的用户（活的、已吊销的会话）的设备、没有任何会话的设备、别的 app 的设备；X-App-Id 改不了范围', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const mine = await owned(s, target, { lastSeenAt: minutesAgo(s, 60) });
  const someone = await user(h, s.appId);
  const theirs = await owned(s, someone);
  const theirsEnded = await owned(s, someone, {}, REVOKED);
  await device(s, s.appId);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp);
  await owned(s, foreign);
  const scopes: Record<string, string>[] = [{}, { 'x-app-id': otherApp }];
  for (const headers of scopes) {
    const page = await pageOf(s, target, { headers });
    expect(page.items.map(normal)).toEqual([row(mine)]);
    expect(page.total).toBe(1);
  }
  const page = await pageOf(s, someone);
  expect(ids(page).sort()).toEqual([theirs.id, theirsEnded.id].sort());
  expect(page.total).toBe(2);
});

it('[AC-B1-02zz#13] 一条也不依赖 devices.user_id：列上写着本人而无本人会话的不列，列上写着别人或空而有本人会话的列出', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const other = await user(h, s.appId);
  await device(s, s.appId, { userColumn: target, lastSeenAt: minutesAgo(s, 1) });
  const lent = await owned(s, other, { userColumn: target, lastSeenAt: minutesAgo(s, 2) });
  const used = await owned(s, target, { userColumn: other, lastSeenAt: minutesAgo(s, 3) });
  const plain = await owned(s, target, { lastSeenAt: minutesAgo(s, 4) });

  const mine = await pageOf(s, target);
  expect(mine.items.map(normal)).toEqual([row(used), row(plain)]);
  expect(mine.total).toBe(2);
  const theirs = await pageOf(s, other);
  expect(theirs.items.map(normal)).toEqual([row(lent)]);
  expect(theirs.total).toBe(1);
});

it('[AC-B1-02zz#14] 设备表已吊销的不列（本用户的活会话、已吊销会话都不算），也不计入 total', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const kept = await owned(s, target, { lastSeenAt: minutesAgo(s, 30) });
  const gone = await owned(s, target);
  const goneEnded = await owned(s, target, {}, REVOKED);
  await revoke(s, gone);
  await revoke(s, goneEnded);
  const page = await pageOf(s, target);
  expect(page.items.map(normal)).toEqual([row(kept)]);
  expect(page.total).toBe(1);
});

it('[AC-B1-02zz#15] 未知 user_id、别的 app 的用户（带不带 X-App-Id）都是 20001 [user_id]，不漏设备、什么都不写', async () => {
  const s = await setup(h);
  // A real local account with a device stays present: a read that drops the user filter must show.
  await owned(s, await user(h, s.appId));
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await user(h, otherApp);
  const stray = await owned(s, foreign);
  const nothingChanged = await readOnly(s);
  const cases: [string, Record<string, string>][] = [
    [randomUUID(), {}],
    [foreign.id, {}],
    [foreign.id, { 'x-app-id': otherApp }],
  ];
  for (const [id, headers] of cases) {
    const response = await list(s, id, { headers });
    await rejected(response, 20001, UNKNOWN_USER);
    expect(JSON.stringify(response.json())).not.toContain(stray.id);
  }
  await nothingChanged();
});

it.each([...NOT_UUIDS, 'a'.repeat(65)])(
  '[AC-B1-02zz#16] user_id 不是 UUID（%s）→ 20001 [user_id]，不是 5XX，什么都不写、不记审计',
  async (id) => {
    const s = await setup(h);
    const nothingChanged = await readOnly(s);
    await rejected(await list(s, id), 20001, UNKNOWN_USER);
    await nothingChanged();
  },
);

it('[AC-B1-02zz#17] 用户存在、一台设备也没有：200 空列表，total 0，不是 20001', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await owned(s, await user(h, s.appId));
  await device(s, s.appId);
  expect(await pageOf(s, target)).toEqual({ items: [], page: 1, page_size: 20, total: 0 });
});
