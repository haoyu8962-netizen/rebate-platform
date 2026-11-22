import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { currentVersion } from '../bill/kit.ts';
import {
  databaseFixture,
  fixture,
  itemsOf,
  main,
  obligation,
  order,
  settlement,
  state,
  supplements,
  validations,
  BEFORE,
  LATER,
  LAUNCH,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// BR-FUND-04 ⑧：补充批次流程同 ④–⑦；本文件只看 ④ 校验与 ⑤ 候选入批（⑫ 补记项）。

it(
  '[AC-B2-04r#1] hold 解除、维权关闭的暂缓单进入同一账单的补充批次，按快照基数换算入批',
  async () => {
    const h = fixture(database.db);
    const held = await order(h, { hold: true });
    const rights = await order(h, { rightsPending: true });
    for (const o of [held, rights]) await settlement(h, o);
    await main(h);
    expect((await state(h)).batches).toEqual([]);
    held.fact.order.hold = false;
    rights.fact.order.rightsPending = false;
    const before = await state(h);

    const result = await h.launch();
    expect(result).toMatchObject({ outcome: 'generated', billId: MONTH, platform: 'taobao' });
    const s = await state(h);
    const batches = supplements(s);
    expect(batches).toEqual([
      expect.objectContaining({ bill_id: MONTH, platform: 'taobao', status: 'DRAFT' }),
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items).toEqual(
      expect.arrayContaining(
        [held, rights].map((o) =>
          expect.objectContaining({
            batch_id: batches[0]!.batch_id,
            item_type: 'order',
            order_id: o.id,
            settle_seq: 1,
            b_settle_fen: 850n,
          }),
        ),
      ),
    );
    expect(s.diffs).toEqual(before.diffs);
    expect(await validations(h)).toEqual(
      expect.arrayContaining(
        [held, rights].map((o) =>
          expect.objectContaining({
            billId: MONTH,
            platform: 'taobao',
            orderKey: o.key,
            result: 'candidate',
            settleSeq: 1,
          }),
        ),
      ),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#2] 账单日应结未结（只计数、不登记差错单，B2-18a）、联盟结算数据后到的订单进入补充批次',
  async () => {
    const h = fixture(database.db);
    const late = await order(h);
    await settlement(h, late, { created_at: new Date(LATER) });
    await main(h);
    const before = await state(h);
    expect(before.diffs).toEqual([]);
    expect(before.batches).toEqual([]);

    await h.launch();
    const s = await state(h);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: late.id, b_settle_fen: 850n }),
    ]);
    expect(s.diffs).toEqual(before.diffs);
    expect(await validations(h)).toEqual([
      expect.objectContaining({ orderKey: late.key, result: 'candidate', settleSeq: 1 }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#3] 金额不一致经差错结论「以联盟为准」后进入补充批次，B_settle 取联盟结算额换算',
  async () => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o, { settle_commission_fen: 2000n });
    await main(h);
    const before = await state(h);
    expect(before.diffs).toEqual([
      expect.objectContaining({ type: 'settle_amount_mismatch', ref_id: o.key, period: MONTH }),
    ]);
    o.fact.order.unionAuthoritative = true;

    await h.launch();
    const s = await state(h);
    // 联盟结算佣金 2000，预留 1500bp：B_settle = 1700，不取快照基数 850。
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: o.id, b_settle_fen: 1700n }),
    ]);
    expect(s.diffs).toEqual(before.diffs);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#4] 仍不一致的不入批且同账单同单差错不重复；补充时新发现的不一致按目标账单月登记',
  async () => {
    const h = fixture(database.db);
    const stale = await order(h);
    await settlement(h, stale, { settle_commission_fen: 2000n });
    const fresh = await order(h);
    await settlement(h, fresh, { created_at: new Date(LATER), settle_commission_fen: 9000n });
    await main(h);
    const before = await state(h);
    expect(before.diffs).toHaveLength(1);

    await h.launch();
    const s = await state(h);
    expect(s.batches).toEqual([]);
    expect(s.items).toEqual([]);
    expect(s.diffs).toHaveLength(2);
    expect(s.diffs).toEqual(expect.arrayContaining(before.diffs));
    expect(s.diffs).toContainEqual(
      expect.objectContaining({
        type: 'settle_amount_mismatch',
        ref_id: fresh.key,
        period: MONTH,
        expected_fen: 850n,
        actual_fen: 7650n,
      }),
    );
    // 差额口径以契约为准（D10-507 ②）：diff_fen = expected_fen − actual_fen，联盟多结为负。
    expect(
      s.diffs.find((d) => d.ref_id === fresh.key && d.type === 'settle_amount_mismatch')?.diff_fen,
    ).toBe(-6800n);
    expect(h.registerDiff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: h.appId, type: 'settle_amount_mismatch', refId: fresh.key }),
      expect.objectContaining({ clock: h.clock }),
    );
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: stale.key, result: 'amount_mismatch' }),
        expect.objectContaining({ orderKey: fresh.key, result: 'amount_mismatch' }),
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#5] 仍 hold 或维权中的订单记暂缓，不登记差错、不生成补充批次',
  async () => {
    const h = fixture(database.db);
    const held = await order(h, { hold: true });
    const rights = await order(h, { rightsPending: true });
    await settlement(h, held, { settle_commission_fen: 9000n });
    await main(h);
    const before = await state(h);

    expect(await h.launch()).toMatchObject({ outcome: 'generated', batchIds: [] });
    const s = await state(h);
    expect(s.batches).toEqual([]);
    expect(s.items).toEqual([]);
    expect(s.diffs).toEqual(before.diffs);
    expect(h.registerDiff).not.toHaveBeenCalled();
    expect(await validations(h)).toEqual(
      expect.arrayContaining(
        [held, rights].map((o) => expect.objectContaining({ orderKey: o.key, result: 'deferred' })),
      ),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#6] 校验截点取发起时的 Clock（含等号），不取名义请求时刻；更晚取得的结算数据不计',
  async () => {
    const h = fixture(database.db);
    await main(h);
    const requested = '2032-07-26T09:00:00+08:00';
    const atCutoff = await order(h);
    await settlement(h, atCutoff, { created_at: new Date(LAUNCH) });
    const afterRequest = await order(h);
    await settlement(h, afterRequest, { created_at: new Date('2032-07-26T09:30:00+08:00') });
    const tooLate = await order(h);
    await settlement(h, tooLate, { created_at: new Date('2032-07-26T10:00:00.001+08:00') });

    await h.launch({ requestedAt: new Date(requested) });
    expect(h.readSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appId: h.appId,
        platform: 'taobao',
        billId: MONTH,
        runAt: new Date(requested),
        generationStartedAt: new Date(LAUNCH),
      }),
    );
    const s = await state(h);
    expect(s.items.map((i) => i.order_id).sort()).toEqual([atCutoff.id, afterRequest.id].sort());
    expect(s.diffs).toEqual([]);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: atCutoff.key, result: 'candidate' }),
        expect.objectContaining({ orderKey: afterRequest.key, result: 'candidate' }),
        expect.objectContaining({
          orderKey: tooLate.key,
          result: 'missing_settlement',
          settleSeq: null,
        }),
      ]),
    );
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ billId: MONTH, runAt: new Date(requested).toISOString() }),
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#7] 范围按目标账单月：次月发起时 settle_period 晚于账单月的订单不纳入，早于的有数据才纳入',
  async () => {
    const h = fixture(database.db);
    await main(h);
    h.clock.set('2032-08-02T10:00:00+08:00');
    const current = await order(h);
    const older = await order(h, { settlePeriod: '2032-05' });
    const next = await order(h, { settlePeriod: '2032-07' });
    for (const o of [current, older, next]) {
      await settlement(h, o, { created_at: new Date(LATER) });
    }
    const missing = await order(h);
    const olderMissing = await order(h, { settlePeriod: '2032-05' });
    const nextMissing = await order(h, { settlePeriod: '2032-07' });

    await h.launch({ requestedAt: new Date('2032-08-02T10:00:00+08:00') });
    const s = await state(h);
    expect(supplements(s).map((b) => b.bill_id)).toEqual([MONTH]);
    expect(s.items.map((i) => i.order_id).sort()).toEqual([current.id, older.id].sort());
    expect(s.diffs).toEqual([]);
    const seen = (await validations(h)).map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [current.key, 'candidate'],
        [older.key, 'candidate'],
        [missing.key, 'missing_settlement'],
      ].sort(),
    );
    for (const o of [next, olderMissing, nextMissing]) {
      expect(s.items.some((i) => i.order_id === o.id)).toBe(false);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#8] 已入账订单不再作为子订单行；其未完成义务生成补记项，沿用同一 beneficiary_credit_id',
  async () => {
    const h = fixture(database.db);
    const paid = await order(h);
    await settlement(h, paid);
    const credited = await order(h, { rebateStatus: 'CREDITED' });
    await settlement(h, credited, { seq: 3 });
    const credit = await obligation(h, credited);
    await main(h);
    const first = await state(h);
    expect(itemsOf(first, first.batches)).toContainEqual(
      expect.objectContaining({
        item_type: 'beneficiary',
        beneficiary_credit_id: credit.beneficiary_credit_id,
      }),
    );
    // 首批执行后该单已入账（执行归 B2-04p；这里只改来源端口的事实）。
    paid.fact.order.rebateStatus = 'CREDITED';

    await h.launch();
    const s = await state(h);
    const batches = supplements(s);
    expect(batches).toEqual([expect.objectContaining({ status: 'DRAFT', platform: 'taobao' })]);
    expect(itemsOf(s, batches)).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: credited.id,
        user_id: credit.user_id,
        role: credit.role,
        beneficiary_credit_id: credit.beneficiary_credit_id,
        settle_seq: 3,
        b_settle_fen: null,
        amount_fen: null,
        result: null,
      }),
    ]);
    expect(s.obligations).toEqual(first.obligations);
    expect(s.vouchers).toEqual(first.vouchers);
    expect(s.balances).toEqual(first.balances);
    expect(await validations(h)).toEqual(
      expect.arrayContaining(
        [paid, credited].map((o) =>
          expect.objectContaining({ orderKey: o.key, result: 'already_credited' }),
        ),
      ),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#9] 只校验发起的平台：另一平台的订单与义务不进本次补充批次，另一 app 不受影响',
  async () => {
    const h = fixture(database.db);
    const taobao = await order(h, { hold: true });
    const jd = await order(h, { hold: true }, 'jd');
    const jdCredited = await order(h, { rebateStatus: 'CREDITED' }, 'jd');
    for (const o of [taobao, jd, jdCredited]) await settlement(h, o);
    await obligation(h, jdCredited);
    const other = fixture(database.db);
    const otherOrder = await order(other, { hold: true });
    await settlement(other, otherOrder);
    await main(other);
    otherOrder.fact.order.hold = false;
    const untouched = await state(other);
    await main(h, ['taobao', 'jd']);
    const jdBefore = (await state(h)).batches.filter((b) => b.platform === 'jd');
    taobao.fact.order.hold = false;
    jd.fact.order.hold = false;

    await h.launch();
    const s = await state(h);
    const batches = supplements(s);
    expect(batches.map((b) => b.platform)).toEqual(['taobao']);
    expect(itemsOf(s, batches)).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: taobao.id }),
    ]);
    expect(s.batches.filter((b) => b.platform === 'jd')).toEqual(jdBefore);
    for (const call of h.readSource.mock.calls) {
      expect(call[1]).toMatchObject({ appId: h.appId, platform: 'taobao' });
    }
    expect((await validations(h)).map((v) => v.orderKey)).toEqual([taobao.key]);
    expect(await state(other)).toEqual(untouched);
  },
  TIMEOUT,
);

it.each([
  { label: 'ESTIMATED', rebateStatus: 'ESTIMATED' },
  { label: 'VOID', rebateStatus: 'VOID' },
  { label: 'CLAWED_BACK', rebateStatus: 'CLAWED_BACK' },
  { label: '我方无单', rebateStatus: null },
] as const)(
  '[AC-B2-04r#26] 补充校验遇联盟后到结算而我方 $label：登记 union_mismatch，不入批',
  async ({ rebateStatus }) => {
    const h = fixture(database.db);
    const released = await order(h, { hold: true });
    await settlement(h, released);
    let key = 'taobao:synthetic-orphan-late';
    if (rebateStatus === null) {
      h.orphans.push({
        orderKey: key,
        order: null,
        settlements: [
          {
            seq: 1,
            source: 'STATEMENT',
            createdAt: new Date(LATER),
            settledAt: new Date(BEFORE),
            commissionFen: 1000n,
          },
        ],
      });
    } else {
      const o = await order(h, { rebateStatus });
      await settlement(h, o, { created_at: new Date(LATER) });
      key = o.key;
    }
    // 联盟结算数据晚于账单日截点取得：账单日任务看不到它，不登记差错。
    await main(h);
    const before = await state(h);
    expect(before.diffs).toEqual([]);
    released.fact.order.hold = false;

    await h.launch();
    const s = await state(h);
    // BR-FUND-04 ④ 沿用 BR-FUND-09 R1：联盟有结算、我方状态异常或无单，登记 union_mismatch，
    // 账期为目标账单月（断言口径同 [AC-B2-04n#13]、[AC-B2-04n#14]）。
    expect(s.diffs).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: key, period: MONTH }),
    ]);
    expect(h.registerDiff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: h.appId, type: 'union_mismatch', refId: key }),
      expect.objectContaining({ clock: h.clock }),
    );
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: released.id }),
    ]);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: key, result: 'unexpected_settlement', settleSeq: 1 }),
        expect.objectContaining({ orderKey: released.key, result: 'candidate' }),
      ]),
    );
    expect(s.vouchers).toEqual(before.vouchers);
    expect(s.balances).toEqual(before.balances);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#27] 补充前已追加分佣快照 v2：按当前最大版本比对，联盟按 v2 结算的入批、不误报不一致',
  async () => {
    const h = fixture(database.db);
    const o = await order(h, { hold: true });
    await settlement(h, o, { settle_commission_fen: 2000n });
    await main(h);
    expect((await state(h)).diffs).toEqual([]);
    // 价保改价：v2 基数 1700（联盟佣金 2000，预留 1500bp）；v1 基数 850 已不是当前版本。
    await currentVersion(h, o);
    o.fact.order.hold = false;

    await h.launch();
    expect(h.readSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: h.appId, orderId: o.id, commissionVersion: 2 }),
    );
    const s = await state(h);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: o.id, b_settle_fen: 1700n }),
    ]);
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
    expect(await validations(h)).toEqual([
      expect.objectContaining({ orderKey: o.key, result: 'candidate', settleSeq: 1 }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#28] 补充前已追加分佣快照 v2：联盟仍按 v1 结算的按当前版本判不一致，不入批',
  async () => {
    const h = fixture(database.db);
    const o = await order(h, { hold: true });
    await settlement(h, o);
    await main(h);
    expect((await state(h)).diffs).toEqual([]);
    // 联盟结算佣金 1000 → B_settle 850，只与已被取代的 v1 基数一致；当前 v2 基数 1700。
    await currentVersion(h, o);
    o.fact.order.hold = false;

    await h.launch();
    const s = await state(h);
    expect(supplements(s)).toEqual([]);
    expect(s.items).toEqual([]);
    expect(s.diffs).toEqual([
      expect.objectContaining({
        type: 'settle_amount_mismatch',
        ref_id: o.key,
        period: MONTH,
        expected_fen: 1700n,
        actual_fen: 850n,
        diff_fen: 850n,
      }),
    ]);
    expect(await validations(h)).toEqual([
      expect.objectContaining({ orderKey: o.key, result: 'amount_mismatch', settleSeq: 1 }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#29] B_settle 按 BR-CALC-02 向下取整并扣淘礼金：联盟佣金 1001 不整除时仍与快照基数一致',
  async () => {
    const h = fixture(database.db);
    const plain = await order(h, { hold: true });
    const tlj = await order(h, { hold: true }, 'taobao', {
      tlj: 100n,
      base: 750n,
      amounts: [375n, 75n, 37n],
      userTotal: 487n,
      retain: 263n,
    });
    for (const o of [plain, tlj]) await settlement(h, o, { settle_commission_fen: 1001n });
    await main(h);
    expect((await state(h)).diffs).toEqual([]);
    h.readTljDeductFen.mockImplementation(async (_trx, input) => {
      return input.orderId === tlj.id ? 100n : 0n;
    });
    plain.fact.order.hold = false;
    tlj.fact.order.hold = false;

    await h.launch();
    // floor(1001 × 8500 / 10000) = floor(850.85) = 850；四舍五入得 851，与基数 850 不一致。
    // 淘礼金单：850 − 100 = 750，等于快照基数 750；漏减得 850、先减后乘得 765，都不一致。
    expect(h.readTljDeductFen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: h.appId, orderId: tlj.id, commissionVersion: 1 }),
    );
    const s = await state(h);
    const items = itemsOf(s, supplements(s));
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_type: 'order', order_id: plain.id, b_settle_fen: 850n }),
        expect.objectContaining({ item_type: 'order', order_id: tlj.id, b_settle_fen: 750n }),
      ]),
    );
    expect(s.diffs).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
    expect(await validations(h)).toEqual(
      expect.arrayContaining(
        [plain, tlj].map((o) => expect.objectContaining({ orderKey: o.key, result: 'candidate' })),
      ),
    );
  },
  TIMEOUT,
);
