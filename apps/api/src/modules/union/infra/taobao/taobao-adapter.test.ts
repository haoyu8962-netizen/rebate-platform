// B1-04zzzzq: unit tests of the channel filing's sdk_token path and of the authorization refusals
// on both paths (synthetic transport and values only; no database, no network).
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type BindReq } from '../../domain/types.ts';
import type { UnionTransportRequest, UnionTransportResponse } from '../replay.ts';
import { TAOBAO_PUBLISHER_GET, TAOBAO_PUBLISHER_SAVE } from './publisher.ts';
import type { TaobaoWarning } from './response.ts';
import { TaobaoUnionAdapter } from './taobao-adapter.ts';

const APP_KEY = 'unit-app-key';
const SECRET = 'unit-secret-unit-secret';
const INVITER = 'unit-inviter-code';
const ACCOUNT = 'unit-union-account';
const SDK_TOKEN = 'unit-sdk+token/%2B=';
const ACCESS = 'unit-access-from-code';
const RELATION = '000819712';
const CTX = { appId: 'unit-app', requestId: 'unit-request', purpose: 'online' } as const;

const json = (body: unknown): UnionTransportResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

function setup(answers: Record<string, () => UnionTransportResponse> = {}) {
  const requests: UnionTransportRequest[] = [];
  const warnings: TaobaoWarning[] = [];
  const transport = vi.fn(async (request: UnionTransportRequest) => {
    requests.push(request);
    const method = new URLSearchParams(request.body ?? '').get('method') ?? 'oauth';
    const answer = answers[method];
    if (answer !== undefined) return answer();
    if (method === 'oauth') {
      return json({ access_token: ACCESS, token_type: 'Bearer', expires_in: 86400 });
    }
    if (method === TAOBAO_PUBLISHER_SAVE) {
      return json({ tbk_sc_publisher_info_save_response: { data: { relation_id: RELATION } } });
    }
    throw new Error('unit: unexpected request');
  });
  const adapter = new TaobaoUnionAdapter({
    clock: new FixedClock('2032-01-01T00:00:00.000Z'),
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: { redirectUri: null, inviterCode: INVITER, inviterAccountId: ACCOUNT },
    }),
    endpoint: {
      platform: 'taobao',
      mode: 'live',
      baseUrl: 'https://taobao-gateway.invalid/router/rest',
      quotaKey: 'unit',
    },
    transport,
    warn: (warning) => {
      warnings.push(warning);
    },
  });
  const form = (index: number) =>
    Object.fromEntries(new URLSearchParams(requests[index]?.body ?? '').entries());
  return { adapter, form, requests, transport, warnings };
}

const sdkReq = (over: Partial<BindReq> = {}): BindReq => ({
  authorizationCode: SDK_TOKEN,
  credentialType: 'sdk_token',
  unionAccountId: ACCOUNT,
  oauthApp: { appKey: APP_KEY, redirectUri: '' },
  ...over,
});

const webReq = (over: Partial<BindReq> = {}): BindReq => ({
  authorizationCode: 'unit-code',
  credentialType: 'authorization_code',
  unionAccountId: ACCOUNT,
  oauthApp: { appKey: APP_KEY, redirectUri: 'https://unit.invalid/cb' },
  ...over,
});

function recorder() {
  const events: string[] = [];
  const filing = {
    started: async () => {
      events.push('started');
    },
    settled: async (outcome: 'rejected' | 'duplicate') => {
      events.push(outcome);
    },
    done: () => {
      events.push('done');
    },
  };
  return { events, filing };
}

it('[AC-B1-04zzzzq-UNIT#3] sdk_token 原样当 session 调 save，不换令牌、不要回调地址，先落单', async () => {
  const { adapter, form, requests, warnings } = setup();
  const { events, filing } = recorder();
  expect(await adapter.bindPublisher(sdkReq({ filing }), CTX)).toEqual({ relationId: RELATION });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.archive).toBeUndefined();
  expect(form(0)).toMatchObject({
    method: TAOBAO_PUBLISHER_SAVE,
    app_key: APP_KEY,
    session: SDK_TOKEN,
    inviter_code: INVITER,
    info_type: '1',
  });
  expect(events).toEqual(['started', 'done']);
  expect(warnings).toEqual([]);
});

it('[AC-B1-04zzzzq-UNIT#4] sdk_token 重复备案用同一 session 查回，编号标 fromDuplicateLookup', async () => {
  const { adapter, form } = setup({
    [TAOBAO_PUBLISHER_SAVE]: () =>
      json({ tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } } }),
    [TAOBAO_PUBLISHER_GET]: () =>
      json({
        tbk_sc_publisher_info_get_response: {
          data: { inviter_list: { map_data: [{ relation_id: RELATION, relation_app: 'common' }] } },
        },
      }),
  });
  const { events, filing } = recorder();
  expect(await adapter.bindPublisher(sdkReq({ filing }), CTX)).toEqual({
    relationId: RELATION,
    fromDuplicateLookup: true,
  });
  expect(form(1)).toMatchObject({ method: TAOBAO_PUBLISHER_GET, session: SDK_TOKEN });
  expect(events).toEqual(['started', 'duplicate', 'done']);
});

it('[AC-B1-04zzzzq-UNIT#5] sdk_token 的 appKey 不是本应用、邀请码账号不符、令牌为空 → 拒绝且零请求', async () => {
  const cases: readonly [BindReq, string][] = [
    [sdkReq({ oauthApp: { appKey: 'unit-other-app', redirectUri: '' } }), 'upstream_misconfigured'],
    [sdkReq({ unionAccountId: 'unit-other-account' }), 'upstream_misconfigured'],
    [sdkReq({ authorizationCode: '' }), 'invalid_identity'],
  ];
  for (const [req, code] of cases) {
    const { adapter, transport, warnings } = setup();
    const { events, filing } = recorder();
    await expect(adapter.bindPublisher({ ...req, filing }, CTX)).rejects.toMatchObject({ code });
    expect(transport).not.toHaveBeenCalled();
    expect(events).toEqual(['done']);
    expect(JSON.stringify(warnings)).not.toContain(SDK_TOKEN);
  }
  const { adapter, warnings } = setup();
  await adapter
    .bindPublisher(sdkReq({ oauthApp: { appKey: 'unit-other-app', redirectUri: '' } }), CTX)
    .catch(() => undefined);
  expect(warnings).toEqual([{ method: TAOBAO_PUBLISHER_SAVE, code: 'oauth_app_mismatch' }]);
});

it.each([
  { authMethod: 'sdk_token', code: 27, subCode: 'isv.invalid-session' },
  { authMethod: 'sdk_token', code: 11, subCode: 'isv.permission-api-package-limit' },
  { authMethod: 'web_code', code: 29, subCode: 'isv.synthetic-detail' },
  { authMethod: 'web_code', code: 11, subCode: 'isv.permission-api-package-limit' },
  { authMethod: 'sdk_token', code: 15, subCode: 'isv.invalid-app-key' },
] as const)(
  '[AC-B1-04zzzzq-UNIT#6] $authMethod 的 save 收 TOP $code / $subCode → invalid_identity、尝试记 rejected、恰好一条只含码与授权方式的告警',
  async ({ authMethod, code, subCode }) => {
    const token = authMethod === 'sdk_token' ? SDK_TOKEN : ACCESS;
    const detail = `unit upstream ${token} ${RELATION}`;
    const { adapter, warnings } = setup({
      [TAOBAO_PUBLISHER_SAVE]: () =>
        json({
          error_response: { code, sub_code: subCode, msg: detail, sub_msg: detail, session: token },
        }),
    });
    const { events, filing } = recorder();
    const req = authMethod === 'sdk_token' ? sdkReq({ filing }) : webReq({ filing });
    const error: unknown = await adapter.bindPublisher(req, CTX).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'invalid_identity', duplicateConfirmed: false });
    expect(events).toEqual(['started', 'rejected', 'done']);
    expect(warnings).toEqual([
      {
        method: TAOBAO_PUBLISHER_SAVE,
        code: String(code),
        sub_code: subCode,
        auth_method: authMethod,
      },
    ]);
    const text = JSON.stringify([String(error), { ...(error as object) }, warnings]);
    for (const marker of [token, encodeURIComponent(token), RELATION, 'unit upstream', SECRET]) {
      expect(text).not.toContain(marker);
    }
  },
);

it('[AC-B1-04zzzzq-UNIT#7] 非鉴权类拒绝与网关系统错误照旧：不告警、不当凭证无效', async () => {
  for (const [error, expected] of [
    [{ code: 15, sub_code: 'isv.invalid-parameter' }, 'upstream_rejected'],
    [{ code: 15, sub_code: 'isp.remote-service-timeout' }, 'upstream_unavailable'],
    [{ code: 7, sub_code: 'isv.permission-unit' }, 'rate_limited'],
  ] as const) {
    const { adapter, warnings } = setup({
      [TAOBAO_PUBLISHER_SAVE]: () => json({ error_response: error }),
    });
    await expect(adapter.bindPublisher(sdkReq(), CTX)).rejects.toMatchObject({ code: expected });
    expect(warnings).toEqual([]);
  }
});

it('[AC-B1-04zzzzq-UNIT#10] HTTP ≥ 500 带 TOP 鉴权类码：照旧 upstream_unavailable，不告警、尝试不记拒绝（未知）', async () => {
  for (const status of [500, 503]) {
    for (const authMethod of ['sdk_token', 'web_code'] as const) {
      const { adapter, warnings } = setup({
        [TAOBAO_PUBLISHER_SAVE]: () => ({
          status,
          headers: {},
          body: JSON.stringify({ error_response: { code: 27, sub_code: 'isv.invalid-session' } }),
        }),
      });
      const { events, filing } = recorder();
      const req = authMethod === 'sdk_token' ? sdkReq({ filing }) : webReq({ filing });
      await expect(adapter.bindPublisher(req, CTX)).rejects.toMatchObject({
        code: 'upstream_unavailable',
      });
      expect(events).toEqual(['started', 'done']);
      expect(warnings).toEqual([]);
    }
  }
  // Below 500 the same answer is still an authorization refusal.
  const { adapter } = setup({
    [TAOBAO_PUBLISHER_SAVE]: () => ({
      status: 400,
      headers: {},
      body: JSON.stringify({ error_response: { code: 27, sub_code: 'isv.invalid-session' } }),
    }),
  });
  await expect(adapter.bindPublisher(sdkReq(), CTX)).rejects.toMatchObject({
    code: 'invalid_identity',
  });
});

it('[AC-B1-04zzzzq-UNIT#11] sdk_token 缺已签发的应用引用 → 落单前拒绝、零请求；web_code 缺引用照旧走实例配置', async () => {
  const { adapter, transport, warnings } = setup();
  const { events, filing } = recorder();
  const { oauthApp: _dropped, ...withoutApp } = sdkReq({ filing });
  void _dropped;
  await expect(adapter.bindPublisher(withoutApp, CTX)).rejects.toMatchObject({
    code: 'upstream_misconfigured',
  });
  expect(transport).not.toHaveBeenCalled();
  expect(events).toEqual(['done']);
  expect(warnings).toEqual([{ method: TAOBAO_PUBLISHER_SAVE, code: 'oauth_app_missing' }]);
  expect(JSON.stringify(warnings)).not.toContain(SDK_TOKEN);

  // web_code without a reference keeps its legacy path: the instance's callback (none here → the
  // existing flat refusal, not the new one).
  const web = setup();
  const { oauthApp: _web, ...webWithoutApp } = webReq();
  void _web;
  await expect(web.adapter.bindPublisher(webWithoutApp, CTX)).rejects.toMatchObject({
    code: 'upstream_misconfigured',
  });
  expect(web.warnings).toEqual([
    { method: TAOBAO_PUBLISHER_SAVE, code: 'user_oauth_redirect_uri_missing' },
  ]);
});
