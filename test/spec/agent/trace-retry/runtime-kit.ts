// B3-08y rule-test kit, integration side (contract: ./kit.ts header). The production stream entry
// of [AC-B3-08g] (../stream-assembly-orders/kit.ts ordersFixture → createProductionStreamAssembly →
// createAgentStreamRuntime on the fixture's ManualTime clock and scheduler) over real PG, with the
// trace writer switch below installed before the runtime is built. Runs go through the runtime's
// HTTP layer. Everything under test is built inside the tests (never in hooks).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createAgentDataPurge } from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import * as traceStore from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { AgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { Step } from '../core-reply-templates/kit.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import type { ManualTime } from '../stream-run/kit.ts';
import { pause, scriptModel } from '../trace-persist/kit.ts';
import { SECOND } from './kit.ts';

/** The agent user hash key of these tests (any non-blank value; BR-AI-22 HMAC key). */
export const HASH_KEY = 'synthetic-b3-08y-user-hash-key';

/** How the real writer is reached: 'pass' writes, 'throw' rejects first, 'hold' waits for release(). */
export type WriterMode = 'pass' | 'throw' | 'hold';

export interface WriterCall {
  readonly method: 'recordCards' | 'recordToolCalls';
  readonly mode: WriterMode;
  readonly appId: string;
  readonly runId: string;
  /** What the real writer resolved (unset while pending or when it rejected). */
  outcome?: unknown;
}

/**
 * Spies on createPgAgentTraceWriter (agent/store/results): every writer built from now on is the
 * real one behind a switch; the real writer's resolved value goes on unchanged ('skipped' too).
 */
export function controlWriter() {
  const original = traceStore.createPgAgentTraceWriter;
  let mode: WriterMode = 'pass';
  let open!: () => void;
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: WriterCall[] = [];
  async function apply(call: WriterCall, write: () => Promise<unknown>): Promise<void> {
    calls.push(call);
    const held = gate;
    if (call.mode === 'throw') throw new Error('合成 trace 写入失败');
    if (call.mode === 'hold') await held;
    const outcome = await write();
    call.outcome = outcome;
    return outcome as void;
  }
  const spy = vi.spyOn(traceStore, 'createPgAgentTraceWriter').mockImplementation((deps) => {
    const real = original(deps);
    const writer: AgentTraceWriter = {
      recordCards(appId, sessionId, runId, cards) {
        return apply({ method: 'recordCards', mode, appId, runId }, () =>
          real.recordCards(appId, sessionId, runId, cards),
        );
      },
      recordToolCalls(appId, runId, toolCalls) {
        return apply({ method: 'recordToolCalls', mode, appId, runId }, () =>
          real.recordToolCalls(appId, runId, toolCalls),
        );
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
    /** Lets every call held so far go on. */
    release(): void {
      open();
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    of(runId: string, which?: WriterMode): WriterCall[] {
      return calls.filter(
        (call) => call.runId === runId && (which === undefined || call.mode === which),
      );
    },
  };
}

/**
 * The production stream entry for `caller` (default: a new phone-bound member of app couli): the
 * writer switch installed, then (with `scripts`) the scripted model of ../trace-persist/kit.ts,
 * then createProductionStreamAssembly and createAgentStreamRuntime.
 */
export async function traceRig(
  db: Kysely<DB>,
  options: {
    readonly scripts?: Readonly<Record<string, readonly Step[]>>;
    readonly caller?: AgentCaller;
  } = {},
) {
  const f = await ordersFixture(db, options.caller === undefined ? {} : { caller: options.caller });
  const writer = controlWriter();
  if (options.scripts !== undefined) scriptModel(options.scripts);
  const assembly = f.build();
  const r = f.mount(assembly);
  return { f, r, writer, appId: f.caller.appId, time: f.time, logs: f.logs };
}

export type TraceRig = Awaited<ReturnType<typeof traceRig>>;

/**
 * Reads until `ready` holds, moving manual time forward by `stepMs` between reads (at most
 * `spanMs` of manual time in all) with a short real pause for real I/O; at most about ten seconds
 * of real time. Then asserts it holds and returns the last value read.
 */
export async function driveUntil<T>(
  time: ManualTime,
  what: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  options: { readonly stepMs?: number; readonly spanMs?: number } = {},
): Promise<T> {
  const stepMs = options.stepMs ?? 250;
  const limit = time.t + (options.spanMs ?? 30 * SECOND);
  let value = await read();
  for (let i = 0; i < 400 && !ready(value); i += 1) {
    if (time.t < limit) await time.to(Math.min(limit, time.t + stepMs));
    await pause(25);
    value = await read();
  }
  expect(ready(value), `never happened within the bound: ${what}`).toBe(true);
  return value;
}

/** Moves manual time forward by `spanMs` in `stepMs` steps, with a short real pause per step. */
export async function letTimePass(time: ManualTime, spanMs: number, stepMs = 30 * SECOND) {
  const target = time.t + spanMs;
  while (time.t < target) {
    await time.to(Math.min(target, time.t + stepMs));
    await pause(5);
  }
}

/** The account deletion's agent purge (BR-AI-22) of `userId` in `appId`, committed. */
export async function purgeUser(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string; readonly at: Date },
) {
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  return db.transaction().execute((trx) => port.purgeAgentDataForUser(trx, { ...input }));
}

export function uuid(): string {
  return randomUUID();
}
