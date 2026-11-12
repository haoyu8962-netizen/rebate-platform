// B3-05o rule tests, second round (spec-test review r1): rule_qa's delegated question is the
// redacted text (BR-AI-01 细则「意图兜底与不空回复」); 不空回复 writes one log line and counts once,
// only when it fills a run; an error ending gets nothing added; BR-AI-18 细则「比较与适用性的提示」
// needs "no intent object" on its own (out_of_scope, page_guide account wording).
import { expect, it } from 'vitest';
import {
  maskForTrace,
  redactForModel,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import {
  content,
  copy,
  done,
  expectEmptyReply,
  expectNoEmptyReply,
  intent,
  kit,
  says,
  titleNotices,
  tracedCalls,
  typesOf,
  unknownCalls,
  type Kit,
} from './kit.ts';

/** A first run of the session in which the model's search delivered a product list. */
async function showProducts(h: Kit): Promise<void> {
  const question = '合成保温杯';
  h.say(question, [{ calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] }, says('')]);
  const shown = await h.run(question);
  expect(shown.cards.some((c) => c.type === 'product_list')).toBe(true);
  expect(titleNotices(shown)).toEqual([]);
}

it('[AC-B3-05o#54] rule_qa 代调 search_rules 的问句是本条消息脱敏后的文字：不含原手机号与原长数字，留痕的 args 也不含原值', async () => {
  const h = kit();
  const phone = '13800138000';
  const member = '88001234567890';
  const question = `我会员号${member}，手机${phone}，返利规则是怎样的`;
  const redacted = redactForModel(question).text;
  // The model form: the phone masked, the long number a run-local placeholder.
  expect(redacted).not.toContain(phone);
  expect(redacted).not.toContain(member);
  expect(redacted).toContain('<num_1>');
  h.say(question, [{ text: intent('rule_qa') }]);
  const view = await h.run(question);
  done(view);
  expect(h.chunks).toHaveBeenCalled();
  expect(typesOf(view)).toEqual(['rule_ref']);
  expect(view.text).toBe(copy('agent.rule.found'));
  const calls = tracedCalls(view, 'search_rules');
  expect(calls).toEqual([
    expect.objectContaining({
      args: { question: maskForTrace(redacted) },
      status: 'ok',
      initiator: 'server',
    }),
  ]);
  const traced = JSON.stringify(calls[0]?.args);
  expect(traced).not.toContain(phone);
  expect(traced).not.toContain(member);
  // Not the storage form of the raw message either (that keeps the long number's last four).
  expect(calls[0]?.args).not.toEqual({ question: maskForTrace(question) });
});

it('[AC-B3-05o#55] 补空回复时记一条空回复日志、计数加一', async () => {
  const h = kit();
  const question = '嗯';
  h.say(question, [says('   ')]);
  expect(h.emptyReplyLogs()).toEqual([]);
  const view = await h.run(question);
  expectEmptyReply(view, 'stop');
  expect(h.emptyReplyLogs()).toHaveLength(1);
  expect(h.emptyReplies.record).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05o#56] limit 结束补空回复同样记一条日志、计一次；之后一轮正常答复不再增加', async () => {
  const h = kit();
  const empty = '帮我多查几次';
  h.say(empty, [unknownCalls(5)]);
  expectEmptyReply(await h.run(empty), 'limit');
  expect(h.emptyReplyLogs()).toHaveLength(1);
  expect(h.emptyReplies.record).toHaveBeenCalledTimes(1);

  const answered = '你能做什么';
  h.say(answered, [says('我可以帮你找货、查返利。')]);
  const view = await h.run(answered);
  done(view);
  expectNoEmptyReply(view);
  expect(h.emptyReplyLogs()).toHaveLength(1);
  expect(h.emptyReplies.record).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05o#57] 正常下发文字、或只出 notice 卡（不算空）时不记空回复日志、不计数', async () => {
  const h = kit();
  const answered = '你能做什么';
  h.say(answered, [says('我可以帮你找货、查返利。')]);
  const first = await h.run(answered);
  done(first);
  expectNoEmptyReply(first);

  h.state.rows = [];
  const nothing = '耳机 50以内';
  h.say(nothing, [says(intent('search'))]);
  const second = await h.run(nothing);
  done(second);
  expect(second.cards.length).toBeGreaterThan(0);
  for (const card of second.cards) expect(card.type).toBe('notice');
  expectNoEmptyReply(second);

  expect(h.emptyReplyLogs()).toEqual([]);
  expect(h.emptyReplies.record).not.toHaveBeenCalled();
});

it('[AC-B3-05o#58] 以 error 结束的轮次（模型不可用、无模型降级全部平台检索失败 50302）且无任何下发：不补空回复、不出快捷问法、不记日志不计数', async () => {
  const h = kit();
  h.searchProducts.mockRejectedValue(new Error('synthetic upstream unavailable'));
  const question = '帮我找合成耳机';
  h.say(question, [{ degraded: 'models_failed' }]);
  const view = await h.run(question);
  expect(view.result).toMatchObject({ kind: 'error', error: { code: 50302 } });
  expect(h.searchProducts).toHaveBeenCalled();
  expect(view.cards).toEqual([]);
  expect(view.suggestions).toEqual([]);
  expect(content(view).filter((e) => e.kind === 'text')).toEqual([]);
  expectNoEmptyReply(view);
  expect(h.emptyReplyLogs()).toEqual([]);
  expect(h.emptyReplies.record).not.toHaveBeenCalled();
});

it('[AC-B3-05o#59] 有当前结果集时模型输出 out_of_scope：服务端出 agent.refuse.out_of_scope、不调工具，不附 title_based', async () => {
  const h = kit();
  await showProducts(h);
  const searches = h.searchProducts.mock.calls.length;
  const question = '今天天气怎么样';
  h.say(question, [says(intent('out_of_scope'))]);
  const view = await h.run(question);
  done(view);
  expect(view.text).toBe(copy('agent.refuse.out_of_scope'));
  expect(titleNotices(view)).toEqual([]);
  expect(view.cards).toEqual([]);
  expect(view.trace?.tool_calls ?? []).toEqual([]);
  expect(h.searchProducts.mock.calls.length).toBe(searches);
});

it('[AC-B3-05o#60] 有当前结果集时模型输出 page_guide、服务端只给账户安全类文字（「帮我注销账号」→ agent.guide.account.delete）：不出卡、不调工具，不附 title_based', async () => {
  const h = kit();
  await showProducts(h);
  const question = '帮我注销账号';
  h.say(question, [says(intent('page_guide', { guide_route: 'DeleteAccount' }))]);
  const view = await h.run(question);
  done(view);
  expect(view.text).toBe(copy('agent.guide.account.delete'));
  expect(titleNotices(view)).toEqual([]);
  expect(view.cards).toEqual([]);
  expect(view.suggestions).toEqual([]);
  expect(view.trace?.tool_calls ?? []).toEqual([]);
});
