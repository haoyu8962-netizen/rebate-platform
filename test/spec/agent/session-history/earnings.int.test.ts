// B3-08zc · BR-AI-19 细则「助手回复落库」(收益卡只留引用) and listAgentSessionMessages (04 §6.5;
// contracts/agent-stream.schema.json $defs.earnings_summary_history): the earnings card of a reply is
// stored with the terminal state without amounts (as_of and actions only) and the history gives it
// back in that shape, valid against the contract, with no amount anywhere in the answer. Production
// stream entry of [AC-B3-08g] with the earnings port app.module adds (../earnings-tool/production.int
// .test.ts precedent), model scripted; contract in ../reply-persist/kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createEarningsReads } from '../../../../apps/api/src/agent-earnings-reads.ts';
import type { EarningsReads } from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import {
  ACTIONS,
  SOURCE_FIGURES,
  TOOL,
  expectNoAmounts,
  frameIsValidCard,
  registerDecrypt,
  walletSources,
} from '../earnings-tool/kit.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import { framesOf, message, openSession, send, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { cardFramesOf, cardTypesOf, finishOf, runIdOf, scriptModel } from '../trace-persist/kit.ts';
import {
  assistantItemOf,
  expectHistory,
  expectReplyStored,
  historySide,
  listHistory,
  timelessItems,
  userItemOf,
  type Row,
} from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ASK = '我还有多少钱能提';
/** The model's own figure: none of the synthetic amounts. */
const MODEL_ANSWER = '你可提现 4321.09 元。';

/** Every synthetic figure behind the wallet summary of this test. */
const SOURCE_AMOUNTS: readonly number[] = [
  Number(SOURCE_FIGURES.estimated_fen),
  Number(SOURCE_FIGURES.pending_credit_fen),
  Number(SOURCE_FIGURES.pending_credit_paused_fen),
  Number(SOURCE_FIGURES.withdrawn_fen),
  Number(SOURCE_FIGURES.estimated_fen + SOURCE_FIGURES.pending_credit_fen),
];

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 收益卡：终止帧写出后立即读库，agent_cards 只存 as_of 与按钮、card_ids 含该卡；历史接口返回 earnings_summary_history 形状（过契约），整个响应不含金额', async () => {
  const f = await ordersFixture(pg.db, { switches: { [TOOL]: 'on' } });
  registerDecrypt();
  const s = walletSources();
  const earnings: { readonly earningsReads: EarningsReads } = {
    earningsReads: createEarningsReads({ db: pg.db, clock: f.time.clock, wallet: s.dependencies }),
  };
  Object.assign(f.ports, earnings);
  await setConfig(pg.db, f.caller.appId, 'agent.page_guide.routes', ['Wallet', 'WithdrawRecords']);
  const scripts: Record<string, readonly Step[]> = {
    [ASK]: [{ text: LEAD, calls: [{ name: TOOL, args: {} }] }, { text: MODEL_ANSWER }],
  };
  scriptModel(scripts);
  const r = f.mount(f.build());
  try {
    const sessionId = await openSession(r, f.caller);
    const frames = framesOf((await send(r, f.caller, sessionId, message(ASK))).chunks);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['earnings_summary']);
    const live = cardFramesOf(frames)[0]!.data['data'] as Row;
    expect(live['actions']).toEqual(ACTIONS);
    const runId = runIdOf(frames);
    await expectReplyStored(pg.db, { appId: f.caller.appId, sessionId, runId }, frames);

    const history = await historySide(pg.pool(), f.time.clock);
    const { reply, caller } = await listHistory(history, f.caller, sessionId);
    const data = await expectHistory(reply, caller);
    expect(timelessItems(data.items)).toEqual([
      await userItemOf(pg.db, runId),
      await assistantItemOf(pg.db, frames),
    ]);
    const card = data.items[1]?.cards[0];
    expect(card?.data, 'the history shape: as_of and the two actions').toEqual({
      as_of: live['as_of'],
      actions: ACTIONS,
    });
    expect(frameIsValidCard({ ...card }), 'a contract earnings_summary_history card').toBe(true);
    expectNoAmounts(reply.jsons, 'the history answer', SOURCE_AMOUNTS, [
      SOURCE_FIGURES.next_credit_period,
    ]);
  } finally {
    await r.runtime.close();
  }
}, 120_000);
