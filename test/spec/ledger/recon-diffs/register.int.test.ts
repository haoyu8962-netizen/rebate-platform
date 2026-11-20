import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerReconDiff } from '../../../../apps/api/src/modules/ledger/index.ts';
import { snapshot } from '../posting/kit.ts';
import { TIMEOUT, INSTANT, close, fixture, open, rows, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['ledger_mismatch', 'R3'],
  ['platform_restore', 'R1'],
  ['appeal_restore', 'R3'],
  ['union_mismatch', 'R1'],
  ['channel_mismatch', 'R2'],
  ['settle_amount_mismatch', 'R1'],
  ['settle_missing', 'R1'],
  ['estimate_changed_after_credit', 'R1'],
  ['month_end_unbalanced', 'R4'],
] as const)('[AC-B2-04k#1] 登记 %s / %s 只落差错单初值，不记账或自动处置', async (type, source) => {
  const { input, clock } = fixture({
    type,
    source,
    period: '2032-06',
    resolution: { evidence: 'snapshot-1' },
  });
  const before = await snapshot(h.db, input.appId);
  const row = await h.db.transaction().execute((trx) => registerReconDiff(trx, input, { clock }));
  expect(row).toMatchObject({
    app_id: input.appId,
    type,
    source,
    period: input.period,
    ref_type: input.refType,
    ref_id: input.refId,
    expected_fen: 4900n,
    actual_fen: 5000n,
    diff_fen: -100n,
    status: 'open',
    dedupe_key: null,
    handler_id: null,
    closed_at: null,
    resolution: { evidence: 'snapshot-1' },
    created_at: new Date(INSTANT),
    updated_at: new Date(INSTANT),
  });
  expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await rows(h.db, input.appId)).toEqual([row]);
  expect(await snapshot(h.db, input.appId)).toEqual(before);
});

it.each([
  [9007199254740993n, 9007199254740992n, 1n],
  [-9007199254740993n, -9007199254740992n, -1n],
  [-1n, -1n, 0n],
] as const)(
  '[AC-B2-04k#2] 金额原样保留整数分、符号与零差额：%s / %s / %s',
  async (expectedFen, actualFen, diffFen) => {
    const { input, clock } = fixture({ expectedFen, actualFen, diffFen });
    const row = await h.db.transaction().execute((trx) => registerReconDiff(trx, input, { clock }));
    expect(row).toMatchObject({
      expected_fen: expectedFen,
      actual_fen: actualFen,
      diff_fen: diffFen,
      resolution: null,
    });
    expect(await rows(h.db, input.appId)).toEqual([row]);
  },
);

it('[AC-B2-04k#3] 业务键重放返回同一行，不因 source/ref_type/金额/初始 resolution 不同重复登记', async () => {
  const { input, clock } = fixture({ resolution: { evidence: 'first' } });
  await h.db.transaction().execute(async (trx) => {
    const first = await registerReconDiff(trx, input, { clock });
    clock.set('2032-06-16T16:00:00.000Z');
    const again = await registerReconDiff(
      trx,
      {
        ...input,
        source: 'R1',
        refType: 'order',
        expectedFen: 2n,
        actualFen: 1n,
        diffFen: 1n,
        resolution: { evidence: 'second' },
      },
      { clock },
    );
    expect(again).toEqual(first);
    expect(await rows(trx, input.appId)).toEqual([first]);
  });
});

it('[AC-B2-04k#4] 非空 dedupe_key 跨业务键去重；已关闭差错单也不重开或覆盖处置', async () => {
  const { input, clock } = fixture({ dedupeKey: 'invariant:balance:once' });
  const first = await h.db.transaction().execute((trx) => registerReconDiff(trx, input, { clock }));
  await h.db
    .withSchema('app')
    .updateTable('recon_diffs')
    .set({ status: 'closed', closed_at: clock.now(), resolution: { reason: 'no_action' } })
    .where('id', '=', first.id)
    .execute();
  const before = await rows(h.db, input.appId);
  const again = await h.db.transaction().execute((trx) =>
    registerReconDiff(
      trx,
      {
        ...input,
        type: 'platform_restore',
        period: '2032-07',
        refId: randomUUID(),
        resolution: { reason: 'overwrite' },
      },
      { clock },
    ),
  );
  expect(again).toEqual(before[0]);
  expect(await rows(h.db, input.appId)).toEqual(before);
});

it('[AC-B2-04k#5] NULL 去重键不相互冲突；业务键各维度及 app 隔离', async () => {
  const { input, clock } = fixture();
  // B2-02zc (D10-2224 B ①): an external type, whose business key (app_id, type, period, ref_id)
  // keeps one ticket per period; unresolved ledger_mismatch is pinned by recon-diffs-unresolved.
  const base = { ...input, type: 'union_mismatch' as const };
  const inputs = [
    base,
    { ...base, type: 'platform_restore' as const },
    { ...base, period: '2032-07' },
    { ...base, refId: randomUUID() },
    { ...base, appId: `${input.appId}-other` },
  ];
  const registered = [];
  for (const request of inputs)
    registered.push(
      await h.db.transaction().execute((trx) => registerReconDiff(trx, request, { clock })),
    );
  expect(new Set(registered.map((row) => row.id)).size).toBe(5);
  expect(await rows(h.db, input.appId)).toHaveLength(4);
  const keyed = { ...input, refId: randomUUID(), dedupeKey: 'same-across-apps' };
  const a = await h.db.transaction().execute((trx) => registerReconDiff(trx, keyed, { clock }));
  const b = await h.db
    .transaction()
    .execute((trx) =>
      registerReconDiff(trx, { ...keyed, appId: `${input.appId}-other` }, { clock }),
    );
  expect(a.id).not.toBe(b.id);
  expect(b.app_id).toBe(`${input.appId}-other`);
});

it('[AC-B2-04k#6] 月末差错按 app/period 去重，不同 ref_id 仍返回原行，其他月份独立', async () => {
  const { input, clock } = fixture({
    type: 'month_end_unbalanced',
    source: 'R4',
    period: '2032-06',
  });
  const first = await h.db.transaction().execute((trx) => registerReconDiff(trx, input, { clock }));
  const again = await h.db
    .transaction()
    .execute((trx) => registerReconDiff(trx, { ...input, refId: randomUUID() }, { clock }));
  expect(again).toEqual(first);
  const next = await h.db
    .transaction()
    .execute((trx) => registerReconDiff(trx, { ...input, period: '2032-07' }, { clock }));
  expect(next.id).not.toBe(first.id);
  expect(await rows(h.db, input.appId)).toHaveLength(2);
});

it('[AC-B2-04k#7] 登记沿用调用方事务，外部不可见，回滚后可重新登记', async () => {
  const { input, clock } = fixture({ dedupeKey: 'rollback' });
  const abort = new Error('caller rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      const row = await registerReconDiff(trx, input, { clock });
      expect(await rows(trx, input.appId)).toEqual([row]);
      expect(await rows(h.reader, input.appId)).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await rows(h.db, input.appId)).toEqual([]);
  const committed = await h.db
    .transaction()
    .execute((trx) => registerReconDiff(trx, input, { clock }));
  expect(await rows(h.db, input.appId)).toEqual([committed]);
});
