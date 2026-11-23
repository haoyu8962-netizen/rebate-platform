import { expect, it, vi } from 'vitest';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import { productionRunTexts } from '../../../../apps/api/src/modules/agent/stream/mount/production.ts';
import { context } from '../orchestrator-core/kit.ts';
import { quotes, request, success, url } from '../orchestrator-deterministic/kit.ts';
import { ENTRY_KEY, kit, MEMBER } from '../scenario-entry/kit.ts';
import { fileText } from '../stream-mount/kit.ts';

const PRICE_NOTICE = 'agent.notice.price_unavailable';
const STOP = { kind: 'done', finishReason: 'stop' };
const linkCases = [
  { kind: 'price_unavailable', singleAc: 1, mixedAc: 3 },
  { kind: 'no_card', singleAc: 2, mixedAc: 4 },
] as const;

function expectNotice(card: { readonly fallback_text: string } | undefined, key: string) {
  expect(card).toMatchObject({
    type: 'notice',
    data: { text_key: key },
    fallback_text: fileText(key),
  });
  expect(card?.fallback_text).not.toMatch(/[{}]/u);
}

it.each(linkCases)(
  '[AC-B3-05v#$singleAc] 单链接 $kind 下发无占位符的价格提示并正常结束',
  async ({ kind }) => {
    const out = context();
    const path = createDeterministicPath({
      quotes: quotes([{ kind, cards: [] }]),
      texts: productionRunTexts(async () => [], { warn: vi.fn() }),
    });

    expect(await path.run(request(), out.ctx)).toEqual(STOP);
    const frames = out.content();
    expect(frames).toHaveLength(1);
    const [notice] = frames;
    expectNotice(notice?.kind === 'card' ? notice.card : undefined, PRICE_NOTICE);
  },
);

it.each(linkCases)(
  '[AC-B3-05v#$mixedAc] $kind 与解析失败、服务端失败及成功链接混排时各自下发对应提示或报价',
  async ({ kind }) => {
    const out = context();
    const quote = success(4);
    const path = createDeterministicPath({
      quotes: quotes([
        { kind: 'parse_error', error_code: 30131, cards: [] },
        { kind: 'parse_error', error_code: 50301, cards: [] },
        { kind, cards: [] },
        quote,
      ]),
      texts: productionRunTexts(async () => [], { warn: vi.fn() }),
    });

    expect(await path.run(request([url(1), url(2), url(3), url(4)]), out.ctx)).toEqual(STOP);
    const frames = out.content();
    expect(frames).toHaveLength(4);
    const [parse, server, price, rebate] = frames;
    expectNotice(parse?.kind === 'card' ? parse.card : undefined, 'error.30131');
    expectNotice(server?.kind === 'card' ? server.card : undefined, 'agent.notice.quote_failed');
    expect(rebate).toEqual({ kind: 'card', card: quote.cards[0] });
    expectNotice(price?.kind === 'card' ? price.card : undefined, PRICE_NOTICE);
  },
);

it.each([
  { ac: 5, label: 'price_unavailable', catalogKind: 'price_unavailable' },
  { ac: 6, label: 'no_card', catalogKind: 'skipped' },
] as const)(
  '[AC-B3-05v#$ac] 无模型商品情境入口 $label 下发无占位符的价格提示并正常结束',
  async ({ catalogKind }) => {
    const h = kit();
    h.state.noModel = true;
    h.assemble.mockResolvedValue({ kind: catalogKind });

    const view = await h.run('帮我查这件商品', {
      caller: MEMBER,
      context: { product_key: ENTRY_KEY },
    });

    expect(h.assemble.mock.calls.map(([input]) => input.ref.productKey)).toEqual([ENTRY_KEY]);
    expect(view.result).toEqual(STOP);
    expect(view.cards).toHaveLength(1);
    expectNotice(view.cards[0], PRICE_NOTICE);
  },
);
