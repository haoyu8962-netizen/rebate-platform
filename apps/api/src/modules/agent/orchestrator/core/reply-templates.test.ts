import { expect, it } from 'vitest';
import { ReplyTemplateCalls, isReplyTemplateTool } from './reply-templates.ts';

const PAID = { reason_code: null, display_status: 'PAID' };
const WAITING = { reason_code: null, display_status: 'WAITING' };

it('[AC-B3-08m#3] template tools are the two order tools and search_rules only', () => {
  expect(['list_my_orders', 'explain_order', 'search_rules'].every(isReplyTemplateTool)).toBe(true);
  for (const name of ['search_products', 'get_rebate_quote', 'handoff_to_human', 'prefill_claim']) {
    expect(isReplyTemplateTool(name), name).toBe(false);
  }
});

it('[AC-B3-08m#3] no call: no template; a call counts before its outcome', () => {
  const calls = new ReplyTemplateCalls();
  expect(calls.any).toBe(false);
  expect(calls.texts()).toEqual([]);
  calls.called('search_rules');
  expect(calls.any).toBe(true);
  expect(calls.texts()).toEqual([{ key: 'agent.rule.not_found' }]);
});

it('[AC-B3-08m#3] orders over all calls: one order → its status, several → summary with count', () => {
  const one = new ReplyTemplateCalls();
  one.succeeded('explain_order', { orders: [PAID] });
  expect(one.texts()).toEqual([{ key: 'order_status.PAID.summary' }]);

  const two = new ReplyTemplateCalls();
  two.succeeded('list_my_orders', { orders: [WAITING] });
  two.succeeded('explain_order', { orders: [PAID] });
  expect(two.texts()).toEqual([{ key: 'order_list.summary', count: 2 }]);
});

it('[AC-B3-08m#3] reason code wins; a failed order call alone is order_list.empty', () => {
  const reason = new ReplyTemplateCalls();
  reason.succeeded('explain_order', {
    orders: [{ reason_code: 'REFUND', display_status: 'PAID' }],
  });
  expect(reason.texts()).toEqual([{ key: 'order_reason.REFUND.summary' }]);

  const failed = new ReplyTemplateCalls();
  failed.called('list_my_orders');
  expect(failed.texts()).toEqual([{ key: 'order_list.empty' }]);
});

it('[AC-B3-08m#3] lookup markers: not_tracked is one NOT_TRACKED entry; rate_limited adds lookup_limited only', () => {
  const miss = new ReplyTemplateCalls();
  miss.succeeded('explain_order', { orders: [], lookup: 'not_tracked' });
  expect(miss.texts()).toEqual([{ key: 'order_reason.NOT_TRACKED.summary' }]);

  const limited = new ReplyTemplateCalls();
  limited.succeeded('explain_order', { orders: [], lookup: 'rate_limited' });
  expect(limited.texts()).toEqual([{ key: 'agent.order.lookup_limited' }]);

  const both = new ReplyTemplateCalls();
  both.succeeded('list_my_orders', { orders: [PAID] });
  both.succeeded('explain_order', { orders: [], lookup: 'rate_limited' });
  both.succeeded('search_rules', { matched: true });
  expect(both.texts()).toEqual([
    { key: 'order_status.PAID.summary' },
    { key: 'agent.order.lookup_limited' },
    { key: 'agent.rule.found' },
  ]);
});

it('[AC-B3-08m#3] a malformed trace never builds an arbitrary key', () => {
  const calls = new ReplyTemplateCalls();
  calls.succeeded('explain_order', { orders: [{ reason_code: null, display_status: 'x.y' }] });
  expect(calls.texts()).toEqual([{ key: 'order_list.summary', count: 1 }]);

  const junk = new ReplyTemplateCalls();
  junk.succeeded('explain_order', { orders: [{ display_status: 1 }, 'PAID', null] });
  junk.succeeded('search_rules', { matched: 'yes' });
  expect(junk.texts()).toEqual([{ key: 'order_list.empty' }, { key: 'agent.rule.not_found' }]);
});

it('[AC-B3-16a#11] get_my_earnings: shown by any call → summary, else unavailable; between orders and rules', () => {
  expect(isReplyTemplateTool('get_my_earnings')).toBe(true);

  const failed = new ReplyTemplateCalls();
  failed.called('get_my_earnings');
  expect(failed.any).toBe(true);
  expect(failed.texts()).toEqual([{ key: 'agent.earnings.unavailable' }]);
  failed.succeeded('get_my_earnings', { earnings: 'shown' });
  expect(failed.texts()).toEqual([{ key: 'agent.earnings.summary' }]);

  const junk = new ReplyTemplateCalls();
  junk.succeeded('get_my_earnings', { earnings: 'yes' });
  expect(junk.texts()).toEqual([{ key: 'agent.earnings.unavailable' }]);

  const all = new ReplyTemplateCalls();
  all.succeeded('search_rules', { matched: false });
  all.succeeded('get_my_earnings', { earnings: 'shown' });
  all.succeeded('list_my_orders', { orders: [WAITING] });
  expect(all.texts()).toEqual([
    { key: 'order_status.WAITING.summary' },
    { key: 'agent.earnings.summary' },
    { key: 'agent.rule.not_found' },
  ]);
});
