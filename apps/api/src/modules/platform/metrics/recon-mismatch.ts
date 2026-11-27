// The worker's two reconciliation mismatch metrics (B2-09zn; D10-3308, D10-3360), wired by entry.ts
// (platform imports no business module):
// - couli_payout_recon_diff_open: unresolved (open or processing) channel_mismatch recon diffs per
//   app_id, from ledger's read-only port;
// - couli_settle_bill_amount_mismatch and couli_settle_bill_generated_timestamp_seconds: the latest
//   generated monthly bill's amount_mismatch_count and its generation time in Unix seconds per
//   app_id, from settlement's read-only port. An app has both samples or neither.
// Only the worker exports them; couli-fund.yaml alerts on them. An app without a value has no sample:
// it is never 0.
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's channel mismatch values. */
export interface ChannelMismatchSnapshot {
  /** app_id → unresolved (open or processing) channel_mismatch diffs; an app without any has no key. */
  readonly open: Readonly<Record<string, number>>;
}

/** One scrape's latest generated bill values. */
export interface SettleBillMismatchSnapshot {
  /** app_id → the latest generated bill's mismatch count and generation time (Unix seconds). */
  readonly bills: Readonly<
    Record<string, { readonly amountMismatch: number; readonly generatedAtSeconds: number }>
  >;
}

/** The channel mismatch gauge and its label. */
export const CHANNEL_MISMATCH_GAUGE = {
  name: 'couli_payout_recon_diff_open',
  help: 'Payout channel reconciliation diffs (channel_mismatch) not resolved yet (open or processing), per app_id; no sample for an app without any.',
  label: 'app_id',
} as const;

/** The two gauges of the latest generated monthly bill and their label. */
export const SETTLE_BILL_MISMATCH_GAUGES = {
  amountMismatch: {
    name: 'couli_settle_bill_amount_mismatch',
    help: 'Orders still not matching the union after regeneration in the latest generated monthly bill (amount_mismatch_count as of its bill day), per app_id; no sample when that bill has no count.',
  },
  generatedAt: {
    name: 'couli_settle_bill_generated_timestamp_seconds',
    help: 'Generation time of the latest generated monthly bill in Unix seconds, per app_id; present exactly when the mismatch count of that bill is.',
  },
  label: 'app_id',
} as const;

/** Default freshness of a cached snapshot: 30 seconds (the rules alert after 5 minutes). */
const DEFAULT_TTL_MS = 30_000;

/**
 * The worker's channel mismatch collection cached for 30 seconds by default: never a rejected
 * snapshot, so a failed read fails the scrape and the next scrape reads again; an expired snapshot
 * never stands in for a failed read.
 */
export function cacheChannelMismatchCollector(
  collect: () => Promise<ChannelMismatchSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<ChannelMismatchSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}

/** The worker's latest bill collection, cached the same way as cacheChannelMismatchCollector. */
export function cacheSettleBillMismatchCollector(
  collect: () => Promise<SettleBillMismatchSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<SettleBillMismatchSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}
