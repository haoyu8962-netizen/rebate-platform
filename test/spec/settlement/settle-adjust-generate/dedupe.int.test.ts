// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): a candidate is never generated twice
// for one settlement record, commission version and beneficiary (contract adminRunSettleAdjust: 「the
// job writes a new batch for the orders whose current settlement record has no pending candidate
// yet (a candidate is never generated twice for one seq and beneficiary)」; D10-780: same version
// already pending → the order is skipped, the unique key settle_adjustments_candidate_key backs it).
// A rerun of the same run, two manual triggers, or the scheduled and a manual run overlapping, leave
// one pending row per (order, seq, version, beneficiary) and never an empty batch.
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
  '[AC-B2-09zb#6] 同一运行重跑：第二次不写任何行、不建批次（batchId null）；仍只有一个批次、三行 pending',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);

    const first = await h.run();
    const firstRows = await h.allRows();
    const second = await h.run();

    expect(first).toMatchObject({ orders: 1, candidates: 3 });
    expect(second).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(firstRows);
    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    const batches = await h.batches();
    expect(batches.map((b) => b.batch_id)).toEqual([first.batchId]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#6] 两次运行并发（定时与手动重叠）：每个 (单, seq, 版本, 受益人) 只有一行 pending，两次的候选数合计等于行数，没有空批次',
  async () => {
    const h = await adjustHarness(p.db);
    const a = await h.raised(EXAMPLE, 1300n);
    const b = await h.raised(EXAMPLE, 1250n);

    const results = await Promise.all([h.run(), h.run({ accountingDate: '2032-07-25' })]);

    const rows = await h.allRows();
    const keys = rows.map((r) =>
      [r.order_id, r.settle_seq, r.commission_version, r.user_id ?? '-', r.role ?? '-'].join('|'),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(ordered(await h.rowsOf(a.o))).toEqual([
      beneficiaryRow(a.o, 'self', 33n, a.seq),
      beneficiaryRow(a.o, 'direct', 7n, a.seq),
      platformRow(26n, a.seq),
    ]);
    // 1250: 625 / 125 / 500 → +8 / +2 / +6.
    expect(ordered(await h.rowsOf(b.o))).toEqual([
      beneficiaryRow(b.o, 'self', 8n, b.seq),
      beneficiaryRow(b.o, 'direct', 2n, b.seq),
      platformRow(6n, b.seq),
    ]);
    expect(results[0].candidates + results[1].candidates).toBe(rows.length);
    expect(results[0].orders + results[1].orders).toBe(2);
    await h.expectNoEmptyBatch();
    const batchIds = results.map((r) => r.batchId).filter((id) => id !== null);
    expect((await h.batches()).map((x) => x.batch_id).sort()).toEqual([...batchIds].sort());
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#6] 同 seq、同版本的候选已被拒绝：再跑不重新生成（不报错、不建空批），拒绝的行不动',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await h.raised(EXAMPLE, 1300n);
    await h.run();
    const approver = await h.admin();
    await h.decide(o, 'rejected', approver, '2032-07-24T10:30:00+08:00');
    const decided = await h.allRows();

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.allRows()).toEqual(decided);
    expect(decided.every((r) => r.status === 'rejected')).toBe(true);
    expect(await h.batches()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#6] 新的结算记录（seq + 1）到达后再跑：当前 seq 还没有候选，为它生成新的一批（seq 去重只看当前 seq）',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await h.raised(EXAMPLE, 1300n);
    await h.run();
    const next = await h.settle(o, 1320n);

    const result = await h.run();

    // 1320: 660 / 132 / 528 → +43 / +9 / +34 against the unchanged nets.
    const rows = await h.rowsOf(o);
    expect(ordered(rows.filter((r) => r.settle_seq === next))).toEqual([
      beneficiaryRow(o, 'self', 43n, next),
      beneficiaryRow(o, 'direct', 9n, next),
      platformRow(34n, next),
    ]);
    expect(result).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(await h.batches()).toHaveLength(2);
  },
  TIMEOUT,
);
