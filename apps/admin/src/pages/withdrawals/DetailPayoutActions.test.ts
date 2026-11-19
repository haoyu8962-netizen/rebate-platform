import { expect, it } from 'vitest';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { canExecuteDetail, canRecordPaidDetail } from './DetailPayoutActions.tsx';
import type { WithdrawalDetail } from './model.ts';

type Attempt = WithdrawalDetail['payout_attempts'][number];

const access = (...points: string[]): AccessControl => ({
  isSuper: false,
  can: (point) => points.includes(point),
  stepUpTier: () => null,
});

const transfer = (result: Attempt['result']): Attempt => ({
  attempt_id: 'a1',
  kind: 'transfer',
  result,
  resp_code: null,
  resp_sub_code: null,
  at: '2026-11-17T10:00:05+08:00',
});

/** Only the fields the entry rules read. */
const item = (changes: Partial<WithdrawalDetail> = {}): WithdrawalDetail =>
  ({
    status: 'APPROVED',
    payout_channel: 'alipay',
    payout_method: 'alipay',
    payout_attempts: [],
    ...changes,
  }) as WithdrawalDetail;

const both = access('payout.execute', 'payout.manual_entry');

it('[F1-08am] entries follow the permission points and only an APPROVED withdrawal', () => {
  expect(canExecuteDetail(item(), access('payout.execute'))).toBe(true);
  expect(canRecordPaidDetail(item(), access('payout.execute'))).toBe(false);
  expect(canExecuteDetail(item(), access('payout.manual_entry'))).toBe(false);
  expect(canRecordPaidDetail(item(), access('payout.manual_entry'))).toBe(true);
  for (const status of ['PENDING_REVIEW', 'PAYING', 'PAID_MANUAL', 'FAILED'] as const) {
    expect(canExecuteDetail(item({ status }), both), status).toBe(false);
    expect(canRecordPaidDetail(item({ status }), both), status).toBe(false);
  }
});

it('[F1-08am] a transfer attempt hides execute; only a failed one leaves the manual entry', () => {
  for (const result of ['pending', 'success', 'unknown'] as const) {
    const withAttempt = item({ payout_attempts: [transfer(result)] });
    expect(canExecuteDetail(withAttempt, both), result).toBe(false);
    expect(canRecordPaidDetail(withAttempt, both), result).toBe(false);
  }
  const failed = item({ payout_attempts: [transfer('fail')] });
  expect(canExecuteDetail(failed, both)).toBe(false);
  expect(canRecordPaidDetail(failed, both)).toBe(true);
});

it('[F1-08am] a WeChat withdrawal has no manual entry; a bank card one has', () => {
  const wechat = item({ payout_channel: 'wechat', payout_method: 'wechat' });
  expect(canExecuteDetail(wechat, both)).toBe(true);
  expect(canRecordPaidDetail(wechat, both)).toBe(false);
  const bank = item({ payout_channel: 'bank_card', payout_method: 'bank_card' });
  expect(canRecordPaidDetail(bank, both)).toBe(true);
});
