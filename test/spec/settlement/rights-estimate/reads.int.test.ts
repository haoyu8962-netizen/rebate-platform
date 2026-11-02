// B2-03r · 钱包与订单页的未关闭应扣（BR-FUND-18、BR-TEXT-02；D10-483；编排方案 C）：open 只算 type=RIGHTS、
// status=SUCCEEDED、有应扣数、answered_at 为空的记录；ESTIMATED / WAITING 的 N 减 open，下限 0；CREDITED 不走这里；
// 批量读，不逐单查（一次读取对 app.order_rights 只一条语句）；app_id 进谓词。order_keys.order_id 全局唯一，
// 库里造不出两个 App 共用一个 order_id，跨 App 只能看各读各的金额与语句的 app_id。
// 这里的维权记录直接种进 order_rights，好覆盖权利命令走不到的组合。金额全部手写，见 kit.ts 头部。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { T1, TIMEOUT, databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03r#16] 无未关闭应扣的单与现在一样，读取是批量的：三单（无维权、FAILED 300、已回应 400）钱包 1275、全 App 1275、订单页各 850 / 425；钱包、全 App 与订单页各自对 order_rights 只发一条语句',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const plain = await h.estimated({ people });
    const failed = await h.estimated({ people });
    const answered = await h.estimated({ people });
    await h.rightsRow(failed, { status: 'FAILED', deductionFen: 300n });
    await h.rightsRow(answered, { deductionFen: 400n, answeredAt: new Date(T1) });
    const orders = [plain, failed, answered];

    const read = await h.tracedReads(me, orders);

    expect(read.wallet.estimated_fen).toBe(1275n);
    expect(read.wallet.estimated_total_fen).toBe(1275n);
    expect(read.totals.total_estimated_fen).toBe(1275n);
    for (const o of orders) {
      expect(read.figures.get(o.orderId)).toMatchObject({ b_est: 850n, est_rebate_fen: 425n });
    }
    expect(read.walletReads).toHaveLength(1);
    expect(read.totalsReads).toHaveLength(1);
    expect(read.figuresReads).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#17] 只有 RIGHTS 的 SUCCEEDED、有应扣数、未回应的记录算 open：FAILED、PROCESSING、WAIT_COMMISSION、已回应、PUNISH 与无应扣数的记录都不减；同一用户另一单 SUCCEEDED 400 才减，钱包 425 + 255，订单页分别 850 / 425、510 / 255',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const others = await h.estimated({ people });
    const open = await h.estimated({ people });
    await h.rightsRow(others, { status: 'FAILED', deductionFen: 300n });
    await h.rightsRow(others, { status: 'PROCESSING', deductionFen: 200n });
    await h.rightsRow(others, { status: 'WAIT_COMMISSION', deductionFen: 100n });
    await h.rightsRow(others, { deductionFen: 50n, answeredAt: new Date(T1) });
    await h.rightsRow(others, { type: 'PUNISH', deductionFen: 70n });
    await h.rightsRow(others, { deductionFen: null });
    await h.rightsRow(open, { deductionFen: 400n });

    expect((await h.walletOf(me)).estimated_fen).toBe(680n);
    const figures = await h.figuresOf(me, [others, open]);
    expect(figures.get(others.orderId)).toMatchObject({ b_est: 850n, est_rebate_fen: 425n });
    expect(figures.get(open.orderId)).toMatchObject({ b_est: 510n, est_rebate_fen: 255n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#18] 同一单的 open 相加（D10-474 ①）：两条 SUCCEEDED 300、100 → N 600；已回应的 200 不算',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated();
    await h.rightsRow(o, { deductionFen: 300n });
    await h.rightsRow(o, { deductionFen: 100n });
    await h.rightsRow(o, { deductionFen: 200n, answeredAt: new Date(T1) });

    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#19] 跨 App 不串：两个 App 各一单，A 应扣 400、B 应扣 100，各读各的：A 钱包与全 App 255、订单页 510 / 255；B 钱包与全 App 382、订单页 765 / 382；读 order_rights 的语句都按本 App 的 app_id 过滤',
  async () => {
    const a = await harness(p.db);
    const b = await harness(p.db);
    const userA = await a.user();
    const userB = await b.user();
    const orderA = await a.estimated({ people: a.ownedBy(userA) });
    const orderB = await b.estimated({ people: b.ownedBy(userB) });
    await a.rightsRow(orderA, { deductionFen: 400n });
    await b.rightsRow(orderB, { deductionFen: 100n });

    const readA = await a.tracedReads(userA, [orderA]);
    const readB = await b.tracedReads(userB, [orderB]);

    expect(readA.wallet.estimated_fen).toBe(255n);
    expect(readA.totals.total_estimated_fen).toBe(255n);
    expect(readA.figures.get(orderA.orderId)).toMatchObject({ b_est: 510n, est_rebate_fen: 255n });
    expect(readB.wallet.estimated_fen).toBe(382n);
    expect(readB.totals.total_estimated_fen).toBe(382n);
    expect(readB.figures.get(orderB.orderId)).toMatchObject({ b_est: 765n, est_rebate_fen: 382n });
    for (const [read, appId] of [
      [readA, a.appId],
      [readB, b.appId],
    ] as const) {
      for (const statements of [read.walletReads, read.totalsReads, read.figuresReads]) {
        expect(statements).toHaveLength(1);
        expect(statements[0]?.sql).toContain('app_id');
        expect(statements[0]?.parameters).toContain(appId);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#20] 有效佣金取结算优先、下限 0：结算 1000、预估 3000、open 400 → 255（不是预估 3000 − 400）；预估 300、open 400 → N 按 0，钱包这单 0，订单页 B_est 0、不显示金额',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const settled = await h.settled({ people, estFen: 3000n });
    const floored = await h.estimated({ people, estFen: 300n });
    await h.rightsRow(settled, { deductionFen: 400n });
    await h.rightsRow(floored, { deductionFen: 400n });

    const wallet = await h.walletOf(me);
    expect(wallet.pending_credit_fen).toBe(255n);
    expect(wallet.estimated_fen).toBe(0n);
    const figures = await h.figuresOf(me, [settled, floored]);
    expect(figures.get(settled.orderId)).toMatchObject({ b_est: 510n, est_rebate_fen: 255n });
    expect(figures.get(floored.orderId)).toMatchObject({ b_est: 0n, est_rebate_fen: null });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#21] CREDITED 不走这里：入账后还留着的 open 400 不减。查看者份额暂缓的 CREDITED 单订单页仍按 booked 510 → 255（不是 510 再减）；同批 WAITING 单照减到 255；钱包只计 WAITING 这单',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const held = await h.credited({ people });
    const pending = await h.waiting({ people });
    await h.heldShare(held, me);
    await h.rightsRow(held, { deductionFen: 400n });
    await h.rightsRow(pending, { deductionFen: 400n });

    const figures = await h.figuresOf(me, [held, pending]);
    expect(figures.get(held.orderId)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
      viewer_share_held: true,
    });
    expect(figures.get(pending.orderId)).toMatchObject({ b_est: 510n, est_rebate_fen: 255n });
    expect((await h.walletOf(me)).pending_credit_fen).toBe(255n);
  },
  TIMEOUT,
);
