// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): 决-10 A (08 BR-FUND-09 ②: 同一条结算记录
// （seq）只在其写入时刻晚于该子订单最近一次扣回（CLAWBACK）时才生成正差候选；开关
// settle.adjust.void_on_clawback.enabled，默认 on，off 时候选照常生成、由批准人把关).
// Example order: credited at 1234 (617 / 123 / 494, reserve 0); a partial rights clawback to 1100
// (R9: 550 / 110 / 440, booked 1100); a settlement record of 1300 (650 / 130 / 520) → +100 / +20 / +80.
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  VOID_ON_CLAWBACK,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
  type AdjustHarness,
  type SeededOrder,
} from './harness.ts';

const p = databaseFixture(createDatabase);

const CREDIT_AT = '2032-07-24T10:00:00+08:00';
const RECORD_BEFORE = '2032-07-24T10:15:00+08:00';
const CLAWBACK_AT = '2032-07-24T10:30:00+08:00';
const RECORD_AFTER = '2032-07-24T10:45:00+08:00';
const RUN_AT = '2032-07-24T11:00:00+08:00';

/** A partial rights clawback (R9) of the order to N = 1100 at CLAWBACK_AT. */
async function clawTo1100(h: AdjustHarness, o: SeededOrder): Promise<void> {
  h.clock.set(CLAWBACK_AT);
  const rightsId = await h.rights(o);
  expect(
    await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 1100n,
    }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R9', bookedBaseFen: 1100n });
  expect(await h.clawbackKeys(o)).not.toEqual([]);
}

/** Credited at CREDIT_AT, raised to 1300 at RECORD_BEFORE, then clawed back to 1100. */
async function recordBeforeClawback(h: AdjustHarness) {
  h.clock.set(CREDIT_AT);
  const o = await h.credited(EXAMPLE);
  const seq = await h.settle(o, 1300n, { createdAt: RECORD_BEFORE });
  await clawTo1100(h, o);
  h.clock.set(RUN_AT);
  return { o, seq };
}

it(
  '[AC-B2-09zb#5] 开关默认（未设）：当前结算记录写入早于该单最近一次扣回 → 不生成；同一运行里没有扣回的正差单照常生成',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await recordBeforeClawback(h);
    const control = await h.raised(EXAMPLE, 1300n);

    await h.run();

    expect(await h.rowsOf(o)).toEqual([]);
    expect(ordered(await h.rowsOf(control.o))).toEqual([
      beneficiaryRow(control.o, 'self', 33n, control.seq),
      beneficiaryRow(control.o, 'direct', 7n, control.seq),
      platformRow(26n, control.seq),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#5] 开关显式 on：结算记录早于扣回 → 不生成',
  async () => {
    const h = await adjustHarness(p.db);
    const { o } = await recordBeforeClawback(h);
    h.configValues.set(VOID_ON_CLAWBACK, 'on');

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.rowsOf(o)).toEqual([]);
    expect(await h.batches()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#5] 开关 off：结算记录早于扣回也照常生成（+100 / +20 / +80，按扣回后的 booked 1100 算）',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await recordBeforeClawback(h);
    h.configValues.set(VOID_ON_CLAWBACK, 'off');
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1100n,
      booked_n_fen: 1100n,
    });

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 100n, seq),
      beneficiaryRow(o, 'direct', 20n, seq),
      platformRow(80n, seq),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#5] 结算记录写入晚于最近一次扣回 → 照常生成（开关默认 on）',
  async () => {
    const h = await adjustHarness(p.db);
    h.clock.set(CREDIT_AT);
    const o = await h.credited(EXAMPLE);
    await clawTo1100(h, o);
    const seq = await h.settle(o, 1300n, { createdAt: RECORD_AFTER });
    h.clock.set(RUN_AT);

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 100n, seq),
      beneficiaryRow(o, 'direct', 20n, seq),
      platformRow(80n, seq),
    ]);
  },
  TIMEOUT,
);
