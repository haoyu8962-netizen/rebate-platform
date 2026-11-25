import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  bill,
  databaseFixture,
  fixture,
  itemsOf,
  main,
  obligation,
  order,
  rejectedUnchanged,
  settlement,
  state,
  supplements,
  validations,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// BR-FUND-04 ⑨ 与「平台入账开关」表：off 时该平台不得生成批次；off → on 后对当期已生成的月结账单
// 重新校验、生成补充批次，照常人工确认（首个月结批次：08b 通过后打开开关再发起）。

it.each(['off', undefined])(
  '[AC-B2-04r#15] credit.enabled=%s 时拒绝发起补充，不写批次、校验记录、差错或任务行',
  async (enabled) => {
    const h = fixture(database.db);
    const o = await order(h, { hold: true });
    await settlement(h, o);
    const bad = await order(h);
    await settlement(h, bad, { settle_commission_fen: 9000n });
    await main(h);
    o.fact.order.hold = false;
    h.values.set('credit.enabled.taobao', enabled);
    await rejectedUnchanged(h, () => h.launch(), 'credit_disabled');
    await rejectedUnchanged(h, () => h.recheck(), 'credit_disabled');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#16] 开关 off 期间账单只留校验结果；打开后对该账单发起补充，候选与补记项入批，差错不重复',
  async () => {
    const h = fixture(database.db);
    h.values.set('credit.enabled.taobao', 'off');
    const good = await order(h);
    await settlement(h, good);
    const bad = await order(h);
    await settlement(h, bad, { settle_commission_fen: 9000n });
    const credited = await order(h, { rebateStatus: 'CREDITED' });
    await settlement(h, credited);
    const credit = await obligation(h, credited);
    await main(h);
    const before = await state(h);
    expect(before.batches).toEqual([]);
    // B2-18：开关 off 期间 bad 单金额不一致不再登记差错单。
    expect(before.diffs).toHaveLength(0);

    h.values.set('credit.enabled.taobao', 'on');
    const result = await h.launch();
    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH, platform: 'taobao' });
    const s = await state(h);
    const batches = supplements(s);
    expect(s.batches).toEqual(batches);
    expect(batches).toEqual([
      expect.objectContaining({ bill_id: MONTH, kind: 'supplement', status: 'DRAFT' }),
    ]);
    const items = itemsOf(s, batches);
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_type: 'order', order_id: good.id, b_settle_fen: 850n }),
        expect.objectContaining({
          item_type: 'beneficiary',
          order_id: credited.id,
          beneficiary_credit_id: credit.beneficiary_credit_id,
        }),
      ]),
    );
    expect(s.diffs).toEqual(before.diffs);
    expect(s.obligations).toEqual(before.obligations);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: good.key, result: 'candidate' }),
        expect.objectContaining({ orderKey: bad.key, result: 'amount_mismatch' }),
        expect.objectContaining({ orderKey: credited.key, result: 'already_credited' }),
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#17] 开关打开后的重校验取当期账单（最近一份已生成账单），不取更早的账单',
  async () => {
    const h = fixture(database.db);
    h.values.set('credit.enabled.taobao', 'off');
    await bill(h, '2032-05', true);
    const o = await order(h);
    await settlement(h, o);
    await main(h);
    expect((await state(h)).batches).toEqual([]);

    h.values.set('credit.enabled.taobao', 'on');
    const result = await h.recheck();
    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH, platform: 'taobao' });
    expect(h.readSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: h.appId, platform: 'taobao', billId: MONTH }),
    );
    expect(h.readSource).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ billId: '2032-05' }),
    );
    const s = await state(h);
    expect(supplements(s).map((b) => b.bill_id)).toEqual([MONTH]);
    expect(s.batches).toEqual(supplements(s));
    expect(itemsOf(s, s.batches)).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: o.id }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#18] 当期账单仍在出账中时重校验拒绝（bill_not_ready），不退回更早账单',
  async () => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o);
    await main(h);
    await bill(h, '2032-07', false);
    await rejectedUnchanged(h, () => h.recheck(), 'bill_not_ready');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#19] 还没有任何月结账单时重校验拒绝（bill_not_found）',
  async () => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o);
    const other = fixture(database.db);
    await settlement(other, await order(other));
    await main(other);
    await rejectedUnchanged(h, () => h.recheck(), 'bill_not_found');
  },
  TIMEOUT,
);
