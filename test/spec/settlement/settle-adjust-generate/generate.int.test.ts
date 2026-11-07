// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): R1's positive-difference candidates
// (08 BR-FUND-09 ②: 正差 → R1 生成补差候选行（记录生成时的 seq）写入 settle_adjust_batches；分路按整单，
// B_settle 与 booked_base_fen 相等时改比结算佣金的正数部分与 booked_n_fen；负差与无变化不进候选；
// 补差只针对 CREDITED；BR-CALC-02 换算、BR-CALC-09 全额重拆). The generator writes candidates only:
// no voucher, no balance, no booked pair, no event (D10-769).
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from './harness.ts';

const p = databaseFixture(createDatabase);

it(
  '[AC-B2-09zb#1] 结算 B=1300、已入账 1234（617 / 123 / 平台 494，预留 0）：一个批次、三行 pending +33 / +7 / +26，settle_seq 为当前 seq、commission_version 为订单当前版本；分录、余额、booked_base_fen、booked_n_fen、事件都不变',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 1234n, booked_n_fen: 1234n });
    const before = await h.state();

    const result = await h.run();

    const batches = await h.batches();
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toMatchObject({ app_id: h.appId, confirmed_by: null, confirmed_at: null });
    expect(result).toEqual({ batchId: batch.batch_id, orders: 1, candidates: 3, superseded: 0 });

    const rows = await h.rowsOf(o);
    expect(ordered(rows)).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        batch_id: batch.batch_id,
        approver: null,
        decided_at: null,
      });
    }

    // Candidates only: the ledger, balances, the order row (booked pair included), obligations,
    // beneficiary events, rebate history and events are exactly as before.
    expect(await h.state()).toEqual(before);
    expect(await h.balance(o.user('self'))).toBe(617n);
    expect(await h.balance(o.user('direct'))).toBe(123n);
    expect(await h.voucherKeys()).not.toContainEqual(expect.stringContaining(':ADJ:'));
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#2] 只取正差：结算额低于 booked（负差）、与 booked 相等、结算额未变、非 CREDITED 的单都不生成任何行；同一运行里的正差单照常进唯一的批次',
  async () => {
    const h = await adjustHarness(p.db);
    // Negative: B_settle 1200 < booked 1234 (that one is orders' immediate path, never a candidate).
    const negative = await h.raised(EXAMPLE, 1200n);
    // Equal: a new record of the same 1234 (base and positive part both equal: no action).
    const equal = await h.raised(EXAMPLE, 1234n);
    // Unchanged: credited, no later record.
    const unchanged = await h.credited(EXAMPLE);
    // Not credited: WAITING with a raised settlement.
    const waiting = await h.order(EXAMPLE);
    await h.settle(waiting, 1300n);
    // The one positive order of the run.
    const positive = await h.raised(EXAMPLE, 1300n);
    const before = await h.state();

    const result = await h.run();

    for (const o of [negative.o, equal.o, unchanged, waiting]) {
      expect(await h.rowsOf(o), o.orderId).toEqual([]);
    }
    expect(ordered(await h.rowsOf(positive.o))).toEqual([
      beneficiaryRow(positive.o, 'self', 33n, positive.seq),
      beneficiaryRow(positive.o, 'direct', 7n, positive.seq),
      platformRow(26n, positive.seq),
    ]);
    const batches = await h.batches();
    expect(batches).toHaveLength(1);
    expect(result).toEqual({
      batchId: batches[0]!.batch_id,
      orders: 1,
      candidates: 3,
      superseded: 0,
    });
    expect(await h.state()).toEqual(before);
    expect(await h.read(waiting)).toMatchObject({ rebate_status: 'WAITING' });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#2] 没有任何正差单时：不建批次、不写候选，答 batchId null 与全 0 计数',
  async () => {
    const h = await adjustHarness(p.db);
    await h.raised(EXAMPLE, 1200n);
    await h.credited(EXAMPLE);
    const before = await h.state();

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.batches()).toEqual([]);
    expect(await h.allRows()).toEqual([]);
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#3] 基数相等而佣金不同（预留 5000、1000 → 1001，B 都是 500）：受益人应得不变，只有平台一行 +1，无受益人行',
  async () => {
    const h = await adjustHarness(p.db);
    // Default people self 5000 / direct 1000 / indirect 500: 250 / 50 / 25, platform 675 → 676.
    const { o, seq } = await h.raised({ settleFen: 1000n, reserveBp: 5000 }, 1001n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 500n, booked_n_fen: 1000n });
    const before = await h.state();

    const result = await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([platformRow(1n, seq)]);
    expect(result).toMatchObject({ orders: 1, candidates: 1, superseded: 0 });
    expect(result.batchId).not.toBeNull();
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#3] 基数变大且佣金也变大（预留 1500：1000 → 1100，B 850 → 935）：按新基数全额重拆的受益人差额 + 平台差额（含预留）合计等于联盟佣金之差',
  async () => {
    const h = await adjustHarness(p.db);
    // 850 → 425 / 85 / 42 (platform 448); 935 → 467 / 93 / 46 (platform 1100 − 606 = 494).
    const { o, seq } = await h.raised({ settleFen: 1000n, reserveBp: 1500 }, 1100n);

    await h.run();

    const rows = ordered(await h.rowsOf(o));
    expect(rows).toEqual([
      beneficiaryRow(o, 'self', 42n, seq),
      beneficiaryRow(o, 'direct', 8n, seq),
      beneficiaryRow(o, 'indirect', 4n, seq),
      platformRow(46n, seq),
    ]);
    expect(rows.reduce((sum, r) => addFen(sum, r.diff_fen), 0n)).toBe(100n);
  },
  TIMEOUT,
);
