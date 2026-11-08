// B2-09gb rule tests, out-of-date and malformed differences (claude-independent, SPEC_REF
// 29c27a1b): contracts/openapi.yaml restoreAdminReconDiff — the order named by the order_key of
// ref_id is locked; its current rebate_status is not VOID / CLAWED_BACK, or the rebate-history row by
// which it entered that status is no longer the entry_id of ref_id (it left and came back) → 20902
// data.resource=order, nothing written (the difference is ended with POST .../close); a ref_id not of
// the form `{order_key}#RESTORE#{entry_id}` or naming no order of the app → 20001 [recon_diff_id]
// reason restore_not_supported, nothing written. A difference for the current entry is still handled.
// Requests go through the real admin entry (kit.ts). Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  addRebateStep,
  diffNow,
  fixture,
  orderConflict,
  orderRow,
  platformRestored,
  refIdOf,
  refusedWith,
  seedBareOrder,
  seedClawedBack,
  seedPlatformDiff,
  suite,
  withRestoreAdmin,
  world,
  type DiffRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#17] 订单已不是 VOID / CLAWED_BACK（别处已恢复：VOID → ESTIMATED、CLAWED_BACK → CREDITED，各有返利历史）→ 20902 data.resource=order：订单、凭证、差错单、审计都不动；同一入口对仍为 VOID 的订单照常恢复', async () => {
  const f = await fixture(s);
  const voided = await seedBareOrder(f);
  const voidDiff = await seedPlatformDiff(f, voided);
  await f.db
    .updateTable('orders')
    .set({ rebate_status: 'ESTIMATED' })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', voided.orderId)
    .execute();
  await addRebateStep(f, voided.orderId, {
    from: 'VOID',
    event: 'ADMIN_RESTORE',
    to: 'ESTIMATED',
    source: 'admin',
  });
  const clawed = await seedClawedBack(f);
  const clawedDiff = await seedPlatformDiff(f, clawed);
  await f.db
    .updateTable('orders')
    .set({ rebate_status: 'CREDITED' })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', clawed.orderId)
    .execute();
  await addRebateStep(f, clawed.orderId, {
    from: 'CLAWED_BACK',
    event: 'ADMIN_RESTORE',
    to: 'CREDITED',
    source: 'admin',
  });
  const control = await seedBareOrder(f);
  const controlDiff = await seedPlatformDiff(f, control);
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of [voidDiff, clawedDiff]) {
      await orderConflict(await h.restore(diff.id));
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);
    expect((await platformRestored(await h.restore(controlDiff.id))).rebate_status_after).toBe(
      'ESTIMATED',
    );
  });
});

it('[AC-B2-09gb#18] 离开后又进入（VOID → ESTIMATED → VOID、CLAWED_BACK → CREDITED → CLAWED_BACK：进入当前状态的历史行已换）或 ref_id 的 entry_id 不是进入行 → 20902 data.resource=order，什么都不写；按新进入行登记的差错单照常处理（R12 → ESTIMATED）', async () => {
  const f = await fixture(s);
  const voided = await seedBareOrder(f);
  const oldVoidDiff = await seedPlatformDiff(f, voided);
  await addRebateStep(f, voided.orderId, {
    from: 'VOID',
    event: 'ADMIN_RESTORE',
    to: 'ESTIMATED',
    source: 'admin',
  });
  const newEntry = await addRebateStep(f, voided.orderId, {
    from: 'ESTIMATED',
    event: 'PLATFORM_INVALID',
    to: 'VOID',
  });
  const wrongEntry = await seedPlatformDiff(f, voided, {
    ref_id: refIdOf(voided.orderKey, newEntry + 1_000_000n),
    dedupe_key: null,
  });
  const clawed = await seedClawedBack(f);
  const oldClawedDiff = await seedPlatformDiff(f, clawed);
  await addRebateStep(f, clawed.orderId, {
    from: 'CLAWED_BACK',
    event: 'ADMIN_RESTORE',
    to: 'CREDITED',
    source: 'admin',
  });
  await addRebateStep(f, clawed.orderId, {
    from: 'CREDITED',
    event: 'RIGHTS_FULL',
    to: 'CLAWED_BACK',
  });
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of [oldVoidDiff, wrongEntry, oldClawedDiff]) {
      await orderConflict(await h.restore(diff.id));
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);

    const current = await seedPlatformDiff(f, { ...voided, entryId: newEntry });
    const data = await platformRestored(await h.restore(current.id));
    expect(data.rebate_status_after).toBe('ESTIMATED');
    expect((await orderRow(f, voided.orderId)).rebate_status).toBe('ESTIMATED');
  });
});

it('[AC-B2-09gb#19] ref_id 不是 `{order_key}#RESTORE#{entry_id}` 的形式（没有后缀、entry_id 为空或不是数字、分隔不是 #RESTORE#、order_key 为空），或指向本 app 没有的订单（不存在的子订单、别的 app 的订单）→ 20001 data.fields=[recon_diff_id] reason=restore_not_supported：什么都不写；同一订单形式正确的差错单照常恢复', async () => {
  const f = await fixture(s);
  const other = await fixture(s);
  const order = await seedBareOrder(f);
  const foreign = await seedBareOrder(other);
  const entry = order.entryId.toString(10);
  const refs = [
    order.orderKey,
    `${order.orderKey}#RESTORE#`,
    `${order.orderKey}#RESTORE#abc`,
    `${order.orderKey}#REFUND#${entry}`,
    `#RESTORE#${entry}`,
    refIdOf(`taobao:missing-${randomUUID()}`, order.entryId),
    refIdOf(foreign.orderKey, foreign.entryId),
  ];
  const malformed: DiffRow[] = [];
  for (const ref of refs) {
    malformed.push(await seedPlatformDiff(f, order, { ref_id: ref, dedupe_key: null }));
  }
  const good = await seedPlatformDiff(f, order);
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    const foreignBefore = await world(other);
    for (const diff of malformed) {
      await refusedWith(await h.restore(diff.id), 'restore_not_supported');
    }
    expect(await world(f)).toEqual(before);
    expect(await world(other)).toEqual(foreignBefore);
    expect((await platformRestored(await h.restore(good.id))).rebate_status_after).toBe(
      'ESTIMATED',
    );
  });
});
