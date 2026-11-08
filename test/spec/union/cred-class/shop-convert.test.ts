import { expect, it } from 'vitest';
import {
  callShop,
  converted,
  envelope,
  expectQuietError,
  response,
  setup,
  SHOP_LINK,
  SHOP_PATH,
  shopData,
  unionFailure,
  visible,
} from '../taobao-shop-convert/kit.ts';

// 原 [AC-B1-04zzt#17] 表里外层 10021 一行的新期望（编排者补充第 3 轮第 2 条）：店铺转链遇凭据类外层码
// 即使 data 里带着链接也失败，码为 upstream_misconfigured；不返回地址，错误不带 pid / relationId / 链接
// 与上游说明；大淘客客户端照现状告警一次 { path, code }。夹具只读复用 taobao-shop-convert/kit.ts。

it('[AC-B1-04zzzx#21] 店铺转链外层 code 10021（即使 data 里带着链接）→ upstream_misconfigured，不返回地址、错误不带 pid / relationId / 链接，告警一次，不重发', async () => {
  const reply = response({ code: 10021, msg: 'synthetic upstream msg', data: shopData() });
  const h = setup({ reply });
  const error = await unionFailure(() => callShop(h.adapter), 'upstream_misconfigured');
  expect(visible(error)).not.toContain('synthetic upstream msg');
  expectQuietError(error);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.taobaoTransport).not.toHaveBeenCalled();
  expect(h.dataokeWarn.mock.calls).toEqual([[{ path: SHOP_PATH, code: '10021' }]]);

  h.dataokeTransport.mockResolvedValueOnce(response(envelope()));
  const next = await converted(() => callShop(h.adapter));
  expect(next.url).toBe(SHOP_LINK);
});
