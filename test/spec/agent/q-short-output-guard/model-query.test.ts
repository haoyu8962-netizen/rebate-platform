// B3-05s / D10-1469: model tool arguments are untrusted suggestion variables.
// Reuse the real stream assembly, registry, search handler and result decorator. Only the
// model, upstream search and sentence-review ports are doubles; OutputGuard is never mocked.
// Each test includes a newly required rejection, including the paired regression controls,
// so the current implementation fails by assertion without replacing production functions.
import { expect, it } from 'vitest';
import {
  copy,
  done,
  intent,
  kit,
  noResultSuggestions,
  says,
  type Kit,
  type RunView,
} from '../intent-fallback/kit.ts';

async function modelSearch(h: Kit, q: string, question = '合成检索'): Promise<RunView> {
  h.state.rows = [];
  h.say(question, [{ calls: [{ name: 'search_products', args: { q } }] }, says('')]);
  const view = await h.run(question);
  expect(h.searchProducts).toHaveBeenCalledWith(
    expect.objectContaining({ q }),
    expect.anything(),
    expect.anything(),
  );
  return view;
}

function rejected(
  view: RunView,
  fragment: string,
  hit?: 'amount' | 'url' | 'tpwd',
  explanation = '',
): void {
  done(view);
  // Checking q must not feed or stop the explanation guard, even when sentence review blocks q.
  expect(view.text).toBe(explanation);
  // Exact items check both display and send_text; neither a sanitized second chip nor a
  // blank second chip is allowed. The first and third dictionary entries stay in order.
  expect(view.suggestions).toEqual([noResultSuggestions(null)]);
  expect(view.cards.map((card) => card.data['text_key'])).toContain('agent.notice.no_result');
  expect(JSON.stringify(view.events)).not.toContain(fragment);
  expect(view.trace).toMatchObject({ output_filtered: true });
  if (hit !== undefined) expect(view.trace?.filter_hits).toContain(hit);
}

it('[AC-B3-05s#1][BR-AI-06] 模型检索词中的元金额命中：整条只搜建议消失，其余两条和金额留痕保留', async () => {
  const h = kit();
  const view = await modelSearch(h, '99元耳机');
  rejected(view, '99元', 'amount');
});

it('[AC-B3-05s#2][BR-AI-06] 模型检索词中的货币符号命中：不把见卡片替换结果放进只搜建议', async () => {
  const h = kit();
  const view = await modelSearch(h, '¥30水杯');
  rejected(view, '¥30', 'amount');
});

it('[AC-B3-05s#3][BR-AI-06] 模型检索词含 HTTP 链接：不出只搜建议并留痕 url', async () => {
  const h = kit();
  // A complete synthetic URL fits within eight code points; no truncation-order assumption.
  const view = await modelSearch(h, 'http://a');
  rejected(view, 'http://a', 'url');
});

it('[AC-B3-05s#4][BR-AI-06] 模型检索词含 scheme：第 1、3 条保留且不泄露跳转串', async () => {
  const h = kit();
  const view = await modelSearch(h, 'tb://a');
  rejected(view, 'tb://a', 'url');
});

it('[AC-B3-05s#5][BR-AI-06] 模型检索词含无协议短链：第 2 条删除并留痕 url', async () => {
  const h = kit();
  const view = await modelSearch(h, 'x.cn/a');
  rejected(view, 'x.cn/a', 'url');
});

it('[AC-B3-05s#6][BR-AI-06] 模型检索词含复制打开口令：第 2 条删除并留痕 tpwd', async () => {
  const h = kit();
  // This passcode form fits within q_short, unlike an 8–14 character wrapped token.
  const view = await modelSearch(h, '复制打开淘宝');
  rejected(view, '复制打开淘宝', 'tpwd');
});

it('[AC-B3-05s#7][BR-AI-06] 审核桩只拦模型检索词：不出第 2 条，其他建议照出且记 output_filtered', async () => {
  const h = kit();
  const q = '合成审核拦截词';
  h.review.mockImplementation(async (text) => (text.includes(q) ? 'block' : 'pass'));
  const view = await modelSearch(h, q);
  // No model explanation was emitted, so this review and filtering trace must come from q.
  expect(h.review).toHaveBeenCalledWith(expect.stringContaining(q));
  rejected(view, q);
});

it('[AC-B3-05s#8][BR-AI-06][BR-TEXT-22] 同一编排实例里金额词被拦，普通词仍取前 8 码点且留痕不串轮', async () => {
  const h = kit();
  const unsafe = await modelSearch(h, '99元耳机', '合成金额检索');
  const safe = await modelSearch(h, '𠮷野家牛肉饭套餐双人份', '合成普通检索');
  // Check the control before the new rejection: no standalone already-green test is added.
  done(safe);
  expect(safe.suggestions).toEqual([noResultSuggestions('𠮷野家牛肉饭套餐')]);
  expect(safe.trace).toMatchObject({ output_filtered: false, filter_hits: [] });
  rejected(unsafe, '99元', 'amount');
});

it('[AC-B3-05s#9][BR-AI-06][BR-TEXT-22] 同样含金额的检索词：服务端意图兜底代调照旧，模型工具参数才删除第 2 条', async () => {
  const server = kit();
  server.state.rows = [];
  // A bare price without a bound word stays in the existing server keyword extraction.
  const q = '99元合成保温杯加大款';
  const question = `帮我找${q}`;
  server.say(question, [says(intent('search'))]);
  const unchanged = await server.run(question);
  done(unchanged);
  expect(server.searchProducts).toHaveBeenCalledWith(
    expect.objectContaining({ q }),
    expect.anything(),
    expect.anything(),
  );
  expect(unchanged.suggestions).toEqual([noResultSuggestions('99元合成保温杯')]);

  const model = kit();
  const filtered = await modelSearch(model, q);
  rejected(filtered, '99元', 'amount');
});

async function continuedSearch(
  source: 'model' | 'keyword',
  question: string,
  conditions: Readonly<Record<string, unknown>>,
): Promise<RunView> {
  const h = kit();
  const q = '99元合成保温杯加大款';
  const firstQuestion = source === 'model' ? '合成检索' : `帮我找${q}`;
  h.say(
    firstQuestion,
    source === 'model'
      ? [{ calls: [{ name: 'search_products', args: { q } }] }, says('')]
      : [says(intent('search'))],
  );
  const first = await h.run(firstQuestion);
  done(first);
  expect(first.cards.some((card) => card.type === 'product_list')).toBe(true);
  expect(h.searchProducts).toHaveBeenCalledWith(
    expect.objectContaining({ q }),
    expect.anything(),
    1,
  );

  h.searchProducts.mockClear();
  h.state.rows = [];
  // The second model turn supplies only refinement conditions, never q. The server must
  // remember where the inherited term came from, despite making the tool call itself.
  h.say(question, [says(intent('refine', { conditions }))]);
  const second = await h.run(question);
  expect(h.searchProducts).toHaveBeenCalledWith(
    expect.objectContaining({
      q,
      ...(conditions['platform'] === undefined ? {} : { platform: conditions['platform'] }),
      ...(conditions['price_max_fen'] === undefined
        ? {}
        : { price_max_fen: conditions['price_max_fen'] }),
    }),
    expect.anything(),
    conditions['next_batch'] === true ? 2 : 1,
  );
  return second;
}

it.each([
  { ac: 10, question: '换一批', conditions: { next_batch: true } },
  { ac: 11, question: '换到京东', conditions: { platform: 'jd' } },
  { ac: 12, question: '价格改成五十元以内', conditions: { price_max_fen: 5000 } },
])(
  '[AC-B3-05s#$ac][BR-AI-06][BR-TEXT-22] $question 续搜无结果：沿用模型词须过滤，沿用服务端关键词照旧',
  async ({ question, conditions }) => {
    const unchanged = await continuedSearch('keyword', question, conditions);
    done(unchanged);
    expect(unchanged.suggestions).toEqual([noResultSuggestions('99元合成保温杯')]);
    expect(unchanged.text).toBe('');
    expect(unchanged.trace).toMatchObject({ output_filtered: false, filter_hits: [] });

    const filtered = await continuedSearch('model', question, conditions);
    rejected(filtered, '99元', 'amount');
  },
);

it('[AC-B3-05s#13][BR-AI-06] 回答价格追问后服务端沿用模型检索词：无结果时仍须过滤只搜建议', async () => {
  const h = kit();
  const q = '99元耳机';
  h.say('合成检索', [
    {
      calls: [{ name: 'search_products', args: { q, price_min_fen: 5000, price_max_fen: 1000 } }],
    },
    says(''),
  ]);
  const asked = await h.run('合成检索');
  done(asked);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(asked.suggestions).toEqual([
    [1, 2, 3].map((n) => {
      const text = copy(`agent.suggest.clarify.price.${n}`);
      return { text, send_text: text };
    }),
  ]);

  h.state.rows = [];
  h.say('五十到一百元', [
    says(intent('refine', { conditions: { price_min_fen: 5000, price_max_fen: 10000 } })),
  ]);
  const answered = await h.run('五十到一百元');
  expect(h.searchProducts).toHaveBeenCalledWith(
    expect.objectContaining({ q, price_min_fen: 5000, price_max_fen: 10000 }),
    expect.anything(),
    1,
  );
  rejected(answered, '99元', 'amount');
});

it.each([
  { ac: 14, q: '99元耳机', reviewBlocked: false },
  { ac: 15, q: '合成审核拦截词', reviewBlocked: true },
])(
  '[AC-B3-05s#$ac][BR-AI-06] 检索词 $q 被拦仅删除第 2 条建议，模型说明文字原样下发',
  async ({ q, reviewBlocked }) => {
    const h = kit();
    h.state.rows = [];
    if (reviewBlocked) {
      h.review.mockImplementation(async (text) => (text.includes(q) ? 'block' : 'pass'));
    }
    // Two sentences expose both buffer contamination and accidental use of the explanation's
    // sentence budget. Neither belongs to the query's guard evaluation.
    const explanation = '暂时没有找到合适的商品。可以换个关键词试试。';
    h.say('合成检索', [{ calls: [{ name: 'search_products', args: { q } }] }, says(explanation)]);
    const view = await h.run('合成检索');
    expect(h.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ q }),
      expect.anything(),
      expect.anything(),
    );
    rejected(view, q, reviewBlocked ? undefined : 'amount', explanation);
  },
);
