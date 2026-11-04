import { afterEach, expect, it, vi } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/index.ts';
import { assertContract, httpFixture, type HttpApp } from '../search-route/http-kit.ts';
import {
  ALL_CODES_LISTED,
  MSG_50304,
  PLATFORMS,
  SECRETS,
  UNION_CODES,
  controllerFixture,
  expectUnion50304,
  unionError,
  type LogRecord,
} from './kit.ts';

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

/** Warn lines (pino level 40) naming this UnionError code in any (flat) field. */
function unionWarns(records: readonly LogRecord[], code: string): LogRecord[] {
  return records.filter((r) => r.level === 40 && Object.values(r).includes(code));
}

it.each(UNION_CODES)(
  '[AC-B1-05z#1] 服务层抛出 UnionError(%s) 时 HTTP 回 503 / 50304，data 只有请求的 platform',
  async (code) => {
    expect(ALL_CODES_LISTED).toBe(true);
    const f = await controllerFixture();
    app = f.app;
    // The error itself names no platform: data.platform comes from the request.
    f.search.mockRejectedValue(unionError(code, null));
    const response = await f.request('jd');
    await expectUnion50304(response, 'jd');
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.search.mock.calls[0]?.[0]).toMatchObject({ platform: 'jd', q: '合成纸巾' });
  },
);

it.each(PLATFORMS)(
  '[AC-B1-05z#1] %s 搜索遇联盟业务拒绝 upstream_rejected 回 503 / 50304 { platform }',
  async (platform) => {
    const f = await controllerFixture();
    app = f.app;
    f.search.mockRejectedValue(unionError('upstream_rejected', platform));
    await expectUnion50304(await f.request(platform), platform);
  },
);

it('[AC-B1-05z#1] 经真实 searchProducts：京东业务拒绝（内层 403）原样冒出后，HTTP 收成 503 / 50304', async () => {
  const f = await httpFixture();
  app = f.app;
  f.search.mockRejectedValue(unionError('upstream_rejected', 'jd'));
  const response = await f.request({ platform: 'jd' });
  await expectUnion50304(response, 'jd');
  expect(f.search).toHaveBeenCalled();
});

it.each(['upstream_rejected', 'invalid_dto', 'item_unavailable'] as const)(
  '[AC-B1-05z#2] UnionError(%s) 不得回 500 / 50001，响应体不含错误原文、上游报文或错误 code',
  async (code) => {
    const f = await controllerFixture();
    app = f.app;
    f.search.mockRejectedValue(unionError(code, 'taobao'));
    const response = await f.request('taobao');
    expect(response.statusCode).not.toBe(500);
    expect(response.json<{ code: number }>().code).not.toBe(50001);
    const raw = JSON.stringify(response.json());
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    expect(raw).not.toContain(code);
    await expectUnion50304(response, 'taobao');
  },
);

it('[AC-B1-05z#2] 连续多次 UnionError 每次都是 50304，应用照常服务后续成功请求', async () => {
  const f = await controllerFixture();
  app = f.app;
  f.search
    .mockRejectedValueOnce(unionError('upstream_rejected', 'pdd'))
    .mockRejectedValueOnce(unionError('invalid_identity', 'pdd'))
    .mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false, fallback_items: [] });
  await expectUnion50304(await f.request('pdd'), 'pdd');
  await expectUnion50304(await f.request('pdd'), 'pdd');
  const ok = await f.request('pdd');
  expect(ok.statusCode).toBe(200);
  await assertContract(ok, true);
  expect(ok.json()).toMatchObject({ code: 0, data: { items: [], has_more: false } });
});

// #3: the existing mapping is unchanged. Each test also answers a UnionError on the same app, so
// the controller must tell the failures apart (and the test stays red until it does).

it('[AC-B1-05z#3] CatalogError 20001 照旧 400 / 20001 带 data.fields，同一应用的 UnionError 回 50304', async () => {
  const f = await controllerFixture();
  app = f.app;
  f.search
    .mockRejectedValueOnce(new CatalogError(20001, 'search: limit out of range'))
    .mockRejectedValueOnce(unionError('upstream_rejected', 'jd'));
  const invalid = await f.request('jd');
  expect(invalid.statusCode).toBe(400);
  await assertContract(invalid, false);
  expect(invalid.json()).toEqual({
    code: 20001,
    msg: '填写内容有误，请检查',
    data: { fields: ['limit'] },
    trace_id: invalid.headers['x-trace-id'],
  });
  await expectUnion50304(await f.request('jd'), 'jd');
});

it('[AC-B1-05z#3] CatalogError 30131 照旧 422 / 30131 不带 data，同一应用的 UnionError 回 50304', async () => {
  const f = await controllerFixture();
  app = f.app;
  f.search
    .mockRejectedValueOnce(new CatalogError(30131, 'search: platform not supported'))
    .mockRejectedValueOnce(unionError('item_unavailable', 'taobao'));
  const unsupported = await f.request('taobao');
  expect(unsupported.statusCode).toBe(422);
  await assertContract(unsupported, false);
  expect(unsupported.json()).toEqual({
    code: 30131,
    msg: '暂不支持这个链接或平台',
    trace_id: unsupported.headers['x-trace-id'],
  });
  await expectUnion50304(await f.request('taobao'), 'taobao');
});

it('[AC-B1-05z#3] CatalogError 50304 { platform } 照旧原样回且不带 cause，同一应用的 UnionError 也回 50304', async () => {
  const f = await controllerFixture();
  app = f.app;
  const cause = new Error('synthetic-union-secret ECONNRESET');
  f.search
    .mockRejectedValueOnce(
      new CatalogError(50304, 'search: union unavailable', { platform: 'pdd' }, { cause }),
    )
    .mockRejectedValueOnce(unionError('invalid_dto', 'pdd'));
  const outage = await f.request('pdd');
  expect(outage.statusCode).toBe(503);
  await assertContract(outage, false);
  expect(outage.json()).toEqual({
    code: 50304,
    msg: MSG_50304,
    data: { platform: 'pdd' },
    trace_id: outage.headers['x-trace-id'],
  });
  expect(JSON.stringify(outage.json())).not.toContain('synthetic-union-secret');
  await expectUnion50304(await f.request('pdd'), 'pdd');
});

it.each(PLATFORMS)(
  '[AC-B1-05z#3] %s 开关关闭的 CatalogError 50304 照旧带 reason=search_disabled 与其文案，UnionError 不带 reason',
  async (platform) => {
    const f = await controllerFixture();
    app = f.app;
    f.search
      .mockRejectedValueOnce(
        new CatalogError(50304, 'search: switched off', { platform, reason: 'search_disabled' }),
      )
      .mockRejectedValueOnce(unionError('upstream_rejected', platform));
    const disabled = await f.request(platform);
    expect(disabled.statusCode).toBe(503);
    await assertContract(disabled, false);
    expect(disabled.json()).toEqual({
      code: 50304,
      msg: '该平台暂不提供搜索，可以粘贴商品链接查返利',
      data: { platform, reason: 'search_disabled' },
      trace_id: disabled.headers['x-trace-id'],
    });
    await expectUnion50304(await f.request(platform), platform);
  },
);

it.each([
  ['Error', () => new Error('synthetic programming defect')],
  ['TypeError', () => new TypeError('synthetic cannot read properties of undefined')],
] as const)(
  '[AC-B1-05z#3] 非 UnionError、非 CatalogError 的未知错误（%s）仍交全局过滤器 500 / 50001，UnionError 回 50304',
  async (_name, make) => {
    const f = await controllerFixture();
    app = f.app;
    f.search
      .mockRejectedValueOnce(make())
      .mockRejectedValueOnce(unionError('upstream_rejected', 'jd'));
    const unknown = await f.request('jd');
    expect(unknown.statusCode).toBe(500);
    await assertContract(unknown, false);
    expect(unknown.json()).toMatchObject({ code: 50001 });
    expect(JSON.stringify(unknown.json())).not.toContain('synthetic');
    await expectUnion50304(await f.request('jd'), 'jd');
  },
);

it.each(['upstream_rejected', 'invalid_dto', 'item_unavailable'] as const)(
  '[AC-B1-05z#4] 收成 50304 时记一条 warn：带事件名、请求的 platform 与 UnionError code(%s)，不带 message 或报文',
  async (code) => {
    const f = await controllerFixture();
    app = f.app;
    f.search.mockRejectedValue(unionError(code, null));
    await expectUnion50304(await f.request('pdd'), 'pdd');
    const warns = unionWarns(f.records(), code);
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    expect(typeof warn['event']).toBe('string');
    expect(warn['event']).not.toBe('');
    expect(warn['platform']).toBe('pdd');
    for (const key of ['err', 'error', 'error_message', 'stack', 'cause', 'payload', 'body']) {
      expect(warn).not.toHaveProperty(key);
    }
    // No captured line of this request carries the UnionError message or the upstream payload.
    for (const raw of f.lines) {
      for (const secret of SECRETS) expect(raw).not.toContain(secret);
    }
  },
);

it('[AC-B1-05z#4] 每次收成 50304 各记一条 warn，code 与各自的 UnionError 一致，事件名相同', async () => {
  const f = await controllerFixture();
  app = f.app;
  f.search
    .mockRejectedValueOnce(unionError('upstream_rejected', 'jd'))
    .mockRejectedValueOnce(unionError('link_unrecognized', 'jd'));
  await expectUnion50304(await f.request('jd'), 'jd');
  await expectUnion50304(await f.request('jd'), 'jd');
  const records = f.records();
  const rejected = unionWarns(records, 'upstream_rejected');
  const unrecognized = unionWarns(records, 'link_unrecognized');
  expect(rejected).toHaveLength(1);
  expect(unrecognized).toHaveLength(1);
  expect(rejected[0]!['platform']).toBe('jd');
  expect(unrecognized[0]!['platform']).toBe('jd');
  expect(rejected[0]!['event']).toBe(unrecognized[0]!['event']);
});
