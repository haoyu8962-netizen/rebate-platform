// BR-WDR-15, D10-702 ① / SPEC_REF 18f0015e: deliberately missing transfer evidence.
import { expect } from 'vitest';
import type { listAdminUnknownPayouts } from '../../../../apps/api/src/modules/payout/application/admin-unknown-payouts.ts';
import type { Sealer, WithdrawalSeed } from '../admin-withdrawals/kit.ts';
import type { ReviewFixture } from '../admin-withdrawal-review/review-harness.ts';
import {
  DAY,
  answer,
  attemptsOf,
  reviewing,
  rowOf,
  type AdminSent,
  type Member,
} from '../admin-unknown-payouts/unknown-harness.ts';

export async function withoutTransfer(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
) {
  const row = await reviewing(f, h, who, {
    status: 'PAYING',
    execute_seq: 1,
    // Neither an old created_at nor executed_at can substitute for a missing T.
    created_at: new Date(f.clock.now().getTime() - 5 * DAY),
    executed_at: new Date(f.clock.now().getTime() - 4 * DAY),
    // db/schema.sql: withdrawals_hold_at_check requires this pair to be null together.
    hold_reason: null,
    hold_at: null,
    ...seed,
  });
  // This column belongs to couli_payout; reviewing inserts via couli_app without the flag.
  await f.payout
    .withSchema('app')
    .updateTable('withdrawals')
    .set({ needs_manual: true })
    .where('app_id', '=', row.app_id)
    .where('id', '=', row.id)
    .execute();
  const current = await rowOf(f, row);
  expect(current).toMatchObject({ status: 'PAYING', needs_manual: true });
  expect(await attemptsOf(f, row)).toEqual([]);
  return current;
}

/** answer checks both HTTP/code and conforms against the CT-24zt response schema. */
export async function pageOf(sent: AdminSent) {
  const response = await answer(sent, 0);
  return response.data as Awaited<ReturnType<typeof listAdminUnknownPayouts>>;
}

export function warnings(lines: readonly string[]) {
  return lines
    .flatMap((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['level'] === 40);
}
