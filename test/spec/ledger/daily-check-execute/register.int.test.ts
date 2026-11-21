// B2-02p: every difference of the run is registered as a ledger_mismatch recon diff (source R3,
// period D) through registerReconDiffOnce — one per (app, invariant, entity), keyed and amounted as
// the task brief fixes (see kit.ts).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  NEXT_DAY,
  OTHER,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  duplicateCredits,
  entry,
  executedOf,
  expectDetailKept,
  expectRegistered,
  negativeDropDiff,
  orderKey,
  payAccountDiff,
  paySuspenseDiff,
  platformAccount,
  receivableDiff,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
} from './kit.ts';

it(
  '[AC-B2-02p#1] 账户级差异（①）：登记 1 张 ledger_mismatch 差错单，R3、会计日 D、open，ref 指向用户账户，金额取缓存与分录合计',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const difference = balanceCacheDiff(account, { expected: 300n, cache: 500n });
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [difference],
      });
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expectRegistered(row, {
        refType: 'ledger_account',
        refId: `01:${account.accountId}`,
        expectedFen: 300n,
        actualFen: 500n,
      });
      expect(row.diff_fen).toBe(-200n);
      expect(row.created_at).toEqual(h.clock.now());
      expectDetailKept(row, difference);
      expect(execution.accountingDate).toBe(DAY);
      expect(execution.reconDiffs).toHaveLength(1);
      expect(executedOf(execution, row)).toMatchObject({
        appId: APP,
        invariant: '01',
        refType: 'ledger_account',
        refId: `01:${account.accountId}`,
        inserted: true,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#2] ② 凭证不平：ref_type voucher、ref_id 02:<凭证 id>，期望 0、实际为分录合计',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cash = await platformAccount(h, 'CASH');
      const v = await voucher(h);
      await entry(h, v.id, account.accountId, -100n, true);
      await entry(h, v.id, cash, 107n, false);
      const difference = voucherDiff(v, 7n, 2);
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [difference] });
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(1);
      expectRegistered(rows[0]!, {
        refType: 'voucher',
        refId: `02:${v.id}`,
        expectedFen: 0n,
        actualFen: 7n,
      });
      expect(rows[0]!.diff_fen).toBe(-7n);
      expectDetailKept(rows[0]!, difference);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#3] ③ 同键多张 CREDIT：ref_type order、ref_id 03:<子订单键>，没有成对金额时三项金额为 0',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const difference = await duplicateCredits(h, key, account, 'self', receivable);
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [difference] });
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(1);
      expectRegistered(rows[0]!, {
        refType: 'order',
        refId: `03:${key}`,
        expectedFen: 0n,
        actualFen: 0n,
      });
      expect(rows[0]!.diff_fen).toBe(0n);
      expectDetailKept(rows[0]!, difference);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#4] ⑤ 应收不符：ref_type order、ref_id 05:<子订单键>，期望为应有应收净额、实际为应收净额',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const key = orderKey();
      const difference = receivableDiff(key, randomUUID(), account.userId, {
        expected: 1000n,
        actual: 900n,
      });
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [difference] });
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(1);
      expectRegistered(rows[0]!, {
        refType: 'order',
        refId: `05:${key}`,
        expectedFen: 1000n,
        actualFen: 900n,
      });
      expect(rows[0]!.diff_fen).toBe(100n);
      expectDetailKept(rows[0]!, difference);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#5] pay- 差异（账户级与全局）照样各登记 1 张 ledger_mismatch / R3 差错单',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const accountLevel = payAccountDiff(account);
      const global = paySuspenseDiff();
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [accountLevel, global] });
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(2);
      const onAccount = await diffByRef(h, `pay-01:${account.accountId}`);
      expect(onAccount).toMatchObject({
        type: 'ledger_mismatch',
        source: 'R3',
        period: DAY,
        status: 'open',
        ref_type: 'ledger_account',
        dedupe_key: `R3:${DAY}:pay-01:${account.accountId}`,
      });
      expectDetailKept(onAccount, accountLevel);
      const suspense = rows.find((row) => row.id !== onAccount.id)!;
      expect(suspense).toMatchObject({
        app_id: APP,
        type: 'ledger_mismatch',
        source: 'R3',
        period: DAY,
        status: 'open',
      });
      expect(suspense.ref_id.startsWith('pay-04:')).toBe(true);
      expect(suspense.dedupe_key).toBe(`R3:${DAY}:${suspense.ref_id}`);
      expectDetailKept(suspense, global);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#6] 同一账户同日：不同不变量各 1 张；同一不变量的多行差异只 1 张',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const cacheAvailable = balanceCacheDiff(account, { expected: 300n, cache: 500n });
      const cacheFrozen = {
        ...balanceCacheDiff(account, { expected: 0n, cache: 40n }),
        detail: {
          check: 'balance_cache',
          sub_account: 'frozen',
          cache_present: true,
          cache_fen: '40',
          expected_cache_fen: '0',
          entries_sum_fen: '0',
        },
      };
      const negative = negativeDropDiff(account);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [cacheAvailable, cacheFrozen, negative],
      });
      const rows = await diffsOf(h);
      expect(rows.map((row) => row.ref_id).sort()).toEqual(
        [`01:${account.accountId}`, `07:${account.accountId}`].sort(),
      );
      for (const row of rows) expect(row.ref_type).toBe('ledger_account');
      expect(new Set(execution.reconDiffs.map((d) => d.reconDiffId))).toEqual(
        new Set(rows.map((row) => row.id)),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#7] 差错单按差异所属 app 登记，不串 app',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const mine = await userAccount(h, APP);
      const theirs = await userAccount(h, OTHER);
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [
          balanceCacheDiff(mine, { expected: 1n, cache: 2n }),
          balanceCacheDiff(theirs, { expected: 3n, cache: 4n }),
        ],
      });
      const own = await diffsOf(h, APP);
      const other = await diffsOf(h, OTHER);
      expect(own.map((row) => row.ref_id)).toEqual([`01:${mine.accountId}`]);
      expect(other.map((row) => row.ref_id)).toEqual([`01:${theirs.accountId}`]);
      expectRegistered(other[0]!, {
        appId: OTHER,
        refType: 'ledger_account',
        refId: `01:${theirs.accountId}`,
        expectedFen: 3n,
        actualFen: 4n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#8] 同日重跑不新增、不改写已有差错单（inserted=false）；次日同一差异在前一张未结时不新增、不改写',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const differences = [balanceCacheDiff(account, { expected: 300n, cache: 500n })];
      await h.executor.execute(h.db, { accountingDate: DAY, differences });
      const [first] = await diffsOf(h);
      expect(first).toBeDefined();

      h.clock.set('2032-06-15T19:00:00.000Z');
      const again = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      expect(await diffsOf(h)).toEqual([first]);
      expect(executedOf(again, first!).inserted).toBe(false);

      h.clock.set('2032-06-16T17:00:00.000Z');
      const next = await h.executor.execute(h.db, { accountingDate: NEXT_DAY, differences });
      expect(await diffsOf(h)).toEqual([first]);
      expect(next.reconDiffs).toHaveLength(1);
      expect(next.reconDiffs[0]!.reconDiffId).toBe(first!.id);
      expect(executedOf(next, first!).inserted).toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#9] 没有差异：不登记、不冻结、不关开关',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences: [] });
      expect(execution).toEqual({ accountingDate: DAY, reconDiffs: [], autoSettlementOff: [] });
      expect(await diffsOf(h)).toEqual([]);
      expect(h.holds.calls).toEqual([]);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
    });
  },
  TIMEOUT,
);
