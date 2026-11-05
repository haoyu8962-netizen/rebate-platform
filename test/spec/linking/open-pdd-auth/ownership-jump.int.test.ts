import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { expectOpaqueState } from '../auth-url/kit.ts';
import { identity, noConversion, response } from './assertions.ts';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service, type Fixture } from './kit.ts';

const database = databaseFixture(createTestDatabase);

async function expectNewLinkAuthorization(f: Fixture, person: 'a' | 'b') {
  const opener = f[person];
  const before = await f.bindings();
  const result = await response(
    await outcome(() => service(f).open(f.request({ installed: 'true' }))),
    30111,
    422,
  );
  expect(result.envelope.data).toEqual({ auth_jump: expect.any(Object) });
  const data = result.envelope.data as { auth_jump: components['schemas']['AuthJumpPlan'] };
  expect(Object.keys(data)).toEqual(['auth_jump']);

  expect(f.query).toHaveBeenCalledTimes(1);
  identity(f, f.query.mock.calls[0]![0], opener.attr, 'self_buy');
  const links = await f.links();
  expect(links).toHaveLength(2);
  const served = links.find((row) => row.link_id !== f.row.link_id);
  expect(served).toMatchObject({
    user_id: opener.userId,
    pid_scene: 'self_buy',
    identity_snapshot: { user_id: opener.userId, attr_code: opener.attr },
  });

  const sessions = await f.sessions();
  expect(sessions).toHaveLength(1);
  const session = sessions[0]!;
  expect(session).toMatchObject({
    app_id: f.appId,
    user_id: opener.userId,
    device_id: opener.deviceId,
    platform: 'pdd',
    mode: 'bind',
    link_id: served!.link_id,
    client: 'ios',
    used_at: null,
  });
  expect(session.link_id).not.toBe(f.row.link_id);
  expectOpaqueState(session.state, opener.userId, opener.deviceId);
  expect(session.expire_at.getTime()).toBe(f.clock.now().getTime() + 600_000);
  expect(data.auth_jump.expire_at).toBe(session.expire_at.toISOString());
  // B1-06zf (D10-658 ③): the jump is over the union's own authorization link; the state stays in
  // the session row (bound above to uid, device and the served link) and is never in a link.
  for (const step of [data.auth_jump.primary, ...data.auth_jump.fallbacks]) {
    expect(step.type).not.toBe('sdk');
    expect(step).not.toHaveProperty('sdk');
    for (const link of [step.value, decodeURIComponent(step.value)]) {
      expect(link).not.toContain('example.test');
      expect(link).not.toContain(session.state);
      expect(link).not.toContain(encodeURIComponent(session.state));
      expect(link).not.toContain(session.state.replace(/^st_/, ''));
    }
  }
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.bindings()).toEqual(before);
  await noConversion(f);
}

it('[AC-B1-06v#20] B 开 A 非分享 link 未授权：仅返回 auth_jump，跳转链接里不含 state；会话照旧绑 B、B 的设备与 B 的新 link', async () => {
  const f = await fixture(database(), { binding: 'active', query: false });
  await f.bind('absent', f.b.userId);
  f.opener('b');
  await expectNewLinkAuthorization(f, 'b');
}, 60_000);

it('[AC-B1-06v#21] A 开自己的分享 link 未授权：仅返回 auth_jump，跳转链接里不含 state；会话照旧绑 A、A 的设备与新 self_buy link', async () => {
  const f = await fixture(database(), { binding: 'absent', query: false, scene: 'share' });
  f.opener('a');
  await expectNewLinkAuthorization(f, 'a');
}, 60_000);
