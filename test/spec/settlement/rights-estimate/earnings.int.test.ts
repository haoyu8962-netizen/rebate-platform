// B2-03r · 收益看板（BR-FUND-25：份额算法同 BR-FUND-18；编排裁定 reads/earnings.ts 进本单）：ESTIMATED / WAITING 的
// N 同样减未关闭应扣，下限 0，要与钱包、订单页同数；open 的口径与 reads.int.test.ts 相同；CREDITED 的预估仍是 0；
// 批量读，不逐单查：只读本人栏时对 app.order_rights 一条语句，连邀请栏最多两条。金额全部手写，见 kit.ts 头部。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { PAID, T1, T2, T3, TIMEOUT, databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The estimates of the rows, order-independent: the rows carry no order id. */
function estimates(rows: readonly { readonly estFen: bigint }[]): string[] {
  return rows.map((row) => String(row.estFen)).sort();
}

it.each([{ state: 'ESTIMATED' }, { state: 'WAITING' }] as const)(
  '[AC-B2-03r#31] $state 单 R7（est 1000，应扣 400）：看板本人栏 255，与钱包、订单页同数；邀请栏直推 51、间推 25',
  async ({ state }) => {
    const h = await harness(p.db);
    const spec = { patch: PAID };
    const o = state === 'ESTIMATED' ? await h.estimated(spec) : await h.waiting(spec);

    await h.deduct(o, 400n);

    const board = await h.earningsOf(o.user('self'));
    expect(estimates(board.own)).toEqual(['255']);
    expect((await h.walletOf(o.user('self'))).estimated_total_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({ est_rebate_fen: 255n });
    expect(estimates((await h.earningsOf(o.user('direct'))).referral)).toEqual(['51']);
    expect(estimates((await h.earningsOf(o.user('indirect'))).referral)).toEqual(['25']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#32] D10-474 ① 累计、D10-483 不重复扣：应扣 400 再 100，看板 212；联盟回传 500 后仍 212（不是 500 再减 500 成 0）；邀请栏直推 42',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated({ patch: PAID });

    await h.deduct(o, 400n, 'rights-1', T1);
    await h.deduct(o, 100n, 'rights-2', T2);

    expect(estimates((await h.earningsOf(o.user('self'))).own)).toEqual(['212']);

    await h.unionSync(o, { estAfter: 500n, at: T3 });

    expect(estimates((await h.earningsOf(o.user('self'))).own)).toEqual(['212']);
    expect(estimates((await h.earningsOf(o.user('direct'))).referral)).toEqual(['42']);
    expect((await h.walletOf(o.user('self'))).estimated_fen).toBe(212n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#33] 无未关闭应扣的单与现在一样，读取是批量的：三单（无维权、FAILED 300、已回应 400）看板各 425；只读本人栏对 order_rights 一条语句，连邀请栏最多两条',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    await h.estimated({ people, patch: PAID });
    const failed = await h.estimated({ people, patch: PAID });
    const answered = await h.estimated({ people, patch: PAID });
    await h.rightsRow(failed, { status: 'FAILED', deductionFen: 300n });
    await h.rightsRow(answered, { deductionFen: 400n, answeredAt: new Date(T1) });

    const read = await h.tracedEarnings(me);

    expect(estimates(read.own)).toEqual(['425', '425', '425']);
    expect(read.ownReads).toHaveLength(1);
    expect(read.bothReads.length).toBeLessThanOrEqual(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#34] 只有 RIGHTS 的 SUCCEEDED、有应扣数、未回应的记录算 open：FAILED、PROCESSING、WAIT_COMMISSION、已回应、PUNISH 与无应扣数都不减；另一单 SUCCEEDED 300 与 100 相加后才减：看板 425、255，与钱包合计 680 相同',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const others = await h.estimated({ people, patch: PAID });
    const open = await h.estimated({ people, patch: PAID });
    await h.rightsRow(others, { status: 'FAILED', deductionFen: 300n });
    await h.rightsRow(others, { status: 'PROCESSING', deductionFen: 200n });
    await h.rightsRow(others, { status: 'WAIT_COMMISSION', deductionFen: 100n });
    await h.rightsRow(others, { deductionFen: 50n, answeredAt: new Date(T1) });
    await h.rightsRow(others, { type: 'PUNISH', deductionFen: 70n });
    await h.rightsRow(others, { deductionFen: null });
    await h.rightsRow(open, { deductionFen: 300n });
    await h.rightsRow(open, { deductionFen: 100n });

    expect(estimates((await h.earningsOf(me)).own)).toEqual(['255', '425']);
    expect((await h.walletOf(me)).estimated_fen).toBe(680n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#35] 有效佣金结算优先、下限 0、CREDITED 不走这里：结算 1000、预估 3000、open 400 → 255；预估 300、open 400 → 0，这单仍计入笔数；已入账的单留着 open 400，预估仍是 0、不为负',
  async () => {
    const h = await harness(p.db);
    const me = await h.user();
    const people = h.ownedBy(me);
    const settled = await h.settled({ people, estFen: 3000n, patch: PAID });
    const floored = await h.estimated({ people, estFen: 300n, patch: PAID });
    const credited = await h.credited({ people, patch: PAID });
    await h.rightsRow(settled, { deductionFen: 400n });
    await h.rightsRow(floored, { deductionFen: 400n });
    await h.rightsRow(credited, { deductionFen: 400n });

    expect(estimates((await h.earningsOf(me)).own)).toEqual(['0', '0', '255']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#36] 跨 App 不串：两个 App 各一单，A 应扣 400、B 应扣 100，看板各读各的：A 255、B 382；读 order_rights 的语句都按本 App 的 app_id 过滤',
  async () => {
    const a = await harness(p.db);
    const b = await harness(p.db);
    const userA = await a.user();
    const userB = await b.user();
    const orderA = await a.estimated({ people: a.ownedBy(userA), patch: PAID });
    const orderB = await b.estimated({ people: b.ownedBy(userB), patch: PAID });
    await a.rightsRow(orderA, { deductionFen: 400n });
    await b.rightsRow(orderB, { deductionFen: 100n });

    const readA = await a.tracedEarnings(userA);
    const readB = await b.tracedEarnings(userB);

    expect(estimates(readA.own)).toEqual(['255']);
    expect(estimates(readB.own)).toEqual(['382']);
    for (const [read, appId] of [
      [readA, a.appId],
      [readB, b.appId],
    ] as const) {
      expect(read.ownReads).toHaveLength(1);
      expect(read.ownReads[0]?.sql).toContain('app_id');
      expect(read.ownReads[0]?.parameters).toContain(appId);
    }
  },
  TIMEOUT,
);
