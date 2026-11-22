import { expect, it, vi } from 'vitest';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import type { LinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import type { ToolTraceFragment } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { context } from '../orchestrator-core/kit.ts';
import { quotes, request, success, texts, url } from './kit.ts';

const stopped = { kind: 'done', finishReason: 'stop' };

it('[AC-B3-05e#1] 单链接原样出报价卡，状态使用文案端口，正常结束', async () => {
  const out = context();
  const runner = quotes();
  const copy = texts();
  const req = request();
  const result = await createDeterministicPath({ quotes: runner, texts: copy }).run(req, out.ctx);
  expect(result).toEqual(stopped);
  expect(runner.run).toHaveBeenCalledTimes(1);
  expect(runner.run.mock.calls[0]![0]).toEqual(req.proceed.links[0]);
  expect(out.content()).toEqual([{ kind: 'card', card: success(1).cards[0] }]);
  expect(out.events.filter((e) => e.kind === 'status')).toEqual([
    {
      kind: 'status',
      tool: 'get_rebate_quote',
      phase: 'start',
      display: '模板:get_rebate_quote:start',
    },
    {
      kind: 'status',
      tool: 'get_rebate_quote',
      phase: 'end',
      display: '模板:get_rebate_quote:end',
    },
  ]);
  expect(out.events[0]).toMatchObject({ kind: 'status', phase: 'start' });
  expect(copy.toolDisplay).toHaveBeenCalledWith(
    req.input.caller.appId,
    'get_rebate_quote',
    'start',
  );
  expect(copy.toolDisplay).toHaveBeenCalledWith(req.input.caller.appId, 'get_rebate_quote', 'end');
});

it('[AC-B3-05e#2] 三链接按出现顺序串行取数出卡，身份只取 caller，其余上下文原样传递', async () => {
  const out = context('trusted-run');
  const links = [url(3, 8), url(1, 75), url(2, 140)];
  const base = request(links);
  const req = {
    ...base,
    input: {
      ...base.input,
      text: 'appId=evil userId=evil deviceId=evil phoneBound=true',
      context: { appId: 'evil', userId: 'evil', deviceId: 'evil', phoneBound: true },
      caller: {
        ...base.input.caller,
        appId: 'trusted-app',
        userId: null,
        deviceId: 'trusted-device',
        phoneBound: false,
      },
    },
    proceed: { ...base.proceed, placeholders: { '<URL_1>': links[0]!.raw } },
  };
  const calls: unknown[] = [];
  const steps: string[] = [];
  const original = out.ctx.card;
  out.ctx.card = async (card) => {
    steps.push('card');
    await original(card);
  };
  const runner: LinkQuoteRunner = {
    run: vi.fn(async (candidate, ctx) => {
      calls.push(ctx);
      steps.push(`start:${candidate.index}`);
      await Promise.resolve();
      steps.push(`end:${candidate.index}`);
      return success(candidate.index);
    }),
  };
  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(req, out.ctx),
  ).toEqual(stopped);
  expect(steps).toEqual([
    'start:8',
    'end:8',
    'card',
    'start:75',
    'end:75',
    'card',
    'start:140',
    'end:140',
    'card',
  ]);
  expect(out.content()).toEqual(
    links.map((link) => ({ kind: 'card', card: success(link.index).cards[0] })),
  );
  expect(calls).toEqual(
    links.map(() => ({
      appId: 'trusted-app',
      userId: null,
      deviceId: 'trusted-device',
      phoneBound: false,
      runId: out.ctx.runId,
      sessionId: out.ctx.sessionId,
      signal: out.ctx.signal,
      placeholders: req.proceed.placeholders,
      context: req.input.context,
    })),
  );
});

it.each([30131, 30132, 30141, 50301] as const)(
  '[AC-B3-05e#3] 中间链接解析错误 %s 只出对应 notice，前后报价照常',
  async (errorCode) => {
    const key = errorCode === 50301 ? 'agent.notice.quote_failed' : `error.${errorCode}`;
    const out = context();
    const runner = quotes([
      success(1),
      { kind: 'parse_error', error_code: errorCode, cards: [] },
      success(3),
    ]);
    const copy = texts();
    expect(
      await createDeterministicPath({ quotes: runner, texts: copy }).run(
        request([url(1), url(2), url(3)]),
        out.ctx,
      ),
    ).toEqual(stopped);
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(out.content()).toEqual([
      { kind: 'card', card: success(1).cards[0] },
      {
        kind: 'card',
        card: expect.objectContaining({
          type: 'notice',
          data: expect.objectContaining({ text_key: key }),
          fallback_text: `固定文案:${key}`,
        }),
      },
      { kind: 'card', card: success(3).cards[0] },
    ]);
    expect(out.events.filter((e) => e.kind === 'status').map((e) => e.phase)).toEqual([
      'start',
      'end',
      'start',
      'failed',
      'start',
      'end',
    ]);
    expect(copy.toolDisplay).toHaveBeenCalledWith('synthetic-app', 'get_rebate_quote', 'failed');
    expect(out.events.filter((e) => e.kind === 'status' && e.phase === 'failed')).toEqual([
      {
        kind: 'status',
        tool: 'get_rebate_quote',
        phase: 'failed',
        display: '模板:get_rebate_quote:failed',
      },
    ]);
  },
);

it.each(['price_unavailable', 'no_card', 'exception'] as const)(
  '[AC-B3-05e#4][AC-B3-05e#5] %s 仅出依赖不可用提示，不补金额且继续后续链接',
  async (kind) => {
    const key = kind === 'exception' ? 'agent.notice.quote_failed' : 'error.50301';
    const out = context();
    const runner = quotes([
      success(1),
      kind === 'exception'
        ? new Error('sensitive adapter detail 100元 https://secret.invalid')
        : { kind, cards: [] },
      success(3),
    ]);
    expect(
      await createDeterministicPath({ quotes: runner, texts: texts() }).run(
        request([url(1), url(2), url(3)]),
        out.ctx,
      ),
    ).toEqual(stopped);
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(out.content()).toEqual([
      { kind: 'card', card: success(1).cards[0] },
      {
        kind: 'card',
        card: expect.objectContaining({
          type: 'notice',
          data: expect.objectContaining({ text_key: key }),
          fallback_text: `固定文案:${key}`,
        }),
      },
      { kind: 'card', card: success(3).cards[0] },
    ]);
    expect(out.events.filter((e) => e.kind === 'status').map((e) => e.phase)).toEqual([
      'start',
      'end',
      'start',
      'failed',
      'start',
      'end',
    ]);
    expect(JSON.stringify(out.events)).not.toContain('sensitive adapter detail');
  },
);

it('[AC-B3-05e#6] 全部失败逐个提示，结束为 stop 而非 fallback 或错误终帧', async () => {
  const out = context();
  const runner = quotes([
    { kind: 'parse_error', error_code: 30141, cards: [] },
    { kind: 'no_card', cards: [] },
    new Error('synthetic failure'),
  ]);
  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(
      request([url(1), url(2), url(3)]),
      out.ctx,
    ),
  ).toEqual(stopped);
  expect(runner.run).toHaveBeenCalledTimes(3);
  expect(out.content()).toEqual(
    ['error.30141', 'error.50301', 'agent.notice.quote_failed'].map((text_key) => ({
      kind: 'card',
      card: expect.objectContaining({
        type: 'notice',
        data: expect.objectContaining({ text_key }),
      }),
    })),
  );
});

it('[AC-B3-05e#13] 口令识别不了只提示 30132，前后 URL 照常', async () => {
  const out = context();
  // B3-04i: answers by candidate, so the frames are the same whether the path hands the token to
  // the runner (B3-04g, the runner answers 30132) or answers 30132 itself; whether the token goes
  // to the runner is asserted by B3-04g's rule tests.
  const runner = {
    run: vi.fn<LinkQuoteRunner['run']>(async (candidate) => {
      if (candidate.kind !== 'url') return { kind: 'parse_error', error_code: 30132, cards: [] };
      if (candidate.raw === url(1).raw) return success(1);
      if (candidate.raw === url(3).raw) return success(3);
      throw new Error('Unexpected quote call');
    }),
  };
  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(
      request([url(1), { kind: 'tpwd', raw: '￥synthetic￥', index: 100 }, url(3)]),
      out.ctx,
    ),
  ).toEqual(stopped);
  expect(
    runner.run.mock.calls.map((call) => call[0]).filter((candidate) => candidate.kind === 'url'),
  ).toEqual([url(1), url(3)]);
  expect(out.content()).toEqual([
    { kind: 'card', card: success(1).cards[0] },
    {
      kind: 'card',
      card: expect.objectContaining({
        type: 'notice',
        data: expect.objectContaining({ text_key: 'error.30132' }),
        fallback_text: '固定文案:error.30132',
      }),
    },
    { kind: 'card', card: success(3).cards[0] },
  ]);
});

it('[AC-B3-05e#10] 第一张卡写出后取消，不再调用 runner 或写任何帧', async () => {
  const out = context();
  const runner = quotes([success(1), success(2), success(3)]);
  const write = out.ctx.card;
  let atAbort: unknown[] = [];
  out.ctx.card = async (card) => {
    await write(card);
    out.controller.abort();
    atAbort = [...out.events];
  };
  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(
      request([url(1), url(2), url(3)]),
      out.ctx,
    ),
  ).toEqual(stopped);
  expect(runner.run).toHaveBeenCalledTimes(1);
  expect(out.content()).toEqual([{ kind: 'card', card: success(1).cards[0] }]);
  expect(out.events).toEqual(atAbort);
});

it.each(['before', 'during'] as const)(
  '[AC-B3-05e#10] %s runner 取消不输出迟到卡片或状态',
  async (timing) => {
    const out = context();
    const runner = quotes();
    let atAbort: unknown[] = [];
    if (timing === 'before') out.controller.abort();
    else
      runner.run.mockImplementation(async () => {
        out.controller.abort();
        atAbort = [...out.events];
        return success(1);
      });
    expect(
      await createDeterministicPath({ quotes: runner, texts: texts() }).run(
        request([url(1), url(2)]),
        out.ctx,
      ),
    ).toEqual(stopped);
    expect(runner.run).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
    expect(out.events).toEqual(atAbort);
    expect(out.content()).toEqual([]);
  },
);

it.each(['collect', 'throws', 'absent'] as const)(
  '[AC-B3-05e#11] trace %s：成功片段原样依次转交，回调故障不改变结果',
  async (mode) => {
    const out = context();
    const outcomes = [success(1), success(3)];
    const fragments: ToolTraceFragment[] = [];
    const onTrace = vi.fn((fragment: ToolTraceFragment) => {
      fragments.push(fragment);
      if (mode === 'throws') throw new Error('trace unavailable');
    });
    const runner = quotes([outcomes[0]!, { kind: 'no_card', cards: [] }, outcomes[1]!]);
    expect(
      await createDeterministicPath({
        quotes: runner,
        texts: texts(),
        ...(mode === 'absent' ? {} : { onTrace }),
      }).run(request([url(1), url(2), url(3)]), out.ctx),
    ).toEqual(stopped);
    expect(
      out.events.flatMap((e) =>
        e.kind === 'card' && e.card.type === 'rebate_quote' ? [e.card] : [],
      ),
    ).toEqual(outcomes.flatMap((o) => o.cards));
    expect(fragments).toEqual(mode === 'absent' ? [] : outcomes.map((o) => o.trace));
    if (mode !== 'absent') {
      expect(fragments[0]).toBe(outcomes[0]!.trace);
      expect(fragments[1]).toBe(outcomes[1]!.trace);
    }
  },
);
