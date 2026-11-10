// B3-16a · the production stream entry over real PG ([AC-B3-08g]'s ordersFixture →
// createProductionStreamAssembly → createAgentStreamRuntime, the B3-08q trace-persist precedent),
// with the earnings port app.module adds (stream/mount/earnings.ts AgentEarningsProvidedPorts, the
// D10-1244 / approvals 71 shape: earningsReads, built by the composition root's
// apps/api/src/agent-earnings-reads.ts createEarningsReads over its own db, no database handle
// passed into the agent) and the model scripted (trace-persist kit scriptModel). Pinned (08 BR-AI-01
// 细则「判定顺序」③④ and「收益查询」, BR-AI-02, BR-AI-07, BR-AI-19; 04 §8.3; history fixture
// contracts/fixtures/agent-streams/normal-earnings-history.ndjson):
// - get_my_earnings is registered and offered to a phone-bound caller whose switch is on; never to
//   a guest or an unbound caller, who get auth_required (login / bind_phone) whatever the switch;
// - switch off: not offered, an earnings question degrades to the Wallet page guide card;
// - a call delivers one earnings_summary card whose figures are getWalletSummary's for that user,
//   the text is exactly agent.earnings.summary; agent_cards stores the card without amounts (the
//   history shape: as_of and actions only); agent_tool_calls and the text carry no amount.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { createEarningsReads } from '../../../../apps/api/src/agent-earnings-reads.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { EarningsReads } from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import { getWalletSummary } from '../../../../apps/api/src/modules/ledger/read.ts';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import {
  definitionNames,
  freshAppId,
  ordersFixture,
  type SwitchState,
} from '../stream-assembly-orders/kit.ts';
import {
  consent,
  fileText,
  framesOf,
  message,
  newGuest,
  newMember,
  openSession,
  send,
  setConfig,
  usePgEach,
  type Frame,
} from '../stream-mount/kit.ts';
import { readFixture } from '../stream-writer/kit.ts';
import {
  cardFramesOf,
  cardRowsOf,
  cardTypesOf,
  eventually,
  finishOf,
  runIdOf,
  scriptModel,
  toolCallsOnce,
} from '../trace-persist/kit.ts';
import {
  ACTIONS,
  KEYS,
  SOURCE_FIGURES,
  SWITCH,
  TOOL,
  expectNoAmounts,
  frameIsValidCard,
  registerDecrypt,
  walletFigures,
  walletSources,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ASK = '我还有多少钱能提';
const BALANCE_ASK = '我余额还有多少';
const INTENT = JSON.stringify({ agent_intent: 'earnings_query' });
/** The model's own figure: none of the synthetic amounts (leak checks are about the server). */
const MODEL_ANSWER = '你可提现 4321.09 元。';

/** Every synthetic figure behind the wallet summary of these tests. */
const SOURCE_AMOUNTS: readonly number[] = [
  Number(SOURCE_FIGURES.estimated_fen),
  Number(SOURCE_FIGURES.pending_credit_fen),
  Number(SOURCE_FIGURES.pending_credit_paused_fen),
  Number(SOURCE_FIGURES.withdrawn_fen),
  Number(SOURCE_FIGURES.estimated_fen + SOURCE_FIGURES.pending_credit_fen),
];

/**
 * ordersFixture (phone-bound member of app couli unless `caller`) plus the earnings port, the
 * get_my_earnings switch as given (default on), the guide routes, the scripted model; then the
 * production assembly and the runtime.
 */
async function earningsRig(
  db: Kysely<DB>,
  options: {
    readonly scripts: Readonly<Record<string, readonly Step[]>>;
    readonly earningsSwitch?: SwitchState;
    readonly caller?: AgentCaller;
  },
) {
  const f = await ordersFixture(db, {
    ...(options.caller === undefined ? {} : { caller: options.caller }),
    switches: { [TOOL]: options.earningsSwitch ?? 'on' },
  });
  registerDecrypt();
  const s = walletSources();
  // AgentEarningsProvidedPorts as D10-1244 has it: the reads app.module builds with its own db
  // (written out here so this file compiles against the agent before its port is reshaped).
  const earnings: { readonly earningsReads: EarningsReads } = {
    earningsReads: createEarningsReads({ db, clock: f.time.clock, wallet: s.dependencies }),
  };
  Object.assign(f.ports, earnings);
  await setConfig(db, f.caller.appId, 'agent.page_guide.routes', ['Wallet', 'WithdrawRecords']);
  const complete = scriptModel(options.scripts);
  const assembly = f.build();
  const r = f.mount(assembly);
  return { f, s, assembly, r, complete };
}

async function ask(
  x: Awaited<ReturnType<typeof earningsRig>>,
  who: AgentCaller,
  text: string,
): Promise<{ readonly sessionId: string; readonly frames: Frame[] }> {
  const sessionId = await openSession(x.r, who);
  const frames = framesOf((await send(x.r, who, sessionId, message(text))).chunks);
  return { sessionId, frames };
}

interface ToolCallJson {
  readonly tool_call: Record<string, unknown>;
}

/** Every column of the run's app.agent_tool_calls rows (to_jsonb: a new column is scanned too). */
async function toolCallColumnsOf(
  db: Kysely<DB>,
  runId: string,
): Promise<Record<string, unknown>[]> {
  const result = await sql<ToolCallJson>`SELECT to_jsonb(t) AS tool_call
    FROM app.agent_tool_calls t WHERE t.run_id::text = ${runId} ORDER BY t.seq`.execute(db);
  return result.rows.map((found) => found.tool_call);
}

function textOf(frames: readonly Frame[]): string {
  return frames
    .filter((frame) => frame.event === 'text.delta')
    .map((frame) => String(frame.data['delta']))
    .join('');
}

it('[AC-B3-16a#19][BR-AI-01][BR-AI-04][BR-AI-07][BR-AI-19] 生产流装配：已绑手机且开关开 → 下发 get_my_earnings；调用后出 1 张 earnings_summary，四个数字与该用户 getWalletSummary 逐一相等，fallback_text 为 agent.earnings.fallback，文本恰为 agent.earnings.summary；agent_cards 只存 as_of 与按钮（历史重载形状），agent_tool_calls 与文本无金额', async () => {
  const x = await earningsRig(pg.db, {
    scripts: {
      [ASK]: [{ text: LEAD, calls: [{ name: TOOL, args: {} }] }, { text: MODEL_ANSWER }],
    },
  });
  try {
    expect(await definitionNames(x.assembly, x.f.caller)).toContain(TOOL);
    const who = { appId: x.f.caller.appId, userId: x.f.caller.userId ?? '' };
    const { sessionId, frames } = await ask(x, x.f.caller, ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['earnings_summary']);
    const frame = cardFramesOf(frames)[0]!;
    const data = frame.data['data'] as Record<string, unknown>;

    const wallet = await getWalletSummary(pg.db, who, x.s.dependencies);
    expect({
      withdrawable_fen: data['withdrawable_fen'],
      estimated_total_fen: data['estimated_total_fen'],
      next_credit_period: data['next_credit_period'],
      credit_overdue: data['credit_overdue'],
    }).toEqual(walletFigures(wallet));
    expect(data['estimated_total_fen'], 'the synthetic estimates reached the card').toBe(
      SOURCE_AMOUNTS[4],
    );
    expect(data['latest_withdrawal']).toBeNull();
    expect(data['actions']).toEqual(ACTIONS);
    expect(frame.data['fallback_text']).toBe(fileText(KEYS.fallback));
    expect(textOf(frames)).toBe(fileText(KEYS.summary));
    expectNoAmounts(textOf(frames), 'delivered text', SOURCE_AMOUNTS);

    // Stored without amounts: exactly the history shape of the contract fixture.
    const runId = runIdOf(frames);
    const rows = await eventually(
      `agent_cards of run ${runId}`,
      () => cardRowsOf(pg.db, 'run_id', runId),
      (found) => found.some((row) => row.card_id === frame.data['card_id']),
    );
    const stored = rows.filter((row) => row.type === 'earnings_summary');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.session_id).toBe(sessionId);
    expect(stored[0]!.data).toEqual({ as_of: data['as_of'], actions: ACTIONS });
    const history = readFixture('normal-earnings-history')[0] as {
      readonly data: Record<string, unknown>;
    };
    expect(Object.keys(stored[0]!.data as object).sort()).toEqual(
      Object.keys(history.data['data'] as object).sort(),
    );
    expect(
      frameIsValidCard({
        card_id: stored[0]!.card_id,
        type: stored[0]!.type,
        schema_version: stored[0]!.schema_version,
        data: stored[0]!.data,
        fallback_text: stored[0]!.fallback_text,
      }),
      'the stored card is the contract history shape',
    ).toBe(true);
    expectNoAmounts(rows, 'agent_cards', SOURCE_AMOUNTS, [SOURCE_FIGURES.next_credit_period]);

    const calls = await toolCallsOnce(pg.db, runId, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([[1, TOOL, 'ok']]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask({}, {}));
    expectNoAmounts(calls, 'agent_tool_calls', SOURCE_AMOUNTS, [SOURCE_FIGURES.next_credit_period]);

    // Every column of the stored tool call, result_digest included (10 AC-S1-148).
    const full = await toolCallColumnsOf(pg.db, runId);
    expect(full).toHaveLength(1);
    const { created_at: createdAt, ...columns } = full[0]!;
    expect(Object.keys(columns), 'result_digest is scanned').toContain('result_digest');
    expect(Object.keys(columns), 'args is scanned').toContain('args');
    // created_at is the database's own timestamp (its microseconds are a random digit run).
    expect(createdAt, 'created_at').toBeTypeOf('string');
    expect(Number.isFinite(Date.parse(createdAt as string)), 'created_at is a timestamp').toBe(
      true,
    );
    expectNoAmounts(columns, 'agent_tool_calls (all columns)', SOURCE_AMOUNTS, [
      SOURCE_FIGURES.next_credit_period,
    ]);
    expectNoAmounts(columns['result_digest'], 'agent_tool_calls.result_digest', SOURCE_AMOUNTS, [
      SOURCE_FIGURES.next_credit_period,
    ]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-16a#20][BR-AI-01] 判定顺序③：开关开时游客与已登录未绑手机都不下发 get_my_earnings，问收益一律出 auth_required（login / bind_phone），不取数；同一装配对已绑手机主体下发', async () => {
  const x = await earningsRig(pg.db, {
    scripts: { [BALANCE_ASK]: [{ text: INTENT }, { text: INTENT }] },
  });
  try {
    expect(await definitionNames(x.assembly, x.f.caller), 'phone-bound').toContain(TOOL);
    const guest = await newGuest(pg.db);
    const unbound = await newMember(pg.db, { phoneBound: false });
    for (const [who, reason] of [
      [guest, 'login'],
      [unbound, 'bind_phone'],
    ] as const) {
      await consent(pg.db, who);
      expect(await definitionNames(x.assembly, who), reason).not.toContain(TOOL);
      const { frames } = await ask(x, who, BALANCE_ASK);
      expect(cardTypesOf(frames), reason).toEqual(['auth_required']);
      expect((cardFramesOf(frames)[0]!.data['data'] as Record<string, unknown>)['reason']).toBe(
        reason,
      );
      expect(finishOf(frames), reason).toBe('auth_required');
    }
    expect(x.s.readUser).not.toHaveBeenCalled();
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-16a#21][BR-AI-01][BR-AI-02] 判定顺序④：开关关的 app 不下发 get_my_earnings，已绑手机问余额降为 Wallet 引导卡、不取数；同一装配对开关开的另一 app 照常下发', async () => {
  const x = await earningsRig(pg.db, {
    earningsSwitch: 'false',
    scripts: { [BALANCE_ASK]: [{ text: INTENT }] },
  });
  try {
    const otherApp = freshAppId();
    await setConfig(pg.db, otherApp, SWITCH, true);
    const elsewhere: AgentCaller = { ...x.f.caller, appId: otherApp };
    expect(await definitionNames(x.assembly, elsewhere), 'switch on elsewhere').toContain(TOOL);
    expect(await definitionNames(x.assembly, x.f.caller), 'switch off here').not.toContain(TOOL);

    const { frames } = await ask(x, x.f.caller, BALANCE_ASK);
    expect(cardTypesOf(frames)).toEqual(['page_guide']);
    expect((cardFramesOf(frames)[0]!.data['data'] as Record<string, unknown>)['route']).toBe(
      'Wallet',
    );
    expect(x.s.readUser).not.toHaveBeenCalled();
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
