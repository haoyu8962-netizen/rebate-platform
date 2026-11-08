// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): approval of a positive-difference batch
// (08 BR-FUND-09 ②: 写凭证时必须按 orders.settle_commission_fen 当前值换算的 B_settle 与当前净额重算：diff=0
// 不写；候选行 seq ≠ 该订单当前 seq 时该行作废，不写；扣回发生时…候选全部作废、批准接口返回已作废; 两路 uniq_key
// 受益人 `{order_key}:{user_id}:{role}:ADJ:{seq}`、平台 `{order_key}:PLATFORM:ADJ:{seq}`，同事务
// booked_base_fen = B_settle、booked_n_fen = 结算佣金的正数部分; 分录 正差 借 UNION_RECEIVABLE / 贷
// USER_BALANCE.available; BR-CALC-02 reserve; BR-CALC-09 全额重算; D10-770 ① 按批次、任一单作废不挡其余各单,
// ③ 批准时差额为 0 记已批准不写凭证; contracts/openapi.yaml adminApproveSettleAdjustBatch).
// Every amount below is worked by hand: B = floor(N × (10000 − reserve_bp) / 10000), each share
// floor(B × ratio / 10000), the platform the rest of N (retain + reserve).
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  EXAMPLE,
  TIMEOUT,
  VOID_ON_CLAWBACK,
  answer,
  approveHarness,
  approveSuite,
  expectApproved,
  expectDerived,
  mentionsAmount,
  ordered,
  platformDecrease,
  platformIncrease,
  recordText,
  result,
  userIncrease,
  withAdmin,
  type ApproveHarness,
  type OrderSpec,
  type SeededOrder,
} from './kit.ts';

const s = approveSuite();

const GENERATED_AT = '2032-07-24T10:00:00+08:00';
const APPROVED_AT = '2032-07-24T10:20:00+08:00';

/** Every candidate of the order approved by `approver` at the clock. */
async function expectDecided(
  h: ApproveHarness,
  o: SeededOrder,
  status: string,
  approver: string | null,
): Promise<void> {
  const rows = await h.rowsOf(o);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.status, r.id).toBe(status);
    if (approver !== null) expect(r.approver, r.id).toBe(approver);
    expect(r.decided_at, r.id).toEqual(h.clock.now());
  }
}

it(
  '[AC-B2-09zc#2] 08 例「正差，批准后」：1234 → 1300 批准，写 self +33、直推 +7（*:USER:INCREASE）与平台 +26（*:PLATFORM:INCREASE），booked=1300/1300，候选已批准（批准人、时间），批次确认，answer approved / credited_fen 40，一条审计',
  async () => {
    const h = await approveHarness(s);
    h.clock.set(GENERATED_AT);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    // The seeded candidates (B2-09zb), for reference only: approval recomputes.
    expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen, r.status])).toEqual([
      ['self', 33n, 'pending'],
      ['direct', 7n, 'pending'],
      [null, 26n, 'pending'],
    ]);
    h.clock.set(APPROVED_AT);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 40)]);

      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(650n);
      expect(await h.balance(o.user('direct'))).toBe(130n);
      expect(await h.netOf(o, 'self')).toBe(650n);
      expect(await h.netOf(o, 'direct')).toBe(130n);
      expect(await h.receivableOf(o)).toBe(1300n);
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1300n,
        booked_n_fen: 1300n,
      });
      await expectDecided(h, o, 'approved', a.adjuster.id);
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
      expect(await h.orderObligations(o)).toEqual([]);

      const records = await h.audits(APPROVE_ACTION);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.admin_id).toBe(a.adjuster.id);
      expect(record.at).toEqual(h.clock.now());
      const recorded = recordText(record);
      expect(recorded).toContain(batchId);
      expect(recorded).toContain(o.orderId);
      expect(recorded).toContain('approved');
      expect(mentionsAmount(recorded, 40)).toBe(true);
      expectDerived(record, batchId);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 预留比例不为 0（08 E-04：淘宝 reserve 2000，本人 5000、直推 1000）：入账 N=1000（B 800：400 / 80 / 平台 520），结算 1250 → B_settle 1000：本人 +100、直推 +20、平台 +130（留存 400 + 预留 250 − 520），booked=1000/1250',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = {
      settleFen: 1000n,
      reserveBp: 2000,
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000 },
      ],
    };
    const { o, seq } = await h.raised(spec, 1250n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 800n, booked_n_fen: 1000n });
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 120)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 100n, seq),
        ...userIncrease(o, 'direct', 20n, seq),
        ...platformIncrease(o, 130n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(500n);
      expect(await h.balance(o.user('direct'))).toBe(100n);
      expect(await h.receivableOf(o)).toBe(1250n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1000n, booked_n_fen: 1250n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 基数不变只调平台（08 例：reserve 5000，结算佣金 1000 → 1001，B 仍 500、预留 500 → 501）：只写平台 +1（*:PLATFORM:INCREASE），受益人不补不扣、余额与义务不变，booked=500/1001，credited_fen 0 而结果仍是 approved',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = {
      settleFen: 1000n,
      reserveBp: 5000,
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000 },
      ],
    };
    const { o, seq } = await h.raised(spec, 1001n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 500n, booked_n_fen: 1000n });
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen])).toEqual([[null, 1n]]);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 0)]);
      await h.expectAdjust(o, seq, platformIncrease(o, 1n, seq));
      expect(await h.balance(o.user('self'))).toBe(250n);
      expect(await h.balance(o.user('direct'))).toBe(50n);
      expect(await h.receivableOf(o)).toBe(1001n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 500n, booked_n_fen: 1001n });
      expect(await h.orderObligations(o)).toEqual([]);
      await expectDecided(h, o, 'approved', a.adjuster.id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 基数为 0 仍记预留（BR-FUND-05，reserve 10000）：结算佣金 1000 → 1200，B 仍为 0：只写平台 +200，受益人无分录，booked=0/1200，订单保持 CREDITED',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = {
      settleFen: 1000n,
      reserveBp: 10000,
      people: [{ role: 'self', ratioBp: 5000 }],
    };
    const { o, seq } = await h.raised(spec, 1200n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 0n, booked_n_fen: 1000n });
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 0)]);
      await h.expectAdjust(o, seq, platformIncrease(o, 200n, seq));
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.receivableOf(o)).toBe(1200n);
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 0n,
        booked_n_fen: 1200n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 平台差额为负（取整，reserve 0，本人 5000、直推 1000）：1009（504 / 100 / 405）→ 1010（505 / 101 / 404）：本人 +1、直推 +1，平台 −1 写 *:PLATFORM:DECREASE（借 COMMISSION_REVENUE / 贷 UNION_RECEIVABLE，同一 ADJ 键），booked=1010/1010',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = { ...EXAMPLE, settleFen: 1009n };
    const { o, seq } = await h.raised(spec, 1010n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 2)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 1n, seq),
        ...userIncrease(o, 'direct', 1n, seq),
        ...platformDecrease(o, 1n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(505n);
      expect(await h.balance(o.user('direct'))).toBe(101n);
      expect(await h.receivableOf(o)).toBe(1010n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1010n, booked_n_fen: 1010n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 受益人带未完成义务（入账时冻结，first_credit 待补 123，现已解冻）且基数变大 1234 → 1300：补给 = 新份额 130 − 已入账净额 0 = 130（不扣待补额），义务随之完成（done）；本人 +33、平台 +26，应收 1300',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = {
      settleFen: 1234n,
      reserveBp: 0,
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
      ],
    };
    const { o, seq } = await h.raised(spec, 1300n);
    // Credit left the direct share held: no voucher, one open first_credit obligation.
    expect(await h.netOf(o, 'direct')).toBe(0n);
    const [held] = await h.orderObligations(o);
    expect(held).toMatchObject({
      user_id: o.user('direct'),
      role: 'direct',
      kind: 'first_credit',
      status: 'open',
    });
    expect(await h.receivableOf(o)).toBe(1111n);
    await h.setRisk(h.db, o.user('direct'), 'normal');
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen])).toEqual([
      ['self', 33n],
      ['direct', 130n],
      [null, 26n],
    ]);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 163)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...userIncrease(o, 'direct', 130n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      expect(await h.balance(o.user('direct'))).toBe(130n);
      expect(await h.netOf(o, 'direct')).toBe(130n);
      expect(await h.receivableOf(o)).toBe(1300n);
      const obligations = await h.orderObligations(o);
      expect(obligations).toHaveLength(1);
      expect(obligations[0]).toMatchObject({
        beneficiary_credit_id: held!.beneficiary_credit_id,
        status: 'done',
      });
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 批准时重算差额为 0（当前 settle_commission_fen 已回到已入账值 1234，seq 未变）→ approved_zero：候选记已批准（批准人、时间）、不写任何凭证、余额与 booked 不变，批次确认，审计写明该单「批准时差额为 0」',
  async () => {
    const h = await approveHarness(s);
    const { o } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    // The order's current settlement amount (the value approval recomputes from) is the booked one
    // again, the settlement record seq unchanged.
    await h.db
      .updateTable('orders')
      .set({ settle_commission_fen: 1234n })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const before = await h.moneyOf(o);
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved_zero', 0)]);
      expect(await h.moneyOf(o)).toEqual(before);
      expect(await h.adjLinesOf(o)).toEqual([]);
      await expectDecided(h, o, 'approved', a.adjuster.id);
      expect((await h.batch(batchId)).confirmed_by).toBe(a.adjuster.id);
      const records = await h.audits(APPROVE_ACTION);
      expect(records).toHaveLength(1);
      const recorded = recordText(records[0]!);
      expect(recorded).toContain(o.orderId);
      expect(recorded).toContain('approved_zero');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 一个批次三单（D10-770 ①）：生成后 A 不变 → approved；B 又来新结算记录（seq 变）→ voided_stale_seq；C 被部分扣回（R9）→ voided_by_clawback；作废的两单什么都不写，不挡 A；批次确认，results 列出每一单',
  async () => {
    const h = await approveHarness(s);
    const a1 = await h.raised(EXAMPLE, 1300n);
    const b = await h.raised(EXAMPLE, 1300n);
    const c = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    for (const x of [a1, b, c]) {
      expect((await h.rowsOf(x.o)).map((r) => r.batch_id)).toEqual([batchId, batchId, batchId]);
    }
    h.clock.advanceMs(60_000);
    const newSeq = await h.settle(b.o, 1350n);
    expect(newSeq).toBe(b.seq + 1);
    const rightsId = await h.rights(c.o);
    expect(
      await h.apply(c.o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 1100n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    expect((await h.rowsOf(c.o)).map((r) => r.status)).toEqual([
      'voided_by_clawback',
      'voided_by_clawback',
      'voided_by_clawback',
    ]);
    const cVoidedAt = h.clock.now();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const bBefore = await h.moneyOf(b.o);
      const cBefore = await h.moneyOf(c.o);
      const cRows = await h.rowsOf(c.o);
      await expectApproved(await a.approve(batchId), batchId, [
        result(a1.o, 'approved', 40),
        result(b.o, 'voided_stale_seq', 0),
        result(c.o, 'voided_by_clawback', 0),
      ]);
      await h.expectAdjust(a1.o, a1.seq, [
        ...userIncrease(a1.o, 'self', 33n, a1.seq),
        ...userIncrease(a1.o, 'direct', 7n, a1.seq),
        ...platformIncrease(a1.o, 26n, a1.seq),
      ]);
      // B: the candidates of the old seq are voided now; nothing written, booked 1234 kept.
      expect(await h.moneyOf(b.o)).toEqual(bBefore);
      expect(await h.adjLinesOf(b.o)).toEqual([]);
      await expectDecided(h, b.o, 'voided_stale_seq', null);
      // C: voided by the clawback before approval; left as the clawback left it.
      expect(await h.moneyOf(c.o)).toEqual(cBefore);
      expect(await h.adjLinesOf(c.o)).toEqual([]);
      expect(await h.rowsOf(c.o)).toEqual(cRows);
      expect(cRows.every((r) => r.decided_at?.getTime() === cVoidedAt.getTime())).toBe(true);
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
      const recorded = recordText((await h.audits(APPROVE_ACTION))[0]!);
      for (const x of [a1, b, c]) expect(recorded).toContain(x.o.orderId);
      expect(recorded).toContain('voided_stale_seq');
      expect(recorded).toContain('voided_by_clawback');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 批次里的候选全部已被扣回作废（两单 R8 整单扣回）：不拒绝，200、每单 voided_by_clawback / 0，不写 SETTLE_ADJUST，批次确认，一条审计',
  async () => {
    const h = await approveHarness(s);
    const x = await h.raised(EXAMPLE, 1300n);
    const y = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    for (const o of [x.o, y.o]) {
      expect(
        await h.apply(o, { cause: 'PLATFORM_INVALID', ref: { kind: 'platform' } }),
      ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    }
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const before = { x: await h.moneyOf(x.o), y: await h.moneyOf(y.o) };
      await expectApproved(await a.approve(batchId), batchId, [
        result(x.o, 'voided_by_clawback', 0),
        result(y.o, 'voided_by_clawback', 0),
      ]);
      expect({ x: await h.moneyOf(x.o), y: await h.moneyOf(y.o) }).toEqual(before);
      expect([...(await h.adjLinesOf(x.o)), ...(await h.adjLinesOf(y.o))]).toEqual([]);
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
      expect(await h.audits(APPROVE_ACTION)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 开关 settle.adjust.void_on_clawback.enabled off（08：候选照常生成、由批准人把关）：扣回（R9 → 1100）后旧结算记录 1300 的候选照常批准，按扣回后的净额重算：本人 +100、直推 +20、平台 +80，booked=1300/1300',
  async () => {
    const h = await approveHarness(s);
    h.clock.set('2032-07-24T10:00:00+08:00');
    const o = await h.credited(EXAMPLE);
    const seq = await h.settle(o, 1300n, { createdAt: '2032-07-24T10:15:00+08:00' });
    h.clock.set('2032-07-24T10:30:00+08:00');
    const rightsId = await h.rights(o);
    expect(
      await h.apply(o, {
        cause: 'RIGHTS',
        ref: { kind: 'rights', orderRightsId: rightsId },
        newCommissionFen: 1100n,
      }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R9', bookedBaseFen: 1100n });
    await h.setConfig(VOID_ON_CLAWBACK, false);
    h.clock.set('2032-07-24T11:00:00+08:00');
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen, r.status])).toEqual([
      ['self', 100n, 'pending'],
      ['direct', 20n, 'pending'],
      [null, 80n, 'pending'],
    ]);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 120)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 100n, seq),
        ...userIncrease(o, 'direct', 20n, seq),
        ...platformIncrease(o, 80n, seq),
      ]);
      expect(await h.netOf(o, 'self')).toBe(650n);
      expect(await h.netOf(o, 'direct')).toBe(130n);
      expect(await h.receivableOf(o)).toBe(1300n);
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1300n,
        booked_n_fen: 1300n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 按批次批准：只动本批次的候选，同 app 另一批次的待批候选与其订单原样、批次不确认',
  async () => {
    const h = await approveHarness(s);
    const first = await h.raised(EXAMPLE, 1300n);
    const firstBatch = await h.generate();
    const second = await h.raised(EXAMPLE, 1300n);
    const secondBatch = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const otherRows = await h.rowsOf(second.o);
      const otherMoney = await h.moneyOf(second.o);
      await expectApproved(await a.approve(firstBatch), firstBatch, [
        result(first.o, 'approved', 40),
      ]);
      expect(await h.rowsOf(second.o)).toEqual(otherRows);
      expect(await h.moneyOf(second.o)).toEqual(otherMoney);
      expect((await h.batch(secondBatch)).confirmed_at).toBeNull();
      await answer(await a.approve(secondBatch), 0);
    });
  },
  TIMEOUT,
);
