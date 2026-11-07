// B2-09zb rule test (claude-independent, SPEC_REF 18f0015; review r1 S2): only CREDITED orders take
// candidates (08 BR-FUND-09: 补差只针对 rebate_status=CREDITED 的子订单). The order leaves CREDITED through
// the real B2-04s clawback (R8, P8 punish through rebate.onUpdated, the clawback harness' sync); a
// settlement record written after that clawback (so 决-10 A alone would take it) raises it to 1300.
// Control in the same run: a CREDITED order raised 1234 → 1300 gets +33 / +7 / +26.
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
  '[AC-B2-09zb#2] 经真实扣回（R8）转 CLAWED_BACK 的单，之后再有一条上调的结算记录（晚于扣回）→ 没有任何候选行；同场正常上调的 CREDITED 单照常生成',
  async () => {
    const h = await adjustHarness(p.db);
    const clawed = await h.credited(EXAMPLE);
    const outcome = await h.sync(clawed, { event: 'PLATFORM_PUNISH', rule: 'P8' });
    expect(outcome.result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.read(clawed)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
    });
    h.clock.advanceMs(15 * 60_000);
    await h.settle(clawed, 1300n);
    const control = await h.raised(EXAMPLE, 1300n);
    const before = await h.state();

    const result = await h.run();

    expect(await h.rowsOf(clawed)).toEqual([]);
    expect(ordered(await h.rowsOf(control.o))).toEqual([
      beneficiaryRow(control.o, 'self', 33n, control.seq),
      beneficiaryRow(control.o, 'direct', 7n, control.seq),
      platformRow(26n, control.seq),
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
    expect(await h.read(clawed)).toMatchObject({ rebate_status: 'CLAWED_BACK' });
  },
  TIMEOUT,
);
