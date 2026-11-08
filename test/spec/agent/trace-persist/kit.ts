// B3-08q rule-test kit · BR-AI-19「每个 run 都必须异步落 PG，不阻塞 SSE」(D10-960; followups
// AGENT-lane open-followups-20261108 第 11 条). The production stream entry of [AC-B3-08g]
// (../stream-assembly-orders/kit.ts ordersFixture → createProductionStreamAssembly, mounted by
// createAgentStreamRuntime through the fixture's mount) over real PG; runs go through the runtime's
// HTTP layer (sendMessage), so cards are numbered and written by the real RunManager and the run
// rows are real agent_runs rows.
//
// Contract pinned by the tests of this directory (the implementation's freedom ends here):
// - The production stream runtime built over createProductionStreamAssembly, with nothing more
//   than the fixture's mount hands createAgentStreamRuntime (db, clock, logger, contentReader,
//   consentReader, assembly; no new runtime dependency, no test seam), persists every run's
//   delivered card frames to app.agent_cards (card_id, type, schema_version, data and fallback_text
//   exactly as the frame carried them; link_id = top-level data.link_id or null; app / session /
//   run of that run, from the server-side run context only, BR-AI-03) and the model's tool calls to
//   app.agent_tool_calls (seq 1, 2, … in call order, name, status, args = the runtime's traceMask of
//   the model arguments, BR-AI-14 / BR-AI-19), whatever path wrote them: model, degraded keyword
//   search, deterministic link path, intent port.
// - The writes go through agent/store/results createPgAgentTraceWriter (obtained from that module
//   when the assembly or the runtime is built; the tests spy on it there) and happen after, and
//   apart from, the stream: a slow writer does not hold the reply, a failing writer changes no frame
//   and no finish reason and is logged as exactly ONE warn line per run, msg TRACE_WARN below, with
//   the flat field run_id and no card, argument or user text. Repeated writes of the same card or
//   call stay one row (the writer's unique keys).
// - The model path: the production runtime never calls a model (its route is fixed to no_model), so
//   the model-path tests wrap the core body factory the runtime calls (createAgentRunBody) with a
//   scripted model, passing every other dependency the runtime built through unchanged
//   (../core-reply-templates/production.int.test.ts precedent, here inside the runtime).
// Out of scope here (other tasks): BR-AI-19's 24-hour local retry queue and agent.trace_lost alarm,
// retention / cleanup (BR-ID-30 ①). db/schema.sql has no column for card_sources; the link ids of
// link_registrations are checked through the stored card data and agent_cards.link_id only.
// Everything under test is built inside the tests (never in hooks). Synthetic values only.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import * as traceStore from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { AgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { scriptedModels, type Step } from '../core-reply-templates/kit.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import { modelPath } from '../stream-model-prereq/kit.ts';
import { framesOf, message, send, setConfig, type Frame, type Row } from '../stream-mount/kit.ts';

export type { Frame, Row, Step };

/** The one warn line of a run whose trace could not be written (flat fields, run_id). */
export const TRACE_WARN = 'agent_trace_write_failed';

/** The fixture's synthetic product is found by this keyword (degraded and model search alike). */
export const KEYWORD = '合成保温杯';

const PASS = { review: async () => 'pass' as const };

// ---- the trace writer ---------------------------------------------------------------------------

/**
 * How the writer behaves for calls made while the mode is set: 'pass' writes, 'throw' rejects
 * without writing, 'hold' waits for release() and then writes, 'twice' writes the same input
 * twice at once (a repeated delivery).
 */
export type WriterMode = 'pass' | 'throw' | 'hold' | 'twice';

export interface WriterCall {
  readonly method: 'recordCards' | 'recordToolCalls';
  readonly mode: WriterMode;
  readonly appId: string;
  readonly runId: string;
}

/**
 * Spies on createPgAgentTraceWriter (agent/store/results): every writer built from now on is the
 * real one behind a switch (WriterMode). Install before the assembly and the runtime are built.
 */
export function controlWriter() {
  const original = traceStore.createPgAgentTraceWriter;
  let mode: WriterMode = 'pass';
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: WriterCall[] = [];
  async function apply(current: WriterMode, write: () => Promise<void>): Promise<void> {
    if (current === 'throw') throw new Error('合成 trace 写入失败');
    if (current === 'hold') await held;
    if (current === 'twice') {
      await Promise.all([write(), write()]);
      return;
    }
    await write();
  }
  const spy = vi.spyOn(traceStore, 'createPgAgentTraceWriter').mockImplementation((deps) => {
    const real = original(deps);
    const writer: AgentTraceWriter = {
      recordCards(appId, sessionId, runId, cards) {
        const current = mode;
        calls.push({ method: 'recordCards', mode: current, appId, runId });
        return apply(current, () => real.recordCards(appId, sessionId, runId, cards));
      },
      recordToolCalls(appId, runId, toolCalls) {
        const current = mode;
        calls.push({ method: 'recordToolCalls', mode: current, appId, runId });
        return apply(current, () => real.recordToolCalls(appId, runId, toolCalls));
      },
    };
    return writer;
  });
  return {
    spy,
    calls,
    set(next: WriterMode): void {
      mode = next;
    },
    /** Lets every held write go on. */
    release(): void {
      open();
    },
  };
}

// ---- the production stream runtime --------------------------------------------------------------

/**
 * The runtime's core body on the model path: createAgentRunBody (as the runtime calls it) gets the
 * scripted model (answers by user text, ../core-reply-templates/kit.ts scriptedModels), a prompt,
 * and passing reviews; every other dependency the runtime built is passed through unchanged.
 */
export function scriptModel(scripts: Readonly<Record<string, readonly Step[]>>) {
  const complete = scriptedModels(scripts);
  const original = core.createAgentRunBody;
  vi.spyOn(core, 'createAgentRunBody').mockImplementation((deps) =>
    original({
      ...deps,
      ...modelPath([]),
      model: { complete },
      outputReview: { forRun: () => PASS },
    }),
  );
  return complete;
}

/**
 * The production stream entry of [AC-B3-08g] for `caller` (default: a new phone-bound member of
 * app couli): ordersFixture's config, product and order ports, the writer switch installed, then
 * createProductionStreamAssembly and createAgentStreamRuntime. With `scripts` the runtime's runs
 * take the model path (scriptModel); without, they take the production no-model route (degraded
 * keyword search, deterministic link path). `routes`: agent.page_guide.routes of the caller's app.
 */
export async function productionRig(
  db: Kysely<DB>,
  options: {
    readonly scripts?: Readonly<Record<string, readonly Step[]>>;
    readonly caller?: AgentCaller;
    readonly routes?: readonly string[];
  } = {},
) {
  const f = await ordersFixture(db, options.caller === undefined ? {} : { caller: options.caller });
  const appId = f.caller.appId;
  if (options.routes !== undefined) {
    await setConfig(db, appId, 'agent.page_guide.routes', options.routes);
  }
  const writer = controlWriter();
  const complete = options.scripts === undefined ? null : scriptModel(options.scripts);
  const assembly = f.build();
  const r = f.mount(assembly);
  return { f, r, writer, complete, appId };
}

export type ProductionRig = Awaited<ReturnType<typeof productionRig>>;

/** One message through the runtime's HTTP layer; the reply's frames once the reply ended. */
export async function ask(
  x: ProductionRig,
  caller: AgentCaller,
  sessionId: string,
  text: string,
): Promise<Frame[]> {
  return framesOf((await send(x.r, caller, sessionId, message(text))).chunks);
}

/** A product URL of the fixture's demo adapter (its link patterns know the demo host). */
export async function demoUrl(x: ProductionRig): Promise<string> {
  const sample = await x.f.demo.searchItems(
    { keyword: '演示商品' },
    { appId: x.appId, requestId: randomUUID(), purpose: 'online' },
  );
  const first = sample.items[0];
  expect(first?.item_id, 'a demo item').toBeTypeOf('string');
  return `https://demo.invalid/taobao/${encodeURIComponent(first?.item_id ?? '')}`;
}

// ---- frames -------------------------------------------------------------------------------------

export function cardFramesOf(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => frame.event === 'card');
}

export function cardTypesOf(frames: readonly Frame[]): unknown[] {
  return cardFramesOf(frames).map((frame) => frame.data['type']);
}

/** meta.run_id of a reply (an assertion failure when absent). */
export function runIdOf(frames: readonly Frame[]): string {
  const id = frames.find((frame) => frame.event === 'meta')?.data['run_id'];
  expect(id, 'meta.run_id').toBeTypeOf('string');
  return id as string;
}

export function finishOf(frames: readonly Frame[]): unknown {
  return frames.find((frame) => frame.event === 'done')?.data['finish_reason'];
}

/**
 * What the user got, without the per-run ids: event order, text deltas, tool status, card type
 * and card_id, the finish reason.
 */
export function shapeOf(frames: readonly Frame[]): unknown[] {
  return frames.map((frame) => {
    switch (frame.event) {
      case 'card':
        return [frame.event, frame.data['type'], frame.data['card_id']];
      case 'text.delta':
        return [frame.event, frame.data['delta']];
      case 'tool.status':
        return [frame.event, frame.data['tool'], frame.data['phase']];
      case 'done':
        return [frame.event, frame.data['finish_reason']];
      default:
        return [frame.event];
    }
  });
}

// ---- stored rows --------------------------------------------------------------------------------

export interface CardRow {
  readonly app_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly card_id: string;
  readonly type: string;
  readonly data: unknown;
  readonly link_id: string | null;
  readonly schema_version: number;
  readonly fallback_text: string;
}

export interface ToolCallRow {
  readonly app_id: string;
  readonly run_id: string;
  readonly seq: number;
  readonly name: string;
  readonly args: unknown;
  readonly status: string;
}

/** app.agent_cards rows whose `column` equals `value`. */
export async function cardRowsOf(
  db: Kysely<DB>,
  column: 'run_id' | 'session_id' | 'app_id',
  value: string,
): Promise<CardRow[]> {
  const result = await sql<CardRow>`SELECT app_id, session_id::text AS session_id,
      run_id::text AS run_id, card_id, type, data, link_id::text AS link_id, schema_version,
      fallback_text
    FROM app.agent_cards WHERE ${sql.ref(column)}::text = ${value}
    ORDER BY created_at, card_id`.execute(db);
  return result.rows;
}

/** app.agent_tool_calls rows whose `column` equals `value`, by seq. */
export async function toolCallRowsOf(
  db: Kysely<DB>,
  column: 'run_id' | 'app_id',
  value: string,
): Promise<ToolCallRow[]> {
  const result = await sql<ToolCallRow>`SELECT app_id, run_id::text AS run_id, seq, name, args,
      status
    FROM app.agent_tool_calls WHERE ${sql.ref(column)}::text = ${value}
    ORDER BY run_id, seq`.execute(db);
  return result.rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

export function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads until `ready` holds (the trace is written after the reply ended: real I/O time), at most
 * about ten seconds; then asserts it holds and returns the last value read.
 */
export async function eventually<T>(
  what: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let i = 0; i < 400 && !ready(value); i += 1) {
    await pause(25);
    value = await read();
  }
  expect(ready(value), `never happened within the polling bound: ${what}`).toBe(true);
  return value;
}

export interface RunAt {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
}

/**
 * Every card frame of the reply is stored, once, under the run: same card_id, type,
 * schema_version, data and fallback_text as the frame, link_id = top-level data.link_id or null,
 * app / session / run of the run. Returns the run's stored rows.
 */
export async function expectCardsStored(
  db: Kysely<DB>,
  at: RunAt,
  frames: readonly Frame[],
): Promise<CardRow[]> {
  const cards = cardFramesOf(frames);
  expect(cards.length, 'the reply carried card frames').toBeGreaterThan(0);
  const ids = cards.map((frame) => frame.data['card_id']);
  const rows = await eventually(
    `agent_cards of run ${at.runId}: ${ids.join(', ')}`,
    () => cardRowsOf(db, 'run_id', at.runId),
    (found) => ids.every((id) => found.some((row) => row.card_id === id)),
  );
  for (const frame of cards) {
    const id = frame.data['card_id'];
    const matching = rows.filter((row) => row.card_id === id);
    expect(matching, `one stored row for ${String(id)}`).toHaveLength(1);
    const data = frame.data['data'] as Row;
    const linkId = data['link_id'];
    expect(matching[0], `stored ${String(id)}`).toEqual({
      app_id: at.appId,
      session_id: at.sessionId,
      run_id: at.runId,
      card_id: id,
      type: frame.data['type'],
      data,
      link_id: typeof linkId === 'string' ? linkId : null,
      schema_version: frame.data['schema_version'],
      fallback_text: frame.data['fallback_text'],
    });
  }
  return rows;
}

/** The run's stored tool calls once at least `count` are there. */
export function toolCallsOnce(
  db: Kysely<DB>,
  runId: string,
  count: number,
): Promise<ToolCallRow[]> {
  return eventually(
    `${String(count)} agent_tool_calls of run ${runId}`,
    () => toolCallRowsOf(db, 'run_id', runId),
    (rows) => rows.length >= count,
  );
}
