// BR-AI-01 细则「意图兜底与不空回复」不空回复: a run ending stop or limit that delivered no text, card or
// suggestions gets agent.reply.empty and agent.suggest.empty.1–3 (BR-TEXT-22). Only notices are an
// answer; cancellation, errors, time limit and safety endings keep their own wording.
import { expect, it } from 'vitest';
import { candidate } from '../tools-search/kit.ts';
import {
  content,
  copy,
  done,
  emptyShortcuts,
  expectEmptyReply,
  expectNoEmptyReply,
  intent,
  kit,
  says,
  unknownCalls,
} from './kit.ts';

it('[AC-B3-05o#30] 模型只返回空白字符：补 agent.reply.empty 与 3 个快捷问法，结束原因 stop', async () => {
  const h = kit();
  const question = '嗯';
  h.say(question, [says('  \n\t ')]);
  const view = await h.run(question);
  expectEmptyReply(view, 'stop');
});

it('[AC-B3-05o#31] 模型既无文字也无工具调用：补 agent.reply.empty 与 3 个快捷问法', async () => {
  const h = kit();
  const question = '这个呢';
  h.say(question, [{}]);
  const view = await h.run(question);
  expectEmptyReply(view, 'stop');
});

it('[AC-B3-05o#32] 最后一轮仍在要工具（limit 结束）且什么都没下发：同样补，结束原因保持 limit', async () => {
  const h = kit();
  const question = '帮我比一比';
  h.say(question, [unknownCalls(1), unknownCalls(1), unknownCalls(1)]);
  const view = await h.run(question);
  expectEmptyReply(view, 'limit');
});

it('[AC-B3-05o#33] 单轮工具调用超过 4 次（limit 结束）且什么都没下发：同样补，结束原因 limit', async () => {
  const h = kit();
  const question = '帮我多查几次';
  h.say(question, [unknownCalls(5)]);
  const view = await h.run(question);
  expectEmptyReply(view, 'limit');
});

it('[AC-B3-05o#34] 本轮只出了 notice 卡（再便宜点已无更便宜的）不算空：不补空回复文案与快捷问法', async () => {
  const h = kit();
  // Shown: one product at exactly the user's lower bound, so nothing cheaper can match.
  h.state.rows = [candidate('tb:synthetic-tissue', 1000)];
  const first = '合成纸巾 10元以上';
  h.say(first, [
    { calls: [{ name: 'search_products', args: { q: '合成纸巾', price_min_fen: 1000 } }] },
    says(''),
  ]);
  const shown = await h.run(first);
  expect(shown.cards.some((c) => c.type === 'product_list')).toBe(true);

  const question = '再便宜点';
  h.say(question, [says(intent('refine', { conditions: { cheaper: true } }))]);
  const view = await h.run(question);
  done(view);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: 'agent.notice.no_cheaper' }),
    }),
  ]);
  expect(view.text).toBe('');
  expect(view.suggestions).toEqual([]);
});

it('[AC-B3-05o#35] search 意图代调检索无结果、只出 notice：不补空回复', async () => {
  const h = kit();
  h.state.rows = [];
  const question = '耳机 50以内';
  h.say(question, [says(intent('search'))]);
  const view = await h.run(question);
  done(view);
  expect(view.cards.length).toBeGreaterThan(0);
  for (const card of view.cards) expect(card.type).toBe('notice');
  expectNoEmptyReply(view);
});

it('[AC-B3-05o#36] 用户在模型回答时取消：什么都不补', async () => {
  const h = kit();
  const controller = new AbortController();
  const question = '帮我找个保温杯';
  h.say(question, [
    {
      text: '',
      before: async () => {
        controller.abort('cancelled');
      },
    },
  ]);
  const view = await h.run(question, { controller });
  done(view, 'stop');
  expect(content(view)).toEqual([]);
});

it('[AC-B3-05o#37] 模型服务拒答（safety 结束）：只有 agent.refuse.unsafe，不补空回复', async () => {
  const h = kit();
  h.complete.mockImplementationOnce(async () => ({
    kind: 'refused',
    entryId: 'synthetic-entry',
    attempts: [],
  }));
  const view = await h.run('合成问题');
  done(view, 'safety');
  expect(content(view)).toEqual([{ kind: 'text', text: copy('agent.refuse.unsafe') }]);
});

it('[AC-B3-05o#38] 输出审核拦截（safety 结束）：不补空回复文案与快捷问法', async () => {
  const h = kit();
  h.state.review = 'block';
  const question = '合成问题';
  h.say(question, [says('这是一句会被拦下的话。')]);
  const view = await h.run(question);
  done(view, 'safety');
  expectNoEmptyReply(view);
  expect(view.suggestions).toEqual([]);
});

it('[AC-B3-05o#39] 正常下发了说明文字：原样结束，不补空回复', async () => {
  const h = kit();
  const question = '你能做什么';
  h.say(question, [says('我可以帮你找货、查返利。')]);
  const view = await h.run(question);
  done(view);
  expect(view.text).toBe('我可以帮你找货、查返利。');
  expect(view.suggestions).toEqual([]);
  expect(view.cards).toEqual([]);
});

it('[AC-B3-05o#40] 快捷问法与空回复文案取自文案字典，不含金额与花括号占位', async () => {
  const h = kit();
  const question = '嗯嗯';
  h.say(question, [says(' ')]);
  const view = await h.run(question);
  expectEmptyReply(view, 'stop');
  for (const item of emptyShortcuts()) {
    expect(item.text).not.toMatch(/[{}¥元]|\d/u);
  }
  expect(view.text).not.toMatch(/[{}]/u);
});
