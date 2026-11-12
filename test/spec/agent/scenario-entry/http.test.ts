// B3-05q · BR-AI-01 细则「情境入口」: context 的形状由契约校验（AgentMessageContext：三选一、不许多余
// 字段），不合法的请求按 20001 拒绝，不受理、不计额度; a valid one reaches the run unchanged and
// drives the entry card. HTTP layer: createAgentHttp over the stream-http fakes (no listen); the
// run body the HTTP layer hands out is then run on this suite's production composition.
import { expect, it } from 'vitest';
import { expectStream, httpStatusOf, member, message, rig, send } from '../stream-http/kit.ts';
import { ENTRY_KEY, OWN_ORDER, kit, quotedKeys } from './kit.ts';

const MALFORMED: readonly unknown[] = [
  { product_key: ENTRY_KEY, order_id: OWN_ORDER },
  { product_key: ENTRY_KEY, text: '合成剪贴板' },
  { order_id: OWN_ORDER, text: '合成剪贴板' },
  { product_key: ENTRY_KEY, scene: 'detail' },
  { order_id: OWN_ORDER, user_id: 'synthetic-other-user' },
  { text: '合成剪贴板', source: 'clipboard' },
  {},
  { text: '' },
  { product_key: 12345 },
  'tb:synthetic-entry',
  [{ product_key: ENTRY_KEY }],
  null,
];

it('[AC-B3-05q#17][BR-AI-01][BR-AI-23][BR-AI-15] context 形状不合法（同时给两项、多余字段、空对象、类型不对）→ 20001，不受理、不计额度、不进本轮；合法的 product_key 原样交给本轮并按入口出卡', async () => {
  const r = rig();
  const caller = member();
  const sessionId = r.sessions.add(caller);

  for (const context of MALFORMED) {
    const reply = await send(r, caller, sessionId, { ...message('这个值得买吗'), context });
    const call = reply.single();
    expect(call.body['code'], JSON.stringify(context)).toBe(20001);
    expect(call.status, JSON.stringify(context)).toBe(httpStatusOf(20001));
  }
  // Refused before acceptance: no admission (no quota), no redaction, no run.
  expect(r.admission.admits).toEqual([]);
  expect(r.redactor.calls).toEqual([]);
  expect(r.bodyInputs).toEqual([]);
  expect(r.starts).toEqual([]);

  const accepted = await send(r, caller, sessionId, {
    ...message('这个值得买吗'),
    context: { product_key: ENTRY_KEY },
  });
  expectStream(accepted);
  expect(r.admission.admits).toHaveLength(1);
  expect(r.bodyInputs).toHaveLength(1);
  const input = r.bodyInputs[0]!;
  expect(input.context).toEqual({ product_key: ENTRY_KEY });

  const h = kit();
  const view = await h.runInput(input);
  expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(h.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
});
