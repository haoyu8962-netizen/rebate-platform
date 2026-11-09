// B1-06zi (BR-ID-22 「授权状态按 (user_id, pid) 记录」): an own Pinduoduo open whose binding is
// active looks up the filing of this open's current slot (getActivePid) in union_pdd_pid_filings;
// none → one authority query with the conversion's identity: filed → one row, open goes on; not
// filed → 30111 (auth_jump only, state in union_auth_sessions); the port failing → 50303.
// A row present → not queried (asserted as the second half of #1, which is red on main).
// "Active, this pid unfiled" is built via activeUnfiled (pending_auth → active), never the open
// kit's `binding: 'active'`, which may seed the current slots' rows (B1-06zj).
import { randomUUID } from 'node:crypto';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { DemoUnionAdapter, type CallCtx } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { outcome, service } from '../open-pdd-auth/kit.ts';
import {
  identity,
  noAuthEntry,
  noConversion,
  response,
  success,
} from '../open-pdd-auth/assertions.ts';
import { TIMEOUT, activeUnfiled, currentPid, file, filed, filings, snapshotPid } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([
  { scene: 'search', pidScene: 'self_buy' },
  { scene: 'agent', pidScene: 'agent' },
] as const)(
  '[AC-B1-06zi#1] active 绑定缺本场景当前推广位（$pidScene）备案：查一次 authority，答已备案插一行后照常 200；再开同 pid 有备案行不再查',
  async ({ scene, pidScene }) => {
    const f = await activeUnfiled(database(), { query: true, scene });
    const before = await f.bindings();
    const open = service(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    const [queried, ctx] = f.query.mock.calls[0]!;
    // Same identity as the conversion: this scene's current slot, custom_parameters with attr_code.
    identity(f, queried, f.a.attr, pidScene);
    expect(ctx).toMatchObject({ appId: f.appId, purpose: 'online' });
    expect(JSON.stringify(f.query.mock.calls[0])).not.toMatch(/user_id|device_id/);
    expect(await filings(f)).toEqual([filed(f, f.a.userId, currentPid(pidScene), f.clock.now())]);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    expect(f.convert).toHaveBeenCalledTimes(1);
    identity(f, f.convert.mock.calls[0]![1], f.a.attr, pidScene);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(
      f.convert.mock.invocationCallOrder[0]!,
    );

    // Filed now: a new key on the same pid goes on without another query or row.
    const rows = await filings(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await filings(f)).toEqual(rows);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  { scene: 'search', pidScene: 'self_buy' },
  { scene: 'agent', pidScene: 'agent' },
] as const)(
  '[AC-B1-06zi#2] active 绑定缺本场景当前推广位（$pidScene）备案且答未备案：30111 仅 auth_jump，链接就是该 pid 身份的 pddAuthorityUrl，state 只在会话里并绑定本 link，不写备案行、绑定仍 active 不变',
  async ({ scene, pidScene }) => {
    const f = await activeUnfiled(database(), { query: false, scene });
    const before = await f.bindings();
    const open = service(f);
    const result = await response(await outcome(() => open.open(f.request())), 30111, 422);
    const data = result.envelope.data as { auth_jump: components['schemas']['AuthJumpPlan'] };
    expect(Object.keys(data)).toEqual(['auth_jump']);
    expect(f.query).toHaveBeenCalledTimes(1);
    const queried = f.query.mock.calls[0]![0];
    identity(f, queried, f.a.attr, pidScene);
    // 「生成该 pid 的备案链接」: the links are what the port answers for exactly the identity just
    // queried (current-pdd-<scene> + {app:'n', uid: attr_code, sc}). The kit adapter forwards to a
    // demo adapter of this seed, whose answer depends only on (seed, app, user key, slot).
    const ctx: CallCtx = { appId: f.appId, requestId: randomUUID(), purpose: 'online' };
    const expected = await new DemoUnionAdapter({
      platform: 'pdd',
      seed: 'pdd-auth-fixture',
      clock: f.clock,
      environment: 'test',
    }).pddAuthorityUrl(queried, ctx);
    // ios device record, installed not reported: the upstream scheme first, the web address after.
    expect(data.auth_jump.primary).toEqual({ type: 'scheme', value: expected.schema_url });
    expect(data.auth_jump.fallbacks).toContainEqual({
      type: 'h5',
      value: expected.mobile_short_url,
    });
    for (const step of [data.auth_jump.primary, ...data.auth_jump.fallbacks]) {
      expect([expected.schema_url, expected.mobile_short_url]).toContain(step.value);
    }
    const sessions = await f.sessions();
    expect(sessions).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        user_id: f.a.userId,
        device_id: f.a.deviceId,
        platform: 'pdd',
        link_id: f.row.link_id,
        used_at: null,
      }),
    ]);
    const session = sessions[0]!;
    expect(session.expire_at.getTime()).toBe(f.clock.now().getTime() + 600_000);
    expect(data.auth_jump.expire_at).toBe(session.expire_at.toISOString());
    for (const step of [data.auth_jump.primary, ...data.auth_jump.fallbacks]) {
      expect(step.type).not.toBe('sdk');
      for (const link of [step.value, decodeURIComponent(step.value)]) {
        expect(link).not.toContain(session.state);
        expect(link).not.toContain(session.state.replace(/^st_/, ''));
      }
    }
    expect(await filings(f)).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    expect(f.fetch).not.toHaveBeenCalled();
    await noConversion(f);
    expect(await f.logs()).toEqual([expect.objectContaining({ result_code: 30111 })]);
  },
  TIMEOUT,
);

it.each(['failing', 'missing'] as const)(
  '[AC-B1-06zi#3] active 绑定缺本 pid 备案、查询端口 %s：50303，不写备案行、不签发 state、绑定不变',
  async (failure) => {
    const f = await activeUnfiled(database(), {
      query: failure === 'missing' ? 'missing' : new Error('synthetic authority failure'),
    });
    const before = await f.bindings();
    const open = service(f);
    const result = await response(await outcome(() => open.open(f.request())), 50303, 503);
    noAuthEntry(result);
    expect(f.query).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 1);
    expect(await filings(f)).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    await noConversion(f);
    expect(await f.logs()).toEqual([expect.objectContaining({ result_code: 50303 })]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zi#4] 备案按 pid 不按用户：另一推广位、注册时的旧推广位、别人在本 pid 的备案都不算，active 仍查并只补本 pid',
  async () => {
    const f = await activeUnfiled(database(), { query: true });
    await file(f, f.a.userId, currentPid('agent'));
    await file(f, f.a.userId, snapshotPid('self_buy'));
    await file(f, f.b.userId, currentPid('self_buy'));
    const seeded = await filings(f);
    expect(seeded).toHaveLength(3);
    const open = service(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    identity(f, f.query.mock.calls[0]![0], f.a.attr, 'self_buy');
    const rows = await filings(f);
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      expect.arrayContaining([
        ...seeded,
        filed(f, f.a.userId, currentPid('self_buy'), f.clock.now()),
      ]),
    );
  },
  TIMEOUT,
);
