import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { TaobaoCredentials } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  appKey,
  beijing,
  endpoint,
  envelope,
  expectRedacted,
  formContentType,
  formFields,
  instant,
  md5,
  method,
  otherSecret,
  response,
  secret,
  sent,
  setup,
  unionFailure,
} from './kit.ts';

it('[AC-B1-04j#11] sends one signed form POST to endpoint.baseUrl with the TOP public parameters and returns the inner object', async () => {
  const { adapter, transport, credentials, warn } = setup();
  const signal = new AbortController().signal;
  const parameters = Object.freeze({ page_no: 1, q: 'x' });
  const inner = { synthetic_marker: 'opaque-inner-object' };
  transport.mockResolvedValue(response({ [envelope]: inner }));

  expect(await adapter.request(method, parameters, { envelope, signal })).toEqual(inner);

  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = sent(transport);
  expect(request).toMatchObject({ platform: 'taobao', url: endpoint.baseUrl, method: 'POST' });
  expect(request.url).toBe(endpoint.baseUrl);
  expect(request.url).not.toContain('?');
  expect(request.signal).toBe(signal);
  expect(new Headers(request.headers).get('content-type')).toMatch(formContentType);
  const form = formFields(request);
  expect(Object.keys(form).sort()).toEqual([
    'app_key',
    'format',
    'method',
    'page_no',
    'q',
    'sign',
    'sign_method',
    'timestamp',
    'v',
  ]);
  expect(form).toMatchObject({
    app_key: appKey,
    format: 'json',
    method,
    page_no: '1',
    q: 'x',
    sign_method: 'md5',
    timestamp: beijing,
    v: '2.0',
  });
  expect(form.sign).toBe(
    md5(
      `${secret}app_key${appKey}formatjsonmethod${method}page_no1qxsign_methodmd5timestamp${beijing}v2.0${secret}`,
    ),
  );
  expect(warn).not.toHaveBeenCalled();
  expect(parameters).toEqual({ page_no: 1, q: 'x' });
});

it('[AC-B1-04j#12] the app secret never reaches the transport request or the adapter object', async () => {
  const { adapter, transport } = setup();
  expectRedacted(adapter, [secret]);
  await adapter.request(method, { q: 'x' }, { envelope });
  const request = sent(transport);
  expectRedacted(request, [secret]);
  expect(request.url).not.toContain(secret);
  expect(JSON.stringify(request.headers)).not.toContain(secret);
  expect(request.body ?? '').not.toContain(secret);
  expect(Object.values(formFields(request))).not.toContain(secret);
  expectRedacted(adapter, [secret]);
  expect(inspect(adapter, { depth: null, showHidden: true })).not.toContain(secret);
});

it('[AC-B1-04j#13] fetches credentials and the clock anew for every call, timestamp truncated to the second', async () => {
  const credentials = vi
    .fn<() => Promise<TaobaoCredentials>>()
    .mockResolvedValueOnce({ appKey: 'first-app-key', appSecret: secret })
    .mockResolvedValueOnce({ appKey: 'second-app-key', appSecret: otherSecret });
  const clock = new FixedClock(instant);
  const { adapter, transport } = setup({ clock, credentials });

  await adapter.request(method, {}, { envelope });
  clock.advanceMs(1999);
  await adapter.request(method, {}, { envelope });

  expect(credentials).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledTimes(2);
  const first = formFields(sent(transport, 0));
  const second = formFields(sent(transport, 1));
  expect(first.timestamp).toBe('2026-10-30 23:55:42');
  expect(second.timestamp).toBe('2026-10-30 23:55:43');
  expect(first.app_key).toBe('first-app-key');
  expect(second.app_key).toBe('second-app-key');
  expect(first.sign).toBe(
    md5(
      `${secret}app_keyfirst-app-keyformatjsonmethod${method}sign_methodmd5timestamp2026-10-30 23:55:42v2.0${secret}`,
    ),
  );
  expect(second.sign).toBe(
    md5(
      `${otherSecret}app_keysecond-app-keyformatjsonmethod${method}sign_methodmd5timestamp2026-10-30 23:55:43v2.0${otherSecret}`,
    ),
  );
  expectRedacted(transport.mock.calls, [secret, otherSecret]);
});

it('[AC-B1-04j#14] awaits the asynchronous credential provider before sending, never at construction', async () => {
  const pending = Promise.withResolvers<TaobaoCredentials>();
  const credentials = vi.fn(() => pending.promise);
  const { adapter, transport } = setup({ credentials });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();

  const result = adapter.request(method, {}, { envelope });
  await Promise.resolve();
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
  pending.resolve({ appKey, appSecret: secret });

  await expect(result).resolves.toEqual({});
  expect(transport).toHaveBeenCalledTimes(1);
});

// TODO(规划/11 §4.5): 数组 / 对象参数的表单形式待淘宝录制核对 — blocked on 淘宝录制
it('[AC-B1-04j#15] encodes the form as UTF-8 and submits numbers, booleans and structured values as the strings it signs', async () => {
  const { adapter, transport } = setup();
  const parameters = Object.freeze({
    q: '汉字 &+=%',
    ids: Object.freeze(['例子', 'a&b']),
    range: Object.freeze({ min: 0, max: 10 }),
    flag: true,
    n: 0,
  });
  await adapter.request(method, parameters, { envelope });

  const request = sent(transport);
  const body = request.body ?? '';
  expect(body).not.toContain('汉');
  expect(body.toUpperCase()).toContain('%E6%B1%89');
  const form = formFields(request);
  expect(form).toMatchObject({
    q: '汉字 &+=%',
    ids: '["例子","a&b"]',
    range: '{"min":0,"max":10}',
    flag: 'true',
    n: '0',
  });
  expect(form.sign).toBe(
    md5(
      `${secret}app_key${appKey}flagtrueformatjsonids["例子","a&b"]method${method}n0q汉字 &+=%range{"min":0,"max":10}sign_methodmd5timestamp${beijing}v2.0${secret}`,
    ),
  );
  expect(parameters).toEqual({
    q: '汉字 &+=%',
    ids: ['例子', 'a&b'],
    range: { min: 0, max: 10 },
    flag: true,
    n: 0,
  });
});

it('[AC-B1-04j#16] leaves undefined, null and empty-string parameters out of both the form and the signature', async () => {
  const { adapter, transport } = setup();
  await adapter.request(
    method,
    { keep: 'k', empty: '', nothing: null, missing: undefined, zero: 0, no: false },
    { envelope },
  );
  const form = formFields(sent(transport));
  expect(Object.keys(form).sort()).toEqual([
    'app_key',
    'format',
    'keep',
    'method',
    'no',
    'sign',
    'sign_method',
    'timestamp',
    'v',
    'zero',
  ]);
  expect(form).toMatchObject({ keep: 'k', no: 'false', zero: '0' });
  expect(form.sign).toBe(
    md5(
      `${secret}app_key${appKey}formatjsonkeepkmethod${method}nofalsesign_methodmd5timestamp${beijing}v2.0zero0${secret}`,
    ),
  );
});

it.each(['method', 'app_key', 'timestamp', 'format', 'v', 'sign_method', 'sign'])(
  '[AC-B1-04j#17] a business parameter named like the public parameter %s is refused before sending',
  async (reserved) => {
    const { adapter, transport } = setup();
    await unionFailure(
      () => adapter.request(method, { [reserved]: 'business-value' }, { envelope }),
      'invalid_dto',
    );
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04j#18] a call without a response envelope key is unimplemented and touches neither credentials nor transport', async () => {
  const { adapter, credentials, transport } = setup();
  await unionFailure(
    () => adapter.request(method, { q: 'x' }, { envelope: '' }),
    'adapter_unimplemented',
  );
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04j#19] the archive context rides only on the transport request, never on the wire', async () => {
  const { adapter, transport } = setup();
  const archive = { appId: 'archive-app-marker', kind: 'query' };
  await adapter.request(method, { q: 'x' }, { envelope, archive });
  await adapter.request(method, { q: 'x' }, { envelope });

  const withArchive = sent(transport, 0);
  expect(withArchive.archive).toEqual(archive);
  expect(withArchive.url).not.toContain('archive-app-marker');
  expect(JSON.stringify(withArchive.headers)).not.toContain('archive-app-marker');
  expect(withArchive.body ?? '').not.toContain('archive-app-marker');
  expect(Object.keys(formFields(withArchive))).not.toContain('kind');

  // Same parameters, clock and credentials: the archive context changes nothing on the wire.
  const without = sent(transport, 1);
  expect(without.archive).toBeUndefined();
  expect(without.signal).toBeUndefined();
  expect(formFields(without)).toEqual(formFields(withArchive));
  expect(without.url).toBe(withArchive.url);
  expect(without.headers).toEqual(withArchive.headers);
});

it.each<[string, () => unknown]>([
  ['network', () => new Error(`${secret} transport-marker`, { cause: new Error(secret) })],
  ['abort', () => new DOMException(`${secret} transport-marker`, 'AbortError')],
  ['timeout', () => new DOMException(`${secret} transport-marker`, 'TimeoutError')],
  [
    'unavailable',
    () => new UnionError('upstream_unavailable', 'taobao transport: network failure', 'taobao'),
  ],
])(
  '[AC-B1-04j#20] a transport failure (%s) is upstream_unavailable without upstream text, sent once',
  async (_kind, failure) => {
    const { adapter, transport, warn } = setup();
    transport.mockRejectedValue(failure());
    const error = await unionFailure(
      () => adapter.request(method, { q: 'x' }, { envelope }),
      'upstream_unavailable',
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expectRedacted(error, [secret, 'transport-marker']);
  },
);

it('[AC-B1-04j#21] code 11 is rejected and warned once with only method, code and sub_code', async () => {
  const { adapter, transport, warn } = setup();
  transport.mockResolvedValue(
    response({
      error_response: {
        code: '11',
        msg: `${secret} msg-marker`,
        sub_code: 'isv.permission-api-package-limit',
        sub_msg: 'scope-list-marker 1001,1002,1003',
        request_id: 'request-id-marker',
      },
    }),
  );
  const error = await unionFailure(
    () => adapter.request(method, { q: 'x' }, { envelope }),
    'upstream_misconfigured',
  );
  expect(error.message).toContain(method);
  expect(error.message).toContain('11');
  expect(error.message).toContain('isv.permission-api-package-limit');
  expect(warn.mock.calls).toEqual([
    [{ method, code: '11', sub_code: 'isv.permission-api-package-limit' }],
  ]);
  expectRedacted(
    [error, warn.mock.calls],
    [secret, 'msg-marker', 'scope-list-marker', 'request-id-marker'],
  );
});

it.each<[string, UnionEndpoint]>([
  ['no gateway URL', { ...endpoint, baseUrl: null }],
  ['an endpoint of another platform', { ...endpoint, platform: 'pdd' }],
])(
  '[AC-B1-04j#22] %s is an invalid endpoint, refused before credentials or transport',
  async (_label, wrong) => {
    const credentials = vi.fn(async () => ({ appKey, appSecret: secret }));
    const transport = vi.fn(async () => response({ [envelope]: {} }));
    await unionFailure(async () => {
      const { adapter } = setup({ endpoint: wrong, credentials, transport });
      await adapter.request(method, {}, { envelope });
    }, 'invalid_endpoint');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);
