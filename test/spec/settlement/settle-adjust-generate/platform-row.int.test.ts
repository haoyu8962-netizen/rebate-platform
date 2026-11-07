// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015; review r1 S1-2, S1-3): the platform row of
// the positive route (08 BR-FUND-09: 基数为 0 仍记预留的订单（BR-FUND-05）联盟佣金变化而基数仍为 0、新的结算佣金
// 仍大于 0 的同此（迁移 R10）；平台差额随所在一路记账（可正可负，取整所致）; task §9: 平台行 diff_fen 可正可负、
// ≠ 0). Expected amounts by hand from BR-CALC-02 / BR-CALC-04 / BR-CALC-09.
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
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
  '[AC-B2-09zb#3] 基数为 0 仍记预留（预留 10000，自购 5000 / 直推 1000）：入账 1000（B=0、平台 1000）后结算上调到 1200 → 只有一条平台行 +200、没有受益人行，一个批次；凭证、余额、booked 都不变',
  async () => {
    const h = await adjustHarness(p.db);
    // B = floor(1000 × 0 / 10000) = 0: shares 0 / 0, platform 1000 (all reserve); 1200 → B still 0,
    // positive part 1200 > booked_n_fen 1000: the approval route, platform 1200 − 1000 = +200.
    const { o, seq } = await h.raised(
      {
        settleFen: 1000n,
        reserveBp: 10000,
        people: [
          { role: 'self', ratioBp: 5000 },
          { role: 'direct', ratioBp: 1000 },
        ],
      },
      1200n,
    );
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 0n,
      booked_n_fen: 1000n,
    });
    expect((await h.nets(o)).platform_net_fen).toBe(1000n);
    const before = await h.state();

    const result = await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([platformRow(200n, seq)]);
    const batches = await h.batches();
    expect(batches).toHaveLength(1);
    expect(result).toEqual({
      batchId: batches[0]!.batch_id,
      orders: 1,
      candidates: 1,
      superseded: 0,
    });
    expect(await h.state()).toEqual(before);
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#3] 平台行可为负（预留 0，自购 5000 / 直推 1000）：入账 1009（504 / 100 / 平台 405）上调到 1010（505 / 101 / 404）→ 恰好 self +1、direct +1、平台 −1 三行，三行之和 = 联盟佣金之差 1',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(
      {
        settleFen: 1009n,
        reserveBp: 0,
        people: [
          { role: 'self', ratioBp: 5000 },
          { role: 'direct', ratioBp: 1000 },
        ],
      },
      1010n,
    );
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 1009n, booked_n_fen: 1009n });
    expect(await h.netOf(o, 'self')).toBe(504n);
    expect(await h.netOf(o, 'direct')).toBe(100n);
    expect((await h.nets(o)).platform_net_fen).toBe(405n);
    const before = await h.state();

    const result = await h.run();

    const rows = ordered(await h.rowsOf(o));
    expect(rows).toEqual([
      beneficiaryRow(o, 'self', 1n, seq),
      beneficiaryRow(o, 'direct', 1n, seq),
      platformRow(-1n, seq),
    ]);
    expect(rows.reduce((sum, r) => addFen(sum, r.diff_fen), 0n)).toBe(1n);
    expect(result).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(result.batchId).not.toBeNull();
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);
