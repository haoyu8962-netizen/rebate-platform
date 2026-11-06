// B1-04zzi / D10-680 end to end at the use-case layer: B1-22c's createSiteReauth (real PG, real
// FieldCrypto, unchanged flow) over the providers the admin entry gets in staging with appKey, secret
// and redirect URI present. The Taobao token endpoint is a stub transport; nothing goes on the
// network. The database harness is B1-22c's (test/spec/union/reauth-session/kit.ts), used read-only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createSiteReauth, SiteReauthError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  createSiteOAuthProviders,
  type SiteOAuthWiring,
} from '../../../../apps/api/src/modules/union/infra/fake-site-oauth.ts';
import type {
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  account,
  credentials,
  databaseFixture,
  expectNoSecrets,
  harness,
  hash,
  seed,
  seedCredential,
  session,
  snapshot,
  startInput,
  type Harness,
} from '../reauth-session/kit.ts';
import {
  ACCESS,
  APP_KEY,
  AUTHORIZE_ENDPOINT,
  CODE,
  DAY_S,
  DESCRIPTION,
  REDIRECT,
  REFRESH,
  ROUND_TRIP_MS,
  SECRET,
  TOKEN_ENDPOINT,
  jsonAnswer,
  stubTransport,
  tokenAnswer,
  visible,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);
const ACCESS_CONTEXT = 'union_credentials.access';
const REFRESH_CONTEXT = 'union_credentials.refresh';

/** createSiteReauth over the staging providers built from `wiring` (clock shared with the harness). */
function staging(
  h: Harness,
  answer: (
    request: UnionTransportRequest,
  ) => UnionTransportResponse | Promise<UnionTransportResponse>,
  patch: Partial<SiteOAuthWiring> = {},
) {
  const lines: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void lines.push(args) };
  const clock = h.clock;
  const stub = stubTransport(async (request) => {
    clock.advanceMs(ROUND_TRIP_MS);
    return answer(request);
  });
  const oauth = createSiteOAuthProviders(
    'staging',
    clock,
    logger as unknown as Parameters<typeof createSiteOAuthProviders>[2],
    {
      taobaoCredentials: Object.freeze({ appKey: APP_KEY, appSecret: SECRET }),
      taobaoRedirectUri: REDIRECT,
      transport: stub.transport,
      ...patch,
    },
  );
  const service = createSiteReauth({ ...h.options, oauth });
  return { service, requests: stub.requests, lines };
}

it('[AC-B1-04zzi#17] staging 三项齐备：发起得淘宝授权地址，回调换令牌后加密写入 union_credentials', async () => {
  const h = await harness(db());
  const { service, requests, lines } = staging(h, () => jsonAnswer(200, tokenAnswer()));
  const a = await seed(h);
  const old = await seedCredential(h, a.id);

  const started = await service.start(startInput(h, a.id));
  expect(started.authUrl.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
  const url = new URL(started.authUrl);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: APP_KEY,
    redirect_uri: REDIRECT,
    state: expect.any(String),
    view: 'web',
  });
  const state = url.searchParams.get('state')!;
  expect((await session(h, started.sessionId)).state_hash).toEqual(hash(state));
  expect(requests).toEqual([]);

  h.clock.advanceMs(60_000);
  const callbackAt = h.clock.now().getTime();
  expect(await service.callback({ state, code: CODE, error: null })).toEqual({
    sessionId: started.sessionId,
    status: 'succeeded',
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe(TOKEN_ENDPOINT);
  expect(requests[0]!.method).toBe('POST');
  expect(Object.fromEntries(new URLSearchParams(requests[0]!.body))).toEqual({
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    client_secret: SECRET,
    code: CODE,
    redirect_uri: REDIRECT,
  });

  const expiresAt = new Date(callbackAt + ROUND_TRIP_MS + DAY_S * 1000);
  const rows = await credentials(h);
  expect(rows.find((row) => row.id === old.id)?.is_current).toBe(false);
  const current = rows.filter((row) => row.union_account_id === a.id && row.is_current);
  expect(current).toHaveLength(1);
  const credential = current[0]!;
  expect(credential.expires_at).toEqual(expiresAt);
  expect(h.crypto.decrypt(credential.access_token_cipher.toString(), ACCESS_CONTEXT)).toBe(ACCESS);
  expect(h.crypto.decrypt(credential.refresh_token_cipher!.toString(), REFRESH_CONTEXT)).toBe(
    REFRESH,
  );
  expect(await account(h, a.id)).toMatchObject({
    auth_status: 'active',
    auth_expires_at: expiresAt,
    auth_expires_estimated: false,
  });
  expect((await session(h, started.sessionId)).status).toBe('succeeded');

  expectNoSecrets(await snapshot(h), [ACCESS, REFRESH, CODE, SECRET, state, started.authUrl]);
  for (const secret of [ACCESS, REFRESH, CODE, SECRET, state]) {
    expect(visible(lines)).not.toContain(secret);
  }
});

it('[AC-B1-04zzi#18] token 应答带 error：会话失败（只记类别），不写令牌、不动账号', async () => {
  const h = await harness(db());
  const { service, requests, lines } = staging(h, () =>
    jsonAnswer(400, { error: 'invalid_grant', error_description: DESCRIPTION }),
  );
  const a = await seed(h);
  await seedCredential(h, a.id);
  const started = await service.start(startInput(h, a.id));
  const state = new URL(started.authUrl).searchParams.get('state')!;
  expect(started.authUrl.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
  const beforeCredentials = await credentials(h);
  const beforeAccount = await account(h, a.id);

  expect(await service.callback({ state, code: CODE, error: null })).toEqual({
    sessionId: started.sessionId,
    status: 'failed',
  });
  expect(requests).toHaveLength(1);
  expect(await credentials(h)).toEqual(beforeCredentials);
  expect(await account(h, a.id)).toEqual(beforeAccount);
  const failed = await session(h, started.sessionId);
  expect(failed.status).toBe('failed');
  expect(failed.error).toBe('exchange_failed');
  expectNoSecrets(await snapshot(h), [CODE, SECRET, DESCRIPTION, state]);
  expect(visible(lines)).not.toContain(DESCRIPTION);
});

it.each([
  ['没有回调地址', { taobaoRedirectUri: null }],
  ['没有淘宝凭据', { taobaoCredentials: null }],
] as [string, Partial<SiteOAuthWiring>][])(
  '[AC-B1-04zzi#19] staging %s：发起照旧 fail closed（provider_missing），不建会话、不调传输',
  async (_label, patch) => {
    const h = await harness(db());
    const { service, requests, lines } = staging(h, () => jsonAnswer(200, tokenAnswer()), patch);
    expect(lines.filter((args) => args.includes('union_site_oauth_unconfigured'))).toHaveLength(1);
    const a = await seed(h);
    const before = await snapshot(h);
    const refused = service.start(startInput(h, a.id));
    await expect(refused).rejects.toBeInstanceOf(SiteReauthError);
    await expect(refused).rejects.toMatchObject({ code: 'provider_missing' });
    expect(await snapshot(h)).toEqual(before);
    expect(requests).toEqual([]);
  },
);
