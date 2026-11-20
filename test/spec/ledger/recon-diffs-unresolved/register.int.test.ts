// B2-02zc: registerReconDiffOnce on the unresolved internal key (D10-2224 B ①). Two transactions
// registering the same app's ledger_mismatch on the same ref_id for different periods, the first
// still uncommitted when the second inserts: the database (partial unique index) makes the second
// wait; exactly one ticket exists, exactly one call reports inserted = true, the other does not
// throw, reads the same row back and keeps a usable transaction. Contrast: an external difference
// (union_mismatch) on one ref_id stays one ticket per period while the first is still open.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  registerReconDiffOnce,
  type ReconDiffRegistration,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { bounded } from '../posting/kit.ts';
import { TIMEOUT, close, fixture, open, rows, type Harness } from '../recon-diffs/kit.ts';
import { waitsOn } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-02zc#8] 并发：同 app、同 ref_id、不同 period 的 ledger_mismatch，第一张未提交时第二个事务登记 → 等待后恰好 1 张、恰好一方 inserted=true，另一方不抛错、读回同一行、事务仍可用；对照：union_mismatch 同 ref_id 不同 period 首张未结仍各开一张',
  async () => {
    const refId = `01:${randomUUID()}`;
    const { input, clock } = fixture({
      type: 'ledger_mismatch',
      source: 'R3',
      period: '2032-06-15',
      refType: 'ledger_account',
      refId,
      dedupeKey: `R3:2032-06-15:${refId}`,
    });
    const contender = { ...input, period: '2032-06-16', dedupeKey: `R3:2032-06-16:${refId}` };
    const ready = Promise.withResolvers<{ pid: number; registration: ReconDiffRegistration }>();
    const release = Promise.withResolvers<void>();
    const waiter = Promise.withResolvers<number>();
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      const registration = await registerReconDiffOnce(trx, input, { clock });
      ready.resolve({ pid, registration });
      await release.promise;
      return registration;
    });
    const leftDone = Promise.allSettled([left]);
    let rightDone: Promise<PromiseSettledResult<ReconDiffRegistration>[]> | undefined;
    try {
      const held = await Promise.race([
        ready.promise,
        left.then(() => {
          throw new Error('missing registration barrier');
        }),
      ]);
      expect(held.registration.inserted).toBe(true);
      const right = h.right.transaction().execute(async (trx) => {
        waiter.resolve(await bounded(trx));
        const registration = await registerReconDiffOnce(trx, contender, { clock });
        // A recovered conflict must leave the transaction usable (no 25P02).
        const usable = await sql<{ one: number }>`SELECT 1 AS one`.execute(trx);
        expect(usable.rows).toEqual([{ one: 1 }]);
        return registration;
      });
      const settled = { done: false };
      rightDone = Promise.allSettled([right]);
      void rightDone.then(() => {
        settled.done = true;
      });
      const pid = await Promise.race([
        waiter.promise,
        right.then(() => {
          throw new Error('missing contender barrier');
        }),
      ]);
      const waited = await waitsOn(h.db, pid, held.pid, () => settled.done);
      release.resolve();
      const first = await left;
      const second = await right;
      const stored = await rows(h.db, input.appId);
      expect(stored, '同一未结差异恰好 1 张').toHaveLength(1);
      expect([first.inserted, second.inserted]).toEqual([true, false]);
      expect(second.row).toEqual(first.row);
      expect(stored).toEqual([first.row]);
      expect(first.row).toMatchObject({ period: '2032-06-15', status: 'open', ref_id: refId });
      expect(waited, '第二个事务由数据库唯一约束挡住并等待第一张提交').toBe(true);
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }

    // Contrast: external differences keep one ticket per (app_id, type, period, ref_id).
    const externalRef = randomUUID();
    const external = {
      ...input,
      type: 'union_mismatch' as const,
      source: 'R1' as const,
      refType: 'order',
      refId: externalRef,
      dedupeKey: null,
    };
    const june = await h.db
      .transaction()
      .execute((trx) => registerReconDiffOnce(trx, { ...external, period: '2032-06' }, { clock }));
    const july = await h.db
      .transaction()
      .execute((trx) => registerReconDiffOnce(trx, { ...external, period: '2032-07' }, { clock }));
    expect(june).toMatchObject({ inserted: true, row: { status: 'open', period: '2032-06' } });
    expect(july).toMatchObject({ inserted: true, row: { status: 'open', period: '2032-07' } });
    expect(july.row.id).not.toBe(june.row.id);
    const externalRows = (await rows(h.db, input.appId)).filter(
      (row) => row.ref_id === externalRef,
    );
    expect(externalRows).toHaveLength(2);
  },
  TIMEOUT,
);
