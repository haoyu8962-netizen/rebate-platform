// B2-09gb rule tests, the re-check at handling time (claude-independent, SPEC_REF 29c27a1b):
// contracts/openapi.yaml restoreAdminReconDiff (after the order lock and before anything is written:
// a current platform_status INVALID → 20001 [recon_diff_id] reason restore_platform_invalid, R12 and
// R13 alike; a CLAWED_BACK order whose current effective union commission has a positive part of 0 →
// reason restore_commission_zero; restore_platform_invalid first; the difference stays open) and
// 08 BR-FUND-22 细则「处理时再核」(D10-982, D10-986). Nothing is written: no voucher, no order change,
// no obligation, no audit, the difference as it was. Once the data is valid again the same difference
// can still be handled. Requests go through the real admin entry (kit.ts). Top-level it() only.
import { expect, it } from 'vitest';
import {
  diffNow,
  fixture,
  orderRow,
  platformRestored,
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

it('[AC-B2-09gb#14] 处理时再核（R12）：VOID 订单当前 platform_status 又为 INVALID（差错单登记之后平台再报失效）→ 20001 data.fields=[recon_diff_id] reason=restore_platform_invalid：什么都不写，差错单保持 open；平台随后回到 PAID，同一张差错单再处理即恢复到 ESTIMATED', async () => {
  const f = await fixture(s);
  const order = await seedBareOrder(f, { platformStatus: 'INVALID' });
  const diff = await seedPlatformDiff(f, order, {
    resolution: {
      reason_code: 'REFUND',
      rebate_status: 'VOID',
      trigger: 'status',
      platform_status: 'PAID',
    },
  });
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    await refusedWith(await h.restore(diff.id), 'restore_platform_invalid');
    expect(await world(f)).toEqual(before);
    expect(await diffNow(f, diff.id)).toEqual(diff);

    await f.db
      .updateTable('orders')
      .set({ platform_status: 'PAID' })
      .where('app_id', '=', f.appId)
      .where('order_id', '=', order.orderId)
      .execute();
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.rebate_status_after).toBe('ESTIMATED');
    expect((await orderRow(f, order.orderId)).rebate_status).toBe('ESTIMATED');
  });
});

it('[AC-B2-09gb#15] 处理时再核（R13）：CLAWED_BACK 订单当前 platform_status 为 INVALID → restore_platform_invalid；INVALID 且有效佣金为 0 时也先报 restore_platform_invalid；什么都不写，差错单保持 open', async () => {
  const f = await fixture(s);
  const invalid = await seedClawedBack(f, { platformStatus: 'INVALID', settle: 2000n });
  const both = await seedClawedBack(f, { platformStatus: 'INVALID', settle: 0n });
  const diffs = [
    await seedPlatformDiff(f, invalid, { expected_fen: 2000n, diff_fen: 2000n }),
    await seedPlatformDiff(f, both, { expected_fen: 2000n, diff_fen: 2000n }),
  ];
  const control = await seedClawedBack(f);
  const controlDiff = await seedPlatformDiff(f, control);
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of diffs) {
      await refusedWith(await h.restore(diff.id), 'restore_platform_invalid');
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);
    // The same entry restores a valid order (the refusals are about the data, not the route).
    expect((await platformRestored(await h.restore(controlDiff.id))).restored_fen).toBe(1105);
  });
});

it('[AC-B2-09gb#16] 处理时再核（R13）：当前有效联盟佣金的正数部分为 0（结算佣金 0；结算佣金 −50；结算佣金为空而预估 0；结算佣金 0 而预估 5000——结算佣金非空只取它）→ 20001 reason=restore_commission_zero：不恢复、什么都不写、差错单保持 open；有效佣金 1 分则照常恢复（只写平台 1）', async () => {
  const f = await fixture(s);
  const zero = [
    await seedClawedBack(f, { settle: 0n, est: 5555n }),
    await seedClawedBack(f, { settle: -50n, est: 5555n }),
    await seedClawedBack(f, { settle: null, est: 0n }),
    await seedClawedBack(f, { settle: 0n, est: 5000n }),
  ];
  const diffs: DiffRow[] = [];
  for (const c of zero) {
    diffs.push(await seedPlatformDiff(f, c, { expected_fen: 1000n, diff_fen: 1000n }));
  }
  const tiny = await seedClawedBack(f, { settle: 1n });
  const tinyDiff = await seedPlatformDiff(f, tiny);
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of diffs) {
      await refusedWith(await h.restore(diff.id), 'restore_commission_zero');
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);
    for (const c of zero) expect((await orderRow(f, c.orderId)).rebate_status).toBe('CLAWED_BACK');

    const data = await platformRestored(await h.restore(tinyDiff.id));
    expect(data.restored_fen).toBe(0);
    expect(data.rebate_status_after).toBe('CREDITED');
  });
});
