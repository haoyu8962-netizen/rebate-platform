import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  registerReconDiffOnce,
  registerReconDiffWriteOnly,
  type ReconDiff,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { bounded } from '../posting/kit.ts';
import { CONCLUDED_AT, moveTo } from '../recon-diffs-unresolved/kit.ts';
import { TIMEOUT, close, open, rows, type Harness } from '../recon-diffs/kit.ts';
import { difference, expectOnlyRow, recordSql, replay, seed, waitsForInsert } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['[AC-B2-02zf#8]', '提交', false],
  ['[AC-B2-02zf#9]', '回滚', true],
] as const)(
  '%s 等到 PostgreSQL 报告 B 被 A 的同键 INSERT 阻塞，A %s 后 B 返回 inserted=%s',
  async (_id, finish, inserted) => {
    const { input, clock } = difference();
    const candidate = replay(input);
    const holder = await h.left.startTransaction().setIsolationLevel('read committed').execute();
    try {
      const holderPid = await bounded(holder);
      const first = await registerReconDiffOnce(holder, input, { clock });
      expect(first.inserted).toBe(true);

      const waiter = await h.right.startTransaction().setIsolationLevel('read committed').execute();
      let pending: Promise<PromiseSettledResult<{ readonly inserted: boolean }>[]> | undefined;
      try {
        const waiterPid = await bounded(waiter);
        expect(waiterPid).not.toBe(holderPid);
        let finished = false;
        pending = Promise.allSettled([
          registerReconDiffWriteOnly(waiter, candidate, { clock }),
        ]).finally(() => {
          finished = true;
        });
        const waited = await waitsForInsert(h.db, waiterPid, holderPid, () => finished);
        expect(waited, '事务 B 的 INSERT 在 PostgreSQL 上等待事务 A').toBe(true);

        if (finish === '提交') await holder.commit().execute();
        else await holder.rollback().execute();

        expect(await pending).toStrictEqual([{ status: 'fulfilled', value: { inserted } }]);
        const storedByWaiter = await rows(waiter, input.appId);
        expect(storedByWaiter).toHaveLength(1);
        const winner = storedByWaiter[0]!;
        if (inserted) {
          expect(winner.id).not.toBe(first.row.id);
          expect(winner).toMatchObject({
            source: candidate.source,
            ref_type: candidate.refType,
            expected_fen: candidate.expectedFen,
            actual_fen: candidate.actualFen,
            diff_fen: candidate.diffFen,
            dedupe_key: candidate.dedupeKey,
            resolution: candidate.resolution,
          });
        } else {
          expect(winner).toEqual(first.row);
        }
        await waiter.commit().execute();
        await expectOnlyRow(h.db, winner);
      } finally {
        // 先放开持有者的锁，再等待 B 的语句结束。两个连接都设了语句和锁等待上限。
        try {
          if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
        } finally {
          await pending;
          if (!waiter.isCommitted && !waiter.isRolledBack) await waiter.rollback().execute();
        }
      }
    } finally {
      if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
    }
  },
  TIMEOUT,
);

it('[AC-B2-02zf#10] 未结键冲突后并发结案，只写口返回 false 并可提交，旧口因回读不到原票而失败', async () => {
  async function interleave(register: typeof registerReconDiffWriteOnly) {
    const original = difference({
      type: 'ledger_mismatch',
      source: 'R3',
      refType: 'ledger_account',
      period: '2032-06-15',
    });
    const { input, clock } = original;
    const first = await seed(h.db, original);
    const candidate = { ...replay(input), refType: input.refType, period: '2032-06-16' };
    const concluded: ReconDiff[] = [];
    const probe = recordSql(h.right, async () => {
      // B 的 INSERT 已收到零行，B 仍未收到 Kysely 返回值。A 在独立连接结案并提交。
      const closed = await h.left.transaction().execute(async (trx) => {
        await bounded(trx);
        return moveTo(trx, first, 'closed', CONCLUDED_AT);
      });
      concluded.push(closed);
    });
    const operation = probe.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await bounded(trx);
        const result = await register(trx, candidate, { clock });
        expect(concluded).toHaveLength(1);
        expect(await rows(trx, input.appId)).toEqual(concluded);
        return result;
      });
    return { operation, concluded };
  }

  const writeOnly = await interleave(registerReconDiffWriteOnly);
  await expect(writeOnly.operation).resolves.toStrictEqual({ inserted: false });
  expect(writeOnly.concluded).toHaveLength(1);
  await expectOnlyRow(h.db, writeOnly.concluded[0]!);

  const old = await interleave(registerReconDiffOnce);
  await expect(old.operation).rejects.toThrow(
    'ledger: recon diff conflicted but no existing row was found',
  );
  expect(old.concluded).toHaveLength(1);
  await expectOnlyRow(h.db, old.concluded[0]!);
});
