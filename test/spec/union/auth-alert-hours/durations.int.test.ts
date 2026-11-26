import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { AdminUnionAccounts } from '../../../../apps/api/src/modules/union/application/admin-accounts.ts';
import { createSiteReauth } from '../../../../apps/api/src/modules/union/auth-expiry/reauth.ts';
import { createTaobaoSiteOAuth } from '../../../../apps/api/src/modules/union/infra/taobao/site-oauth.ts';
import {
  DAY_MS,
  account,
  adminEntry,
  currentCredential,
  databaseFixture,
  harness,
  later,
  type Harness,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);
const ACCESS = 'fixture-taobao-access-value';
const REFRESH = 'fixture-taobao-refresh-value';
const CODE = 'fixture-taobao-grant';
const MANUAL = 'fixture-manual-key';
const DURATION_KEY = /(?:re|r1|r2|w1|w2)_?expires_?in/i;

/** The real parser receives a synthetic token-endpoint result through its injected transport. */
async function callback(h: Harness, id: string, durations: Record<string, unknown>) {
  const taobao = createTaobaoSiteOAuth({
    clock: h.clock,
    credentials: async () => ({ appKey: 'fixture-key', appSecret: 'fixture-secret' }),
    redirectUri: 'https://console.example.test/unions/oauth-callback',
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: DAY_MS / 1000,
        ...durations,
      }),
    }),
  });
  const reauthOptions = {
    ...h.options,
    auditWriter: h.auditWriter,
    oauth: { taobao },
  };
  const accounts = new AdminUnionAccounts({
    db: h.db,
    clock: h.clock,
    crypto: h.crypto,
    logger: h.logger,
    config: () => h.config,
    auditWriter: h.auditWriter,
    reauth: createSiteReauth(reauthOptions),
  });
  const start = await accounts.start(h.actor, id, {});
  const state = new URL(start.auth_url).searchParams.get('state');
  expect(state).toEqual(expect.any(String));
  const response = await accounts.callback(h.actor, { state: state!, code: CODE });
  expect(response.status).toBe('succeeded');
  return response;
}

function expectNoDurationsOrTokens(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(DURATION_KEY);
  for (const token of [ACCESS, REFRESH, CODE, MANUAL]) expect(text).not.toContain(token);
}

it('[AC-B1-22zd#6] 淘宝回调保留五项整数，换授权时缺省、非整数、负数逐列落 null，日志与审计无时长或令牌', async () => {
  const h = await harness(db());
  const id = (await account(h)).id;
  const original = await callback(h, id, {
    re_expires_in: 70001,
    r1_expires_in: 60002,
    r2_expires_in: 50003,
    w1_expires_in: 40004,
    w2_expires_in: 30005,
  });
  const first = await currentCredential(h, id);

  h.clock.advanceMs(60_000);
  const renewed = await callback(h, id, {
    re_expires_in: 0,
    r2_expires_in: 1.5,
    w1_expires_in: -1,
    w2_expires_in: 11,
  });
  const second = await currentCredential(h, id);

  expect(first).toMatchObject({
    re_expires_in_s: 70001,
    r1_expires_in_s: 60002,
    r2_expires_in_s: 50003,
    w1_expires_in_s: 40004,
    w2_expires_in_s: 30005,
  });
  expect(second.id).not.toBe(first.id);
  expect(second).toMatchObject({
    re_expires_in_s: 0,
    r1_expires_in_s: null,
    r2_expires_in_s: null,
    w1_expires_in_s: null,
    w2_expires_in_s: 11,
  });
  expectNoDurationsOrTokens([h.lines, h.append.mock.calls, original, renewed]);
});

it('[AC-B1-22zd#7] 列表取当前凭据的 true、false 或未知，手工录入和无凭据也是未知', async () => {
  const h = await harness(db());
  h.settings.set('attr.jd.user_key_mode', 'private_position');
  const service = await adminEntry(h);
  const rotating = await account(h);
  const noCredential = await account(h);
  const manual = await account(h, { platform: 'jd' });

  await callback(h, rotating.id, { re_expires_in: 321 });
  const positive = await service.list(h.appId);
  h.clock.advanceMs(60_000);
  await callback(h, rotating.id, { re_expires_in: 0 });
  const zero = await service.list(h.appId);
  h.clock.advanceMs(60_000);
  await callback(h, rotating.id, {});
  const entered = await service.putCredential(h.actor, manual.id, {
    credential: MANUAL,
    expires_at: later(h, 30 * DAY_MS).toISOString(),
  });
  const unknown = await service.list(h.appId);

  expect(positive.find((row) => row.union_account_id === rotating.id)?.auth_refreshable).toBe(true);
  expect(zero.find((row) => row.union_account_id === rotating.id)?.auth_refreshable).toBe(false);
  for (const id of [rotating.id, noCredential.id, manual.id]) {
    const row = unknown.find((item) => item.union_account_id === id);
    expect(row).toBeDefined();
    expect(row?.auth_refreshable ?? null).toBeNull();
  }
  expect(entered.auth_refreshable ?? null).toBeNull();
  expect(await currentCredential(h, manual.id)).toMatchObject({
    re_expires_in_s: null,
    r1_expires_in_s: null,
    r2_expires_in_s: null,
    w1_expires_in_s: null,
    w2_expires_in_s: null,
  });
  expectNoDurationsOrTokens([positive, zero, unknown, entered]);
});
