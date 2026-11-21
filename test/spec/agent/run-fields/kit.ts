import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely } from 'kysely';
import type { PluginTransformQueryArgs } from 'kysely';
import { expect, vi } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { createInputCheck } from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import * as bodyAssembly from '../../../../apps/api/src/modules/agent/stream/mount/agent-body.ts';
import { createAgentStreamRuntime } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { ResolvedRoute } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { SentenceReviewPort } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { ordersFixture } from '../stream-assembly-orders/kit.ts';
import { scriptedModel, type Round } from '../stream-model-prereq/kit.ts';
import {
  contentReaderFor,
  FakeReply,
  framesOf,
  message,
  retrace,
  send,
  setConfig,
} from '../stream-mount/kit.ts';

export const QUESTION = '帮我找合成保温杯';
export const ORDERS = '查一下我的订单';
export const PROMPT = 'synthetic-run-fields-v1';
export const PRIMARY = 'synthetic-flash-2026-11-01';
export const BACKUP = 'synthetic-plus-2026-11-01';
export const SPEC_TIMEOUT = 120_000;

const modelRoute: ResolvedRoute = {
  mode: 'models',
  attempts: [
    { id: 'flash', vendor: 'qwen', tier: 'flash', model: PRIMARY, evaluation: null },
    { id: 'plus', vendor: 'qwen', tier: 'plus', model: BACKUP, evaluation: null },
  ],
  dropped: [],
};

type Complete = AgentRunBodyDeps['model']['complete'];
type Outcome = Awaited<ReturnType<Complete>>;
type Reply = Extract<Outcome, { kind: 'model' }>;
type Step = Round & {
  readonly before?: () => void | Promise<void>;
  readonly usage?: Reply['usage'];
  readonly degrade?: boolean;
};

export function intent(agent_intent: string, fields: Record<string, unknown> = {}): Step {
  return { text: JSON.stringify({ agent_intent, ...fields }) };
}

export function tool(name: string, args: unknown): Step {
  return { calls: [{ name, args }] };
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function runtimeRig(
  db: Kysely<DB>,
  options: {
    readonly steps?: readonly Step[];
    readonly caller?: AgentCaller;
    readonly route?: 'models_without_prompt';
    readonly review?: SentenceReviewPort['review'];
    readonly reviewTimeoutMs?: number;
    readonly config?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const f = await ordersFixture(db, options.caller === undefined ? {} : { caller: options.caller });
  const appId = f.caller.appId;
  await setConfig(db, appId, 'agent.page_guide.routes', ['Wallet']);
  await setConfig(db, appId, 'agent.degraded.route_intents', true);
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await setConfig(db, appId, key, value);
  }
  const steps = options.steps ?? [];
  const answer = scriptedModel(steps);
  let index = 0;
  const complete = vi.fn<Complete>(async (chat, run) => {
    const step = steps[index++];
    await step?.before?.();
    const attempts = [{ entryId: 'flash', result: 'timeout', elapsedMs: 40 }] as const;
    if (step?.degrade === true) {
      return {
        kind: 'degraded',
        reason: 'models_failed',
        attempts: [...attempts, { entryId: 'plus', result: 'timeout', elapsedMs: 45 }],
      };
    }
    const output = await answer(chat, run);
    if (output.kind !== 'model') return output;
    return {
      ...output,
      model: BACKUP,
      entryId: 'plus',
      attempts: [...attempts, { entryId: 'plus', result: 'ok', elapsedMs: 45 }],
      usage: step?.usage ?? output.usage,
    };
  });
  if (options.steps !== undefined || options.route === 'models_without_prompt') {
    const original = bodyAssembly.createStreamAgentBody;
    vi.spyOn(bodyAssembly, 'createStreamAgentBody').mockImplementation((deps) =>
      original({
        ...deps,
        route: async () => modelRoute,
        prompt: {
          current: async () =>
            options.route === 'models_without_prompt'
              ? null
              : { version: PROMPT, system: '合成系统前缀' },
        },
        model: { complete },
        review: { review: async () => 'pass' },
      }),
    );
  }
  const assembly = f.build();
  const normal = createInputCheck({
    review: { review: options.review ?? (async () => 'pass') },
    scheduler: f.time.scheduler,
    texts: assembly.texts,
    ...(options.reviewTimeoutMs === undefined ? {} : { timeoutMs: () => options.reviewTimeoutMs! }),
  });
  const runtime = createAgentStreamRuntime(
    {
      db,
      clock: f.time.clock,
      logger: f.logs.logger,
      contentReader: contentReaderFor(db, f.time.clock),
      consentReader: f.consentReader,
      assembly: () => assembly,
    },
    { inputCheck: normal, schedule: f.time.scheduler },
  );
  const r = { runtime, time: f.time, logs: f.logs };
  const caller = f.caller;
  return {
    f,
    r,
    appId,
    caller,
    complete,
    async ask(session: string, text: string, context?: Record<string, unknown>) {
      const reply = await send(r, caller, session, {
        ...message(text),
        ...(context === undefined ? {} : { context }),
      });
      expect(reply.jsons, '消息已受理并进入流式运行').toEqual([]);
      return framesOf(reply.chunks);
    },
    start(session: string, body = message(QUESTION)) {
      const reply = new FakeReply();
      const settled = runtime.http.sendMessage(retrace(caller), session, body, reply).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      return { reply, settled, frames: () => framesOf(reply.chunks) };
    },
  };
}

export async function storedRun(db: Kysely<DB>, appId: string, runId: string) {
  const row = await db
    .selectFrom('agent_runs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();
  // 迁移前后均可读整行，列缺失时由断言报告。
  return row as typeof row & { readonly input_passed?: boolean };
}

/** 观察真实写入边界。支持 Kysely 的构建器和原生 SQL。 */
export function observeRunUpdates(
  db: Kysely<DB>,
  observe: (statement: string) => void | (() => Promise<void>),
) {
  const compiler = new PostgresQueryCompiler();
  const pending = new WeakMap<PluginTransformQueryArgs['queryId'], () => Promise<void>>();
  return db.withPlugin({
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' || node.kind === 'UpdateQueryNode') {
        const statement = compiler.compileQuery(node, queryId).sql.replaceAll('"', '');
        if (/\bupdate\s+(?:app\.)?agent_runs\b/iu.test(statement)) {
          const after = observe(statement);
          if (after !== undefined) pending.set(queryId, after);
        }
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      const after = pending.get(queryId);
      pending.delete(queryId);
      await after?.();
      return result;
    },
  });
}
