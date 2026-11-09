// The worker's open post-credit diffs gauge (B2-02v; BR-FUND-19 末句; D10-1038, D10-1180, D10-1185):
// couli_credit_postcheck_mismatch_open, one sample per app_id with unresolved (open or processing)
// diffs. The value comes from ledger's read-only port, wired by entry.ts (platform imports no
// business module). Only the worker exports it; couli-fund.yaml alerts on it > 0. An app without such
// diffs has no sample: it is never 0.
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's values. */
export interface CreditPostcheckSnapshot {
  /** app_id → unresolved (open or processing) post-credit confirmation diffs; an app without any has no key. */
  readonly open: Readonly<Record<string, number>>;
}

/** The gauge and its label. */
export const CREDIT_POSTCHECK_GAUGE = {
  name: 'couli_credit_postcheck_mismatch_open',
  help: 'Post-credit confirmation diffs not resolved yet (open or processing), per app_id; no sample for an app without any (BR-FUND-19).',
  label: 'app_id',
} as const;

/** Default freshness of a cached snapshot: 30 seconds, not the common 5 minutes (BR-FUND-19 alerts within 5 minutes). */
const DEFAULT_TTL_MS = 30_000;

/**
 * The worker's collection cached for 30 seconds by default: never a rejected snapshot, so a failed
 * read fails the scrape and the next scrape reads again.
 */
export function cacheCreditPostcheckCollector(
  collect: () => Promise<CreditPostcheckSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<CreditPostcheckSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}
