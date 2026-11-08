// B2-09gb rule tests, R12 (claude-independent, SPEC_REF 29c27a1b): contracts/openapi.yaml
// restoreAdminReconDiff, effects of a platform_restore on a VOID order, and 08 BR-FUND-22 R12 —
// the order returns, by its current platform_status, to ESTIMATED (DEPOSIT_PAID / PAID) or WAITING
// (RECEIVED / SETTLED, settle_period from received_at in China time; without received_at back to
// ESTIMATED, the contract's default); an order without user_id returns to UNATTRIBUTED; no ledger
// entry, restored_fen 0; the difference adjusted with resolution.restore and the trimmed note; audit
// recon_diff_restore; the response carries rebate_status_after; the transition is one CAS
// (row_version + 1) with exactly one history row (VOID → target, ADMIN_RESTORE, source admin).
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  DETAIL_KEYS,
  RESTORE_ACTION,
  audits,
  detailView,
  expectAdjusted,
  expectRestoreStep,
  fixture,
  orderHistory,
  orderRow,
  platformRestored,
  seedBareOrder,
  seedPlatformDiff,
  suite,
  text,
  untouched,
  withRestoreAdmin,
  world,
  type PlatformStatus,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#1] R12：VOID 按当前 platform_status 回到 ESTIMATED（DEPOSIT_PAID / PAID）或 WAITING（RECEIVED / SETTLED，settle_period 按 received_at 的中国时间月份：09-30T17:00Z → 2026-10，08-31T16:30Z → 2026-09）；应答 restored_fen 0、rebate_status_after 为新状态、recon_diff 为处理后的详情；不写任何凭证与分录、余额不变；订单其余列不动；经状态机迁移：row_version + 1、返利状态历史恰新增一行（VOID → 新状态、ADMIN_RESTORE、来源 admin）', async () => {
  const f = await fixture(s);
  const cases: readonly {
    readonly platformStatus: PlatformStatus;
    readonly receivedAt: Date | null;
    readonly after: string;
    readonly period: string | null;
  }[] = [
    { platformStatus: 'PAID', receivedAt: null, after: 'ESTIMATED', period: null },
    { platformStatus: 'DEPOSIT_PAID', receivedAt: null, after: 'ESTIMATED', period: null },
    {
      platformStatus: 'RECEIVED',
      receivedAt: new Date('2026-09-30T17:00:00.000Z'),
      after: 'WAITING',
      period: '2026-10',
    },
    {
      platformStatus: 'SETTLED',
      receivedAt: new Date('2026-08-31T16:30:00.000Z'),
      after: 'WAITING',
      period: '2026-09',
    },
  ];
  await withRestoreAdmin(f, async (h) => {
    for (const c of cases) {
      const order = await seedBareOrder(f, {
        platformStatus: c.platformStatus,
        receivedAt: c.receivedAt,
      });
      const diff = await seedPlatformDiff(f, order);
      const orderBefore = await orderRow(f, order.orderId);
      const historyBefore = await orderHistory(f, order.orderId);
      const before = await world(f);

      const sent = await h.restore(diff.id);
      const data = await platformRestored(sent);
      expect(data.restored_fen, c.platformStatus).toBe(0);
      expect(data.rebate_status_after, c.platformStatus).toBe(c.after);
      const { row } = await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'VOID',
        to: c.after,
        restoredFen: 0n,
      });
      expect(Object.keys(data.recon_diff).sort(), sent.body).toEqual(DETAIL_KEYS);
      expect(data.recon_diff, sent.body).toEqual(detailView(row));

      const now = await orderRow(f, order.orderId);
      expect(now.rebate_status, c.platformStatus).toBe(c.after);
      expect(now.settle_period, c.platformStatus).toBe(c.period);
      expect(untouched(now), c.platformStatus).toEqual(untouched(orderBefore));
      expect(now.booked_base_fen).toBeNull();
      expect(now.booked_n_fen).toBeNull();
      await expectRestoreStep(
        f,
        { order: orderBefore, history: historyBefore },
        { from: 'VOID', to: c.after },
      );

      const after = await world(f);
      expect(after.vouchers, c.platformStatus).toEqual(before.vouchers);
      expect(after.entries, c.platformStatus).toEqual(before.entries);
      expect(after.balances, c.platformStatus).toEqual(before.balances);
      expect(after.obligations, c.platformStatus).toEqual(before.obligations);
    }
  });
});

it('[AC-B2-09gb#2] R12：user_id 为空（未归因）的 VOID 回到 UNATTRIBUTED（未归因池，BR-ATTR-16），不论 platform_status 是 PAID 还是 SETTLED；不写凭证；user_id 仍为空；row_version + 1、历史恰新增 VOID → UNATTRIBUTED（ADMIN_RESTORE、admin）一行', async () => {
  const f = await fixture(s);
  await withRestoreAdmin(f, async (h) => {
    for (const platformStatus of ['PAID', 'SETTLED'] as const) {
      const order = await seedBareOrder(f, {
        userId: null,
        platformStatus,
        receivedAt: platformStatus === 'SETTLED' ? new Date('2026-09-15T00:00:00.000Z') : null,
      });
      const diff = await seedPlatformDiff(f, order);
      const orderBefore = await orderRow(f, order.orderId);
      const historyBefore = await orderHistory(f, order.orderId);
      const before = await world(f);
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after, platformStatus).toBe('UNATTRIBUTED');
      expect(data.restored_fen, platformStatus).toBe(0);
      await expectAdjusted(f, diff, {
        adminId: h.operator.id,
        from: 'VOID',
        to: 'UNATTRIBUTED',
        restoredFen: 0n,
      });
      const now = await orderRow(f, order.orderId);
      expect(now.rebate_status, platformStatus).toBe('UNATTRIBUTED');
      expect(now.user_id, platformStatus).toBeNull();
      await expectRestoreStep(
        f,
        { order: orderBefore, history: historyBefore },
        { from: 'VOID', to: 'UNATTRIBUTED' },
      );
      const after = await world(f);
      expect(after.vouchers, platformStatus).toEqual(before.vouchers);
      expect(after.balances, platformStatus).toEqual(before.balances);
    }
  });
});

it('[AC-B2-09gb#3] R12（契约默认）：platform_status 为 RECEIVED 但没有 received_at → 回到 ESTIMATED（之后照 R4 走），settle_period 仍为空，不写凭证', async () => {
  const f = await fixture(s);
  const order = await seedBareOrder(f, { platformStatus: 'RECEIVED', receivedAt: null });
  const diff = await seedPlatformDiff(f, order);
  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.rebate_status_after).toBe('ESTIMATED');
    const now = await orderRow(f, order.orderId);
    expect(now.rebate_status).toBe('ESTIMATED');
    expect(now.settle_period).toBeNull();
    expect((await world(f)).vouchers).toEqual(before.vouchers);
  });
});

it('[AC-B2-09gb#4] R12 结案：差错单 adjusted、handler_id 为处理人、closed_at = updated_at = 服务端时钟，expected_fen / actual_fen / diff_fen 按登记不变；resolution 保留原键（reason_code、rebate_status、trigger、platform_status）并加 restore（rebate_status_before VOID、rebate_status_after WAITING、beneficiaries 空、platform_fen 与 restored_fen 为 "0"、operator、restored_at）与去空白的 note；审计 recon_diff_restore 一条：处理人、目标差错单，前后 status、order_key、返利状态前后与 restored_fen 0', async () => {
  const f = await fixture(s);
  const order = await seedBareOrder(f, {
    platformStatus: 'RECEIVED',
    receivedAt: new Date('2026-10-02T03:00:00.000Z'),
  });
  const diff = await seedPlatformDiff(f, order, { expected_fen: 800n, diff_fen: 800n });
  await withRestoreAdmin(f, async (h) => {
    const note = '\t 买家撤销退款，核对后恢复  \n';
    const data = await platformRestored(await h.restore(diff.id, { note }));
    expect(data.rebate_status_after).toBe('WAITING');
    const { row, restore } = await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'VOID',
      to: 'WAITING',
      restoredFen: 0n,
      note: note.trim(),
    });
    expect(row.expected_fen).toBe(800n);
    expect(row.actual_fen).toBe(0n);
    expect(row.diff_fen).toBe(800n);
    expect(restore['beneficiaries']).toEqual([]);
    expect(restore['platform_fen']).toBe('0');

    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(h.operator.id);
    expect(record.target).toBe(diff.id);
    const before = text(record.before);
    const after = text(record.after);
    expect(before).toContain('"open"');
    expect(after).toContain('"adjusted"');
    const both = `${before}${after}`;
    expect(both).toContain(order.orderKey);
    expect(both).toContain('"VOID"');
    expect(both).toContain('"WAITING"');
    expect(after).toMatch(/"restored_fen":"?0"?[,}]/);
  });
});
