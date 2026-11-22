import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewVerdict } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type { AliyunReviewFetchResponse } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import type { InputCheckResult } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createStreamOutputReview } from '../../../../apps/api/src/modules/agent/stream/mount/output-review.ts';
import {
  createStreamReview,
  type StreamReviewConfigReader,
  type StreamReviewDeps,
} from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { response, verdictBody } from '../guard-review/kit.ts';
import { APP_A, APP_B, track } from '../stream-model-prereq-2/kit.ts';
import { inputFor, proceedOf, TIMEOUT_KEY, UNAVAILABLE } from '../stream-model-prereq/kit.ts';
import { fixture, flush, requestContent } from '../stream-review/kit.ts';
import { never } from '../stream-run/kit.ts';

afterEach(() => vi.unstubAllGlobals());

const SIDES = [
  { side: 'input', concurrentAc: 7, configAc: 9 },
  { side: 'output', concurrentAc: 8, configAc: 10 },
] as const;
type Side = (typeof SIDES)[number]['side'];

const BUDGET_MS = 300;
const FIRST_TEXT = '合成保温杯。';
const SECOND_TEXT = '合成收纳盒。';
const BLOCKED = {
  input: { kind: 'refuse', textKey: 'agent.refuse.unsafe', finishReason: 'safety' },
  output: 'block',
};
const TIMED_OUT = { input: UNAVAILABLE, output: 'timeout' };

function blockKey(side: Side): string {
  return `agent.safety.block_level.${side}`;
}

function reviewer(
  side: Side,
  wire: ReturnType<typeof fixture>,
  configValue: StreamReviewConfigReader['configValue'],
): (appId: string) => (text: string) => Promise<InputCheckResult | ReviewVerdict> {
  const deps: StreamReviewDeps = {
    options: wire.options,
    clock: wire.time.clock,
    scheduler: wire.time.scheduler,
    logger: wire.logs.logger,
    texts: wire.texts,
    config: { configValue },
  };
  if (side === 'input') {
    const { inputCheck } = createStreamReview(deps);
    return (appId) => {
      const { signal } = new AbortController();
      return (text) => inputCheck.check(inputFor(appId, text), signal);
    };
  }
  const output = createStreamOutputReview(deps);
  return (appId) => {
    const run = output.forRun(appId, new AbortController().signal);
    return (text) => run.review(text);
  };
}

function resolved(value: unknown) {
  return { done: true, value, error: undefined };
}

const ORDERS = [
  { first: APP_A, second: APP_B, heldRisk: 'low' },
  { first: APP_B, second: APP_A, heldRisk: 'medium' },
] as const;
const INTERLEAVINGS = SIDES.flatMap((side) => ORDERS.map((order) => ({ ...side, ...order })));

it.each(INTERLEAVINGS)(
  '[AC-B3-06c#$concurrentAc][BR-AI-18] $side 审核 $first 挂起、$second 先完成，两次审核各用各的起拦等级',
  async ({ side, first, second, heldRisk }) => {
    const wire = fixture();
    const heldReply = Promise.withResolvers<AliyunReviewFetchResponse>();
    const seen: string[] = [];
    wire.fetch.mockImplementation(async (_url, init) => {
      const { content } = requestContent(init);
      seen.push(content);
      return content === FIRST_TEXT ? heldReply.promise : response(verdictBody('low'));
    });
    const levels = new Map<string, string>([
      [APP_A, 'high'],
      [APP_B, 'low'],
    ]);
    const forApp = reviewer(side, wire, async (appId, key) => {
      if (key === TIMEOUT_KEY) return { value: BUDGET_MS };
      if (key !== blockKey(side) || !levels.has(appId)) return null;
      return { value: levels.get(appId) };
    });
    const firstReview = forApp(first);
    const secondReview = forApp(second);

    const held = track(firstReview(FIRST_TEXT));
    await flush();
    expect(seen).toEqual([FIRST_TEXT]);
    expect(held.done).toBe(false);

    const completed = track(secondReview(SECOND_TEXT));
    await flush();
    expect(seen).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(completed.done, '第二个审核先完成').toBe(true);
    expect(held.done, '第一个审核仍在等应答').toBe(false);
    const secondPass = side === 'input' ? proceedOf(SECOND_TEXT) : 'pass';
    expect.soft(completed, second).toEqual(resolved(second === APP_A ? secondPass : BLOCKED[side]));

    heldReply.resolve(response(verdictBody(heldRisk)));
    await flush();
    const firstPass = side === 'input' ? proceedOf(FIRST_TEXT) : 'pass';
    expect(held, first).toEqual(resolved(first === APP_A ? firstPass : BLOCKED[side]));
  },
);

it.each(SIDES)(
  '[AC-B3-06c#$configAc][BR-AI-18] $side 审核起拦等级读取拒绝时按审核不可用，读到非法值时按 low 拦截',
  async ({ side }) => {
    const wire = fixture(['low']);
    let rejectLevelRead = true;
    const forApp = reviewer(side, wire, async (appId, key) => {
      if (appId !== APP_A) return null;
      if (key === TIMEOUT_KEY) return { value: BUDGET_MS };
      if (key !== blockKey(side)) return null;
      if (rejectLevelRead) throw new Error('合成起拦等级读取失败');
      return { value: 'HIGH' };
    });

    const rejected = track(forApp(APP_A)(FIRST_TEXT));
    await flush();
    expect.soft(rejected, '读取拒绝').toEqual(resolved(TIMED_OUT[side]));

    rejectLevelRead = false;
    const invalid = track(forApp(APP_A)(FIRST_TEXT));
    await flush();
    expect(invalid, '读到非法值 HIGH').toEqual(resolved(BLOCKED[side]));
  },
);

const READS = [
  { levelReturns: false, label: '等级读取一直不回' },
  { levelReturns: true, label: '等级延迟读回，审核应答一直不回' },
] as const;
const DEADLINES = SIDES.flatMap((side) => READS.map((read) => ({ ...side, ...read })));

it.each(DEADLINES)(
  '[AC-B3-06c#$configAc][BR-AI-18] $side 审核 $label，按本次审核的原截止时间返回不可用',
  async ({ side, levelReturns }) => {
    const wire = fixture([levelReturns ? 'hang' : 'low']);
    const configValue = vi.fn<StreamReviewConfigReader['configValue']>(async (appId, key) => {
      if (appId !== APP_A) return null;
      if (key === TIMEOUT_KEY) {
        await wire.time.sleep(80);
        return { value: BUDGET_MS };
      }
      if (key !== blockKey(side)) return null;
      if (!levelReturns) return never<never>();
      await wire.time.sleep(120);
      return { value: 'high' };
    });
    const forApp = reviewer(side, wire, configValue);
    const review = track(forApp(APP_A)(FIRST_TEXT));

    await wire.time.to(BUDGET_MS - 1);
    expect.soft(review.done, '截止前一毫秒仍在等待').toBe(false);
    if (levelReturns) {
      expect.soft(wire.fetch, '等级读回后已发起审核').toHaveBeenCalled();
    }
    await wire.time.to(BUDGET_MS);
    expect.soft(review, '截止时审核不可用').toEqual(resolved(TIMED_OUT[side]));
    expect(configValue).toHaveBeenCalledWith(APP_A, blockKey(side));
  },
);
