// Unit tests of the reconciliation mismatch gauges' registration (B2-09zn): no database, fake
// collectors.
import { expect, it } from 'vitest';
import { CHANNEL_MISMATCH_GAUGE, SETTLE_BILL_MISMATCH_GAUGES } from './recon-mismatch.ts';
import { createMetricsRegistry } from './registry.ts';

function sampleLines(text: string, name: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(`${name}{`));
}

it('[AC-B2-09zn#u5] 三个 gauge 的名字固定，账单两项按同一份快照成对输出', async () => {
  expect(CHANNEL_MISMATCH_GAUGE.name).toBe('couli_payout_recon_diff_open');
  expect(SETTLE_BILL_MISMATCH_GAUGES.amountMismatch.name).toBe('couli_settle_bill_amount_mismatch');
  expect(SETTLE_BILL_MISMATCH_GAUGES.generatedAt.name).toBe(
    'couli_settle_bill_generated_timestamp_seconds',
  );
  const text = await createMetricsRegistry({
    entry: 'worker',
    collectChannelMismatch: async () => ({ open: { alpha: 1 } }),
    collectSettleBillMismatch: async () => ({
      bills: {
        alpha: { amountMismatch: 0, generatedAtSeconds: 1_767_225_600 },
        beta: { amountMismatch: 3, generatedAtSeconds: 1_764_547_200 },
      },
    }),
  }).render();
  expect(text).toContain('# TYPE couli_payout_recon_diff_open gauge\n');
  expect(sampleLines(text, 'couli_payout_recon_diff_open')).toEqual([
    'couli_payout_recon_diff_open{app_id="alpha"} 1',
  ]);
  expect(sampleLines(text, 'couli_settle_bill_amount_mismatch')).toEqual([
    'couli_settle_bill_amount_mismatch{app_id="alpha"} 0',
    'couli_settle_bill_amount_mismatch{app_id="beta"} 3',
  ]);
  expect(sampleLines(text, 'couli_settle_bill_generated_timestamp_seconds')).toEqual([
    'couli_settle_bill_generated_timestamp_seconds{app_id="alpha"} 1767225600',
    'couli_settle_bill_generated_timestamp_seconds{app_id="beta"} 1764547200',
  ]);
});
