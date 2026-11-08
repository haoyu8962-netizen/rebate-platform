// B1-09v: a punish import (违规单导入) with the manual sub-reason, end to end — the upload through the
// real admin entry, its rights_import job on the worker's real order-sync handler, settlement's real
// rights command, rebate port (R6 VOID before credit) and clawback (R8 after credit). 08 BR-TEXT-05
// 子原因 写入来源 ②: the manual choice replaces the automatic mapping for the orders the import marks
// PUNISH and counts as chosen by hand (orders.reason_sub_manual), so nothing automatic overwrites it;
// `none` writes no sub-reason; not sent, the automatic mapping decides as before. Migration 0131:
// order_rights.reason_sub is NULL while reason_sub_manual is false. The templates are synthetic
// (../rights-mounts/templates.ts), injected over the real job. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  NONE,
  available,
  attributedOrder,
  creditedOrder,
  detailOf,
  expectManual,
  importPunish,
  importRow,
  imported,
  listItem,
  manualOf,
  orderNow,
  rightsOfOrder,
  rightsRows,
  setup,
  shareImportStore,
  worker,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(['FAKE_TRADE', 'VIOLATION_PROMO', 'PUNISH_ORDER'] as const)(
  '[AC-B1-09v#1] 违规单导入带 reason_sub=%s：rights_imports 存下、详情与列表回显；该导入写出的每条 order_rights 带同一值且 reason_sub_manual=true；入账前的订单经真实 rebate 作废（VOID、原因 PUNISH）时 orders.reason_sub 为该值、reason_sub_manual=true',
  async (reasonSub) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await worker(h);
    const first = await attributedOrder(s);
    const second = await attributedOrder(s);

    const importId = await importPunish(
      s,
      w,
      'jd',
      [first.sub_order_id, second.sub_order_id],
      reasonSub,
    );

    expect((await importRow(s, importId))?.reason_sub).toBe(reasonSub);
    expect(await detailOf(s, importId)).toMatchObject({
      import_id: importId,
      kind: 'punish',
      status: 'done',
      succeeded_rows: 2,
      failed_rows: 0,
      reason_sub: reasonSub,
    });
    expect(await listItem(s, importId)).toMatchObject({
      import_id: importId,
      reason_sub: reasonSub,
    });

    for (const order of [first, second]) {
      const rows = await rightsOfOrder(s, order.order_id);
      const seen = rows.map((row) => ({ type: row.type, status: row.status, ...manualOf(row) }));
      expect(seen).toEqual([
        { type: 'PUNISH', status: 'SUCCEEDED', reason_sub: reasonSub, reason_sub_manual: true },
      ]);
      expect(await orderNow(s, order.order_id)).toMatchObject({
        rebate_status: 'VOID',
        reason: 'PUNISH',
        reason_sub: reasonSub,
        reason_sub_manual: true,
      });
    }
  },
  120_000,
);

it('[AC-B1-09v#1] 已入账订单的违规单导入带 reason_sub=SHOP_TK：经真实扣回（R8）落 CLAWED_BACK、原因 PUNISH 时 orders.reason_sub=SHOP_TK、reason_sub_manual=true；扣回金额照旧（余额归零），子原因不改金额', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const c = await creditedOrder(s, w);
  expect([await available(s, c.self), await available(s, c.direct)]).toEqual([425n, 85n]);

  const importId = await importPunish(s, w, 'taobao', [c.order.sub_order_id], 'SHOP_TK');

  expect((await importRow(s, importId))?.reason_sub).toBe('SHOP_TK');
  expect((await rightsOfOrder(s, c.order.order_id)).map(manualOf)).toEqual([
    { reason_sub: 'SHOP_TK', reason_sub_manual: true },
  ]);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'PUNISH',
    reason_sub: 'SHOP_TK',
    reason_sub_manual: true,
    booked_base_fen: 0n,
    booked_n_fen: 0n,
  });
  expect([
    await available(s, c.self),
    await available(s, c.direct),
    await available(s, c.indirect),
  ]).toEqual([0n, 0n, 0n]);
}, 120_000);

it('[AC-B1-09v#2] 违规单导入带 reason_sub=none（「无」）：rights_imports 存 none、详情与列表回显 none；order_rights reason_sub_manual=true、reason_sub 不写子原因（NULL，或照 0131 CHECK 存 none）；订单作废后 orders.reason_sub 为 NULL、reason_sub_manual=true', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const order = await attributedOrder(s);

  const importId = await importPunish(s, w, 'jd', [order.sub_order_id], NONE);

  expect((await importRow(s, importId))?.reason_sub).toBe(NONE);
  expect(await detailOf(s, importId)).toMatchObject({ status: 'done', reason_sub: NONE });
  expect(await listItem(s, importId)).toMatchObject({ import_id: importId, reason_sub: NONE });

  const rows = await rightsOfOrder(s, order.order_id);
  expect(rows.map((row) => row.reason_sub_manual)).toEqual([true]);
  expect([null, NONE]).toContain(rows[0]?.reason_sub);
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub: null,
    reason_sub_manual: true,
  });
}, 120_000);

it('[AC-B1-09v#2] 已入账订单的违规单导入带 reason_sub=none：扣回落 CLAWED_BACK 后 orders.reason_sub 为 NULL、reason_sub_manual=true', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const c = await creditedOrder(s, w);

  await importPunish(s, w, 'taobao', [c.order.sub_order_id], NONE);

  expect((await rightsOfOrder(s, c.order.order_id)).map((row) => row.reason_sub_manual)).toEqual([
    true,
  ]);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'PUNISH',
    reason_sub: null,
    reason_sub_manual: true,
  });
}, 120_000);

it('[AC-B1-09v#3] 违规单导入不传 reason_sub：rights_imports.reason_sub 为 NULL，详情与列表回显 null；order_rights reason_sub_manual=false、reason_sub NULL；订单作废后 orders.reason_sub_manual 仍 false（交给自动映射）', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const order = await attributedOrder(s);

  const importId = await importPunish(s, w, 'jd', [order.sub_order_id]);

  expect((await importRow(s, importId))?.reason_sub).toBeNull();
  const detail = await detailOf(s, importId);
  expect(detail).toMatchObject({ status: 'done', succeeded_rows: 1 });
  expect(detail).toHaveProperty('reason_sub', null);
  expect(await listItem(s, importId)).toHaveProperty('reason_sub', null);

  expect((await rightsOfOrder(s, order.order_id)).map(manualOf)).toEqual([
    { reason_sub: null, reason_sub_manual: false },
  ]);
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub_manual: false,
  });
}, 120_000);

it.each(['FAKE_TRADE', NONE] as const)(
  '[AC-B1-09v#4] 导入人工选 %s 之后，同一订单再经真实导入任务到来的违规单（不传 reason_sub，交自动映射）与维权单：orders.reason_sub 不变、reason_sub_manual 仍 true；后来的记录 reason_sub_manual=false',
  async (reasonSub) => {
    shareImportStore();
    const s = await setup(h, { grants: CLAIM });
    const w = await worker(h);
    const order = await attributedOrder(s);
    const kept = reasonSub === NONE ? null : reasonSub;

    await importPunish(s, w, 'jd', [order.sub_order_id], reasonSub, ['PN-1']);
    await expectManual(s, order.order_id, kept, true);

    await importPunish(s, w, 'jd', [order.sub_order_id], undefined, ['PN-2']);
    const rights = rightsRows([order.sub_order_id], '12.00');
    await imported(s, w, { kind: 'rights', platform: 'jd' }, rights);

    await expectManual(s, order.order_id, kept, true);
    const rows = await rightsOfOrder(s, order.order_id);
    expect(
      rows.map((row) => [row.type, row.platform_rights_no, row.reason_sub_manual]).sort(),
    ).toEqual(
      [
        ['PUNISH', 'PN-1', true],
        ['PUNISH', 'PN-2', false],
        ['RIGHTS', 'RN-1', false],
      ].sort(),
    );
    expect(await orderNow(s, order.order_id)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'PUNISH',
    });
  },
  120_000,
);

it('[AC-B1-09v#4] 已入账订单导入人工选 RISK_ORDER 扣回后，同一订单再来一张不带 reason_sub 的违规单：orders.reason_sub 仍 RISK_ORDER、reason_sub_manual 仍 true，不再扣回', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const c = await creditedOrder(s, w);

  await importPunish(s, w, 'taobao', [c.order.sub_order_id], 'RISK_ORDER', ['PN-1']);
  await expectManual(s, c.order.order_id, 'RISK_ORDER', true);
  const balances = [await available(s, c.self), await available(s, c.direct)];

  await importPunish(s, w, 'taobao', [c.order.sub_order_id], undefined, ['PN-2']);

  await expectManual(s, c.order.order_id, 'RISK_ORDER', true);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'PUNISH',
  });
  expect([await available(s, c.self), await available(s, c.direct)]).toEqual(balances);
}, 120_000);
