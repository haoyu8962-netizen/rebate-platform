import { expect } from 'vitest';
import { NOW, samples } from '../kit.ts';

export const CHANNEL_OPEN = 'couli_payout_recon_diff_open';
export const BILL_MISMATCH = 'couli_settle_bill_amount_mismatch';
export const BILL_GENERATED = 'couli_settle_bill_generated_timestamp_seconds';
export const BILL_METRICS = [BILL_MISMATCH, BILL_GENERATED] as const;
export const METRICS = [CHANNEL_OPEN, ...BILL_METRICS] as const;
export const TTL_MS = 30_000;

export function appValues(text: string, name: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const { labels, value } of samples(text).filter((sample) => sample.name === name)) {
    expect(Object.keys(labels), name).toEqual(['app_id']);
    const app = labels['app_id']!;
    expect(Object.hasOwn(result, app), `duplicate ${name} sample for ${app}`).toBe(false);
    result[app] = value;
  }
  return result;
}

export function expectAbsent(text: string, names: readonly string[]): void {
  for (const name of names) expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
}

export function movingClock() {
  const start = Date.parse(NOW);
  let now = start;
  return {
    now: () => new Date(now),
    setElapsed(ms: number) {
      now = start + ms;
    },
  };
}
