// B3-05s · BR-AI-06 / BR-TEXT-22 (C-32, D10-1469): a search term the model supplied (its
// search_products q, or a server continuation that reuses it) is model output. Before its first
// 8 code points fill 「只搜{q_short}」, they pass the same OutputGuard checks as the explanation
// text: the BR-AI-06 filters (guard filterSegment: amount, URL / scheme / short link, passcode)
// and the BR-AI-18 sentence review of the run. Any hit or a review that does not pass leaves the
// second suggestion out; a filter hit or a blocking review is recorded on the run's trace like a
// filtered explanation (output_filtered, filter_hits). The whole q_short is checked as one piece:
// no sentence buffer and no ≤2-sentence budget (a cut after the second sentence would let the
// rest go unchecked, e.g. 「茶。杯。好。9元」), and the run's own guard is never touched.
//
// The core (run.ts) binds one checker per run to the run's AbortSignal and run id; the search
// decorator (results/tools.ts) looks it up from the ToolContext it is called with, whether the
// call is the model's, an intent fallback's or a continuation's (all share the run's signal).
import { filterSegment } from '../../guard/index.ts';
import type { FilterHit, ReviewVerdict, SentenceReviewPort } from '../../guard/index.ts';

/** The outcome of one term check. */
export interface QueryVerdict {
  /** No filter hit and the review passed: the term may be shown. */
  readonly allowed: boolean;
  /** The BR-AI-06 filter hits of the term (empty when none). */
  readonly hits: readonly FilterHit[];
  /** A filter hit or a blocking review: recorded as output_filtered on the run's trace. */
  readonly filtered: boolean;
}

/** One run's term check (core only creates it; the decorator only calls it). */
export interface QueryCheck {
  /** Whether `term` (already cut to q_short) may fill the suggestion; recorded on the run. */
  allows(term: string): Promise<boolean>;
}

const REJECTED: QueryVerdict = { allowed: false, hits: [], filtered: false };

/** One review call as the guard makes it: anything but pass / block (or a throw) is a timeout. */
async function reviewOnce(review: SentenceReviewPort, text: string): Promise<ReviewVerdict> {
  try {
    const verdict = await review.review(text);
    return verdict === 'pass' || verdict === 'block' ? verdict : 'timeout';
  } catch {
    return 'timeout';
  }
}

/**
 * Checks the whole `term` at once: the guard's filters over all of it (any hit rejects it, no
 * review needed), else the review of all of it. A review timeout follows the guard (held text is
 * reviewed once more; still not passing → not allowed, not recorded as filtered); anything thrown
 * counts as not allowed (fail-close).
 */
export async function checkQuery(review: SentenceReviewPort, term: string): Promise<QueryVerdict> {
  try {
    const hits = [...filterSegment(term).hits];
    if (hits.length > 0) return { allowed: false, hits, filtered: true };
    let verdict = await reviewOnce(review, term);
    if (verdict === 'timeout') verdict = await reviewOnce(review, term);
    return { allowed: verdict === 'pass', hits: [], filtered: verdict === 'block' };
  } catch {
    return REJECTED;
  }
}

interface Bound {
  readonly runId: string;
  readonly check: QueryCheck;
}

/** Each run's checker, keyed by the run's signal (gone with it, as results/tools.ts budgets). */
const bound = new WeakMap<AbortSignal, Bound>();

/** Core only: `check` is the checker of the run `runId` whose calls carry `signal`. */
export function bindQueryCheck(signal: AbortSignal, runId: string, check: QueryCheck): void {
  bound.set(signal, { runId, check });
}

/**
 * The checker of the run a tool call belongs to, else null (a call outside a core run). Both the
 * signal and the run id must match: another run sharing the signal never borrows it.
 */
export function queryCheckOf(ctx: {
  readonly signal: AbortSignal;
  readonly runId: string;
}): QueryCheck | null {
  const entry = bound.get(ctx.signal);
  return entry !== undefined && entry.runId === ctx.runId ? entry.check : null;
}
