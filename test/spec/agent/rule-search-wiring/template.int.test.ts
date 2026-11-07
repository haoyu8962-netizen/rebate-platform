// B3-08l · BR-AI-07「本 run 调用过 search_rules 时，模型生成的文本一律不下发，由服务端输出模板文本」
// (T6: agent.rule.found / agent.rule.not_found) on the production stream assembly: the same entry
// as [AC-B3-08g] (../stream-assembly-orders/kit.ts ordersFixture → createProductionStreamAssembly),
// mounted by the stream runtime; the core body the runtime built is run with a scripted model
// (../stream-model-prereq/kit.ts, the same way as stream-model-prereq-2/output-review.int.test.ts).
// The sentence review is a passing stand-in (the production review is fail-closed in tests and is
// not what is checked here). Real PG for config and app.agent_rule_chunks; synthetic values only.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { passInput, request } from '../stream-assembly/kit.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import { fileText, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { modelPath, receiptContext, type Round } from '../stream-model-prereq/kit.ts';
import { SEARCH_RULES_SWITCH, insertChunk } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** 问句（BR-AI-07 例「提现最低多少」）。 */
const QUESTION = '提现最低多少';
/** BR-AI-07 例「你们和别家比怎么样」：与本 app 任何 active 块都没有共同的字二元组。 */
const UNRELATED = '你们和别家比怎么样';
/** The model's own conclusion after the tool call: must never reach the user (BR-AI-07). */
const MODEL_TEXT = '提现最低10元，返利已到账。';
/** Ordinary model text (no amount, no link): goes out unchanged when no rule tool ran. */
const PLAIN_TEXT = '返利以订单详情页显示为准，规则可以在帮助中心查看。';

const PASS = { review: async () => 'pass' as const };

/** The stream runtime over the production assembly; the core body deps it built. */
async function rig(db: Kysely<DB>) {
  const f = await ordersFixture(db);
  await setConfig(db, f.caller.appId, SEARCH_RULES_SWITCH, true);
  const assembly = f.build();
  const body = vi.spyOn(core, 'createAgentRunBody');
  const r = f.mount(assembly);
  expect(body).toHaveBeenCalledTimes(1);
  const deps: AgentRunBodyDeps = body.mock.calls[0]![0];
  return { f, r, deps };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** One run of the runtime's core body on the model path (scripted rounds). */
async function runModel(x: Rig, text: string, rounds: readonly Round[]) {
  const ctx = x.f.contextOf(x.f.caller);
  const out = receiptContext({ runId: ctx.runId, sessionId: ctx.sessionId });
  const path = modelPath(rounds);
  const result = await core.createAgentRunBody({
    ...x.deps,
    ...path,
    outputReview: { forRun: () => PASS },
    inputCheck: passInput,
  })(request(ctx, text).input)(out.ctx);
  const offered = (path.model.complete.mock.calls[0]?.[0].tools ?? []).map((tool) => tool.name);
  return {
    result,
    frames: out.frames,
    text: out.texts.join(''),
    offered,
    rounds: path.model.complete.mock.calls.length,
  };
}

function chunkIdsOf(frames: Awaited<ReturnType<typeof runModel>>['frames']): unknown[] {
  return frames
    .filter((frame) => frame.type === 'rule_ref')
    .map((frame) => (frame.data as Record<string, unknown>)['chunk_id']);
}

it('[AC-B3-08l#2][BR-AI-07] 生产流装配：模型先调 search_rules（命中本 app active 块）再写自由文本 → 下发文本恰为 agent.rule.found 模板，不含模型文本；rule_ref 卡照常下发', async () => {
  const x = await rig(pg.db);
  try {
    const row = await insertChunk(pg.db, {
      appId: x.f.caller.appId,
      title: '提现最低多少',
      text: '提现最低多少',
    });
    const run = await runModel(x, QUESTION, [
      { calls: [{ name: 'search_rules', args: { question: QUESTION } }] },
      { text: MODEL_TEXT },
    ]);
    expect(run.offered, 'search_rules offered to the model').toContain('search_rules');
    expect(run.rounds, 'tool round, then the final round').toBe(2);
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual(['rule_ref']);
    expect(chunkIdsOf(run.frames)).toEqual([row.chunk_id]);
    expect(run.text).toBe(fileText('agent.rule.found'));
    expect(run.text).not.toContain('已到账');
    expect(run.text).not.toContain('提现最低');
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08l#2][BR-AI-07] 生产流装配：模型先调 search_rules（无命中）再写自由文本 → 下发文本恰为 agent.rule.not_found 模板，出 handoff 卡，不含模型文本', async () => {
  const x = await rig(pg.db);
  try {
    await insertChunk(pg.db, {
      appId: x.f.caller.appId,
      title: '提现规则',
      text: '提现最低金额为一元',
    });
    const run = await runModel(x, UNRELATED, [
      { calls: [{ name: 'search_rules', args: { question: UNRELATED } }] },
      { text: MODEL_TEXT },
    ]);
    expect(run.offered, 'search_rules offered to the model').toContain('search_rules');
    expect(run.rounds, 'tool round, then the final round').toBe(2);
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual(['handoff']);
    expect(run.text).toBe(fileText('agent.rule.not_found'));
    expect(run.text).not.toContain('已到账');
    expect(run.text).not.toContain('提现最低');
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08l#2][BR-AI-07] 对照：同一生产装配下 search_rules 已下发给模型、但本 run 未调用任何工具 → 模型文本照常下发（不是一律替换），无 rule_ref / handoff 卡', async () => {
  const x = await rig(pg.db);
  try {
    await insertChunk(pg.db, {
      appId: x.f.caller.appId,
      title: '提现最低多少',
      text: '提现最低多少',
    });
    const run = await runModel(x, QUESTION, [{ text: PLAIN_TEXT }]);
    expect(run.offered, 'search_rules offered to the model').toContain('search_rules');
    expect(run.rounds).toBe(1);
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual([]);
    expect(run.text).toBe(PLAIN_TEXT);
    expect(run.text).not.toBe(fileText('agent.rule.found'));
    expect(run.text).not.toBe(fileText('agent.rule.not_found'));
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
