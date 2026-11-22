import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import { productionRunTexts } from '../../../../apps/api/src/modules/agent/stream/mount/production.ts';
import {
  createLinkQuoteRunner,
  type LinkQuoteOutcome,
  type LinkQuoteRunner,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { ParsingError, type Candidate } from '../../../../apps/api/src/modules/parsing/index.ts';
import { context } from '../orchestrator-core/kit.ts';
import { quotes, request, success, texts, url } from '../orchestrator-deterministic/kit.ts';
import { fileText } from '../stream-mount/kit.ts';
import { fixture as quoteFixture } from '../tools-quote/kit.ts';
import { upstreamFailure } from './faults.ts';

const NO_REBATE = 'no_rebate.notice';
const QUOTE_FAILED = 'agent.notice.quote_failed';
const stopped = { kind: 'done', finishReason: 'stop' };
const noRebate = { kind: 'no_rebate', cards: [] } as const satisfies LinkQuoteOutcome;
const serverFailed = { kind: 'server_failed', cards: [] } as const satisfies LinkQuoteOutcome;

function notice(key: string, fallback = `固定文案:${key}`) {
  return {
    kind: 'card',
    card: expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: key }),
      fallback_text: fallback,
    }),
  };
}

function statusPhases(out: ReturnType<typeof context>) {
  return out.events.filter((event) => event.kind === 'status').map((event) => event.phase);
}

function expectServerError(result: unknown) {
  expect(result).toEqual({
    kind: 'error',
    error: {
      code: 50401,
      retryable: false,
      msg: expect.stringMatching(/^[^{}]*[^{}\s][^{}]*$/u),
      fallback: null,
      fallback_q: null,
    },
  });
}

it('[AC-B3-05u#1] 单链接无返利只出无返利提示，正常结束', async () => {
  const out = context();
  const path = createDeterministicPath({ quotes: quotes([noRebate]), texts: texts() });

  expect(await path.run(request(), out.ctx)).toEqual(stopped);
  expect(out.content()).toEqual([notice(NO_REBATE)]);
  expect(statusPhases(out)).toEqual(['start', 'failed']);
});

it.each([
  { ac: 1, label: '超时', outcome: upstreamFailure('timeout') },
  { ac: 2, label: '上游 5xx', outcome: upstreamFailure('5xx') },
  { ac: 3, label: '熔断', outcome: upstreamFailure('circuit_open') },
  { ac: 5, label: '登记抛错', outcome: new Error('合成 links 写入失败') },
  { ac: 6, label: '未归类异常', outcome: new Error('合成内部异常') },
  { ac: 7, label: '归一化服务端失败', outcome: serverFailed },
])(
  '[AC-B3-05u#2#$ac] 单链接$label：保留失败状态，终帧 50401，不出逐条提示',
  async ({ outcome }) => {
    const out = context();
    const copy = texts();
    const path = createDeterministicPath({ quotes: quotes([outcome]), texts: copy });

    expectServerError(await path.run(request(), out.ctx));
    expect(statusPhases(out)).toEqual(['start', 'failed']);
    expect(out.content()).toEqual([]);
  },
);

it('[AC-B3-05u#2#4] ParsingError 50301 在报价器保留解析码，路径判为服务端失败', async () => {
  const f = quoteFixture();
  f.parseUrl.mockRejectedValue(new ParsingError(50301, '合成解析依赖不可用'));
  const runner = createLinkQuoteRunner(f.deps);
  const run = vi.spyOn(runner, 'run');
  const out = context();
  const path = createDeterministicPath({ quotes: runner, texts: texts() });

  expectServerError(await path.run(request(), out.ctx));
  await expect(run.mock.results[0]?.value).resolves.toEqual({
    kind: 'parse_error',
    error_code: 50301,
    cards: [],
  });
  expect(statusPhases(out)).toEqual(['start', 'failed']);
  expect(out.content()).toEqual([]);
});

it('[AC-B3-05u#3] 中间链接服务端失败仍出一条提示，前后报价卡按顺序下发', async () => {
  const out = context();
  const first = success(1);
  const last = success(3);
  const path = createDeterministicPath({
    quotes: quotes([first, serverFailed, last]),
    texts: texts(),
  });

  expect(await path.run(request([url(1), url(2), url(3)]), out.ctx)).toEqual(stopped);
  expect(out.content()).toEqual([
    { kind: 'card', card: first.cards[0] },
    notice(QUOTE_FAILED),
    { kind: 'card', card: last.cards[0] },
  ]);
  expect(statusPhases(out)).toEqual(['start', 'end', 'start', 'failed', 'start', 'end']);
});

it('[AC-B3-05u#4] 上游超时后遇到无返利，两条提示按链接顺序下发并正常结束', async () => {
  const out = context();
  const path = createDeterministicPath({
    quotes: quotes([upstreamFailure('timeout'), noRebate]),
    texts: texts(),
  });

  expect(await path.run(request([url(1), url(2)]), out.ctx)).toEqual(stopped);
  expect(out.content()).toEqual([notice(QUOTE_FAILED), notice(NO_REBATE)]);
  expect(statusPhases(out)).toEqual(['start', 'failed', 'start', 'failed']);
});

it('[AC-B3-05u#5] 口令与 URL 都是服务端失败，两条都保留失败状态且不出逐条提示', async () => {
  const out = context();
  const token: Candidate = { kind: 'tpwd', raw: '￥Synthetic01￥', index: 0 };
  const links = [token, url(1)];
  const runner = quotes([serverFailed, { kind: 'parse_error', error_code: 50301, cards: [] }]);
  const path = createDeterministicPath({ quotes: runner, texts: texts() });

  expectServerError(await path.run(request(links), out.ctx));
  expect(runner.run.mock.calls.map(([link]) => link)).toEqual(links);
  expect(statusPhases(out)).toEqual(['start', 'failed', 'start', 'failed']);
  expect(out.content()).toEqual([]);
});

it('[AC-B3-05u#7] 每个服务端失败记一条脱敏错误日志，商品原因不记错误', async () => {
  const links = [url(1), url(2), url(3)];
  const detail = '合成登记异常详情';
  const amountFen = 870391;
  const error = Object.assign(new Error(`${detail} ${links[0]!.raw} ${String(amountFen)}`), {
    amount_fen: amountFen,
  });
  const logger = { error: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() };
  const runner: LinkQuoteRunner = quotes([error, noRebate, serverFailed, noRebate]);
  const path = createDeterministicPath({ quotes: runner, texts: texts(), logger });

  await path.run(request(links.slice(0, 2)), context().ctx);
  expect(logger.error).toHaveBeenCalledTimes(1);
  await path.run(request(links.slice(2)), context().ctx);
  expect(logger.error).toHaveBeenCalledTimes(2);
  const logged = inspect(logger.error.mock.calls, { depth: null });
  for (const forbidden of [...links.map((link) => link.raw), detail, String(amountFen)]) {
    expect(logged).not.toContain(forbidden);
  }
  logger.error.mockClear();
  await path.run(request([url(4)]), context().ctx);
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B3-05u#10] 部分链接失败时，下发的两条提示都是无占位符的生产文案', async () => {
  const out = context();
  const path = createDeterministicPath({
    quotes: quotes([upstreamFailure('timeout'), noRebate]),
    texts: productionRunTexts(async () => [], { warn: vi.fn() }),
  });

  expect(await path.run(request([url(1), url(2)]), out.ctx)).toEqual(stopped);
  expect(out.content()).toEqual([
    notice(QUOTE_FAILED, fileText(QUOTE_FAILED)),
    notice(NO_REBATE, fileText(NO_REBATE)),
  ]);
  for (const event of out.events) {
    if (event.kind === 'card') expect(event.card.fallback_text).not.toMatch(/[{}]/u);
  }
});

it.each([
  { ac: 1, outcome: { kind: 'no_card', cards: [] }, key: 'error.50301' },
  { ac: 2, outcome: { kind: 'parse_error', error_code: 30131, cards: [] }, key: 'error.30131' },
  { ac: 3, outcome: { kind: 'parse_error', error_code: 30141, cards: [] }, key: 'error.30141' },
  { ac: 4, outcome: { kind: 'price_unavailable', cards: [] }, key: 'error.50301' },
] as const)(
  '[AC-B3-05u#11#$ac] $outcome.kind（$key）是唯一商品原因时仍正常结束并按序出提示',
  async ({ outcome, key }) => {
    const single = context();
    const singlePath = createDeterministicPath({ quotes: quotes([outcome]), texts: texts() });
    expect(await singlePath.run(request(), single.ctx)).toEqual(stopped);
    expect(single.content()).toEqual([notice(key)]);

    const mixed = context();
    const mixedPath = createDeterministicPath({
      quotes: quotes([upstreamFailure('timeout'), outcome]),
      texts: texts(),
    });
    expect(await mixedPath.run(request([url(1), url(2)]), mixed.ctx)).toEqual(stopped);
    expect(mixed.content()).toEqual([notice(QUOTE_FAILED), notice(key)]);
  },
);

it.each([
  { ac: 1, outcome: { kind: 'price_unavailable', cards: [] } },
  { ac: 2, outcome: { kind: 'no_card', cards: [] } },
  { ac: 3, outcome: { kind: 'parse_error', error_code: 30141, cards: [] } },
] as const)(
  '[AC-B3-05u#12#$ac] $outcome.kind 不记错误日志，同一 logger 记录随后发生的服务端失败',
  async ({ outcome }) => {
    const logger = { error: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() };
    const path = createDeterministicPath({
      quotes: quotes([outcome, upstreamFailure('timeout')]),
      texts: texts(),
      logger,
    });

    await path.run(request(), context().ctx);
    expect(logger.error).not.toHaveBeenCalled();

    await path.run(request([url(2)]), context().ctx);
    expect(logger.error).toHaveBeenCalledTimes(1);
  },
);
