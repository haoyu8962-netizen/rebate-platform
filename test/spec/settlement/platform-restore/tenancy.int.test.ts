// B2-09gb rule tests, tenancy and atomicity (claude-independent, SPEC_REF 29c27a1b):
// contracts/openapi.yaml restoreAdminReconDiff (a difference of another app is 20001
// [recon_diff_id]; effects in one transaction) and apps/api AGENTS.md (app_id on every read and
// write) — another app's orders (other sub-orders of the same platform, order_keys being keyed by
// (platform, sub_order_id) across apps) and their differences are never read or written; a failure at any step (the ledger voucher, the update of the difference,
// the audit record) answers 50001 and rolls everything back — order, vouchers, balances, obligations,
// history, difference — with no idempotency record, and the same key then succeeds once. Requests go
// through the real admin entry (kit.ts, whose one-shot fault sits in the entry's database handle).
// Top-level it() only.
import { expect, it } from 'vitest';
import {
  answer,
  available,
  fixture,
  idempotencyRows,
  newKey,
  orderRow,
  platformRestored,
  seedBareOrder,
  seedClawedBack,
  seedPlatformDiff,
  suite,
  unknownDiff,
  withRestoreAdmin,
  world,
  type FaultPoint,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#23] 多租户：别的 app 有同平台另一子订单的订单（R12 的 VOID、R13 的 CLAWED_BACK）及其平台恢复差错单；本 app 处理只动本 app 的订单——别的 app 的订单、差错单、账务、审计一律不变；别的 app 的处理人拿本 app 的差错单 id → 20001 data.fields=[recon_diff_id]，本 app 什么都不变', async () => {
  const f = await fixture(s);
  const other = await fixture(s);
  const voided = await seedBareOrder(f, {
    platformStatus: 'RECEIVED',
    receivedAt: new Date('2026-10-02T00:00:00.000Z'),
  });
  // order_keys is keyed by (platform, sub_order_id) across apps: the twins are other sub-orders of
  // the same platform, so their differences carry their own ref_id.
  const voidTwin = await seedBareOrder(other, {
    platformStatus: 'RECEIVED',
    receivedAt: new Date('2026-10-02T00:00:00.000Z'),
  });
  const clawed = await seedClawedBack(f);
  const clawTwin = await seedBareOrder(other, {
    rebate: 'CLAWED_BACK',
    platformStatus: 'SETTLED',
    settle: 2000n,
  });
  expect(voidTwin.platform).toBe(voided.platform);
  expect(clawTwin.platform).toBe(clawed.platform);
  expect(voidTwin.orderKey).not.toBe(voided.orderKey);
  expect(clawTwin.orderKey).not.toBe(clawed.orderKey);
  const voidDiff = await seedPlatformDiff(f, voided);
  const clawedDiff = await seedPlatformDiff(f, clawed);
  await seedPlatformDiff(other, voidTwin);
  await seedPlatformDiff(other, clawTwin);
  const foreignBefore = await world(other);

  await withRestoreAdmin(other, async (h) => {
    const before = await world(f);
    await unknownDiff(await h.restore(voidDiff.id));
    await unknownDiff(await h.restore(clawedDiff.id));
    expect(await world(f)).toEqual(before);
  });
  await withRestoreAdmin(f, async (h) => {
    expect((await platformRestored(await h.restore(voidDiff.id))).rebate_status_after).toBe(
      'WAITING',
    );
    expect((await platformRestored(await h.restore(clawedDiff.id))).restored_fen).toBe(1105);
  });
  expect((await orderRow(f, voided.orderId)).rebate_status).toBe('WAITING');
  expect((await orderRow(f, clawed.orderId)).rebate_status).toBe('CREDITED');
  expect(await world(other)).toEqual(foreignBefore);
});

it('[AC-B2-09gb#24] 一个事务：写凭证、改差错单、写审计任一步失败 → 50001，整笔回滚（订单状态与 booked 列、凭证、余额、义务、返利历史、差错单都不变），不留幂等记录；同一 key 重发即成功且只入账一次（R13 每个失败点各一单，R12 在改差错单与审计两点各一单）', async () => {
  const f = await fixture(s);
  const r13Points: readonly FaultPoint[] = ['voucher', 'diff_update', 'audit'];
  const r12Points: readonly FaultPoint[] = ['diff_update', 'audit'];
  await withRestoreAdmin(f, async (h) => {
    for (const point of r13Points) {
      const c = await seedClawedBack(f);
      const diff = await seedPlatformDiff(f, c);
      const before = await world(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.restore(diff.id, {}, { key });
      expect(h.fault.tripped, `R13 ${point} 必须在处理事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await world(f), `R13 ${point}`).toEqual(before);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        `R13 ${point}`,
      ).toEqual([]);

      const data = await platformRestored(await h.restore(diff.id, {}, { key }));
      expect(data.restored_fen, `R13 ${point}`).toBe(1105);
      expect(await available(f, c.user('self')), `R13 ${point}`).toBe(850n);
      expect((await orderRow(f, c.orderId)).rebate_status, `R13 ${point}`).toBe('CREDITED');
    }
    for (const point of r12Points) {
      const order = await seedBareOrder(f);
      const diff = await seedPlatformDiff(f, order);
      const before = await world(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.restore(diff.id, {}, { key });
      expect(h.fault.tripped, `R12 ${point} 必须在处理事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await world(f), `R12 ${point}`).toEqual(before);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        `R12 ${point}`,
      ).toEqual([]);

      const data = await platformRestored(await h.restore(diff.id, {}, { key }));
      expect(data.rebate_status_after, `R12 ${point}`).toBe('ESTIMATED');
      expect((await orderRow(f, order.orderId)).rebate_status, `R12 ${point}`).toBe('ESTIMATED');
    }
  });
});
