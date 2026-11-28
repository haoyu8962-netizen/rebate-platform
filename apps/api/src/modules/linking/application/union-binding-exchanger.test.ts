// Unit tests of the default credential exchange (B1-06h): it forwards the code or the access
// token to the union adapter's channel filing with the calling app, maps a union refusal to
// credential_invalid and fails closed without an adapter. No database, no network.
import { describe, expect, it, vi } from 'vitest';
import { UnionError } from '../../union/index.ts';
import {
  UnionBindingExchanger,
  UnionBindingExchangeRefusal,
  type UnionBindPublisher,
} from './union-binding-exchanger.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';

describe('UnionBindingExchanger (default)', () => {
  it('[AC-B1-06h#3] web_code 把授权码交给渠道备案，带调用方 app', async () => {
    const bind = vi.fn<UnionBindPublisher>().mockResolvedValue({ relationId: 'synthetic-r' });
    const exchanger = new UnionBindingExchanger(() => bind);
    await expect(
      exchanger.exchange({
        appId: 'synthetic_app',
        method: 'web_code',
        credential: { code: 'synthetic-code' },
        appRef: 'synthetic/app/web_code',
        traceId: TRACE,
      }),
    ).resolves.toEqual({ kind: 'bound', relationId: 'synthetic-r' });
    expect(bind).toHaveBeenCalledExactlyOnceWith(
      { authorizationCode: 'synthetic-code' },
      { appId: 'synthetic_app', requestId: TRACE, purpose: 'online' },
    );
  });

  it('[AC-B1-06h#2] sdk_token 把访问令牌交给渠道备案', async () => {
    const bind = vi.fn<UnionBindPublisher>().mockResolvedValue({ relationId: 'synthetic-r' });
    const exchanger = new UnionBindingExchanger(() => bind);
    await exchanger.exchange({
      appId: 'synthetic_app',
      method: 'sdk_token',
      credential: { access_token: 'synthetic-sdk-credential', expires_in: 60 },
      appRef: 'synthetic/app/sdk_token',
      traceId: TRACE,
    });
    expect(bind.mock.calls[0]?.[0]).toEqual({ authorizationCode: 'synthetic-sdk-credential' });
  });

  it('[AC-B1-06h#7] 联盟拒绝凭证 → credential_invalid；依赖故障原样抛出', async () => {
    const input = {
      appId: 'synthetic_app',
      method: 'web_code' as const,
      credential: { code: 'synthetic-code' },
      appRef: 'synthetic/app/web_code',
      traceId: TRACE,
    };
    const refused = new UnionBindingExchanger(
      () => () =>
        Promise.reject(new UnionError('upstream_rejected', 'synthetic refusal', 'taobao')),
    );
    await expect(refused.exchange(input)).resolves.toEqual({ kind: 'credential_invalid' });
    const outage = new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
    const down = new UnionBindingExchanger(() => () => Promise.reject(outage));
    await expect(down.exchange(input)).rejects.toBe(outage);
  });

  it('[AC-B1-04zzzzq-UNIT#9] 有 resolveApp 时放行 sdk_token：只带解析出的 appKey 与令牌类型，解析不了即拒且不调适配器', async () => {
    const bind = vi.fn<UnionBindPublisher>().mockResolvedValue({ relationId: 'synthetic-r' });
    const resolveApp = vi.fn((ref: string, method: 'web_code' | 'sdk_token') =>
      ref === 'synthetic/sdk' && method === 'sdk_token' ? { appKey: 'synthetic-key' } : null,
    );
    const exchanger = new UnionBindingExchanger(() => bind, { resolveApp });
    const input = {
      appId: 'synthetic_app',
      method: 'sdk_token' as const,
      credential: { access_token: 'synthetic-sdk-credential', expires_in: 60 },
      appRef: 'synthetic/sdk',
      traceId: TRACE,
    };
    await expect(exchanger.exchange(input)).resolves.toEqual({
      kind: 'bound',
      relationId: 'synthetic-r',
    });
    expect(bind.mock.calls[0]?.[0]).toEqual({
      authorizationCode: 'synthetic-sdk-credential',
      credentialType: 'sdk_token',
      oauthApp: { appKey: 'synthetic-key', redirectUri: '' },
    });
    await expect(exchanger.exchange({ ...input, appRef: 'synthetic/other' })).rejects.toThrow(
      UnionBindingExchangeRefusal,
    );
    // A web_code reference that names no redirect URI is refused as unresolved.
    const webNoRedirect = new UnionBindingExchanger(() => bind, {
      resolveApp: () => ({ appKey: 'synthetic-key' }),
    });
    await expect(
      webNoRedirect.exchange({
        ...input,
        method: 'web_code',
        credential: { code: 'synthetic-code' },
      }),
    ).rejects.toMatchObject({ reason: 'oauth_app_unresolved' });
    expect(bind).toHaveBeenCalledTimes(1);
    // TOP refusing the authorization (invalid_identity) answers credential_invalid.
    const refused = new UnionBindingExchanger(
      () => () => Promise.reject(new UnionError('invalid_identity', 'synthetic', 'taobao')),
      { resolveApp },
    );
    await expect(refused.exchange(input)).resolves.toEqual({ kind: 'credential_invalid' });
  });

  it('[AC-B1-06h#3] 没有联盟适配器时拒绝，不合成 relation_id', async () => {
    const input = {
      appId: 'synthetic_app',
      method: 'web_code' as const,
      credential: { code: 'synthetic-code' },
      appRef: 'synthetic/app/web_code',
      traceId: TRACE,
    };
    await expect(new UnionBindingExchanger().exchange(input)).rejects.toThrow(Error);
    await expect(new UnionBindingExchanger(() => null).exchange(input)).rejects.toThrow(Error);
  });
});
