// B1-22u (编排裁定 D10-434 ②; BR-ID-24 ④, B1-22b): GET /v1/unions/{platform}/auth-url judges the
// site authorization of the account in use against the injected Clock (the use case's own
// options.clock), in both directions:
// - FixedClock earlier than the wall clock, auth_expires_at between them: not reached by the
//   injected clock → the state is issued (the wall clock would refuse);
// - FixedClock later than the wall clock, auth_expires_at between them: reached by the injected
//   clock → Taobao 30101 auth_unavailable / Pinduoduo 50301 maintenance, no state (the wall clock
//   would issue one).
// One account per platform, no binding and no slot: the account in use is the platform's only one.
import { createHash, randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createUnionAuthUrl,
  type UnionAuthUrlOptions,
} from '../../../../apps/api/src/modules/linking/application/union-auth-url.ts';
import { FixedClock, SystemClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { TRACE, validate } from '../auth-url/kit.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { DAY_MS, shifted } from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** Earlier than the wall clock. */
const PAST = '2026-10-08T04:05:06.789Z';
/** Later than the wall clock. */
const FUTURE = '2031-05-06T07:08:09.000Z';

type Platform = 'taobao' | 'pdd';

async function seed(db: Kysely<DB>, clock: FixedClock, expiry: Date) {
  const appId = `synthetic_b122u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userId = randomUUID();
  const deviceId = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: '合成授权用户',
      avatar: 'https://example.test/avatar',
      invite_code: 'syntheticinvite',
      attr_code: 'demo0001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('user_risk_state')
    .values({
      app_id: appId,
      user_id: userId,
      state: 'normal',
      changed_by: 'synthetic-fixture',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      device_hash: createHash('sha256').update(deviceId).digest('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  for (const platform of ['taobao', 'pdd'] as const) {
    await db
      .insertInto('union_accounts')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform,
        account_name: 'synthetic-clock-account',
        status: 'active',
        auth_status: 'active',
        auth_expires_at: expiry,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  // B1-06zf (D10-659): the Pinduoduo authorization link comes through the union port (the demo
  // adapter here) with the user's attr_code read from users.
  const demo = new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'b1-22u-auth-url',
    clock,
    environment: 'test',
  });
  const unionPorts = {
    registry: { get: () => demo },
    attrCodes: {
      attrCode: async (tenant: string, uid: string) => {
        const row = await db
          .selectFrom('users')
          .select('attr_code')
          .where('app_id', '=', tenant)
          .where('id', '=', uid)
          .executeTakeFirst();
        return row?.attr_code ?? null;
      },
    },
  };
  const options: UnionAuthUrlOptions = {
    db,
    clock,
    appEnv: 'test',
    callerContext: { current: async () => ({ appId, userId, deviceId }) },
    config: createContentReader({ db, clock }),
    authApps: {
      resolve: vi.fn<UnionAuthUrlOptions['authApps']['resolve']>(
        async (_app, environment, client, method) => ({
          ref: `synthetic/${environment}/${client}/${method}`,
          app_secret: 'synthetic-unused-secret',
        }),
      ),
    },
    ...unionPorts,
  };
  const sessions = () =>
    db.selectFrom('union_auth_sessions').selectAll().where('app_id', '=', appId).execute();
  return { appId, userId, deviceId, options, sessions };
}

function issue(f: Awaited<ReturnType<typeof seed>>, platform: Platform) {
  return createUnionAuthUrl(f.options).get({ platform, reportedClient: 'ios', traceId: TRACE });
}

// B1-06zf (D10-658 ①): this fixture has no Pinduoduo self_buy slot, so no authorization link can
// be generated: even with the site authorization not reached by the injected clock, 50301
// maintenance and no state.
it('[B1-22u] auth-url pdd：注入的 FixedClock 早于系统时间，站长授权到期时刻在两者之间 → 按注入时钟未到期，但没有 self_buy 推广位生成不了授权链接，50301 maintenance、不写 state', async () => {
  const db = database();
  const clock = new FixedClock(PAST);
  const expiry = shifted(clock, DAY_MS);
  // The window separates the two clocks: the wall clock is already past this instant.
  expect(new SystemClock().now().getTime()).toBeGreaterThan(expiry.getTime());
  const f = await seed(db, clock, expiry);
  const result = await issue(f, 'pdd');
  expect(result).toMatchObject({
    status: 503,
    envelope: { code: 50301, data: { reason: 'maintenance' } },
  });
  await validate(result.envelope, 'ErrorEnvelope');
  for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
    expect(result.envelope.data ?? {}).not.toHaveProperty(field);
  }
  expect(await f.sessions()).toEqual([]);
}, 60_000);

it.each(['taobao'] as const)(
  '[B1-22u] auth-url %s：注入的 FixedClock 早于系统时间，站长授权到期时刻在两者之间 → 按注入时钟未到期，照常签发 state',
  async (platform) => {
    const db = database();
    const clock = new FixedClock(PAST);
    const expiry = shifted(clock, DAY_MS);
    // The window separates the two clocks: the wall clock is already past this instant.
    expect(new SystemClock().now().getTime()).toBeGreaterThan(expiry.getTime());
    const f = await seed(db, clock, expiry);
    const result = await issue(f, platform);
    expect(result).toMatchObject({
      status: 200,
      envelope: { code: 0, data: { auth_url: expect.any(String), state: expect.any(String) } },
    });
    await validate(result.envelope, 'UnionAuthUrlResponse');
    const data = result.envelope.data as { state: string };
    expect(await f.sessions()).toEqual([
      expect.objectContaining({
        state: data.state,
        app_id: f.appId,
        user_id: f.userId,
        device_id: f.deviceId,
        platform,
        mode: 'bind',
        link_id: null,
        used_at: null,
      }),
    ]);
  },
  60_000,
);

/** BR-ID-24 ④: Taobao 30101 auth_unavailable (no unreleased binding); Pinduoduo 50301 maintenance. */
const REFUSAL = {
  taobao: [30101, 422, 'auth_unavailable'],
  pdd: [50301, 503, 'maintenance'],
} as const;

it.each(['taobao', 'pdd'] as const)(
  '[B1-22u] auth-url %s：注入的 FixedClock 晚于系统时间，站长授权到期时刻在两者之间 → 按注入时钟已到期，拒绝且不写 state',
  async (platform) => {
    const db = database();
    const clock = new FixedClock(FUTURE);
    const expiry = shifted(clock, -DAY_MS);
    // The window separates the two clocks: the wall clock has not reached this instant yet.
    expect(new SystemClock().now().getTime()).toBeLessThan(expiry.getTime());
    const f = await seed(db, clock, expiry);
    const result = await issue(f, platform);
    const [code, status, reason] = REFUSAL[platform];
    expect(result).toMatchObject({ status, envelope: { code, data: { reason } } });
    await validate(result.envelope, 'ErrorEnvelope');
    for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
      expect(result.envelope.data ?? {}).not.toHaveProperty(field);
    }
    expect(await f.sessions()).toEqual([]);
  },
  60_000,
);
