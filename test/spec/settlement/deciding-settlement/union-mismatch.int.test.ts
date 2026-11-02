// B2-04zp · 账单和补差算金额的第三处：联盟有结算而我方 ESTIMATED / VOID / CLAWED_BACK 或无单时，
// union_mismatch 差错单的 actual_fen 也是决定金额的那条（BR-FUND-04 ④、BR-FUND-09）。
// 这一路不入批、不到 R5，用账单与补差规则测试的现成夹具（真实任务，来源读口是夹具）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { fixture as billFixture, snapshot, state as billState } from '../bill/kit.ts';
import {
  databaseFixture,
  fixture as supplementFixture,
  main,
  order,
  settlement,
  state as supplementState,
  LATER,
  MONTH,
  TIMEOUT,
} from '../supplement/kit.ts';

const database = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zp#20] 账单：VOID 单有 STATEMENT 900、之后 API 1000，union_mismatch 的联盟金额是 900',
  async () => {
    const h = billFixture(database.db);
    await snapshot(h);
    const o = await order(h, { rebateStatus: 'VOID' });
    await settlement(h, o, { seq: 1, source: 'API', settle_commission_fen: 950n });
    await settlement(h, o, { seq: 2, source: 'STATEMENT', settle_commission_fen: 900n });
    await settlement(h, o, { seq: 3, source: 'API', settle_commission_fen: 1000n });

    expect((await h.run()).outcome).toBe('generated');
    expect((await billState(h)).diffs).toMatchObject([
      { type: 'union_mismatch', ref_id: o.key, period: MONTH, expected_fen: 0n, actual_fen: 900n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zp#21] 补差：VOID 单账单日之后才有记录，union_mismatch 的联盟金额同样是 STATEMENT 的 900',
  async () => {
    const h = supplementFixture(database.db);
    const o = await order(h, { rebateStatus: 'VOID' });
    const late = { created_at: new Date(LATER) };
    await settlement(h, o, { seq: 1, source: 'API', settle_commission_fen: 950n, ...late });
    await settlement(h, o, { seq: 2, source: 'STATEMENT', settle_commission_fen: 900n, ...late });
    await settlement(h, o, { seq: 3, source: 'API', settle_commission_fen: 1000n, ...late });
    await main(h);

    await h.launch();
    expect((await supplementState(h)).diffs).toMatchObject([
      { type: 'union_mismatch', ref_id: o.key, period: MONTH, expected_fen: 0n, actual_fen: 900n },
    ]);
  },
  TIMEOUT,
);
