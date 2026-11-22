// B3-03p · BR-AI-18 (followups 52, 53): the output-side sentence review of the stream entry, per
// app. createStreamReview's sentence review keeps one budget fixed at build time; this one reads
// agent.safety.timeout_ms of each run's app through deps.config (content's configuration reader),
// for every run, and lets the wait for that read count toward the same deadline as the review.
// The stream entry hands it to the core as AgentRunBodyDeps.outputReview (createStreamReview's
// ports carry it to the business assembly; production: createProductionStreamAssembly).
// B3-06c: each review also reads agent.safety.block_level.output of the run's app inside the same
// deadline (./safety.ts reviewSettings) and judges the Aliyun verdict against that level, passed
// along this one review call (never kept in the run's closure or any shared field).
import type { ReviewVerdict, SentenceReviewPort } from '../../guard/index.ts';
import { createAliyunGradedReview, createAliyunOutputReview } from '../../guard/review/index.ts';
import type { RunSentenceReviewPort } from '../../orchestrator/core/ports.ts';
import {
  aliyunDepsFactory,
  type StreamReviewDeps,
  budgetOf,
  liveSettings,
  logUnreadable,
  reviewSettings,
} from './safety.ts';

const TIMED_OUT: SentenceReviewPort = { review: async () => 'timeout' };

/** `pending`, or 'timeout' as soon as `signal` aborts (a late verdict is discarded). */
async function untilAborted(
  pending: Promise<ReviewVerdict>,
  signal: AbortSignal,
): Promise<ReviewVerdict> {
  if (signal.aborted) return 'timeout';
  let stop: () => void = () => undefined;
  const aborted = new Promise<ReviewVerdict>((resolve) => {
    stop = () => resolve('timeout');
  });
  signal.addEventListener('abort', stop, { once: true });
  try {
    const verdict = await Promise.race([pending, aborted]);
    return signal.aborted ? 'timeout' : verdict;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * forRun(appId, signal) returns the sentence review of one run of `appId`. Each review(text) call
 * is one Aliyun output review (llm_response_moderation, the same ACS3-signed adapter and verdict
 * mapping as createStreamReview's review) bounded by agent.safety.timeout_ms of that app:
 * - read through deps.config for this run (never at build; a later change applies to the next
 *   run); a missing key is the BR-AI-18 default 1000 ms (options.timeoutMs stands in for that
 *   default when set); a value that is not a finite positive number takes the same default;
 * - one deadline per review call, counted from the call: the wait for the configuration read is
 *   inside it (a 300 ms budget read in 200 ms leaves 100 ms for the request; a read slower than
 *   its own value answers 'timeout' as soon as the value is known), never read time plus budget;
 * - a read that fails, does not settle within the default, or outlives `signal` answers 'timeout'
 *   (fail-close), as does a request that does not finish within the deadline.
 * Without live settings (no options, local / test, a missing or blank credential half, no https
 * endpoint) every review answers 'timeout' at once with no network request. Building performs no
 * external work; credentials and review text are never logged.
 */
export function createStreamOutputReview(deps: StreamReviewDeps): RunSentenceReviewPort {
  const live = liveSettings(deps.options);
  const config = deps.config;
  if (live === undefined) return { forRun: () => TIMED_OUT };
  const aliyunFor = aliyunDepsFactory(live, deps.options, deps);
  const fallback = budgetOf(deps.options);
  // Without a configuration port (never on the stream entry) every review keeps the fallback.
  const fixed = createAliyunOutputReview(aliyunFor(fallback));
  return {
    // Everything of a run (its app, its signal) is bound in this closure: no shared field.
    forRun(appId, signal) {
      return {
        async review(text) {
          if (config === undefined) return untilAborted(fixed.review(text), signal);
          const settings = await reviewSettings(
            config,
            deps.scheduler,
            appId,
            'output',
            signal,
            fallback,
          );
          if (settings.kind !== 'ready') {
            if (settings.kind === 'unreadable') logUnreadable(deps, appId, settings.key);
            return 'timeout';
          }
          // One adapter per review call: its deadline is what is left of this call's budget, and
          // its block level is this call's own.
          const review = createAliyunGradedReview(aliyunFor(settings.left), 'output');
          return untilAborted(review.review(text, settings.level), signal);
        },
      };
    },
  };
}
