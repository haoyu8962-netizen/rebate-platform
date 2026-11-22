import { afterEach, expect, it, vi } from 'vitest';
import { createStreamOutputReview } from '../../../../apps/api/src/modules/agent/stream/mount/output-review.ts';
import {
  createStreamReview,
  type StreamReviewConfigReader,
  type StreamReviewDeps,
} from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { response, verdictBody } from '../guard-review/kit.ts';
import { inputFor, proceedOf, UNAVAILABLE } from '../stream-model-prereq/kit.ts';
import { fixture, type Answer } from '../stream-review/kit.ts';

afterEach(() => vi.unstubAllGlobals());

const APP_A = 'synthetic-app-a';
const APP_B = 'synthetic-app-b';
const SIDES = ['input', 'output'] as const;
type Side = (typeof SIDES)[number];

const KEYS = {
  input: 'agent.safety.block_level.input',
  output: 'agent.safety.block_level.output',
} as const;

const INPUT_TEXT = '合成保温杯';
const OUTPUT_TEXT = '合成说明。';
const VERDICTS = {
  input: {
    pass: proceedOf(INPUT_TEXT),
    block: { kind: 'refuse', textKey: 'agent.refuse.unsafe', finishReason: 'safety' },
    timeout: UNAVAILABLE,
  },
  output: { pass: 'pass', block: 'block', timeout: 'timeout' },
};

function setup(answers: readonly Answer[] = ['low']) {
  const wire = fixture(answers);
  const values = new Map<string, Record<string, unknown>>();
  const configValue = vi.fn<StreamReviewConfigReader['configValue']>(async (appId, key) => {
    const value = values.get(appId)?.[key];
    return value === undefined ? null : { value };
  });
  const deps: StreamReviewDeps = {
    options: wire.options,
    clock: wire.time.clock,
    scheduler: wire.time.scheduler,
    logger: wire.logs.logger,
    texts: wire.texts,
  };
  return { wire, values, configValue, deps, configured: { ...deps, config: { configValue } } };
}

function reviewer(side: Side, deps: StreamReviewDeps) {
  if (side === 'input') {
    const { inputCheck } = createStreamReview(deps);
    return (appId: string) => {
      const input = inputFor(appId, INPUT_TEXT);
      return inputCheck.check(input, new AbortController().signal);
    };
  }
  const output = createStreamOutputReview(deps);
  return (appId: string) => {
    const run = output.forRun(appId, new AbortController().signal);
    return run.review(OUTPUT_TEXT);
  };
}

const MATRIX = [
  ['low', 'none', 'pass'],
  ['low', 'low', 'block'],
  ['low', 'medium', 'block'],
  ['low', 'high', 'block'],
  ['medium', 'none', 'pass'],
  ['medium', 'low', 'pass'],
  ['medium', 'medium', 'block'],
  ['medium', 'high', 'block'],
  ['high', 'none', 'pass'],
  ['high', 'low', 'pass'],
  ['high', 'medium', 'pass'],
  ['high', 'high', 'block'],
] as const;

it.each([
  { side: 'input', ac: 1 },
  { side: 'output', ac: 2 },
] as const)(
  '[AC-B3-06c#$ac][BR-AI-18] $side 审核的三档起拦等级与四种风险等级逐格判定',
  async ({ side }) => {
    const s = setup(MATRIX.map(([, risk]) => risk));
    const review = reviewer(side, s.configured);
    for (const [level, risk, expected] of MATRIX) {
      s.values.set(APP_A, { [KEYS[side]]: level });
      const label = `起拦等级 ${level}，风险等级 ${risk}`;
      expect.soft(await review(APP_A), label).toEqual(VERDICTS[side][expected]);
    }
    expect(s.wire.fetch).toHaveBeenCalledTimes(MATRIX.length);
  },
);

// 将现有的默认与不可用行为和配置生效后的结果放在同一用例，逐项执行后核对先红。
it.each(SIDES)(
  '[AC-B3-06c#3][BR-AI-18] %s 审核起拦配置缺失或非法时，low 风险也会被拦截',
  async (side) => {
    const s = setup();
    const review = reviewer(side, s.configured);
    const key = KEYS[side];
    const otherKey = KEYS[side === 'input' ? 'output' : 'input'];
    s.values.set(APP_A, { [key]: 'high' });
    expect.soft(await review(APP_A), '本侧配置 high').toEqual(VERDICTS[side].pass);

    s.values.set(APP_A, { [otherKey]: 'high' });
    expect.soft(await review(APP_A), '本侧缺少配置').toEqual(VERDICTS[side].block);
    for (const value of ['none', 'HIGH', '', 2]) {
      s.values.set(APP_A, { [key]: value, [otherKey]: 'high' });
      const label = `本侧配置 ${JSON.stringify(value)}`;
      expect.soft(await review(APP_A), label).toEqual(VERDICTS[side].block);
    }
  },
);

it.each(SIDES)(
  '[AC-B3-06c#4][BR-AI-18] %s 审核应答缺少等级或等级不认识时，按审核超时处置',
  async (side) => {
    const s = setup(['unknown', 'low', 'unknown', 'low']);
    const review = reviewer(side, s.configured);
    for (const [level, expected] of [
      ['low', 'block'],
      ['high', 'pass'],
    ] as const) {
      s.values.set(APP_A, { [KEYS[side]]: level });
      expect.soft(await review(APP_A), `${level}，未知等级`).toEqual(VERDICTS[side].timeout);

      s.wire.fetch.mockResolvedValueOnce(response({ Code: 200, Data: {} }));
      expect.soft(await review(APP_A), `${level}，缺少等级`).toEqual(VERDICTS[side].timeout);

      s.wire.fetch.mockResolvedValueOnce(response(verdictBody('LOW')));
      expect.soft(await review(APP_A), `${level}，大写 LOW`).toEqual(VERDICTS[side].timeout);

      expect.soft(await review(APP_A), `${level}，有效 low`).toEqual(VERDICTS[side][expected]);
    }
    expect(s.wire.fetch).toHaveBeenCalledTimes(8);
  },
);

it.each(SIDES)(
  '[AC-B3-06c#5][BR-AI-18] %s 审核逐请求读取本 app 的本侧配置，改值立即生效',
  async (side) => {
    const s = setup();
    const review = reviewer(side, s.configured);
    const key = KEYS[side];
    const otherKey = KEYS[side === 'input' ? 'output' : 'input'];
    s.values.set(APP_A, { [key]: 'high', [otherKey]: 'low' });
    s.values.set(APP_B, { [key]: 'low', [otherKey]: 'high' });

    for (const [appId, level, expected] of [
      [APP_A, 'high', 'pass'],
      [APP_B, 'low', 'block'],
      [APP_A, 'high', 'pass'],
      [APP_A, 'low', 'block'],
      [APP_B, 'low', 'block'],
    ] as const) {
      if (appId === APP_A && level === 'low') {
        s.values.set(APP_A, { [key]: 'low', [otherKey]: 'high' });
      }
      const before = s.configValue.mock.calls.length;
      expect.soft(await review(appId), `${appId} / ${level}`).toEqual(VERDICTS[side][expected]);
      const reads = s.configValue.mock.calls.slice(before);
      expect.soft(reads).toContainEqual([appId, key]);
      expect.soft(reads.filter(([, readKey]) => readKey === otherKey)).toEqual([]);
    }
  },
);

it.each(SIDES)(
  '[AC-B3-06c#6][BR-AI-18] %s 审核无配置读口时按 low 拦截全部已知风险等级',
  async (side) => {
    const risks = ['low', 'medium', 'high'] as const;
    const s = setup([...risks, 'low']);
    const defaults = reviewer(side, s.deps);
    for (const risk of risks) {
      expect.soft(await defaults(APP_A), risk).toEqual(VERDICTS[side].block);
    }

    s.values.set(APP_A, { [KEYS[side]]: 'high' });
    const configured = reviewer(side, s.configured);
    expect(await configured(APP_A), '接入本侧配置 high').toEqual(VERDICTS[side].pass);
    expect(s.wire.fetch).toHaveBeenCalledTimes(4);
  },
);
