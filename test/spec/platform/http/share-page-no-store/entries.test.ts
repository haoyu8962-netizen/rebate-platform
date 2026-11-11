// B1-15y: the share page routes through the real api entry (bootstrap createHttpApp; no database,
// Redis or listener; SharePageService is a stand-in, see kit.ts). Every response of
// GET /v1/share-pages/{link_id} and POST /v1/share-pages/{link_id}/tpwd is Cache-Control: no-store
// (BR-ATTR-10 细则「缓存」; NoStoreClientError / NoStoreServerError), also when the route schema or
// a request check refuses the request before the controller (the stand-in is then never called);
// other anonymous responses stay untouched and the B1-01zzq identity rule is unchanged.
import { afterEach, expect, it, vi } from 'vitest';
import {
  LINK,
  LINK_ID_MAX,
  NO_STORE,
  TICKET_MAX,
  TRACE,
  cacheControl,
  expectNoStoreClientError,
  expectSchema,
  pageUrl,
  shareEntry,
  tpwdUrl,
  type Probe,
  type Request,
} from './kit.ts';

let e: Awaited<ReturnType<typeof shareEntry>> | undefined;
afterEach(async () => {
  try {
    await e?.close();
  } finally {
    e = undefined;
    vi.restoreAllMocks();
  }
}, 30_000);

async function open(probes: readonly Probe[] = []) {
  e = await shareEntry(probes);
  return e;
}

function ticketBody(ticket: unknown): string {
  return JSON.stringify({ ticket });
}

/**
 * A refusal before the controller; `status` / `code` are pinned where the cause fixes them,
 * `statuses` lists the statuses the contract allows where it leaves the choice to the platform.
 */
interface Refusal {
  readonly what: string;
  readonly request: Request;
  readonly status?: number;
  readonly statuses?: readonly number[];
  readonly code?: number;
}

const PAGE_REFUSALS: readonly Refusal[] = [
  {
    what: '缺 X-App-Version（App 端）',
    request: {
      method: 'GET',
      url: pageUrl(LINK),
      headers: { 'x-platform': 'ios', 'x-app-version': undefined },
    },
    status: 400,
    code: 20001,
  },
  {
    what: 'X-App-Version 不合格式',
    request: { method: 'GET', url: pageUrl(LINK), headers: { 'x-app-version': '1.0' } },
    status: 400,
    code: 20001,
  },
  {
    what: '缺 X-App-Id',
    request: { method: 'GET', url: pageUrl(LINK), headers: { 'x-app-id': undefined } },
  },
  {
    what: 'X-App-Id 不合格式',
    request: { method: 'GET', url: pageUrl(LINK), headers: { 'x-app-id': 'Not-An-App' } },
  },
  {
    what: '缺 X-Platform',
    request: { method: 'GET', url: pageUrl(LINK), headers: { 'x-platform': undefined } },
  },
  {
    what: 'X-Platform 不在枚举内',
    request: { method: 'GET', url: pageUrl(LINK), headers: { 'x-platform': 'web' } },
  },
  {
    what: `link_id ${LINK_ID_MAX + 1} 字符`,
    request: { method: 'GET', url: pageUrl('a'.repeat(LINK_ID_MAX + 1)) },
    status: 400,
    code: 20001,
  },
  {
    what: 'link_id 300 字符',
    request: { method: 'GET', url: pageUrl('b'.repeat(300)) },
    status: 400,
    code: 20001,
  },
];

const TPWD_REFUSALS: readonly Refusal[] = [
  {
    what: '空票据 {"ticket":""}',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: ticketBody('') },
    status: 400,
    code: 20001,
  },
  {
    what: `票据 ${TICKET_MAX + 1} 字符`,
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      payload: ticketBody('t'.repeat(TICKET_MAX + 1)),
    },
    status: 400,
    code: 20001,
  },
  {
    what: '票据 4096 字符',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: ticketBody('u'.repeat(4096)) },
    status: 400,
    code: 20001,
  },
  {
    what: '缺 ticket 字段',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: '{}' },
    status: 400,
    code: 20001,
  },
  {
    what: 'ticket 为数字',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: ticketBody(123456) },
    status: 400,
    code: 20001,
  },
  {
    what: 'ticket 为 null',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: ticketBody(null) },
    status: 400,
    code: 20001,
  },
  {
    what: '多余字段',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      payload: JSON.stringify({ ticket: 'synthetic-ticket', link_id: LINK }),
    },
    status: 400,
    code: 20001,
  },
  {
    what: 'body 为数组',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: '[]' },
    status: 400,
    code: 20001,
  },
  {
    what: 'body 不是合法 JSON',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: '{"ticket":' },
    status: 400,
    code: 20001,
  },
  {
    what: '空 body（Content-Type 为 JSON）',
    request: { method: 'POST', url: tpwdUrl(LINK), payload: '' },
    code: 20001,
  },
  {
    what: 'Content-Type 不是 JSON',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      headers: { 'content-type': 'text/plain' },
      payload: 'synthetic-ticket',
    },
    // A Fastify body error keeps Fastify's status (global-errors.ts); 20001 allows 400 and, as
    // http_also, 415.
    statuses: [400, 415],
    code: 20001,
  },
  {
    what: 'body 超过 bodyLimit',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      payload: ticketBody('v'.repeat(1_100_000)),
    },
    status: 413,
    code: 20001,
  },
  {
    what: `link_id ${LINK_ID_MAX + 1} 字符`,
    request: {
      method: 'POST',
      url: tpwdUrl('c'.repeat(LINK_ID_MAX + 1)),
      payload: ticketBody('synthetic-ticket'),
    },
    status: 400,
    code: 20001,
  },
  {
    what: '缺 X-App-Version（App 端）',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      headers: { 'x-platform': 'ios', 'x-app-version': undefined },
      payload: ticketBody('synthetic-ticket'),
    },
    status: 400,
    code: 20001,
  },
  {
    what: '缺 X-App-Id',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      headers: { 'x-app-id': undefined },
      payload: ticketBody('synthetic-ticket'),
    },
  },
  {
    what: 'X-Platform 不在枚举内',
    request: {
      method: 'POST',
      url: tpwdUrl(LINK),
      headers: { 'x-platform': 'web' },
      payload: ticketBody('synthetic-ticket'),
    },
  },
];

it('[AC-B1-15y#5] GET /v1/share-pages/{link_id}：路由层先拒的请求（缺或坏请求头、超长 link_id）也带 no-store，且仍是契约错误体', async () => {
  const entry = await open();
  for (const refusal of PAGE_REFUSALS) {
    const response = await entry.request(refusal.request);
    await expectNoStoreClientError(response, refusal.what, refusal);
  }
  expect(entry.service.get).not.toHaveBeenCalled();
  expect(entry.service.tpwd).not.toHaveBeenCalled();
}, 30_000);

it('[AC-B1-15y#6] POST /v1/share-pages/{link_id}/tpwd：空票据、超长票据、坏 body、超长 link_id、缺请求头等先拒的请求也带 no-store，且仍是契约错误体', async () => {
  const entry = await open();
  for (const refusal of TPWD_REFUSALS) {
    const response = await entry.request(refusal.request);
    await expectNoStoreClientError(response, refusal.what, refusal);
    if (refusal.statuses !== undefined) {
      expect(refusal.statuses, refusal.what).toContain(response.statusCode);
    }
    // Neither the request body nor the ticket is echoed back.
    expect(response.payload, refusal.what).not.toContain('synthetic-ticket');
  }
  expect(entry.service.tpwd).not.toHaveBeenCalled();
  expect(entry.service.get).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-15y#7] 进入处理器的成功与错误响应照旧只带一个 no-store（含 64 字符 link_id、256 字符票据的边界、429 与 5xx）；同一路由先拒的请求同样 no-store', async () => {
  const entry = await open();

  entry.service.get.mockResolvedValueOnce({
    status: 200,
    envelope: { code: 0, msg: '', data: {}, trace_id: TRACE },
  });
  const page = await entry.request({ method: 'GET', url: pageUrl(LINK) });
  expect(page.statusCode).toBe(200);
  expect(cacheControl(page)).toBe(NO_STORE);
  expect(page.headers['x-trace-id']).toBe(TRACE);

  const longest = 'd'.repeat(LINK_ID_MAX);
  const missing = await entry.request({ method: 'GET', url: pageUrl(longest) });
  await expectNoStoreClientError(missing, 'GET 处理器 404', { status: 404, code: 30144 });
  expect(entry.service.get).toHaveBeenLastCalledWith(expect.objectContaining({ linkId: longest }));

  entry.service.get.mockResolvedValueOnce({
    status: 422,
    envelope: { code: 30102, msg: 'synthetic sharer invalid', trace_id: TRACE },
  });
  const invalid = await entry.request({ method: 'GET', url: pageUrl(LINK) });
  await expectNoStoreClientError(invalid, 'GET 处理器 422', { status: 422, code: 30102 });

  entry.service.get.mockRejectedValueOnce(new Error('synthetic share page failure'));
  const failed = await entry.request({ method: 'GET', url: pageUrl(LINK) });
  expect(failed.statusCode).toBeGreaterThanOrEqual(500);
  expect(cacheControl(failed)).toBe(NO_STORE);
  await expectSchema(failed, 'ErrorEnvelope');
  expect(entry.service.get).toHaveBeenCalledTimes(4);

  const granted = await entry.request({
    method: 'POST',
    url: tpwdUrl(LINK),
    payload: ticketBody('t'.repeat(TICKET_MAX)),
  });
  expect(granted.statusCode).toBe(200);
  expect(cacheControl(granted)).toBe(NO_STORE);
  await expectSchema(granted, 'ShareTpwdResponse');
  expect(entry.service.tpwd).toHaveBeenLastCalledWith(
    expect.objectContaining({ linkId: LINK, ticket: 't'.repeat(TICKET_MAX) }),
  );

  entry.service.tpwd.mockResolvedValueOnce({
    status: 400,
    envelope: {
      code: 20001,
      msg: 'synthetic ticket refused',
      data: { fields: ['ticket'] },
      trace_id: TRACE,
    },
  });
  const refused = await entry.request({
    method: 'POST',
    url: tpwdUrl(LINK),
    payload: ticketBody('synthetic-forged'),
  });
  await expectNoStoreClientError(refused, 'POST 处理器 20001', { status: 400, code: 20001 });

  entry.service.tpwd.mockResolvedValueOnce({
    status: 429,
    envelope: { code: 42901, msg: 'synthetic rate limited', trace_id: TRACE },
    retryAfterSec: 30,
  });
  const limited = await entry.request({
    method: 'POST',
    url: tpwdUrl(LINK),
    payload: ticketBody('synthetic-limited'),
  });
  await expectNoStoreClientError(limited, 'POST 处理器 42901', { status: 429, code: 42901 });
  expect(limited.headers['retry-after']).toBe('30');
  expect(entry.service.tpwd).toHaveBeenCalledTimes(3);

  // Control on the same routes: refused before the controller, still no-store.
  for (const request of [
    { method: 'POST', url: tpwdUrl(LINK), payload: ticketBody('') },
    {
      method: 'GET',
      url: pageUrl(LINK),
      headers: { 'x-platform': 'ios', 'x-app-version': undefined },
    },
  ] as const) {
    const response = await entry.request(request);
    await expectNoStoreClientError(response, `${request.method} 先拒`, {
      status: 400,
      code: 20001,
    });
  }
  expect(entry.service.tpwd).toHaveBeenCalledTimes(3);
  expect(entry.service.get).toHaveBeenCalledTimes(4);
}, 30_000);

it('[AC-B1-15y#8] 其他匿名接口不因本改动加 no-store（含先拒与 404）；带身份请求缺省 no-store、路由自设的保留', async () => {
  const entry = await open([
    { path: '/__share_no_store/anonymous', identity: 'none' },
    { path: '/__share_no_store/share-pages/:link_id', identity: 'none' },
    { path: '/__share_no_store/app', identity: 'app' },
    { path: '/__share_no_store/app-cached', identity: 'app', cacheControl: 'private, max-age=60' },
  ]);
  const device = { 'x-device-id': '0199a3b4-5c6d-7000-8000-0000000015f3' };
  const untouched: readonly { readonly what: string; readonly request: Request }[] = [
    {
      what: 'GET /v1/links/{link_id} 超长 link_id',
      request: { method: 'GET', url: `/v1/links/${'e'.repeat(LINK_ID_MAX + 1)}`, headers: device },
    },
    {
      what: 'GET /v1/links/{link_id} 缺 X-App-Version',
      request: {
        method: 'GET',
        url: `/v1/links/${LINK}`,
        headers: { ...device, 'x-app-version': undefined },
      },
    },
    {
      what: 'GET /v1/links/{link_id} 缺 X-Device-Id',
      request: { method: 'GET', url: `/v1/links/${LINK}` },
    },
    {
      what: 'GET /v1/links/{link_id} 进入处理器',
      request: { method: 'GET', url: `/v1/links/${LINK}`, headers: device },
    },
    {
      what: 'POST /v1/shares 未登录',
      request: { method: 'POST', url: '/v1/shares', headers: device, payload: '{}' },
    },
    { what: '未注册路径 /v1/share-pages', request: { method: 'GET', url: '/v1/share-pages' } },
    {
      what: '未注册路径 /v1/share-pages/{link_id}/other',
      request: { method: 'GET', url: `${pageUrl(LINK)}/other` },
    },
    {
      what: '探针：匿名',
      request: { method: 'GET', url: '/__share_no_store/anonymous' },
    },
    {
      what: '探针：路径相似的匿名路由',
      request: { method: 'GET', url: `/__share_no_store/share-pages/${LINK}` },
    },
  ];
  for (const { what, request } of untouched) {
    const response = await entry.request(request);
    expect(cacheControl(response), `${what} → ${response.statusCode}`).toBeUndefined();
    expect(response.headers['x-trace-id'], what).toBe(TRACE);
  }

  const app = await entry.request({ method: 'GET', url: '/__share_no_store/app' });
  expect(app.statusCode).toBe(200);
  expect(cacheControl(app)).toBe(NO_STORE);
  const cached = await entry.request({ method: 'GET', url: '/__share_no_store/app-cached' });
  expect(cached.statusCode).toBe(200);
  expect(cacheControl(cached)).toBe('private, max-age=60');

  // Control: the share page route refused before the controller is answered no-store.
  const control = await entry.request({
    method: 'GET',
    url: pageUrl('f'.repeat(LINK_ID_MAX + 1)),
  });
  await expectNoStoreClientError(control, 'GET 超长 link_id', { status: 400, code: 20001 });
  expect(entry.service.get).not.toHaveBeenCalled();
}, 30_000);
