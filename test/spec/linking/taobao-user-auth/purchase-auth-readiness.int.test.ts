import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { UnionAuthAppsPort } from '../../../../apps/api/src/modules/linking/application/union-auth-state.ts';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import { APP_KEY } from '../../union/taobao-site-oauth/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose as composeLink, setup as setupLink } from '../open-taobao/kit.ts';
import { compose as composeShop, setup as setupShop } from '../shop-open/kit.ts';
import { USER_REDIRECT } from './kit.ts';

const database = databaseFixture(createTestDatabase);

const CASES = [
  { binding: 'unbound', code: 30101, cause: '备案适配器未就绪' },
  { binding: 'invalid', code: 30102, cause: '备案适配器未就绪' },
  { binding: 'unbound', code: 30101, cause: '邀请码属于另一联盟账号' },
  { binding: 'invalid', code: 30102, cause: '邀请码属于另一联盟账号' },
] as const;

type Fixture = Pick<
  Awaited<ReturnType<typeof setupShop>>,
  'account' | 'appId' | 'a' | 'device' | 'sessions'
>;

async function checkIssuance(
  fixture: Fixture,
  { cause, code }: (typeof CASES)[number],
  linkId: string | null,
  open: (authApps: UnionAuthAppsPort) => Promise<HandlerResult>,
) {
  let liveAdapterReady = cause !== '备案适配器未就绪';
  const mismatched = cause === '邀请码属于另一联盟账号';
  let inviterAccount = mismatched ? randomUUID() : fixture.account;
  // OAuth is configured in both refusals. The account-specific filing readiness can still change.
  const authApps: UnionAuthAppsPort = {
    taobaoUserOAuth: { appKey: APP_KEY, redirectUri: USER_REDIRECT },
    taobaoFilingReadyFor: (accountId) => liveAdapterReady && accountId === inviterAccount,
    resolve: async () => ({ ref: 'synthetic-purchase-web-oauth-app' }),
  };

  const [refusal] = await Promise.allSettled([open(authApps)]);
  expect(refusal).toMatchObject({
    status: 'fulfilled',
    value: { status: 422, envelope: { code, data: { reason: 'auth_unavailable' } } },
  });
  const refusalData = refusal.status === 'fulfilled' ? refusal.value.envelope.data : undefined;
  for (const field of ['state', 'auth_url']) expect(refusalData).not.toHaveProperty(field);
  expect(await fixture.sessions()).toEqual([]);

  liveAdapterReady = true;
  inviterAccount = fixture.account;
  const [issued] = await Promise.allSettled([open(authApps)]);
  expect(issued).toMatchObject({
    status: 'fulfilled',
    value: {
      status: 422,
      envelope: {
        code,
        data: {
          auth_url: expect.any(String),
          state: expect.any(String),
          auth_methods: ['web_code'],
        },
      },
    },
  });
  const data = (issued.status === 'fulfilled' ? issued.value.envelope.data : undefined) as {
    auth_url: string;
    state: string;
  };
  expect(URL.canParse(data.auth_url)).toBe(true);
  expect(new URL(data.auth_url).searchParams.get('state')).toBe(data.state);
  expect(await fixture.sessions()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: fixture.appId,
      user_id: fixture.a,
      device_id: fixture.device,
      platform: 'taobao',
      used_at: null,
      link_id: linkId,
    }),
  ]);
}

it.each(CASES)(
  '[AC-B1-04zzzzn#19] $binding 用户进店与开链接遇到「$cause」时保留 $code，恢复后签发 state',
  async (scenario) => {
    const shop = await setupShop(database());
    await shop.bind(scenario.binding);
    await checkIssuance(shop, scenario, null, async (authApps) =>
      composeShop(shop, { appEnv: 'staging', authApps })(),
    );

    const link = await setupLink(database());
    await link.bind(scenario.binding);
    await checkIssuance(link, scenario, link.row.link_id, async (authApps) =>
      composeLink(link, {
        appEnv: 'staging',
        environment: { ...link.options.environment, appEnv: 'staging' },
        authApps,
      })(),
    );
  },
);
