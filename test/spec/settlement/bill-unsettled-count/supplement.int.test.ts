// B2-18a：补充发起（bill/supplement）遇 missing_settlement 同样不登记差错单；补充发起不改账单的计数列，
// unsettled_count 是出账当时的快照（与 error_count 同一性质），不因补充或结算数据后到而回改。
// 应结未结的单之后有了联盟结算数据：对同一账单发起补充批次时成为候选入批，没有要关闭的差错单。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  databaseFixture,
  fixture,
  itemsOf,
  main,
  order,
  settlement,
  state,
  supplements,
  validations,
  LATER,
  MONTH,
  TIMEOUT,
  type Fixture,
  type State,
} from '../supplement/kit.ts';
import { snapshot } from '../bill/kit.ts';
import type { BillValidation } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import { billCounts, billTouches, billWrites, tracing } from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** 下一期（M+1 = 2032-07）账单：08-24 账单日、08-23 的资产快照。 */
const NEXT_MONTH = '2032-07';
const NEXT_RUN = '2032-08-24T00:01:00+08:00';
const NEXT_NOW = '2032-08-24T00:10:00+08:00';
/** M 的账单日（07-24）之后、M+1 的账单日（08-24）之前才取得的联盟结算数据。 */
const ARRIVED = '2032-08-02T10:00:00+08:00';

/** 不对 M 发起补充，直接跑 M+1 的账单日任务。 */
async function nextBill(h: Fixture) {
  await snapshot(h, '2032-08-23');
  h.clock.set(NEXT_NOW);
  h.registerDiff.mockClear();
  return h.run('taobao', new Date(NEXT_RUN));
}

/** 账单日任务交给 saveValidations 的逐单结果里，某一期账单的 [order_key, result, settle_seq]。 */
function billResults(s: State, billId: string): (string | number | null)[][] {
  return s.validations
    .map((r) => r.payload as unknown as BillValidation & { billId: string })
    .filter((v) => v.billId === billId)
    .map((v) => [v.orderKey, v.result, v.settleSeq])
    .sort();
}

/** 某一期账单的主批次。 */
function mainsOf(s: State, billId: string) {
  return s.batches.filter((b) => b.kind === 'main' && b.bill_id === billId);
}

it(
  '[AC-B2-18a#10] 补充发起遇应结未结：不登记差错单（registerDiff 未被调用），不改账单的 unsettled_count / error_count / held_count，订单仍无结算数据就仍是 missing_settlement',
  async () => {
    const h = fixture(database.db);
    const stillMissing = await order(h);
    await main(h);
    const counts = {
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    // 账单日之后新同步进来、同属账单月、同样没有结算数据的单。
    const newlyMissing = await order(h);
    const before = await state(h);
    expect(before.diffs).toEqual([]);

    const result = await h.launch();

    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH, batchIds: [] });
    expect(h.registerDiff).not.toHaveBeenCalled();
    const s = await state(h);
    expect(s.diffs).toEqual([]);
    expect(supplements(s)).toEqual([]);
    expect(s.bills).toEqual(before.bills);
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [stillMissing.key, 'missing_settlement'],
        [newlyMissing.key, 'missing_settlement'],
      ].sort(),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#11] 账单日应结未结、联盟结算数据后到：补充批次把它作为候选入批（B_settle 850），账单的 unsettled_count 不回改（仍 1），全程没有差错单可关',
  async () => {
    const h = fixture(database.db);
    const late = await order(h);
    await settlement(h, late, { created_at: new Date(LATER) });
    const missing = await order(h);
    await main(h);
    const counts = {
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const before = await state(h);
    expect(before.diffs).toEqual([]);
    expect(before.batches).toEqual([]);

    await h.launch();

    const s = await state(h);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: late.id, b_settle_fen: 850n }),
    ]);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [late.key, 'candidate'],
        [missing.key, 'missing_settlement'],
      ].sort(),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#20] 账单月 M 计过应结未结、结算数据在 M 账单日之后才到、没有对 M 发起补充：M+1 账单日任务把它收进 M+1 的主批次（B_settle 850），settle_period 仍是 M；M 账单三个计数保持出账时的值，M+1 不把它计为应结未结，两期都没有它的差错单',
  async () => {
    const h = fixture(database.db);
    const late = await order(h);
    await settlement(h, late, {
      created_at: new Date(ARRIVED),
      settled_at: new Date('2032-08-01T12:00:00+08:00'),
    });
    const stillMissing = await order(h);
    // M+1（2032-07）的单：一单 08-03 取得结算数据，一单到 M+1 账单日仍无数据。
    const julyGood = await order(h, { settlePeriod: NEXT_MONTH });
    await settlement(h, julyGood, { created_at: new Date('2032-08-03T10:00:00+08:00') });
    const julyMissing = await order(h, { settlePeriod: NEXT_MONTH });
    await main(h);
    const atBillDay = {
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId, MONTH)).toEqual(atBillDay);
    const before = await state(h);
    expect(mainsOf(before, MONTH)).toEqual([]);
    expect(before.diffs).toEqual([]);

    expect(await nextBill(h)).toMatchObject({ outcome: 'generated', billId: NEXT_MONTH });

    const s = await state(h);
    expect(await billCounts(h.db, h.appId, MONTH)).toEqual(atBillDay);
    expect(await billCounts(h.db, h.appId, NEXT_MONTH)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });
    const next = mainsOf(s, NEXT_MONTH);
    expect(next).toEqual([
      expect.objectContaining({ platform: 'taobao', status: 'DRAFT', order_count: 2 }),
    ]);
    const nextItems = itemsOf(s, next).map((i) => [i.order_id, i.settle_seq, i.b_settle_fen]);
    expect(nextItems.sort()).toEqual(
      [
        [late.id, 1, 850n],
        [julyGood.id, 1, 850n],
      ].sort(),
    );
    expect(itemsOf(s, next).every((i) => i.item_type === 'order')).toBe(true);
    expect(supplements(s)).toEqual([]);
    expect(billResults(s, NEXT_MONTH)).toEqual(
      [
        [late.key, 'candidate', 1],
        [julyGood.key, 'candidate', 1],
        [julyMissing.key, 'missing_settlement', null],
      ].sort(),
    );
    // 早于 M+1 而仍无数据的 stillMissing 不在 M+1 范围（它在 M 上计过）。
    expect(billResults(s, NEXT_MONTH).some(([key]) => key === stillMissing.key)).toBe(false);
    expect(late.fact.order.settlePeriod).toBe(MONTH);
    expect(late.fact.order.rebateStatus).toBe('WAITING');
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#21] 应结未结的单结算数据后到、已对 M 发起补充并入批且已入账：M+1 账单日任务不再把它作为子订单入批（逐单结果 already_credited），全程只有补充批次那一个明细；M 计数不回改，M+1 不计它为应结未结',
  async () => {
    const h = fixture(database.db);
    const late = await order(h);
    await settlement(h, late, { created_at: new Date(LATER) });
    await main(h);
    const atBillDay = {
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId, MONTH)).toEqual(atBillDay);

    await h.launch();
    const launched = await state(h);
    expect(itemsOf(launched, supplements(launched))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: late.id, b_settle_fen: 850n }),
    ]);
    // 补充批次执行后该单已入账（执行归 B2-04p；这里只改来源端口的事实）。
    late.fact.order.rebateStatus = 'CREDITED';

    expect(await nextBill(h)).toMatchObject({ outcome: 'generated', billId: NEXT_MONTH });

    const s = await state(h);
    expect(await billCounts(h.db, h.appId, MONTH)).toEqual(atBillDay);
    expect(await billCounts(h.db, h.appId, NEXT_MONTH)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: null,
    });
    expect(itemsOf(s, mainsOf(s, NEXT_MONTH))).toEqual([]);
    expect(s.items.filter((i) => i.order_id === late.id && i.item_type === 'order')).toEqual(
      itemsOf(launched, supplements(launched)),
    );
    expect(billResults(s, NEXT_MONTH)).toEqual([[late.key, 'already_credited', 1]]);
    expect(late.fact.order.settlePeriod).toBe(MONTH);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#23] 补充发起不写账单计数：发起期间经执行器的语句里没有任何写 settle_bills 的（unsettled_count / error_count / held_count 都不碰），账单行与三个计数一字不动；补充仍把后到的单入批、不登记差错单',
  async () => {
    const h = fixture(database.db);
    const late = await order(h);
    await settlement(h, late, { created_at: new Date(LATER) });
    const missing = await order(h);
    const held = await order(h, { hold: true });
    await settlement(h, held);
    await main(h);
    const counts = {
      error_count: 0,
      held_count: 1,
      unsettled_count: 2,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const before = await state(h);

    const traced = tracing(h.db);
    const result = await h.launch({}, traced.db);

    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH });
    expect(billTouches(traced.queries).length).toBeGreaterThan(0);
    expect(billWrites(traced.queries)).toEqual([]);
    const s = await state(h);
    expect(s.bills).toEqual(before.bills);
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: late.id, b_settle_fen: 850n }),
    ]);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [late.key, 'candidate'],
        [missing.key, 'missing_settlement'],
        [held.key, 'deferred'],
      ].sort(),
    );
  },
  TIMEOUT,
);
