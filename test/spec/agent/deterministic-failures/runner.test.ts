import { expect, it, vi } from 'vitest';
import {
  createLinkQuoteRunner,
  type TokenParser,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { candidate, context, fixture } from '../tools-quote/kit.ts';
import { upstreamFailure } from './faults.ts';

async function settle<T>(promise: Promise<T>) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
    };
  }
}

it('[AC-B3-05u#6#1] 无返利保留独立分类，不出卡、不调用链接登记', async () => {
  const f = fixture();
  f.setQuote({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });

  await expect(createLinkQuoteRunner(f.deps).run(candidate, context())).resolves.toEqual({
    kind: 'no_rebate',
    cards: [],
  });
  expect(f.commits).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each([
  { ac: 2, port: 'parseUrl', fault: upstreamFailure('timeout') },
  { ac: 3, port: 'assemble', fault: upstreamFailure('5xx') },
  { ac: 4, port: 'register', fault: new Error('合成链接登记写入失败') },
] as const)(
  '[AC-B3-05u#6#$ac] $port 抛错归为 server_failed，不出卡也不向上抛',
  async ({ port, fault }) => {
    const f = fixture();
    f[port].mockRejectedValueOnce(fault);

    expect(await settle(createLinkQuoteRunner(f.deps).run(candidate, context()))).toEqual({
      ok: true,
      value: { kind: 'server_failed', cards: [] },
    });
    expect(f[port]).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(port === 'register' ? 1 : 0);
  },
);

it('[AC-B3-05u#6#5] 口令解析抛出的非 ParsingError 也归为 server_failed', async () => {
  const f = fixture();
  const token = { kind: 'tpwd' as const, raw: '￥Synthetic01￥', index: 0 };
  const parseToken = vi.fn<TokenParser['parseToken']>().mockRejectedValue(upstreamFailure('5xx'));
  const runner = createLinkQuoteRunner({ ...f.deps, tokens: { parseToken } });

  expect(await settle(runner.run(token, context()))).toEqual({
    ok: true,
    value: { kind: 'server_failed', cards: [] },
  });
  expect(parseToken).toHaveBeenCalledTimes(1);
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});
