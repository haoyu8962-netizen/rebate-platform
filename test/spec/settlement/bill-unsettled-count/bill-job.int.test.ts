// B2-18a：账单日任务（createBillJob，真实库表）遇 missing_settlement——BR-FUND-04 ④（2026-11-21 改写）
// 「settle_period=M、未 hold、未维权而截至生成开始仍无联盟结算数据的，只计入账单的『应结未结』数，
// 不生成差错单，订单保持 WAITING」。其余分类（金额不一致、状态不符、暂缓、候选）一律不变。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  validations,
  NOW,
  MONTH,
  TIMEOUT,
  type Fixture,
} from '../bill/kit.ts';
import { billCounts, legacyBill } from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** 本次出账以什么类型调用了 registerDiff（排序后）。 */
function diffTypes(h: Fixture): string[] {
  return h.registerDiff.mock.calls.map((call) => call[1].type).sort();
}

/** 落库的差错单 [type, ref_id]（排序后）。 */
function storedDiffs(s: Awaited<ReturnType<typeof state>>): string[][] {
  return s.diffs.map((d) => [d.type, d.ref_id]).sort();
}

it(
  '[AC-B2-18a#1] 账单日任务遇应结未结：不调 registerDiff、不登记任何差错单、不计 error_count；逐单结果仍是 missing_settlement 交给 saveValidations；订单事实不动',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const first = await order(h);
    const second = await order(h);
    const before = h.facts.map((f) => ({ ...f.order }));

    expect(await h.run()).toMatchObject({ outcome: 'generated', billId: MONTH });

    expect(h.registerDiff).not.toHaveBeenCalled();
    const s = await state(h);
    expect(s.diffs).toEqual([]);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: null,
    });
    expect(h.saveValidations).toHaveBeenCalledTimes(1);
    const saved = h.saveValidations.mock.calls[0]![2];
    expect(saved.map((v) => [v.orderKey, v.result, v.settleSeq]).sort()).toEqual(
      [
        [first.key, 'missing_settlement', null],
        [second.key, 'missing_settlement', null],
      ].sort(),
    );
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [first.key, 'missing_settlement'],
        [second.key, 'missing_settlement'],
      ].sort(),
    );
    // 订单保持 WAITING、settle_period 不变、不 hold（订单事实只经来源端口，任务不改）。
    expect(h.facts.map((f) => f.order)).toEqual(before);
    expect(h.facts.every((f) => f.order.rebateStatus === 'WAITING')).toBe(true);
    expect(s.batches).toEqual([]);
    expect(s.items).toEqual([]);
    expect(s.vouchers).toEqual([]);
    expect(s.balances).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#2] 混合账单：候选、金额不一致、应结未结、暂缓（hold 有数据、维权无数据）、状态不符各一单——error_count 只含金额不一致与状态不符（2），unsettled_count 只含应结未结（1），held_count 2，差错单恰为那两类，候选、批次、合计一分不变，amount_mismatch_count 不写',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const good = await order(h);
    await settlement(h, good);
    const bad = await order(h);
    await settlement(h, bad, { settle_commission_fen: 9000n });
    const missing = await order(h);
    const held = await order(h, { hold: true });
    await settlement(h, held);
    const rights = await order(h, { rightsPending: true });
    const voided = await order(h, { rebateStatus: 'VOID' });
    await settlement(h, voided);
    // 早于账单月而仍无数据：不在本账单范围，不计数。
    const olderMissing = await order(h, { settlePeriod: '2032-05' });

    const result = await h.run();
    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH, status: '已出账' });

    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 2,
      held_count: 2,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });
    const s = await state(h);
    expect(storedDiffs(s)).toEqual(
      [
        ['settle_amount_mismatch', bad.key],
        ['union_mismatch', voided.key],
      ].sort(),
    );
    expect(s.diffs).toContainEqual(
      expect.objectContaining({
        type: 'settle_amount_mismatch',
        ref_id: bad.key,
        period: MONTH,
        expected_fen: 850n,
        actual_fen: 7650n,
      }),
    );
    expect(s.diffs).toContainEqual(
      expect.objectContaining({
        type: 'union_mismatch',
        ref_id: voided.key,
        period: MONTH,
        expected_fen: 0n,
        actual_fen: 1000n,
      }),
    );
    expect(diffTypes(h)).toEqual(['settle_amount_mismatch', 'union_mismatch']);
    expect(s.batches).toEqual([
      expect.objectContaining({
        platform: 'taobao',
        kind: 'main',
        status: 'DRAFT',
        order_count: 1,
      }),
    ]);
    expect(s.items).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: good.id, b_settle_fen: 850n }),
    ]);
    expect(s.bills).toEqual([
      expect.objectContaining({
        bill_id: MONTH,
        platform_order_counts: { taobao: 1 },
        platform_settle_commission_totals: { taobao: '1000' },
        beneficiary_total_fen: 552n,
        platform_retained_fen: 298n,
        error_count: 2,
        held_count: 2,
      }),
    ]);
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [good.key, 'candidate'],
        [bad.key, 'amount_mismatch'],
        [missing.key, 'missing_settlement'],
        [held.key, 'deferred'],
        [rights.key, 'deferred'],
        [voided.key, 'unexpected_settlement'],
      ].sort(),
    );
    expect(seen.some(([key]) => key === olderMissing.key)).toBe(false);
    expect(s.vouchers).toEqual([]);
    expect(s.balances).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#3] 入账开关关着的平台照样计应结未结：credit.enabled.taobao=off、jd 未设，两平台按平台累加进同一账单，不生成批次、不登记差错单',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    h.values.set('credit.enabled.taobao', 'off');
    h.values.delete('credit.enabled.jd');
    await order(h);
    await order(h, {}, 'jd');
    await order(h, {}, 'jd');

    expect((await h.run('taobao')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });
    expect((await h.run('jd')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 3,
      amount_mismatch_count: null,
    });
    const s = await state(h);
    expect(s.bills).toEqual([
      expect.objectContaining({ platform_order_counts: { taobao: 0, jd: 0 } }),
    ]);
    expect(s.batches).toEqual([]);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#4] 各平台任务在账单行上串行、按平台累加：淘宝 1 单、京东 2 单应结未结并发出账 → unsettled_count 3，error_count 只含京东金额不一致 1 单',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    await order(h);
    await order(h, {}, 'jd');
    await order(h, {}, 'jd');
    const jdBad = await order(h, {}, 'jd');
    await settlement(h, jdBad, { settle_commission_fen: 9000n });

    const results = await Promise.all([h.run('taobao'), h.run('jd')]);
    expect(results.map((r) => r.outcome)).toEqual(['generated', 'generated']);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 1,
      held_count: 0,
      unsettled_count: 3,
      amount_mismatch_count: null,
    });
    const s = await state(h);
    expect(storedDiffs(s)).toEqual([['settle_amount_mismatch', jdBad.key]]);
    expect(diffTypes(h)).toEqual(['settle_amount_mismatch']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#5] 迁移前已有的账单行（新列为 NULL）读取不报错、按 0 起累加：另一平台已出账的行上淘宝 2 单应结未结 → unsettled_count 2，error_count、held_count 照原值累加',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    await legacyBill(h.db, h.appId, {
      platformOrderCounts: { jd: 0 },
      platformCommissionTotals: { jd: '0' },
      errorCount: 3,
      heldCount: 1,
    });
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 3,
      held_count: 1,
      unsettled_count: null,
      amount_mismatch_count: null,
    });
    await order(h);
    await order(h);
    const held = await order(h, { hold: true });

    expect((await h.run('taobao')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 3,
      held_count: 2,
      unsettled_count: 2,
      amount_mismatch_count: null,
    });
    expect((await state(h)).bills).toEqual([
      expect.objectContaining({ platform_order_counts: { jd: 0, taobao: 0 } }),
    ]);
    const heldResult = (await validations(h)).find((v) => v.orderKey === held.key);
    expect(heldResult?.result).toBe('deferred');
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#6] 范围边界照旧：只有 settle_period 等于账单月才计；早于账单月仍无数据的不在本账单、不计；晚于账单月排除；截点取生成开始时刻（含等号），之后才取得的结算数据不算有数据',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const atCutoff = await order(h);
    await settlement(h, atCutoff, { created_at: new Date(NOW) });
    const late = await order(h);
    await settlement(h, late, { created_at: new Date('2032-07-24T00:10:00.001+08:00') });
    const plain = await order(h);
    const olderMissing = await order(h, { settlePeriod: '2032-05' });
    const futureMissing = await order(h, { settlePeriod: '2032-07' });

    await h.run();

    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: null,
    });
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result, v.settleSeq]).sort();
    expect(seen).toEqual(
      [
        [atCutoff.key, 'candidate', 1],
        [late.key, 'missing_settlement', null],
        [plain.key, 'missing_settlement', null],
      ].sort(),
    );
    const s = await state(h);
    expect(s.items).toEqual([expect.objectContaining({ order_id: atCutoff.id })]);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
    for (const o of [olderMissing, futureMissing]) {
      expect(seen.some(([key]) => key === o.key)).toBe(false);
    }
  },
  TIMEOUT,
);
