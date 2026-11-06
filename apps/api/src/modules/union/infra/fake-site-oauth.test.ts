// B1-22d: the admin entry gets the fake site OAuth only in local / test; elsewhere no provider,
// announced once without any secret. The session audit rows take the contract's action names.
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { reauthAuditWriter } from '../application/admin-accounts.ts';
import type { UnionAuditInput } from '../pids/service.ts';
import { createSiteOAuthProviders } from './fake-site-oauth.ts';
import type { UnionTransport, UnionTransportRequest } from './replay.ts';

const clock = new FixedClock('2026-10-09T02:00:00.000Z');

function recorder() {
  const lines: unknown[][] = [];
  return { lines, logger: { warn: (...args: unknown[]) => void lines.push(args) } };
}

it('[B1-22d][BR-ID-24] local / test 装配三个平台的假授权，不打日志', () => {
  for (const appEnv of ['local', 'test']) {
    const { lines, logger } = recorder();
    const providers = createSiteOAuthProviders(appEnv, clock, logger as never);
    expect(Object.keys(providers).sort()).toEqual(['jd', 'pdd', 'taobao']);
    expect(lines).toEqual([]);
  }
});

it('[B1-22d][BR-ID-24] staging / prod 不装假实现，只打一条 union_site_oauth_unconfigured', () => {
  for (const appEnv of ['staging', 'prod']) {
    const { lines, logger } = recorder();
    expect(createSiteOAuthProviders(appEnv, clock, logger as never)).toEqual({});
    expect(lines).toEqual([[{ app_env: appEnv }, 'union_site_oauth_unconfigured']]);
  }
});

it('[B1-04zzi] staging / prod 装配齐备时只给淘宝真实 provider，换令牌直接走传入的传输（不归档）', async () => {
  for (const appEnv of ['staging', 'prod']) {
    const { lines, logger } = recorder();
    const requests: UnionTransportRequest[] = [];
    const transport: UnionTransport = async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: JSON.stringify({ access_token: 'unit-access' }) };
    };
    const providers = createSiteOAuthProviders(appEnv, clock, logger as never, {
      taobaoCredentials: { appKey: 'unit-key', appSecret: 'unit-unit-unit-unit' },
      taobaoRedirectUri: 'https://console.fake-unit.test/unions/oauth-callback',
      transport,
    });
    expect(Object.keys(providers)).toEqual(['taobao']);
    await providers.taobao!.exchange({ appId: 'a', unionAccountId: 'u', code: 'unit-code' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.archive).toBeUndefined();
    expect(lines).toEqual([]);
  }
});

it('[B1-04zzi] staging 缺回调地址：不装淘宝 provider，一条 union_site_oauth_unconfigured', () => {
  const { lines, logger } = recorder();
  const providers = createSiteOAuthProviders('staging', clock, logger as never, {
    taobaoCredentials: { appKey: 'unit-key', appSecret: 'unit-unit-unit-unit' },
    taobaoRedirectUri: null,
    transport: () => Promise.reject(new Error('unused')),
  });
  expect(providers).toEqual({});
  expect(lines).toEqual([[{ app_env: 'staging' }, 'union_site_oauth_unconfigured']]);
});

it('[B1-22d][BR-ID-24] 会话审计按契约改名，其余动作原样', async () => {
  const written: UnionAuditInput[] = [];
  const writer = reauthAuditWriter(() => ({
    append: (input) => {
      written.push(input);
      return Promise.resolve();
    },
  }));
  const base = { appId: 'couli', actor: 'a', target: 't', before: null, after: null, ip: null };
  const bound = writer(undefined as never);
  for (const action of ['union.reauth_start', 'union.reauth_succeeded', 'union_other']) {
    await bound.append({ ...base, action });
  }
  expect(written.map((input) => input.action)).toEqual([
    'union_account_reauthorize_start',
    'union_account_reauthorize',
    'union_other',
  ]);
});
