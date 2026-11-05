import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createUnionAuthUrl } from '../../../../apps/api/src/modules/linking/application/union-auth-url.ts';
import { expectOpaqueState, normalizedJump } from '../auth-url/kit.ts';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service } from './kit.ts';
import { noConversion, response, success } from './assertions.ts';

const database = databaseFixture(createTestDatabase);

it.each(['true', 'false', undefined] as const)(
  '[AC-B1-06v#8] installed=%s 未授权回 30111，仅 auth_jump，跳转链接里不含 state，会话绑定当前设备与服务 link，可重放',
  async (installed) => {
    const f = await fixture(database(), { binding: 'invalid', query: false });
    const before = await f.bindings();
    const open = service(f);
    // Deliberately disagree with the ios device record; authorization must use that record.
    const request = f.request({
      client: 'android',
      ...(installed === undefined ? {} : { installed }),
    });
    const result = await response(await outcome(() => open.open(request)), 30111, 422);
    const data = result.envelope.data as { auth_jump: components['schemas']['AuthJumpPlan'] };
    expect(Object.keys(data)).toEqual(['auth_jump']);
    expect(data.auth_jump.primary.type).toBe(installed === 'false' ? 'h5' : 'scheme');
    const sessions = await f.sessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session).toMatchObject({
      app_id: f.appId,
      user_id: f.a.userId,
      device_id: f.a.deviceId,
      platform: 'pdd',
      mode: 'bind',
      link_id: f.row.link_id,
      client: 'ios',
      used_at: null,
      auth_methods: null,
      auth_app_refs: null,
    });
    expect(session.expire_at.getTime()).toBe(f.clock.now().getTime() + 600_000);
    expect(data.auth_jump.expire_at).toBe(session.expire_at.toISOString());
    expectOpaqueState(session.state, f.a.userId, f.a.deviceId);
    // B1-06zf (D10-658 ③): the jump is over the union's own authorization link; the state stays in
    // the session row (bound above to uid, device and link) and is never in a link.
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
    await noConversion(f);
    expect(await f.bindings()).toEqual(before);
    expect(await f.logs()).toEqual([expect.objectContaining({ result_code: 30111 })]);
    const logs = await f.logs();
    expect(await outcome(() => open.open(request))).toEqual(result);
    expect(await f.sessions()).toEqual(sessions);
    expect(await f.logs()).toEqual(logs);
    expect(f.query).toHaveBeenCalledTimes(1);

    // B1-06zf (D10-659): the auth-url builds its link through the same union port and attr_code.
    const unionPorts = { registry: f.options.registry, attrCodes: f.options.attrCodes };
    const auth = createUnionAuthUrl({
      db: database(),
      clock: f.clock,
      callerContext: f.options.callerContext,
      config: f.options.config,
      pids: f.options.pids,
      appEnv: 'test',
      jumpEnvironment: f.options.environment,
      authApps: { resolve: async () => ({ ref: 'synthetic-unused' }) },
      ...unionPorts,
    });
    const comparison = await auth.get({
      platform: 'pdd',
      reportedClient: 'android',
      traceId: request.traceId,
      ...(installed === undefined ? {} : { installed }),
    });
    expect(comparison.status).toBe(200);
    const expected = comparison.envelope.data as components['schemas']['UnionAuthUrlData'];
    const normalized = JSON.parse(
      JSON.stringify(data.auth_jump).replaceAll(
        encodeURIComponent(session.state),
        '<issued-state>',
      ),
    ) as unknown;
    expect(normalized).toEqual(normalizedJump(expected));
  },
  60_000,
);

it('[AC-B1-06v#9] 授权完成后新键重新查询并置 active，旧键仍重放原 30111', async () => {
  const f = await fixture(database(), { binding: 'pending_auth', query: false });
  const open = service(f);
  const oldRequest = f.request();
  const first = await response(await outcome(() => open.open(oldRequest)), 30111, 422);
  const sessions = await f.sessions();
  f.query.mockResolvedValue({ authorized: true });
  const newRequest = f.request();
  expect(newRequest.idempotencyKey).not.toBe(oldRequest.idempotencyKey);
  await success(await outcome(() => open.open(newRequest)));
  expect(await f.bindings()).toEqual([
    expect.objectContaining({ id: f.bindingId, status: 'active' }),
  ]);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(await outcome(() => open.open(oldRequest))).toEqual(first);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(await f.sessions()).toEqual(sessions);
  expect(await f.logs()).toHaveLength(2);
  expect(await f.attempts()).toHaveLength(1);
}, 60_000);
