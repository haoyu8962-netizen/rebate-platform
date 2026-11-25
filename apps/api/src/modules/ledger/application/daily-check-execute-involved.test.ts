// B2-17 implementer unit tests (no database): the involved-members list the daily check registers
// with a diff (task §9.3 ⑭ and §16.2, D10-3237 (二)). For a sub-order group (ref_type order) the
// list is the members involvedUsers finds ∪ every beneficiary on the sub-order's vouchers; the holds
// stay the members involvedUsers finds. Other groups are unchanged. A recording chain stub stands in
// for the transaction: reads of ledger_vouchers / ledger_accounts answer canned rows, the diff's
// INSERT answers the row it was given.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createDailyCheckExecutor,
  type DailyCheckFiledDifference,
  type LedgerMismatchHoldInput,
} from './daily-check-execute.ts';

const U1 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const U2 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02';
const U3 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a03';
const ACCOUNT = '0199a3b4-5c6d-7e8f-9a0b-acacacacacac';
const APP = 'app_unit';

interface Stub {
  readonly db: Kysely<DB>;
  /** Tables read with `.execute()`, in order. */
  readonly reads: string[];
  /** The `.values()` given to the diff's INSERT. */
  readonly inserted: Record<string, unknown>[];
  /** The `.where(…)` arguments of the vouchers read. */
  readonly voucherWheres: unknown[][];
}

function stub(rows: { vouchers?: string[]; accounts?: string[] }): Stub {
  const reads: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const voucherWheres: unknown[][] = [];
  const trx = (): Transaction<DB> => {
    let table = '';
    let values: Record<string, unknown> = {};
    const chain: object = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== 'string' || property === 'then') return undefined;
          return (...args: unknown[]) => {
            if (property === 'selectFrom' || property === 'insertInto') table = String(args[0]);
            if (property === 'where' && table === 'ledger_vouchers') voucherWheres.push(args);
            if (property === 'values') values = args[0] as Record<string, unknown>;
            if (property === 'execute') {
              reads.push(table);
              if (table === 'ledger_vouchers') {
                return Promise.resolve(
                  (rows.vouchers ?? []).map((id) => ({ beneficiary_user_id: id })),
                );
              }
              if (table === 'ledger_accounts') {
                return Promise.resolve((rows.accounts ?? []).map((id) => ({ owner_id: id })));
              }
              return Promise.resolve([]);
            }
            if (property === 'executeTakeFirst') {
              inserted.push(values);
              return Promise.resolve({ ...values });
            }
            return chain;
          };
        },
      },
    );
    return chain as Transaction<DB>;
  };
  const db = {
    transaction: () => ({
      execute: <T>(callback: (t: Transaction<DB>) => Promise<T>) => callback(trx()),
    }),
  } as unknown as Kysely<DB>;
  return { db, reads, inserted, voucherWheres };
}

function executor(held: LedgerMismatchHoldInput[]) {
  return createDailyCheckExecutor({
    clock: new FixedClock('2032-06-16T00:00:00.000Z'),
    logger: { warn: () => undefined, error: () => undefined },
    holds: {
      add: (_trx, input) => {
        held.push(input);
        return Promise.resolve({ id: `hold-${held.length}` });
      },
    },
    autoSettlement: {
      turnOff: () => Promise.resolve({ changed: true }),
      alertCommitted: () => undefined,
    } as never,
  });
}

/** An 08 difference of a sub-order naming `users` in its detail (an order-level group). */
function orderDiff(users: readonly string[]): DailyCheckFiledDifference {
  return {
    file: '08_invalid_still_credited.sql',
    invariant: '08',
    scope: 'global',
    app_id: APP,
    account_id: null,
    detail: { order_key: 'taobao:K-1', beneficiary_user_ids: [...users] },
  };
}

it('[AC-B2-17#42] 按子订单登记：明细只列 U1、该子订单凭证上的受益人是 U1、U2 → 名单 [U1, U2]（小写升序），只冻结 U1', async () => {
  const s = stub({ vouchers: [U2.toUpperCase(), U1] });
  const held: LedgerMismatchHoldInput[] = [];
  const result = await executor(held).execute(s.db, {
    accountingDate: '2032-06-15',
    differences: [orderDiff([U1])],
  });

  expect(s.inserted).toHaveLength(1);
  expect(s.inserted[0]!['ref_type']).toBe('order');
  expect(s.inserted[0]!['involved_user_ids']).toEqual([U1, U2]);
  expect(held.map((hold) => hold.userId)).toEqual([U1]);
  expect(result.reconDiffs[0]!.heldUserIds).toEqual([U1]);
  expect(s.reads).toContain('ledger_vouchers');
  // The vouchers are read for this app and this sub-order only.
  expect(s.voucherWheres).toContainEqual(['app_id', '=', APP]);
  expect(s.voucherWheres).toContainEqual(['order_key', 'in', ['taobao:K-1']]);
});

it('[AC-B2-17#43] 按子订单登记：明细列了凭证上没有的会员 → 名单是两者的并集；冻结仍只按明细', async () => {
  const s = stub({ vouchers: [U2, U1] });
  const held: LedgerMismatchHoldInput[] = [];
  await executor(held).execute(s.db, {
    accountingDate: '2032-06-15',
    differences: [orderDiff([U3])],
  });

  expect(s.inserted[0]!['involved_user_ids']).toEqual([U1, U2, U3]);
  expect(held.map((hold) => hold.userId)).toEqual([U3]);
});

it('[AC-B2-17#43] 按子订单登记：明细与凭证都没有会员 → 名单不写（NULL），不冻结', async () => {
  const s = stub({ vouchers: [] });
  const held: LedgerMismatchHoldInput[] = [];
  await executor(held).execute(s.db, {
    accountingDate: '2032-06-15',
    differences: [orderDiff([])],
  });

  expect(Object.hasOwn(s.inserted[0]!, 'involved_user_ids')).toBe(false);
  expect(held).toEqual([]);
});

it('[AC-B2-17#26] 按账户登记的差错单：名单 = 冻结的会员，不读订单凭证（不变）', async () => {
  const s = stub({ accounts: [U2], vouchers: [U1] });
  const held: LedgerMismatchHoldInput[] = [];
  await executor(held).execute(s.db, {
    accountingDate: '2032-06-15',
    differences: [
      {
        file: '01_user_balance.sql',
        invariant: '01',
        scope: 'account',
        app_id: APP,
        account_id: ACCOUNT,
        detail: {},
      },
    ],
  });

  expect(s.inserted[0]!['ref_type']).toBe('ledger_account');
  expect(s.inserted[0]!['involved_user_ids']).toEqual([U2]);
  expect(held.map((hold) => hold.userId)).toEqual([U2]);
  expect(s.reads).not.toContain('ledger_vouchers');
});
