// B3-16a · BR-AI-07「本 run 调用过 get_my_earnings 时同样不下发模型文本，用 agent.earnings.* 模板，金额只在
// earnings_summary 卡上」; BR-AI-01 细则「收益查询」: 出卡时文本用 agent.earnings.summary（trace 记
// text_replaced_by_template=true），取数失败文本 agent.earnings.unavailable; BR-AI-05 返回模型只有
// {card_id, status}. One core body (createAgentRunBody over ../core-reply-templates/kit.ts coreRig,
// no database) whose tools are the real get_my_earnings handler behind the real ToolRegistry, with
// the core's own card references (orchestrator/core/card-references.ts).
import { expect, it } from 'vitest';
import { cardReference } from '../../../../apps/api/src/modules/agent/orchestrator/core/card-references.ts';
import { coreRig, expectReplaced, fixed, LEAD, typesOf } from '../core-reply-templates/kit.ts';
import {
  AMOUNTS,
  KEYS,
  TOOL,
  WALLET,
  earningsDeps,
  expectNoAmounts,
  registryWith,
  withdrawal,
} from './kit.ts';

const ASK = '我还有多少钱能提';
/**
 * The model's own figures and conclusions (never delivered once get_my_earnings ran). Its number is
 * none of the synthetic amounts: the leak checks below are about what the server passes on.
 */
const MODEL_ANSWER = '你可提现 4321.09 元，最近一笔提现已到账。';
const MONTH = WALLET.next_credit_period ?? '';

function scripts(text = ASK) {
  return {
    [text]: [{ text: LEAD, calls: [{ name: TOOL, args: {} }] }, { text: MODEL_ANSWER }],
  };
}

/** Every message the model was sent, in all rounds (tool results included). */
function modelInput(complete: ReturnType<typeof coreRig>['complete']): unknown[] {
  return complete.mock.calls.map(([chat]) => chat.messages);
}

/** The tool result the model got for its get_my_earnings call (parsed JSON). */
function toolResult(complete: ReturnType<typeof coreRig>['complete']): unknown {
  const second = complete.mock.calls[1]?.[0].messages ?? [];
  const results = second.filter(
    (message) => (message as { readonly role?: unknown }).role === 'tool',
  );
  expect(results, 'one tool result in the second round').toHaveLength(1);
  const content = (results[0] as { readonly content?: unknown }).content;
  expect(content, 'tool result content').toBeTypeOf('string');
  return JSON.parse(content as string) as unknown;
}

it('[AC-B3-16a#11][BR-AI-07][BR-AI-01][BR-TEXT-22] 本 run 调过 get_my_earnings 且出卡：模型文本一律不下发，文本恰为 agent.earnings.summary；trace text_replaced_by_template=true；卡片照常下发', async () => {
  const { deps, read } = earningsDeps(async () => ({
    wallet: WALLET,
    latestWithdrawal: withdrawal({ status: 'PAID_API', paid_at: new Date('2026-11-02T03:00:00Z') }),
  }));
  const { registry } = registryWith({ ...deps, cardReference });
  const rig = coreRig({ scripts: scripts(), patch: { tools: registry } });
  const view = await rig.run(ASK);
  expect(read).toHaveBeenCalledTimes(1);
  expect(typesOf(view.frames)).toEqual(['earnings_summary']);
  expect(view.text).toBe(fixed(KEYS.summary));
  for (const piece of [LEAD, MODEL_ANSWER]) expect(view.text).not.toContain(piece);
  expectReplaced(view, true);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});

it('[AC-B3-16a#12][BR-AI-05][BR-AI-19] 模型拿到的工具结果恰为 {card_id: 下发卡的编号, status: "shown"}；发给模型的全部消息、run trace 与下发文本都不含金额、预计月份与提现状态', async () => {
  const latest = withdrawal({ status: 'PAID_API', paid_at: new Date('2026-11-02T03:00:00Z') });
  const { deps } = earningsDeps(async () => ({ wallet: WALLET, latestWithdrawal: latest }));
  const { registry } = registryWith({ ...deps, cardReference });
  const rig = coreRig({ scripts: scripts(), patch: { tools: registry } });
  const view = await rig.run(ASK);
  const frame = view.frames.find((card) => card.type === 'earnings_summary');
  expect(frame, 'the earnings card was delivered').toBeDefined();
  expect(toolResult(rig.complete)).toEqual({ card_id: frame?.card_id, status: 'shown' });

  expectNoAmounts(modelInput(rig.complete), 'model input', AMOUNTS, [MONTH]);
  expectNoAmounts(view.trace ?? {}, 'run trace', AMOUNTS, [MONTH]);
  expectNoAmounts(view.text, 'delivered text', AMOUNTS, [MONTH]);
  for (const leak of ['PAID_API', latest.masked_account]) {
    expect(JSON.stringify(modelInput(rig.complete)), `model input: no ${leak}`).not.toContain(leak);
    expect(JSON.stringify(view.trace ?? {}), `trace: no ${leak}`).not.toContain(leak);
  }
});

it('[AC-B3-16a#13][BR-AI-07][BR-AI-04] 取数失败：不出 earnings_summary 卡，文本恰为 agent.earnings.unavailable，模型文本不下发；模型拿到 {status: "unavailable"}', async () => {
  const { deps, read } = earningsDeps(() => Promise.reject(new Error('合成钱包查询超时')));
  const { registry } = registryWith({ ...deps, cardReference });
  const rig = coreRig({ scripts: scripts(), patch: { tools: registry } });
  const view = await rig.run(ASK);
  expect(read).toHaveBeenCalledTimes(1);
  expect(typesOf(view.frames)).not.toContain('earnings_summary');
  expect(view.text).toBe(fixed(KEYS.unavailable));
  expect(view.text).not.toContain(MODEL_ANSWER);
  expectReplaced(view, true);
  expect(toolResult(rig.complete)).toEqual({ status: 'unavailable' });
});
