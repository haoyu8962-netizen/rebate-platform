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
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { TRACE, validate } from '../auth-url/kit.ts';
import { databaseFixture, driftedAccounts, interleavedAccounts, type AuthPlatform } from './kit.ts';

// B1-22l (D10-239 ①; BR-ID-24 ④): the auth-url judges the site authorization of the account
// this authorization uses; with no unreleased binding and no active self_buy slot that is the
// platform's earliest-registered account. The use case runs with its default read-only pid
// reader over real (empty) union_pids rows.
const database = databaseFixture(createTestDatabase);
const NOW = '2026-10-23T04:05:06.789Z';

async function seed(db: Kysely<DB>) {
  const clock = new FixedClock(NOW);
  const appId = `synthetic_fallback_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
  // B1-06zf (D10-659): the Pinduoduo authorization link comes through the union port (the demo
  // adapter here) with the user's attr_code read from users.
  const demo = new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'b1-22l-auth-url',
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
  /** A released binding is not unreleased: it never decides the account (BR-ID-19). */
  const release = async (accountId: string, platform: AuthPlatform) => {
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: userId,
        platform,
        union_account_id: accountId,
        status: 'released',
        released_at: new Date('2026-01-01T00:00:00.000Z'),
        cooldown_until: new Date('2026-02-01T00:00:00.000Z'),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  };
  return { appId, userId, deviceId, options, sessions, release };
}

function issue(f: Awaited<ReturnType<typeof seed>>, platform: AuthPlatform) {
  return createUnionAuthUrl(f.options).get({ platform, reportedClient: 'ios', traceId: TRACE });
}

/** BR-ID-24 ④: Taobao 30101 auth_unavailable (no unreleased binding); Pinduoduo 50301 maintenance. */
const refusal = {
  taobao: [30101, 422, 'auth_unavailable'],
  pdd: [50301, 503, 'maintenance'],
} as const;

it.each([
  ['taobao', 'absent'],
  ['taobao', 'released'],
  ['pdd', 'absent'],
  ['pdd', 'released'],
] as const)(
  '[B1-22l] %s 绑定 %s、无 self_buy 位：最早登记的账号站长授权 expired 即拒绝，较晚登记却更早更新的有效账号不能替代',
  async (platform, binding) => {
    const db = database();
    const f = await seed(db);
    const { later } = await driftedAccounts(db, f.appId, platform, {
      first: 'expired',
      later: 'active',
    });
    if (binding === 'released') await f.release(later, platform);
    const result = await issue(f, platform);
    const [code, status, reason] = refusal[platform];
    expect(result).toMatchObject({ status, envelope: { code, data: { reason } } });
    await validate(result.envelope, 'ErrorEnvelope');
    for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
      expect(result.envelope.data ?? {}).not.toHaveProperty(field);
    }
    expect(await f.sessions()).toEqual([]);
  },
  60_000,
);

/**
 * B1-06zf (D10-658 ①): with no self_buy slot no Pinduoduo authorization link can be generated,
 * so even a valid account answers 50301 maintenance and writes no state.
 */
async function expectNoSlotMaintenance(
  f: Awaited<ReturnType<typeof seed>>,
  result: Awaited<ReturnType<typeof issue>>,
) {
  expect(result).toMatchObject({
    status: 503,
    envelope: { code: 50301, data: { reason: 'maintenance' } },
  });
  await validate(result.envelope, 'ErrorEnvelope');
  for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
    expect(result.envelope.data ?? {}).not.toHaveProperty(field);
  }
  expect(await f.sessions()).toEqual([]);
}

it.each([
  ['pdd', 'absent'],
  ['pdd', 'released'],
] as const)(
  '[B1-22l] %s 绑定 %s、无 self_buy 位：最早登记的账号有效、较晚登记的账号 expired，但没有 self_buy 推广位生成不了授权链接 → 50301 maintenance，不写 state',
  async (platform, binding) => {
    const db = database();
    const f = await seed(db);
    const { later } = await driftedAccounts(db, f.appId, platform, {
      first: 'active',
      later: 'expired',
    });
    if (binding === 'released') await f.release(later, platform);
    await expectNoSlotMaintenance(f, await issue(f, platform));
  },
  60_000,
);

it.each([
  ['taobao', 'absent'],
  ['taobao', 'released'],
] as const)(
  '[B1-22l] %s 绑定 %s、无 self_buy 位：最早登记的账号有效即签发，不因较晚登记的账号 expired 而拒绝',
  async (platform, binding) => {
    const db = database();
    const f = await seed(db);
    const { later } = await driftedAccounts(db, f.appId, platform, {
      first: 'active',
      later: 'expired',
    });
    if (binding === 'released') await f.release(later, platform);
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

// Update order not the reverse of registration order: the most recently re-authorized account
// and the earliest-updated one both carry the other site authorization.
it.each(['taobao', 'pdd'] as const)(
  '[B1-22l] %s 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号 expired 即拒绝，最近重新授权或最早更新的有效账号都不能替代',
  async (platform) => {
    const db = database();
    const f = await seed(db);
    await interleavedAccounts(db, f.appId, platform, { first: 'expired', others: 'active' });
    const result = await issue(f, platform);
    const [code, status, reason] = refusal[platform];
    expect(result).toMatchObject({ status, envelope: { code, data: { reason } } });
    await validate(result.envelope, 'ErrorEnvelope');
    for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
      expect(result.envelope.data ?? {}).not.toHaveProperty(field);
    }
    expect(await f.sessions()).toEqual([]);
  },
  60_000,
);

it('[B1-22l] pdd 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号有效，但没有 self_buy 推广位生成不了授权链接 → 50301 maintenance，不写 state', async () => {
  const db = database();
  const f = await seed(db);
  await interleavedAccounts(db, f.appId, 'pdd', { first: 'active', others: 'expired' });
  await expectNoSlotMaintenance(f, await issue(f, 'pdd'));
}, 60_000);

it.each(['taobao'] as const)(
  '[B1-22l] %s 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号有效即签发，最近重新授权或最早更新的账号 expired 不影响',
  async (platform) => {
    const db = database();
    const f = await seed(db);
    await interleavedAccounts(db, f.appId, platform, { first: 'active', others: 'expired' });
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
