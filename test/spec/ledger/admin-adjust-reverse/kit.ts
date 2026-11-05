// B2-12b harness: ADMIN_ADJUST vouchers and their whole reversal through the real ledger
// application layer on a real database. Only *.int.test.ts imports the database provisioner.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  LedgerError,
  type AccountBalance,
  type Ledger,
  type LedgerErrorCode,
  type PostingEntry,
  type PostingResult,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { account, context, post, snapshot } from '../posting/kit.ts';

export {
  TIMEOUT,
  account,
  close,
  context,
  open,
  post,
  snapshot,
  type Harness,
} from '../posting/kit.ts';

/** The trusted voucher kind of an adjustment reversal, passed only by server code (D10-590 ①). */
export const KIND = 'ADMIN_ADJUST_REV';
/** The admin who executed the original adjustment, and the one who executes its reversal. */
export const MAKER = 'admin:0193a1b2-maker';
export const REVERSER = 'admin:0193c3d4-reverser';
/** posting/kit INSTANT (2032-06-15T23:59:59.999+08:00) as an accounting date. */
export const DAY = '2032-06-15';

export interface AdjustLine {
  readonly subType: string | null;
  /** The platform subject on the other side (BR-FUND-24 ⑥, specs/ledger-rules.md §4.11). */
  readonly counter: string;
}

export const RECON_FIX: AdjustLine = { subType: 'RECON_FIX', counter: 'COMMISSION_REVENUE' };

/**
 * One ADMIN_ADJUST voucher on a user's available: increase = negative (credit) user line,
 * decrease = positive (debit) user line (BR-FUND-16 signs); the counter subject balances it.
 */
export function adjustment(
  appId: string,
  accountId: string,
  uniqKey: string,
  signedUserAmount: bigint,
  line: AdjustLine = RECON_FIX,
): PostingVoucher {
  const user: PostingEntry = {
    account: { ownerType: 'user', accountId },
    sub_account: 'available',
    amount_fen: signedUserAmount,
    ledger_type: 'ADMIN_ADJUST',
    sub_type: line.subType,
    income_type: null,
  };
  return {
    appId,
    uniqKey,
    bizType: 'ADMIN_ADJUST',
    bizId: uniqKey,
    operator: MAKER,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'ADMIN_ADJUST',
    entries: [
      user,
      {
        ...user,
        account: { ownerType: 'platform', subject: line.counter },
        amount_fen: -signedUserAmount,
      },
    ],
  };
}

/**
 * The whole reversal the adjustment flow writes itself (not ledger.reverse, which would copy the
 * original operator): `{original}:REVERSE`, every line negated, its own operator, the trusted kind.
 */
export function reversalOf(
  original: PostingVoucher,
  overrides: Partial<PostingVoucher> = {},
): PostingVoucher {
  return {
    ...original,
    uniqKey: `${original.uniqKey}:REVERSE`,
    bizId: `${original.bizId}:REVERSE`,
    operator: REVERSER,
    voucherKind: KIND,
    entries: original.entries.map((e) => ({ ...e, amount_fen: -e.amount_fen })),
    ...overrides,
  };
}

/** A withdrawal freeze: available -> frozen (BR-FUND-14), so later debits can push available < 0. */
export function freeze(appId: string, accountId: string, amount: bigint): PostingVoucher {
  const line = (sub: 'available' | 'frozen', amount_fen: bigint): PostingEntry => ({
    account: { ownerType: 'user', accountId },
    sub_account: sub,
    amount_fen,
    ledger_type: 'WITHDRAW_FREEZE',
    sub_type: null,
    income_type: null,
  });
  const id = randomUUID();
  return {
    appId,
    uniqKey: `wd:${id}:FREEZE`,
    bizType: 'WITHDRAWAL',
    bizId: id,
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: [line('available', amount), line('frozen', -amount)],
  };
}

export type Outcome = PostingResult | { readonly refused: LedgerErrorCode };

/**
 * A ledger refusal as a value, so a red run fails on an assertion rather than an escaping
 * LedgerError; anything that is not a LedgerError still propagates.
 */
export async function outcome(attempt: Promise<PostingResult>): Promise<Outcome> {
  try {
    return await attempt;
  } catch (error) {
    if (error instanceof LedgerError) return { refused: error.code };
    throw error;
  }
}

export interface Adjusted {
  readonly a: AccountBalance;
  readonly original: PostingVoucher;
}

/**
 * Adjustment `ADJ:{id}` credits +500 (BR-FUND-24 ⑥ 调增), then 300 is frozen for a withdrawal:
 * available 200, frozen 300, version 2. Its whole reversal takes available to -300.
 */
export async function increasedThenFrozen(
  db: Kysely<DB>,
  ledger: Ledger,
  appId: string,
  line: AdjustLine = RECON_FIX,
): Promise<Adjusted> {
  const a = await account(db, ledger, appId);
  const original = adjustment(appId, a.account_id, `ADJ:${randomUUID()}`, -500n, line);
  expect(await outcome(post(db, ledger, [a.user_id], original))).toMatchObject({ kind: 'posted' });
  expect(
    await outcome(post(db, ledger, [a.user_id], freeze(appId, a.account_id, 300n))),
  ).toMatchObject({ kind: 'posted' });
  return { a, original };
}

/**
 * The channel B2-12b opens, in an app of its own: a trusted whole reversal of an increase posts
 * and leaves available at -300. On the skeleton this is the assertion that makes a test red.
 */
export async function expectChannelOpen(db: Kysely<DB>): Promise<void> {
  const { ledger, appId } = context();
  const { a, original } = await increasedThenFrozen(db, ledger, appId);
  expect(await outcome(post(db, ledger, [a.user_id], reversalOf(original)))).toMatchObject({
    kind: 'posted',
  });
  expect(await ledger.getBalances(db, { appId, userIds: [a.user_id] })).toEqual([
    { ...a, available_fen: -300n, frozen_fen: 300n, version: 3n, negative_since: DAY },
  ]);
}

/** A refused write left nothing of this app behind and stored no voucher under `uniqKey`. */
export async function expectNoTrace(
  db: Kysely<DB>,
  appId: string,
  before: Awaited<ReturnType<typeof snapshot>>,
  uniqKey: string,
): Promise<void> {
  const after = await snapshot(db, appId);
  expect(after).toEqual(before);
  expect(after.vouchers.some((v) => v.uniq_key === uniqKey)).toBe(false);
}
