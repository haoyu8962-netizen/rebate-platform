import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ALLOWED_RESULT_KEYS,
  callShop,
  converted,
  dataWithout,
  envelope,
  expectQuietError,
  LONG_TPWD,
  response,
  setup,
  SHOP_LINK,
  shopData,
  TPWD,
  unionFailure,
  visible,
} from './kit.ts';

// 应答口径：code 0 且 shopLinks 是 https、主机属淘宝联盟 → { url: shopLinks, tpwd?, longTpwd? }；
// tpwd 字段名大小写兼容；其余一律失败，从不返回无推广参数的地址；错误信息不带 pid、relationId、链接原文。

const NEXT_LINK = 'https://s.click.taobao.com/t?e=synthetic-shop-next';

it('[AC-B1-04zzt#11] code 0：url = shopLinks 原样，tpwd / longTpwd 原样，只有这三个键', async () => {
  const h = setup();
  const result = await converted(() => callShop(h.adapter));
  expect(result).toEqual({ url: SHOP_LINK, tpwd: TPWD, longTpwd: LONG_TPWD });
  for (const key of Object.keys(result)) expect(ALLOWED_RESULT_KEYS.has(key), key).toBe(true);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.warn).not.toHaveBeenCalled();
});

it.each(['tpwd', 'Tpwd'])(
  '[AC-B1-04zzt#12] 淘口令字段名 %s 都认（实测小写、文档大写），出参键为 tpwd',
  async (name) => {
    const data = { ...dataWithout('tpwd'), [name]: TPWD };
    const h = setup({ reply: response(envelope(data)) });
    const result = await converted(() => callShop(h.adapter));
    expect(result.url).toBe(SHOP_LINK);
    expect(result.tpwd).toBe(TPWD);
    expect(result.longTpwd).toBe(LONG_TPWD);
    expect(result).not.toHaveProperty('Tpwd');
  },
);

it.each([
  ['absent', dataWithout('tpwd', 'longTpwd')],
  ['empty strings', shopData({ tpwd: '', longTpwd: '' })],
  ['null', shopData({ tpwd: null, longTpwd: null })],
])('[AC-B1-04zzt#13] tpwd / longTpwd %s → 照常成功，结果里不出这两个键', async (_label, data) => {
  const h = setup({ reply: response(envelope(data)) });
  const result = await converted(() => callShop(h.adapter));
  expect(Object.keys(result)).toEqual(['url']);
  expect(result.url).toBe(SHOP_LINK);
});

const BAD_LINKS: [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['blank', '   '],
  ['http', 'http://s.click.taobao.com/t?e=synthetic-shop-http'],
  ['protocol-relative', '//s.click.taobao.com/t?e=synthetic-shop-relative'],
  ['no scheme', 's.click.taobao.com/t?e=synthetic-shop-bare'],
  ['a foreign host', 'https://shop-link.invalid/t?e=synthetic-shop-foreign'],
  [
    'a look-alike suffix host',
    'https://s.click.taobao.com.shop-link.invalid/t?e=synthetic-shop-suffix',
  ],
  ['a look-alike dashed host', 'https://s-click-taobao.invalid/t?e=synthetic-shop-dashed'],
  [
    'user info before a foreign host',
    'https://s.click.taobao.com@shop-link.invalid/t?e=synthetic-shop-userinfo',
  ],
  ['a javascript URL', 'javascript:void(0)//synthetic-shop-script'],
  ['a number', 42],
  ['an object', { url: SHOP_LINK }],
];

it.each(BAD_LINKS)(
  '[AC-B1-04zzt#14] shopLinks %s → upstream_unavailable，不返回任何地址、错误不带链接原文；下一次正常应答照常成功',
  async (_label, link) => {
    const data = link === undefined ? dataWithout('shopLinks') : shopData({ shopLinks: link });
    const h = setup({ reply: response(envelope(data)) });
    const error = await unionFailure(() => callShop(h.adapter), 'upstream_unavailable');
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expectQuietError(error, ...(typeof link === 'string' && link.trim() !== '' ? [link] : []));

    h.dataokeTransport.mockResolvedValueOnce(
      response(envelope(shopData({ shopLinks: NEXT_LINK }))),
    );
    const next = await converted(() => callShop(h.adapter));
    expect(next.url).toBe(NEXT_LINK);
  },
);

const UNAVAILABLE: [string, () => ReturnType<typeof response>][] = [
  ['outer code -1', () => response({ code: -1, msg: 'synthetic', data: shopData() })],
  ['outer code "-1"', () => response({ code: '-1', msg: 'synthetic', data: shopData() })],
  ['outer code 10012', () => response({ code: 10012, msg: 'synthetic', data: shopData() })],
  ['no outer code', () => response({ msg: 'synthetic', data: shopData() })],
  ['HTTP 502', () => response(envelope(), 502)],
  ['HTTP 503', () => response(envelope(), 503)],
  ['HTTP 404 with a success-looking body', () => response(envelope(), 404)],
  ['HTTP 403 with a success-looking body', () => response(envelope(), 403)],
  [
    'a body that is not JSON',
    () => ({ status: 200, headers: {}, body: '<html>synthetic gateway page</html>' }),
  ],
  ['data that is not an object', () => response(envelope('synthetic-data-text'))],
  ['data null', () => response(envelope(null))],
];

it.each(UNAVAILABLE)(
  '[AC-B1-04zzt#15] %s → upstream_unavailable，只发一次、不返回地址、错误不带 pid / relationId / 链接；下一次正常应答照常成功',
  async (_label, answer) => {
    const h = setup({ reply: answer() });
    const error = await unionFailure(() => callShop(h.adapter), 'upstream_unavailable');
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expectQuietError(error);

    h.dataokeTransport.mockResolvedValueOnce(
      response(envelope(shopData({ shopLinks: NEXT_LINK }))),
    );
    const next = await converted(() => callShop(h.adapter));
    expect(next.url).toBe(NEXT_LINK);
  },
);

it('[AC-B1-04zzt#16] 传输抛错 → upstream_unavailable，不带原文', async () => {
  const h = setup();
  h.dataokeTransport.mockRejectedValueOnce(new Error('synthetic socket detail must not leak'));
  const error = await unionFailure(() => callShop(h.adapter), 'upstream_unavailable');
  expect(visible(error)).not.toContain('synthetic socket detail must not leak');
  expectQuietError(error);
  const next = await converted(() => callShop(h.adapter));
  expect(next.url).toBe(SHOP_LINK);
});

const FAILED_ANSWER: readonly UnionErrorCode[] = [
  'upstream_unavailable',
  'upstream_rejected',
  'rate_limited',
];

it.each([10021, 10071, 10014, 20001])(
  '[AC-B1-04zzt#17] 其余外层 code %s（即使 data 里带着链接）→ 失败、不返回地址，错误不带 pid / relationId / 链接',
  async (code) => {
    const reply = response({ code, msg: 'synthetic upstream msg', data: shopData() });
    const h = setup({ reply });
    let failure: unknown;
    let result: unknown;
    try {
      result = await callShop(h.adapter);
    } catch (error) {
      failure = error;
    }
    expect(result).toBeUndefined();
    expect(failure).toMatchObject({ platform: 'taobao' });
    expect(FAILED_ANSWER).toContain((failure as { code?: unknown }).code);
    expect(visible(failure)).not.toContain('synthetic upstream msg');
    expectQuietError(failure);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);

    h.dataokeTransport.mockResolvedValueOnce(response(envelope()));
    const next = await converted(() => callShop(h.adapter));
    expect(next.url).toBe(SHOP_LINK);
  },
);
