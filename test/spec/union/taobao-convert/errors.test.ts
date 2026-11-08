import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  converted,
  ctx,
  DATAOKE_SECRET,
  identity,
  req,
  response,
  setup,
  unionFailure,
  visible,
} from './kit.ts';

// gz-13：10031 未查询到相关商品 / 10212 联盟商品不存在 / 10213 联盟优惠券已过期（数字与同值字符串同等）。
const UPSTREAM_MESSAGE = 'synthetic upstream message must not leak';

function failed(code: unknown) {
  return response({ time: 1793500984000, code, msg: UPSTREAM_MESSAGE, data: {} });
}

it.each([10031, '10031', 10212, '10212', 10213, '10213'])(
  '[AC-B1-04d#21] 外层 code %s → item_unavailable（商品不可推广类），不告警',
  async (code) => {
    const h = setup({ reply: failed(code) });
    const error = await unionFailure(
      () => h.adapter.convert(req, identity, ctx),
      'item_unavailable',
    );
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.dataokeWarn).not.toHaveBeenCalled();
    expect(visible(error)).not.toContain(UPSTREAM_MESSAGE);
    expect(visible(error)).not.toContain(DATAOKE_SECRET);
  },
);

const OTHER_CODES: [number | string, UnionErrorCode][] = [
  [10014, 'rate_limited'],
  ['10202', 'rate_limited'],
  [10012, 'upstream_unavailable'],
  [-1, 'upstream_unavailable'],
  [10071, 'upstream_rejected'],
];
const NEXT_URL = 'https://s.click.taobao.com/synthetic-next';

it.each(OTHER_CODES)(
  '[AC-B1-04d#22] 其余外层 code %s 沿用 B1-04m 分类 → %s',
  async (code, expected) => {
    const h = setup({ reply: failed(code) });
    await unionFailure(() => h.adapter.convert(req, identity, ctx), expected);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expect(h.taobaoTransport).not.toHaveBeenCalled();
    // 同一适配器下一次正常响应照常转链（排除「一律拒绝」）。
    h.dataokeTransport.mockResolvedValueOnce(
      response({ time: 1793500984000, code: 0, msg: 'ok', data: { shortUrl: NEXT_URL } }),
    );
    const next = await converted(() => h.adapter.convert(req, identity, ctx));
    expect(next.url).toBe(NEXT_URL);
  },
);

it('[AC-B1-04d#23] 签名 / 凭据类外层 code 照 B1-04m 由大淘客客户端告警一次，适配器不另造 30101 / 30102', async () => {
  const h = setup({ reply: failed(10021) });
  const error = await unionFailure(
    () => h.adapter.convert(req, identity, ctx),
    'upstream_misconfigured',
  );
  expect(h.dataokeWarn).toHaveBeenCalledTimes(1);
  expect(h.dataokeWarn.mock.calls[0]![0]).toMatchObject({ code: '10021' });
  expect(visible(error)).not.toMatch(/3010[12]/);
  expect(visible(error)).not.toContain(UPSTREAM_MESSAGE);
});

it.each([502, 503])('[AC-B1-04d#24] HTTP %s → upstream_unavailable', async (status) => {
  const h = setup({ reply: response({ code: 0, data: {} }, status) });
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04d#25] 传输抛错 → upstream_unavailable，不带原文', async () => {
  const h = setup();
  h.dataokeTransport.mockRejectedValueOnce(new Error('synthetic socket detail must not leak'));
  const error = await unionFailure(
    () => h.adapter.convert(req, identity, ctx),
    'upstream_unavailable',
  );
  expect(visible(error)).not.toContain('synthetic socket detail must not leak');
});
