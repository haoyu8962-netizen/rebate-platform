// B3-03m · BR-AI-18: the stream entry's input check (B3-05d createInputCheck) and sentence review
// (B3-06b Aliyun content safety, llm_query_moderation / llm_response_moderation), signed with
// ACS3 (../../guard/review/sign.ts). Live only in staging / prod with a complete AccessKey pair and
// an https endpoint; anything else (no options, local / test, a missing or blank half, no
// endpoint) is the fail-closed pair: every message is refused as review unavailable
// (agent.refuse.safety_unavailable, ending input_review_timeout, refunded) and every sentence
// review answers timeout, with no network request at all (non-production external adapters are
// fakes only, AGENTS.md §6). Building performs no external work. Credentials are never logged.
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
// B3-03n: with deps.config, the input review budget is agent.safety.timeout_ms of each request's
// app, read per request (createStreamReview below); the sentence review keeps options.timeoutMs.
// B3-03p: the read's wait counts toward that budget; with deps.config the ports also carry the
// per-app output review (./output-review.ts), which the stream entry hands to the core.
// B3-06c: with deps.config the input check also reads agent.safety.block_level.input of the
// request's app, inside the same deadline (./safety.ts reviewSettings), and the Aliyun verdict is
// judged against it; the level is passed along this one check, never stored. Without deps.config
// the adapter's default mapping stays (low / medium / high all block).
import type { SentenceReviewPort } from '../../guard/index.ts';
import {
  createAliyunGradedReview,
  createAliyunInputReview,
  createAliyunOutputReview,
  type ReviewBlockLevel,
} from '../../guard/review/index.ts';
import { failClosedInputCheck, type InputCheckPort } from '../../orchestrator/index.ts';
import type { RunSentenceReviewPort } from '../../orchestrator/core/ports.ts';
import { createInputCheck } from '../../preprocess/input/index.ts';
import { createStreamOutputReview } from './output-review.ts';
import {
  aliyunDepsFactory,
  budgetOf,
  logUnreadable,
  liveSettings,
  reviewSettings,
  type StreamReviewDeps,
} from './safety.ts';

// The option and dependency types live in ./safety.ts (no import cycle with ./output-review.ts).
export type { StreamReviewConfigReader, StreamReviewDeps, StreamReviewOptions } from './safety.ts';

export interface StreamReviewPorts {
  readonly inputCheck: InputCheckPort;
  readonly review: SentenceReviewPort;
  /** B3-03p: with deps.config, the per-app output review (createStreamOutputReview); the stream
   * entry hands it to the core as AgentRunBodyDeps.outputReview. Absent without deps.config. */
  readonly outputReview?: RunSentenceReviewPort;
}

function failClosed(): StreamReviewPorts {
  return {
    inputCheck: failClosedInputCheck(),
    review: { review: async () => 'timeout' },
  };
}

/** Connects B3-05d input checking and B3-06b sentence review, with real ACS3 signing.
 * Default safety budget is 1000ms. Construction performs no external work (no configuration read).
 */
export function createStreamReview(deps: StreamReviewDeps): StreamReviewPorts {
  const config = deps.config;
  // B3-03p: the per-app output review answers 'timeout' at once by itself when not live.
  const outputReview = config === undefined ? {} : { outputReview: createStreamOutputReview(deps) };
  const live = liveSettings(deps.options);
  if (live === undefined) return { ...failClosed(), ...outputReview };
  const options = deps.options;
  const aliyunFor = aliyunDepsFactory(live, options, deps);
  const inputFor = (budget: number): InputCheckPort =>
    createInputCheck({
      review: createAliyunInputReview(aliyunFor(budget)),
      scheduler: deps.scheduler,
      timeoutMs: () => budget,
      texts: deps.texts,
    });
  const fixed = budgetOf(options);
  const review = createAliyunOutputReview(aliyunFor(fixed));
  if (config === undefined) return { inputCheck: inputFor(fixed), review };

  const unavailable = failClosedInputCheck();
  // One check built per request: its budget and block level are this request's own.
  const gradedFor = (budget: number, level: ReviewBlockLevel): InputCheckPort => {
    const graded = createAliyunGradedReview(aliyunFor(budget), 'input');
    return createInputCheck({
      review: { review: (text) => graded.review(text, level) },
      scheduler: deps.scheduler,
      timeoutMs: () => budget,
      texts: deps.texts,
    });
  };
  return {
    inputCheck: {
      async check(input, signal) {
        // B3-03p: the wait for the value counts toward the same deadline; the check gets what is
        // left of it, bound when the check is built (concurrent requests never share a budget).
        const appId = input.caller.appId;
        const settings = await reviewSettings(
          config,
          deps.scheduler,
          appId,
          'input',
          signal,
          fixed,
        );
        if (settings.kind !== 'ready') {
          if (settings.kind === 'unreadable') logUnreadable(deps, appId, settings.key);
          return unavailable.check(input, signal);
        }
        return gradedFor(settings.left, settings.level).check(input, signal);
      },
    },
    review,
    ...outputReview,
  };
}
