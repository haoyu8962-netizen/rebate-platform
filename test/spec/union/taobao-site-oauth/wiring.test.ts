// B1-04zzi / D10-680: the admin entry's provider set. local / test keep the B1-22d fake; staging and
// prod get the real Taobao provider only with appKey, secret and redirect URI all present (jd and
// pdd stay without one); missing any → no taobao provider, the start fails closed and the
// `union_site_oauth_unconfigured` warn stays.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createSiteOAuthProviders,
  type SiteOAuthWiring,
} from '../../../../apps/api/src/modules/union/infra/fake-site-oauth.ts';
import {
  APP_ID,
  APP_KEY,
  AUTHORIZE_ENDPOINT,
  CODE,
  DESCRIPTION,
  NOW,
  REDIRECT,
  SECRET,
  TOKEN_ENDPOINT,
  UNION_ACCOUNT_ID,
  jsonAnswer,
  stubTransport,
  tokenAnswer,
  visible,
} from './kit.ts';

const INPUT = { appId: APP_ID, unionAccountId: UNION_ACCOUNT_ID };
const STATE = 'd2lyaW5nLXN0YXRlLWZpeHR1cmUtYWJjZGVmZ2hpamts';

function recorder() {
  const lines: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void lines.push(args) };
  return { lines, logger: logger as unknown as Parameters<typeof createSiteOAuthProviders>[2] };
}

function wiring(patch: Partial<SiteOAuthWiring> = {}) {
  const stub = stubTransport(() => jsonAnswer(200, tokenAnswer()));
  const value: SiteOAuthWiring = {
    taobaoCredentials: Object.freeze({ appKey: APP_KEY, appSecret: SECRET }),
    taobaoRedirectUri: REDIRECT,
    transport: stub.transport,
    ...patch,
  };
  return { value, requests: stub.requests };
}

const AUTHORIZE_INPUT = {
  ...INPUT,
  state: STATE,
  expiresAt: new Date('2032-03-01T04:15:06.000Z'),
};

function unconfiguredWarnings(lines: unknown[][]) {
  return lines.filter((args) => args.includes('union_site_oauth_unconfigured'));
}

it.each(['staging', 'prod'])(
  '[AC-B1-04zzi#11] %s 三项齐备：只装淘宝真实 provider，京东、拼多多仍为空',
  async (appEnv) => {
    const { lines, logger } = recorder();
    const { value, requests } = wiring();
    const providers = createSiteOAuthProviders(appEnv, new FixedClock(NOW), logger, value);
    expect(providers.taobao).toBeDefined();
    expect(providers.jd).toBeUndefined();
    expect(providers.pdd).toBeUndefined();
    const url = await providers.taobao!.authorizeUrl(AUTHORIZE_INPUT);
    expect(url.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe(APP_KEY);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(parsed.searchParams.get('state')).toBe(STATE);
    expect(requests).toEqual([]);

    await providers.taobao!.exchange({ ...INPUT, code: CODE });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(TOKEN_ENDPOINT);
    const form = new URLSearchParams(requests[0]!.body);
    expect(form.get('client_secret')).toBe(SECRET);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    // Nothing secret reaches the log, whatever is logged on the configured path.
    expect(visible(lines)).not.toContain(SECRET);
    expect(visible(lines)).not.toContain(CODE);
  },
);

const MISSING: [string, Partial<SiteOAuthWiring> | undefined][] = [
  ['不传装配参数', undefined],
  ['没有淘宝凭据', { taobaoCredentials: null }],
  ['appKey 为空', { taobaoCredentials: { appKey: '', appSecret: SECRET } }],
  ['secret 为空', { taobaoCredentials: { appKey: APP_KEY, appSecret: '' } }],
  ['没有回调地址', { taobaoRedirectUri: null }],
  ['回调地址为空', { taobaoRedirectUri: '' }],
];

for (const appEnv of ['staging', 'prod']) {
  it.each(MISSING)(
    `[AC-B1-04zzi#12] ${appEnv} %s：不装淘宝 provider（发起 fail closed），照旧一条 union_site_oauth_unconfigured`,
    (_label, patch) => {
      const { lines, logger } = recorder();
      const { value, requests } = wiring(patch ?? {});
      const providers = createSiteOAuthProviders(
        appEnv,
        new FixedClock(NOW),
        logger,
        patch === undefined ? undefined : value,
      );
      expect(providers).toEqual({});
      expect(unconfiguredWarnings(lines)).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(visible(lines)).not.toContain(SECRET);
      expect(visible(lines)).not.toContain(DESCRIPTION);
      expect(requests).toEqual([]);
    },
  );
}

it.each(['local', 'test'])(
  '[AC-B1-04zzi#13] %s 即使三项齐备也照旧是 B1-22d 假实现（三个平台、不打日志、不调传输）',
  async (appEnv) => {
    const { lines, logger } = recorder();
    const { value, requests } = wiring();
    const providers = createSiteOAuthProviders(appEnv, new FixedClock(NOW), logger, value);
    expect(Object.keys(providers).sort()).toEqual(['jd', 'pdd', 'taobao']);
    const url = new URL(await providers.taobao!.authorizeUrl(AUTHORIZE_INPUT));
    expect(url.hostname).toBe('site-oauth.example.test');
    expect(url.searchParams.get('state')).toBe(STATE);
    await expect(
      providers.taobao!.exchange({ ...INPUT, code: 'fake-site:ok:wiring' }),
    ).resolves.toEqual({
      accessToken: 'fake-site-access:wiring',
      refreshToken: 'fake-site-refresh:wiring',
      expiresAt: null,
    });
    expect(requests).toEqual([]);
    expect(lines).toEqual([]);
  },
);

it.each(['local', 'test'])('[AC-B1-04zzi#13] %s 不传装配参数时同样给假实现', (appEnv) => {
  const { lines, logger } = recorder();
  const providers = createSiteOAuthProviders(appEnv, new FixedClock(NOW), logger);
  expect(Object.keys(providers).sort()).toEqual(['jd', 'pdd', 'taobao']);
  expect(lines).toEqual([]);
});
