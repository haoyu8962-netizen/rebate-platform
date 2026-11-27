import { expect, it, vi } from 'vitest';
import { readChannelMismatchOpen } from '../../../../../apps/api/src/modules/ledger/index.ts';
import { readSettleBillMismatch } from '../../../../../apps/api/src/modules/settlement/index.ts';
import { SQL_CLOCK, WRITE_SQL, mentions, recordingDb } from '../../fund-metrics/kit.ts';

function expectReadOnlyQueries(queries: string[], expectedTable: string, otherTable: string) {
  expect(queries.some((query) => mentions(query, expectedTable))).toBe(true);
  expect(queries.some((query) => mentions(query, otherTable))).toBe(false);
  expect(queries.filter((query) => WRITE_SQL.test(query) || SQL_CLOCK.test(query))).toEqual([]);
  expect(
    queries.filter((query) => /\bfor\s+(?:(?:no\s+key|key)\s+)?(?:update|share)\b/i.test(query)),
  ).toEqual([]);
}

it('[AC-B2-09zn#10] ledger/index 读口读取 recon_diffs，不开事务、不取行锁、不读 SQL 时钟', async () => {
  const queries: string[] = [];
  const db = recordingDb(queries, () => []);
  const transaction = vi.spyOn(db, 'transaction');
  const startTransaction = vi.spyOn(db, 'startTransaction');
  expect(await readChannelMismatchOpen(db)).toEqual({ open: {} });
  expectReadOnlyQueries(queries, 'recon_diffs', 'settle_bills');
  expect(transaction).not.toHaveBeenCalled();
  expect(startTransaction).not.toHaveBeenCalled();
});

it('[AC-B2-09zn#11] settlement/index 读口只读 settle_bills，无已出账数据时返回空映射', async () => {
  const queries: string[] = [];
  const db = recordingDb(queries, () => []);
  expect(await readSettleBillMismatch(db)).toEqual({ bills: {} });
  expectReadOnlyQueries(queries, 'settle_bills', 'recon_diffs');
});

it('[AC-B2-09zn#12] 通道差错单库读失败时保留原错误', async () => {
  const failure = new Error('recon_diffs read failed');
  const db = recordingDb([], () => {
    throw failure;
  });
  await expect(Promise.resolve().then(() => readChannelMismatchOpen(db))).rejects.toBe(failure);
});

it('[AC-B2-09zn#13] 账单库读失败时保留原错误', async () => {
  const failure = new Error('settle_bills read failed');
  const db = recordingDb([], () => {
    throw failure;
  });
  await expect(Promise.resolve().then(() => readSettleBillMismatch(db))).rejects.toBe(failure);
});
