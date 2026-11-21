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
} from '../supplement/kit.ts';
import { billCounts } from './kit.ts';

const database = databaseFixture(createTestDatabase);

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
