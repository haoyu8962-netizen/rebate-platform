import { expect, it, vi } from 'vitest';
import type { Candidate } from '../../../../apps/api/src/modules/parsing/index.ts';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import type {
  LinkQuoteOutcome,
  LinkQuoteRunner,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { context, setup } from '../orchestrator-core/kit.ts';
import { request, success, texts, url } from '../orchestrator-deterministic/kit.ts';
import { input, setup as inputSetup } from '../preprocess-input/kit.ts';

// BR-AI-01 / BR-AI-04: synthetic candidates and quote snapshots only. Answers are keyed by
// candidate, never call number, so skipping a token cannot shift a later URL's answer.
const token: Candidate = { kind: 'tpwd', raw: '￥synthetic01￥', index: 100 };
const stopped = { kind: 'done', finishReason: 'stop' };

function runnerFor(entries: readonly (readonly [Candidate, LinkQuoteOutcome | Error])[]) {
  return {
    run: vi.fn<LinkQuoteRunner['run']>(async (candidate) => {
      const outcome = entries.find(
        ([key]) => key.kind === candidate.kind && key.raw === candidate.raw,
      )?.[1];
      if (outcome === undefined) throw new Error('Unexpected synthetic candidate');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

function status(phase: 'start' | 'end' | 'failed') {
  return {
    kind: 'status',
    tool: 'get_rebate_quote',
    phase,
    display: `模板:get_rebate_quote:${phase}`,
  };
}

function notice(code: number): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'warn', text_key: `error.${code}`, actions: [] },
    fallback_text: `固定文案:error.${code}`,
  };
}

it('[AC-B3-04g#1] URL、口令、URL 按出现顺序串行交给同一 runner，原样出卡', async () => {
  const links = [url(1), token, url(3)];
  const outcomes = [success(1), success(2), success(3)];
  const runner = runnerFor(links.map((link, i) => [link, outcomes[i]!]));
  const out = context();
  const steps: string[] = [];
  const answer = runner.run.getMockImplementation()!;
  runner.run.mockImplementation(async (candidate, ctx) => {
    steps.push(`start:${candidate.raw}`);
    const result = await answer(candidate, ctx);
    steps.push(`end:${candidate.raw}`);
    return result;
  });
  const write = out.ctx.card;
  out.ctx.card = async (card) => {
    steps.push('card');
    await write(card);
  };

  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(request(links), out.ctx),
  ).toEqual(stopped);
  expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual(links);
  expect(runner.run.mock.calls[1]![0]).toEqual({
    kind: 'tpwd',
    raw: '￥synthetic01￥',
    index: 100,
  });
  expect(steps).toEqual(links.flatMap((link) => [`start:${link.raw}`, `end:${link.raw}`, 'card']));
  expect(out.events).toEqual(
    outcomes.flatMap((outcome) => [
      status('start'),
      status('end'),
      ...outcome.cards.map((card) => ({ kind: 'card', card })),
    ]),
  );
});

it('[AC-B3-04g#2] 单口令成功使用 start/end 文案并透传同次报价卡', async () => {
  const out = context();
  const outcome = success(2);
  const runner = runnerFor([[token, outcome]]);
  const copy = texts();
  expect(
    await createDeterministicPath({ quotes: runner, texts: copy }).run(request([token]), out.ctx),
  ).toEqual(stopped);
  expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual([token]);
  expect(out.events).toEqual([
    status('start'),
    status('end'),
    { kind: 'card', card: outcome.cards[0] },
  ]);
  expect(copy.toolDisplay).toHaveBeenNthCalledWith(1, 'synthetic-app', 'get_rebate_quote', 'start');
  expect(copy.toolDisplay).toHaveBeenNthCalledWith(2, 'synthetic-app', 'get_rebate_quote', 'end');
  expect(copy.text).not.toHaveBeenCalled();
});

const failures: readonly { label: string; outcome: LinkQuoteOutcome | Error; code: number }[] = [
  ...([30132, 30131, 30141, 50301] as const).map((code) => ({
    label: `parse_error ${code}`,
    outcome: { kind: 'parse_error' as const, error_code: code, cards: [] as const },
    code,
  })),
  {
    label: 'runner 抛错',
    outcome: new Error('synthetic-private-detail 100元 https://secret.invalid'),
    code: 50301,
  },
  { label: 'price_unavailable', outcome: { kind: 'price_unavailable', cards: [] }, code: 50301 },
  { label: 'no_card', outcome: { kind: 'no_card', cards: [] }, code: 50301 },
];

it.each(failures)(
  '[AC-B3-04g#3] 中间口令 $label 只产生一次对应 notice 和 failed，前后 URL 照常',
  async ({ label, outcome, code }) => {
    const expected = notice(code);
    const key =
      label === 'parse_error 50301' || label === 'runner 抛错'
        ? 'agent.notice.quote_failed'
        : `error.${code}`;
    const out = context();
    const links = [url(1), token, url(3)];
    const runner = runnerFor([
      [links[0]!, success(1)],
      [token, outcome],
      [links[2]!, success(3)],
    ]);
    const copy = texts();
    expect(
      await createDeterministicPath({ quotes: runner, texts: copy }).run(request(links), out.ctx),
    ).toEqual(stopped);
    expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual(links);
    expect(out.events).toEqual([
      status('start'),
      status('end'),
      { kind: 'card', card: success(1).cards[0] },
      status('start'),
      status('failed'),
      {
        kind: 'card',
        card: {
          ...expected,
          data: { ...expected.data, text_key: key },
          fallback_text: `固定文案:${key}`,
        },
      },
      status('start'),
      status('end'),
      { kind: 'card', card: success(3).cards[0] },
    ]);
    expect(copy.text).toHaveBeenCalledExactlyOnceWith('synthetic-app', key);
    expect(JSON.stringify(out.events)).not.toContain('synthetic-private-detail');
  },
);

it.each(['success', 'parse_error', 'exception'] as const)(
  '[AC-B3-04g#4] 口令 runner 内取消后 %s 不输出迟到结果，也不调用后续 URL 或口令',
  async (ending) => {
    const out = context();
    const laterToken: Candidate = { kind: 'tpwd', raw: '￥synthetic02￥', index: 200 };
    const links = [token, url(3), laterToken];
    const runner = runnerFor(links.map((link) => [link, success(link.index)]));
    const answer = runner.run.getMockImplementation()!;
    let atAbort: unknown[] = [];
    runner.run.mockImplementation(async (candidate, ctx) => {
      if (candidate.raw !== token.raw) return answer(candidate, ctx);
      out.controller.abort();
      atAbort = [...out.events];
      if (ending === 'exception') throw new Error('synthetic cancelled quote');
      if (ending === 'parse_error') return { kind: 'parse_error', error_code: 30132, cards: [] };
      return success(2);
    });
    expect(
      await createDeterministicPath({ quotes: runner, texts: texts() }).run(
        request(links),
        out.ctx,
      ),
    ).toEqual(stopped);
    expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual([token]);
    expect(runner.run.mock.calls[0]![1].signal).toBe(out.ctx.signal);
    expect(out.events).toEqual([status('start')]);
    expect(out.events).toEqual(atAbort);
  },
);

it('[AC-B3-04g#5] 口令成功卡写出后取消，后续 URL 与口令都不报价', async () => {
  const out = context();
  const links = [token, url(3), { ...token, raw: '￥synthetic02￥', index: 200 }];
  const runner = runnerFor(links.map((link) => [link, success(link.index)]));
  const write = out.ctx.card;
  let atAbort: unknown[] = [];
  out.ctx.card = async (card) => {
    await write(card);
    out.controller.abort();
    atAbort = [...out.events];
  };
  expect(
    await createDeterministicPath({ quotes: runner, texts: texts() }).run(request(links), out.ctx),
  ).toEqual(stopped);
  expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual([token]);
  expect(out.events).toEqual([
    status('start'),
    status('end'),
    { kind: 'card', card: success(token.index).cards[0] },
  ]);
  expect(out.events).toEqual(atAbort);
});

it.each([
  { label: 'URL/口令/URL', tokenFirst: false, tokenFails: false },
  { label: '口令/URL/口令', tokenFirst: true, tokenFails: false },
  { label: '失败口令仍占名额', tokenFirst: false, tokenFails: true },
])(
  '[AC-B3-04g#6] $label：混合输入共用前三个名额，超限提示一次且不补取后续候选',
  async ({ tokenFirst, tokenFails }) => {
    const secondToken: Candidate = { kind: 'tpwd', raw: '￥synthetic02￥', index: 0 };
    const candidates = tokenFirst
      ? [token, url(1), secondToken, url(3), url(4)]
      : [url(1), token, url(3), secondToken, url(4)];
    const message = candidates.map((candidate) => candidate.raw).join(' ');
    const expected = candidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      index: message.indexOf(candidate.raw),
    }));
    const outcomes = candidates.map((candidate, i): LinkQuoteOutcome => {
      if (tokenFails && candidate.raw === token.raw)
        return { kind: 'parse_error', error_code: 30132, cards: [] };
      return success(i + 1);
    });
    const runner = runnerFor(candidates.map((candidate, i) => [candidate, outcomes[i]!]));
    const core = setup();
    // Real preprocessing owns the shared cap; this verifies its handoff through core to the
    // deterministic path. It does not impose an additional cap inside createDeterministicPath.
    const preprocessing = inputSetup();
    expect(
      await core.run(
        {
          inputCheck: preprocessing.port,
          deterministic: createDeterministicPath({ quotes: runner, texts: core.deps.texts }),
        },
        input(message),
      ),
    ).toEqual(stopped);
    expect(runner.run.mock.calls.map(([candidate]) => candidate)).toEqual(expected);
    expect(core.content()).toEqual([
      {
        kind: 'card',
        card: {
          type: 'notice',
          schema_version: 1,
          data: { level: 'info', text_key: 'agent.notice.link_limit', actions: [] },
          fallback_text: '合成文案:synthetic-input-app:agent.notice.link_limit',
        },
      },
      ...outcomes
        .slice(0, 3)
        .flatMap((outcome) =>
          outcome.kind === 'ok'
            ? outcome.cards.map((card) => ({ kind: 'card', card }))
            : [{ kind: 'card', card: notice(30132) }],
        ),
    ]);
    expect(core.events[0]).toMatchObject({
      kind: 'card',
      card: { type: 'notice', data: { text_key: 'agent.notice.link_limit' } },
    });
    expect(core.complete).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
    expect(core.deps.prompt.current).not.toHaveBeenCalled();
  },
);
