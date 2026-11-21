import { expect, it } from 'vitest';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import { groupable, resultTexts } from './BatchPayout.tsx';
import type { PayoutBatchResult, WithdrawalRow } from './model.ts';

/** Only the fields the rules read. */
const row = (id: string, changes: Partial<WithdrawalRow> = {}): WithdrawalRow =>
  ({
    withdrawal_id: id,
    status: 'APPROVED',
    blocked_reason: null,
    hold_reason: null,
    auto_decision: null,
    batch_id: null,
    ...changes,
  }) as WithdrawalRow;

it('[F1-08an] 一键组批 picks APPROVED rows without a withdrawal block, moved-batch rows included', () => {
  expect(groupable(row('a'))).toBe(true);
  expect(groupable(row('k', { blocked_reason: 'NEGATIVE_BALANCE' }))).toBe(false);
  expect(groupable(row('r', { hold_reason: 'daily_cap', batch_id: 'old' }))).toBe(true);
  expect(
    groupable(
      row('s', {
        batch_id: 'auto',
        auto_decision: { execute_blocked: 'channel_disabled' } as WithdrawalRow['auto_decision'],
      }),
    ),
  ).toBe(true);
  for (const status of ['PENDING_REVIEW', 'PAYING', 'PAID_API', 'REJECTED'] as const)
    expect(groupable(row('x', { status })), status).toBe(false);
});

it('[F1-08an] the results of an executed batch come only from its answer', () => {
  const result: PayoutBatchResult = {
    outcome: 'executed',
    batch_id: 'b1',
    reason: null,
    channel: null,
    paying: ['a'],
    left: [{ withdrawal_id: 'b', reason: 'member_blocked' }],
  };
  const texts = resultTexts(
    [row('a'), row('b'), row('c'), row('p', { status: 'PENDING_REVIEW' })],
    result,
  );
  const te = withdrawalsTexts.execute;
  expect([...texts.entries()]).toEqual([
    ['a', te.paying],
    ['b', te.left['member_blocked']],
    ['c', te.noResult],
    ['p', withdrawalsTexts.batchPayout.unreviewed],
  ]);
});
