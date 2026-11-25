// B3-09o · BR-AI-16 细则「请求根本没发出去，不计」：HTTP 传输在调用 fetch 之前抛出的错登记为没发出，
// 调用 fetch 之后的任何失败都不登记。只用注入的假 fetch，不联网。
import { expect, it, vi } from 'vitest';

import { markNotSent, ModelProtocolError, wasNotSent } from './errors.ts';
import { buildModelRequest, quirksFor, toVendorRequest } from './request.ts';
import { createHttpTransport } from './transport.ts';
import type { FetchLike, FetchResponseLike } from './types.ts';

const BASE = 'https://synthetic-model.invalid/compatible-mode/v1';

const request = toVendorRequest(
  buildModelRequest(
    {
      vendor: 'qwen',
      model: 'qwen-flash-2026-09-01',
      system: '合成系统前缀',
      tools: [],
      messages: [{ role: 'user', content: '合成：找保温杯' }],
    },
    quirksFor('qwen'),
  ),
);

function http(fetch: FetchLike, apiKey: () => string = () => 'synthetic-key') {
  return createHttpTransport({
    vendor: 'qwen',
    baseUrl: BASE,
    apiKey,
    fetch,
    quirks: quirksFor('qwen'),
  });
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

it('[AC-B3-09o#u1] 凭据读不到时在 fetch 之前抛 auth 错，登记为没发出，错误形状不变', async () => {
  const fetch = vi.fn<FetchLike>();
  const error = await failure(
    http(fetch, () => {
      throw new Error('synthetic credential rotation');
    }).send(request),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(ModelProtocolError);
  expect(error).toMatchObject({ kind: 'auth', status: null, vendorCode: null, usage: null });
  expect(Object.keys(error as object).sort()).toEqual([
    'kind',
    'name',
    'status',
    'usage',
    'vendorCode',
  ]);
  expect(wasNotSent(error)).toBe(true);
});

it('[AC-B3-09o#u2] 已中止或厂商不符等发出前的错都登记；fetch 之后的失败不登记', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('synthetic network down')));
  const early = await failure(http(fetch).send(request, aborted.signal));
  const wrongVendor = await failure(http(fetch).send({ ...request, vendor: 'glm' }));
  expect(fetch).not.toHaveBeenCalled();
  expect(wasNotSent(early)).toBe(true);
  expect(wasNotSent(wrongVendor)).toBe(true);
  const late = await failure(http(fetch).send(request));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(late).toMatchObject({ kind: 'network' });
  expect(wasNotSent(late)).toBe(false);
  const rejected = await failure(
    http(() => {
      const response: FetchResponseLike = {
        status: 503,
        body: null,
        text: () => Promise.resolve('{}'),
      };
      return Promise.resolve(response);
    }).send(request),
  );
  expect(rejected).toMatchObject({ kind: 'server', status: 503 });
  expect(wasNotSent(rejected)).toBe(false);
});

it('[AC-B3-09o#u3] 登记只认对象本身：非对象抛出值、未登记的同类错都不算没发出', () => {
  const marked = new ModelProtocolError('auth', 'synthetic');
  const twin = new ModelProtocolError('auth', 'synthetic');
  markNotSent(marked);
  markNotSent('synthetic string');
  expect(wasNotSent(marked)).toBe(true);
  expect(wasNotSent(twin)).toBe(false);
  expect(wasNotSent('synthetic string')).toBe(false);
  expect(wasNotSent(null)).toBe(false);
});
