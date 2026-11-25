import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createSupplementCommand } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  bill,
  databaseFixture,
  failItemWrite,
  fixture,
  itemsOf,
  main,
  order,
  rejectedUnchanged,
  settlement,
  state,
  supplements,
  LATER,
  LAUNCH,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** 本次发起键（名义请求时刻）对应的任务行。 */
function runKey<T extends { readonly run_at: Date }>(
  s: { readonly jobs: readonly T[] },
  at: string,
) {
  return s.jobs.filter((j) => j.run_at.getTime() === new Date(at).getTime());
}

it(
  '[AC-B2-04r#20] 目标账单不存在或仍在出账中时拒绝发起，不写任何东西',
  async () => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o);
    h.clock.set(LAUNCH);
    await rejectedUnchanged(h, () => h.launch(), 'bill_not_found');
    await bill(h, MONTH, false);
    await rejectedUnchanged(h, () => h.launch(), 'bill_not_ready');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#21] 同一发起键重放由数据库识别：重建服务、事实变化后也不重复生成',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    await settlement(h, a);
    await main(h);
    a.fact.order.hold = false;
    expect((await h.launch()).outcome).toBe('generated');
    const s = await state(h);
    expect(supplements(s)).toHaveLength(1);
    expect(runKey(s, LAUNCH)).toEqual([
      expect.objectContaining({ app_id: h.appId, platform: 'taobao', status: 'done' }),
    ]);

    const b = await order(h);
    await settlement(h, b, { created_at: new Date(LATER) });
    h.clock.advanceMs(60_000);
    const fresh = createSupplementCommand(h.supplementDeps);
    const replay = await fresh.launch(h.db, {
      appId: h.appId,
      billId: MONTH,
      platform: 'taobao',
      requestedAt: new Date(LAUNCH),
    });
    expect(replay).toMatchObject({ outcome: 'duplicate', billId: MONTH, platform: 'taobao' });
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#22] 换一个发起键可再发起一轮补充，前一轮批次与明细保持原样',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    await settlement(h, a);
    await main(h);
    a.fact.order.hold = false;
    const first = await h.launch();
    const s1 = await state(h);
    const round1 = supplements(s1);

    const b = await order(h);
    await settlement(h, b, { created_at: new Date(LATER) });
    const next = '2032-07-26T11:00:00+08:00';
    h.clock.set(next);
    const second = await h.launch({ requestedAt: new Date(next) });
    expect(second.outcome).toBe('generated');
    expect(second.batchIds.length).toBeGreaterThan(0);
    expect(second.batchIds.some((id) => first.batchIds.includes(id))).toBe(false);
    const s = await state(h);
    expect(s.batches.filter((x) => first.batchIds.includes(x.batch_id))).toEqual(round1);
    expect(itemsOf(s, round1)).toEqual(itemsOf(s1, round1));
    const round2 = s.batches.filter((x) => second.batchIds.includes(x.batch_id));
    expect(round2.every((x) => x.kind === 'supplement' && x.status === 'DRAFT')).toBe(true);
    expect(itemsOf(s, round2)).toContainEqual(
      expect.objectContaining({ item_type: 'order', order_id: b.id }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#23] 两个独立服务并发同键，只生成一轮补充批次与一份校验记录，PG 唯一约束兜底',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    await settlement(h, a);
    await main(h);
    a.fact.order.hold = false;
    const input = {
      appId: h.appId,
      billId: MONTH,
      platform: 'taobao',
      requestedAt: new Date(LAUNCH),
    };
    const results = await Promise.all([
      h.command.launch(h.db, input),
      createSupplementCommand(h.supplementDeps).launch(h.db, input),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'generated']);
    const s = await state(h);
    expect(supplements(s)).toHaveLength(1);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: a.id }),
    ]);
    expect(s.supplementValidations).toHaveLength(1);
    expect(runKey(s, LAUNCH)).toEqual([
      expect.objectContaining({ platform: 'taobao', status: 'done' }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#24] 明细实际写入后故障整体回滚，不留补充批次、差错或完成的任务行；同键重试可生成',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    await settlement(h, a);
    const late = await order(h);
    await settlement(h, late, { created_at: new Date(LATER), settle_commission_fen: 9000n });
    await main(h);
    a.fact.order.hold = false;
    const before = await state(h);

    await expect(h.launch({}, failItemWrite(h.db))).rejects.toThrow('injected item write failure');
    const failed = await state(h);
    expect(failed.batches).toEqual(before.batches);
    expect(failed.items).toEqual(before.items);
    expect(failed.diffs).toEqual(before.diffs);
    expect(failed.supplementValidations).toEqual([]);
    expect(runKey(failed, LAUNCH).every((j) => j.status !== 'done')).toBe(true);
    expect(failed.vouchers).toEqual(before.vouchers);
    expect(failed.balances).toEqual(before.balances);

    h.clock.advanceMs(60_000);
    expect((await h.launch()).outcome).toBe('generated');
    const s = await state(h);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: a.id }),
    ]);
    // B2-18：late 单金额不一致不再登记差错单（本夹具不注入重生成端口，按重生成失败处理）。
    expect(s.diffs).toHaveLength(before.diffs.length + 0);
    expect(s.supplementValidations).toHaveLength(2);
    expect(runKey(s, LAUNCH)).toEqual([expect.objectContaining({ status: 'done' })]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#25] 校验结果保存失败整体回滚，不留补充批次；同键重试可生成',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    await settlement(h, a);
    await main(h);
    a.fact.order.hold = false;
    const before = await state(h);
    h.supplementSaveValidations.mockRejectedValueOnce(new Error('injected validation failure'));

    await expect(h.launch()).rejects.toThrow('injected validation failure');
    const failed = await state(h);
    expect(failed.batches).toEqual(before.batches);
    expect(failed.items).toEqual(before.items);
    expect(runKey(failed, LAUNCH).every((j) => j.status !== 'done')).toBe(true);

    expect((await h.launch()).outcome).toBe('generated');
    const s = await state(h);
    expect(supplements(s)).toHaveLength(1);
    expect(s.supplementValidations).toHaveLength(1);
  },
  TIMEOUT,
);
