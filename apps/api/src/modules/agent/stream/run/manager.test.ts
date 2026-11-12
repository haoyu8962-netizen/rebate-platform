import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { RedisNamespace, Scheduler } from '../../../platform/index.ts';
import { createRunManager } from './manager.ts';
import { createRedisRunRegistry } from './registry.ts';
import { runConfigDefaults } from './types.ts';
import type { RunBodyResult, RunContext, RunGuard, RunStart, TerminalDraft } from './types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture() {
  const clock = new FixedClock('2026-10-07T00:00:00Z');
  let now = 0;
  const waits: { due: number; resolve: () => void }[] = [];
  const scheduler: Scheduler = {
    now: () => now,
    sleep: (ms) => new Promise<void>((resolve) => waits.push({ due: now + ms, resolve })),
  };
  async function advance(target: number): Promise<void> {
    await flush();
    while (true) {
      waits.sort((a, b) => a.due - b.due);
      const next = waits[0];
      if (next === undefined || next.due > target) break;
      waits.shift();
      clock.advanceMs(next.due - now);
      now = next.due;
      next.resolve();
      await flush();
    }
    clock.advanceMs(target - now);
    now = target;
    await flush();
  }
  const values = new Map<string, string>();
  const redis: RedisNamespace = {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    eval: () => {
      throw new Error('Unexpected Lua');
    },
  };
  const registry = createRedisRunRegistry({ redis, clock, ttlSeconds: 120 });
  const chunks: string[] = [];
  const start: RunStart = {
    ticket: {
      runId: '019a0000-0000-7000-8000-000000000101',
      sessionId: '019a0000-0000-7000-8000-000000000001',
      messageId: '019a0000-0000-7000-8000-000000000201',
      subject: { tier: 'member', userId: 'unit-user' },
      dayKey: '2026-10-07',
      acceptedAtMs: clock.now().getTime(),
      lockExpiresAtMs: clock.now().getTime() + 50_000,
    },
    ownerKey: 'u:unit-user',
    limits: { memberDaily: 30, guestDaily: 3, guestIpDaily: 30, perMinute: 10, maxRounds: 30 },
    meta: {
      message_id: '019a0000-0000-7000-8000-000000000201',
      prompt_version: 'unit-v1',
      model_label: '演示模型',
      ai_label: '内容由 AI 生成，仅供参考',
    },
    sink: {
      write: (chunk) => {
        chunks.push(chunk);
      },
      onClose: () => undefined,
    },
  };
  const settle = vi.fn(async () => ({ refunded: false, quotaLeft: 7 }));
  const check = vi.fn<RunGuard['check']>(async () => null);
  const logger = { error: vi.fn() };
  let reserved = 0;
  const manager = createRunManager({
    clock,
    scheduler,
    registry,
    logger,
    admission: {
      admit: () => {
        throw new Error('Unexpected admission');
      },
      settle,
    },
    cards: {
      reserve: async (_sessionId, count) => {
        reserved += count;
        return reserved - count + 1;
      },
    },
    texts: { text: () => '本轮超时', errorMsg: (code) => `错误提示-${code}` },
    guard: { check },
    config: runConfigDefaults(),
  });
  return { manager, registry, redis, clock, start, check, settle, chunks, logger, advance };
}

it.each([10004, 30501] as const)(
  '[AC-B3-03b#1] 超时守卫随后返回 %i：继续轮询且仍采纳迟到的终止结果',
  async (code) => {
    const f = fixture();
    const late = deferred<Awaited<ReturnType<RunGuard['check']>>>();
    f.check.mockImplementationOnce(() => late.promise);
    let ctx: RunContext | undefined;
    const body = deferred<RunBodyResult>();
    const pending = f.manager.start(f.start, (c) => {
      ctx = c;
      return body.promise;
    });
    await f.advance(10_000);
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(ctx?.signal.aborted).toBe(false);
    late.resolve({ code });
    const final = await pending;
    expect(ctx?.signal.reason).toBe(code === 10004 ? 'consent_withdrawn' : 'disabled');
    expect(final.terminal).toEqual({
      event: 'error',
      data: { code, msg: `错误提示-${code}`, retryable: false, fallback: null },
    });
    body.resolve({ kind: 'done', finishReason: 'stop' });
    await flush();
    expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.chunks.filter((chunk) => /^event: (done|error)\n/.test(chunk))).toHaveLength(1);
  },
);

const recoveryCases: { body: RunBodyResult; draft: TerminalDraft; ending: string }[] = [
  {
    body: { kind: 'done', finishReason: 'safety', ending: 'input_review_timeout' },
    draft: { event: 'done', data: { finish_reason: 'safety' } },
    ending: 'input_review_timeout',
  },
  {
    body: {
      kind: 'error',
      error: {
        code: 50302,
        msg: '请使用搜索',
        retryable: true,
        fallback: 'search_page',
        fallback_q: '牛奶',
      },
    },
    draft: {
      event: 'error',
      data: {
        code: 50302,
        msg: '请使用搜索',
        retryable: true,
        fallback: 'search_page',
        fallback_q: '牛奶',
      },
    },
    ending: 'server_error',
  },
];

it.each(recoveryCases)(
  '[AC-B3-03b#2] $ending 在结算后保存终态失败：另一实例仍能读取结算前的完整草稿',
  async ({ body, draft, ending }) => {
    const f = fixture();
    const reader = createRedisRunRegistry({ redis: f.redis, clock: f.clock, ttlSeconds: 120 });
    const atSettlement: unknown[] = [];
    f.settle.mockImplementation(async () => {
      atSettlement.push(await reader.facts(f.start.ticket.runId));
      atSettlement.push(await reader.draft(f.start.ticket.runId));
      atSettlement.push(await reader.final(f.start.ticket.runId));
      return { refunded: false, quotaLeft: 7 };
    });
    f.registry.finish = async () => {
      throw new Error('Simulated crash before final save');
    };
    await expect(f.manager.start(f.start, async () => body)).rejects.toThrow('Simulated crash');
    expect(atSettlement).toEqual([{ ending, cardsDelivered: 0 }, draft, null]);
    // A stale live snapshot must not erase either the chosen ending or the draft.
    await reader.recordFacts(f.start.ticket.runId, { ending: null, cardsDelivered: 0 });
    expect(await reader.facts(f.start.ticket.runId)).toEqual({ ending, cardsDelivered: 0 });
    expect(await reader.draft(f.start.ticket.runId)).toEqual(draft);
    expect(await reader.final(f.start.ticket.runId)).toBeNull();
    expect(f.chunks.filter((chunk) => /^event: (done|error)\n/.test(chunk))).toEqual([]);
  },
);

it('[AC-B3-03b#3] 事实保存耗尽重试：记录独立诊断，结算仍完成且返回值只有原有字段', async () => {
  const f = fixture();
  const record = vi
    .spyOn(f.registry, 'recordFacts')
    .mockRejectedValue(new Error('Storage unavailable'));
  const result = await f.manager.start(f.start, async () => ({
    kind: 'done',
    finishReason: 'stop',
  }));
  expect(record).toHaveBeenCalledTimes(2);
  expect(f.logger.error).toHaveBeenCalledWith(
    { run_id: f.start.ticket.runId, ending: 'stop', cards_delivered: 0 },
    'agent.run_facts_unconfirmed',
  );
  expect(f.settle).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    terminal: { event: 'done', data: { finish_reason: 'stop', quota_left: 7 } },
    ending: 'stop',
    cardsDelivered: 0,
  });
});

it('[AC-B3-08zc#1][AC-B3-08zc#4][BR-AI-19] 回复随结算交出：文字按序拼接，断线后（宽限内）的文字与卡片照样编号保留、不写帧、不计已下发，也没有回执', async () => {
  const f = fixture();
  let close!: () => void;
  const chunks: string[] = [];
  const start: RunStart = {
    ...f.start,
    sink: {
      write: (chunk) => {
        chunks.push(chunk);
      },
      onClose: (listener) => {
        close = listener;
      },
    },
  };
  const notice = {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
    fallback_text: '合成卡片',
  };
  const receipts: string[] = [];
  const final = await f.manager.start(start, async (ctx) => {
    ctx.text('第一段');
    await ctx.card(notice, (id) => receipts.push(id));
    close();
    ctx.text('第二段');
    await ctx.card({ ...notice, fallback_text: '断线后的卡片' }, (id) => receipts.push(id));
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(final.ending).toBe('stop');
  expect(final.cardsDelivered).toBe(0);
  expect(receipts).toEqual(['c1']);
  expect(chunks.filter((chunk) => chunk.startsWith('event: card\n'))).toHaveLength(1);
  expect(chunks.some((chunk) => chunk.includes('第二段'))).toBe(false);
  const reply = (f.settle.mock.calls[0] as unknown[] | undefined)?.[3] as
    { text: string; cards: { card_id: string; fallback_text: string }[] } | undefined;
  expect(reply?.text).toBe('第一段第二段');
  expect(reply?.cards.map((card) => [card.card_id, card.fallback_text])).toEqual([
    ['c1', '合成卡片'],
    ['c2', '断线后的卡片'],
  ]);
  // Only the card kept without a frame (and so without a receipt) gets delivery records at the
  // ending; c1 had its receipt.
  expect((reply as { unframed?: string[] } | undefined)?.unframed).toEqual(['c2']);
});

it('[AC-B3-08zc#2][BR-AI-19] 断线后不合法的卡片仍以 invalid_frame 拒绝，不进回复', async () => {
  const f = fixture();
  let close!: () => void;
  const start: RunStart = {
    ...f.start,
    sink: {
      write: () => undefined,
      onClose: (listener) => {
        close = listener;
      },
    },
  };
  let refused: unknown;
  await f.manager.start(start, async (ctx) => {
    close();
    refused = await ctx
      .card({ type: 'notice', schema_version: 1, data: {}, fallback_text: '' })
      .then(
        () => 'resolved',
        (error: unknown) => error,
      );
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(refused).toBeInstanceOf(Error);
  const reply = (f.settle.mock.calls[0] as unknown[] | undefined)?.[3] as
    { cards: unknown[] } | undefined;
  expect(reply?.cards).toEqual([]);
});
