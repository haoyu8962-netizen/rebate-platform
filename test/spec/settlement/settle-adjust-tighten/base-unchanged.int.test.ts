// B2-09zf rule test (claude-independent, D10-828 ③; refs 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09):
// B_settle equals booked_base_fen while the positive part of the settlement is above booked_n_fen —
// only the union commission changed. BR-FUND-09: 基数相等而联盟佣金不同时，各受益人应得不变、差额为 0，
// 只调平台的金额（预留与留存按 BR-CALC-02、BR-CALC-04 重算）… 正差进候选审批. So the candidate set is
// the platform row only: no beneficiary row, even for a beneficiary whose share is still owed under an
// open obligation (待补记额) — he is neither credited nor charged and the obligation stays as it is.
// Seeded on the real path: credited by the real credit service while `self` is frozen (his share
// held, net 0, an open first_credit obligation); the freeze is lifted afterwards, then a new
// settlement record raises N by 1 without changing the base.
// Expected amounts by hand from BR-CALC-02 / BR-CALC-04, never from the planner.
import { addFen, subFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  adjustHarness,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from '../settle-adjust-generate/harness.ts';

const p = databaseFixture(createDatabase);

it(
  '[AC-B2-09zf#3] 基数不变只有佣金变化：预留 5000、自购 5000 / 直推 1000，入账 1000（基数 500）时自购冻结（净额 0、未完成义务待补 250，直推 50、平台 700），解冻后结算 1000 → 1001（基数仍 500）→ 恰好一条平台行 +1，没有任何受益人行；凭证、余额、义务都不变',
  async () => {
    const h = await adjustHarness(p.db);
    // B = floor(1000 × 5000 / 10000) = 500, reserve 500: self floor(500 × 5000 / 10000) = 250
    // (held, frozen), direct floor(500 × 1000 / 10000) = 50, platform 1000 − 250 − 50 = 700
    // (retain 200 + reserve 500).
    const o = await h.credited({
      settleFen: 1000n,
      reserveBp: 5000,
      people: [
        { role: 'self', ratioBp: 5000, state: 'frozen' },
        { role: 'direct', ratioBp: 1000 },
      ],
    });

    // The seeded state: self has no CREDIT (net 0) and one open obligation; what is still owed to
    // him under it is booked_n − platform net − Σ nets (BR-FUND-19 ⑤) = 1000 − 700 − 50 − 0 = 250.
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 500n,
      booked_n_fen: 1000n,
    });
    expect(await h.netOf(o, 'self')).toBe(0n);
    expect(await h.netOf(o, 'direct')).toBe(50n);
    const nets = await h.nets(o);
    expect(nets.platform_net_fen).toBe(700n);
    const credited = nets.beneficiaries.reduce((sum, b) => addFen(sum, b.net_fen), 0n);
    expect(subFen(subFen(1000n, nets.platform_net_fen), credited)).toBe(250n);
    const obligations = await h.orderObligations(o);
    expect(obligations).toEqual([
      expect.objectContaining({
        user_id: o.user('self'),
        role: 'self',
        kind: 'first_credit',
        status: 'open',
      }),
    ]);

    await h.setRisk(p.db, o.user('self'), 'normal');
    const seq = await h.settle(o, 1001n);
    const before = await h.state();

    const result = await h.run();

    // B_settle = floor(1001 × 5000 / 10000) = 500 = booked_base; 1001 > booked_n 1000: the
    // positive route. Shares stay 250 / 50 (self still owed 250, direct net 50): no member row.
    // Platform: 1001 − (0 + 250) − 50 = 701, 701 − 700 = +1.
    expect(ordered(await h.rowsOf(o))).toEqual([platformRow(1n, seq)]);
    const batches = await h.batches();
    expect(batches).toHaveLength(1);
    expect(result).toEqual({
      batchId: batches[0]!.batch_id,
      orders: 1,
      candidates: 1,
      superseded: 0,
    });
    expect(await h.state()).toEqual(before);
    expect(await h.orderObligations(o)).toEqual(obligations);
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(50n);
  },
  TIMEOUT,
);
