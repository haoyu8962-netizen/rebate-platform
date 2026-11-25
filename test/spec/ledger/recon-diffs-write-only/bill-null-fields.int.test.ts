import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerReconDiffWriteOnly } from '../../../../apps/api/src/modules/ledger/index.ts';
import { TIMEOUT, close, open, rows, type Harness } from '../recon-diffs/kit.ts';
import { REPLAY_AT, billDifference, expectOnlyRow, expectWriteOnlyConflict, seed } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-02zf#16] 月结差错单的去重键与处置均为空时，插入行与旧口相同，两列均为 NULL', async () => {
  const { input, clock } = billDifference();
  const result = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, input, { clock }));
  expect(result).toStrictEqual({ inserted: true });

  const otherAppId = `${input.appId}-other`;
  const oldRow = await seed(h.db, { input: { ...input, appId: otherAppId }, clock });
  const stored = await rows(h.db, input.appId);
  expect(stored).toHaveLength(1);
  const { id, app_id: appId, ...fields } = stored[0]!;
  const { id: oldId, app_id: oldAppId, ...oldFields } = oldRow;
  expect(id).not.toBe(oldId);
  expect(appId).toBe(input.appId);
  expect(oldAppId).toBe(otherAppId);
  expect(fields).toEqual(oldFields);
  expect(fields).toMatchObject({ dedupe_key: null, resolution: null });
});

it('[AC-B2-02zf#17] 两次登记的去重键与处置均为空时，撞业务键返回 inserted=false 并保留原行', async () => {
  const original = billDifference();
  const { input, clock } = original;
  const first = await seed(h.db, original);
  clock.set(REPLAY_AT);
  // 自拟金额，单位分。补充登记仍用 R1 的订单键，三个金额均与首张不同。
  const candidate = { ...input, expectedFen: 45n, actualFen: 20n, diffFen: 25n };
  const result = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, candidate, { clock }));
  expect(result).toStrictEqual({ inserted: false });
  expect(first).toMatchObject({ dedupe_key: null, resolution: null });
  await expectOnlyRow(h.db, first);
});

it('[AC-B2-02zf#18] 去重键与处置均为空的月结差错单撞业务键时只执行一条 INSERT', async () => {
  const original = billDifference();
  await seed(h.db, original);
  await expectWriteOnlyConflict(h.right, original.input, original.clock);
});
