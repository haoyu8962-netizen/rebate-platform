// B3-08m · BR-AI-07 on the production stream assembly, through the same entry as [AC-B3-08g]
// (../stream-assembly-orders/kit.ts ordersFixture → createProductionStreamAssembly, mounted by the
// stream runtime; the core body deps the runtime built are run with a scripted model, as
// ../rule-search-wiring/template.int.test.ts does). Complements that file (which covers the plain
// "search_rules, then free text" case): tool-round text, an unfinished sentence with an empty final
// round, an order template (explain_order, FU-AGENT-ORDER-TEMPLATE-TRACE: the production intent
// port's trace.calls is always empty, so the core must decide), and two runs of the same body at
// once. Real PG for config, app.agent_rule_chunks and copy; synthetic values only.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { insertChunk } from '../rule-search-wiring/kit.ts';
import { passInput, request } from '../stream-assembly/kit.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import { fileText, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { modelPath, receiptContext } from '../stream-model-prereq/kit.ts';
import { item } from '../tools-orders/kit.ts';
import {
  LEAD,
  LEAD_OPEN,
  MODEL_TEXT,
  ORDER_MODEL_TEXT,
  offeredFor,
  scriptedModels,
  type Step,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const QUESTION = '提现最低多少';
const PLAIN_TEXT = '返利以订单详情页显示为准，规则可以在帮助中心查看。';
const PLAIN_ASK = '返利以什么为准';
const ORDER_ASK = '我昨天买的牛奶返了吗';
const ORDER_NO = '3900112233445566778';
const PASS = { review: async () => 'pass' as const };

/** The stream runtime over the production assembly; the core body deps it built. */
async function rig(db: Kysely<DB>) {
  const f = await ordersFixture(db);
  await setConfig(db, f.caller.appId, 'agent.tools.search_rules.enabled', true);
  const assembly = f.build();
  const body = vi.spyOn(core, 'createAgentRunBody');
  const r = f.mount(assembly);
  expect(body).toHaveBeenCalledTimes(1);
  const deps: AgentRunBodyDeps = body.mock.calls[0]![0];
  return { f, r, deps };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** One body over the runtime's deps (scripted model keyed by user text, passing review). */
function bodyOf(x: Rig, scripts: Readonly<Record<string, readonly Step[]>>) {
  const complete = scriptedModels(scripts);
  const body = core.createAgentRunBody({
    ...x.deps,
    ...modelPath([]),
    model: { complete },
    outputReview: { forRun: () => PASS },
    inputCheck: passInput,
  });
  async function run(text: string) {
    const ctx = x.f.contextOf(x.f.caller);
    const out = receiptContext({ runId: ctx.runId, sessionId: ctx.sessionId });
    const result = await body(request(ctx, text).input)(out.ctx);
    return { result, frames: out.frames, text: out.texts.join('') };
  }
  return { complete, run };
}

it('[AC-B3-08m#6][BR-AI-07] 生产流装配：工具轮「我先看看。」与 search_rules 同轮（命中），最终轮写结论 → 用户文本恰为 agent.rule.found，两轮模型文本都不下发', async () => {
  const x = await rig(pg.db);
  try {
    await insertChunk(pg.db, { appId: x.f.caller.appId, title: QUESTION, text: QUESTION });
    const b = bodyOf(x, {
      [QUESTION]: [
        { text: LEAD, calls: [{ name: 'search_rules', args: { question: QUESTION } }] },
        { text: MODEL_TEXT },
      ],
    });
    const run = await b.run(QUESTION);
    expect(offeredFor(b.complete, QUESTION)).toContain('search_rules');
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual(['rule_ref']);
    expect(run.text).toBe(fileText('agent.rule.found'));
    expect(run.text).not.toContain('我先看看');
    expect(run.text).not.toContain('已到账');
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08m#6][BR-AI-07] 生产流装配：无句末标点「我先看看」+ search_rules（命中），最终轮模型空文本 → 残句不下发，用户文本恰为 agent.rule.found', async () => {
  const x = await rig(pg.db);
  try {
    await insertChunk(pg.db, { appId: x.f.caller.appId, title: QUESTION, text: QUESTION });
    const b = bodyOf(x, {
      [QUESTION]: [
        { text: LEAD_OPEN, calls: [{ name: 'search_rules', args: { question: QUESTION } }] },
        {},
      ],
    });
    const run = await b.run(QUESTION);
    expect(offeredFor(b.complete, QUESTION)).toContain('search_rules');
    expect(b.complete).toHaveBeenCalledTimes(2);
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual(['rule_ref']);
    expect(run.text).toBe(fileText('agent.rule.found'));
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08m#6][BR-AI-07] 生产流装配：explain_order 按单号查到本人 1 笔 (PAID, reason 空) → 用户文本恰为 order_status.PAID.summary，模型「已返利到账」结论不下发；order_status 卡照发', async () => {
  const x = await rig(pg.db);
  try {
    x.f.findOwnByNumber.mockResolvedValue([
      item({ platform: 'taobao', display_status: 'PAID', reason: null }),
    ]);
    const b = bodyOf(x, {
      [ORDER_ASK]: [
        {
          text: LEAD,
          calls: [{ name: 'explain_order', args: { order_no: ORDER_NO, platform: 'taobao' } }],
        },
        { text: ORDER_MODEL_TEXT },
      ],
    });
    const run = await b.run(ORDER_ASK);
    expect(offeredFor(b.complete, ORDER_ASK)).toContain('explain_order');
    expect(x.f.findOwnByNumber).toHaveBeenCalledTimes(1);
    expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(run.frames.map((frame) => frame.type)).toEqual(['order_status']);
    expect(run.text).toBe(fileText('order_status.PAID.summary'));
    expect(run.text).not.toContain('我先看看');
    expect(run.text).not.toContain('放心');
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08m#6][BR-AI-07] 生产流装配同一 body 同时跑两 run：A 调 search_rules（命中）出 agent.rule.found；B（同 app、新 runId、不调工具）模型文本照发；之后同一 body 再起的不调工具 run 仍照发', async () => {
  const x = await rig(pg.db);
  try {
    await insertChunk(pg.db, { appId: x.f.caller.appId, title: QUESTION, text: QUESTION });
    const b = bodyOf(x, {
      [QUESTION]: [
        { text: LEAD, calls: [{ name: 'search_rules', args: { question: QUESTION } }] },
        { text: MODEL_TEXT },
      ],
      // One single-round run each time the text is asked (the script is per text, in order).
      [PLAIN_ASK]: [{ text: PLAIN_TEXT }, { text: PLAIN_TEXT }],
    });
    const [ruled, plain] = await Promise.all([b.run(QUESTION), b.run(PLAIN_ASK)]);
    expect(offeredFor(b.complete, QUESTION)).toContain('search_rules');
    expect(ruled.text).toBe(fileText('agent.rule.found'));
    expect(ruled.frames.map((frame) => frame.type)).toEqual(['rule_ref']);
    expect(plain.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(plain.frames).toEqual([]);
    expect(plain.text).toBe(PLAIN_TEXT);

    const later = await b.run(PLAIN_ASK);
    expect(later.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(later.text).toBe(PLAIN_TEXT);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
