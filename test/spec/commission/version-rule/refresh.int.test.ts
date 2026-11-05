// B2-03s · estimates 端口的 refresh，CREDITED（BR-CALC-23 (a)、BR-CALC-02、BR-CALC-27，D10-578）：N 已知就按新 N 用同一 planVersion
// 重算，复制分支只留作「版本前进而 N 未知」的兜底。默认单：预留 1500，self 5000 / direct 1000 / indirect 500。
// 手算：N 8000 → B 6800 → 3400 / 680 / 340，合计 4420，基数前扣除 1200；淘礼金扣 100、补贴 111 时 B 6700 →
// 3350 / 670 / 335，合计 4355，n_total 8111，基数前扣除 1411，利润 3756；direct 被没收时 3400 / 0 / 340，合计 3740。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  amountsAt,
  databaseFixture,
  fixture,
  orderRow,
  storedVersions,
  totalsAt,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CREDITED = {
  rebateStatus: 'CREDITED',
  platformStatus: 'SETTLED',
  estFen: 9000n,
  settleFen: 8000n,
  commissionVersion: 3,
  patch: { booked_base_fen: 1700n, booked_n_fen: 2000n },
} as const;

it(
  '[AC-B2-03s#31][BR-CALC-23][BR-CALC-15] CREDITED：N 已知按新 N 重算（结算优先，不是复制），null 面额保持 null，重投不多行，booked 不动；两列都空才复制上一版本',
  async () => {
    const f = await fixture(p.db);
    const known = await f.order({ ...CREDITED, redpacketFen: null });

    await f.refresh(known);
    await f.refresh(known);

    expect(await storedVersions(p.db, known)).toEqual({ amounts: [1, 3], totals: [1, 3] });
    expect(await amountsAt(p.db, known, 3)).toEqual([
      ['self', 6800n, 3400n],
      ['direct', 6800n, 680n],
      ['indirect', 6800n, 340n],
    ]);
    expect(await totalsAt(p.db, known, 3)).toEqual({
      n_total_fen: 8000n,
      pre_base_deduct_fen: 1200n,
      base_fen: 6800n,
      user_share_total_fen: 4420n,
      tlj_redpacket_fen: null,
      platform_est_profit_fen: null,
    });
    expect(await orderRow(p.db, known)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1700n,
      booked_n_fen: 2000n,
      commission_version: 3,
    });

    const blank = await f.order({ ...CREDITED, estFen: null, settleFen: null });

    await f.refresh(blank);

    expect(await storedVersions(p.db, blank)).toEqual({ amounts: [1, 3], totals: [1, 3] });
    expect(await amountsAt(p.db, blank, 3)).toEqual(await amountsAt(p.db, blank, 1));
    expect(await totalsAt(p.db, blank, 3)).toEqual(await totalsAt(p.db, blank, 1));
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#32][BR-CALC-02][BR-CALC-27] CREDITED 重算用快照冻结的条款：预留、淘礼金、补贴、受益比例都取快照，后发布的规则版本碰不到',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      ...CREDITED,
      tljDeductFen: 100n,
      rebateMode: 'normal',
      subsidyFen: 111n,
    });
    await f.newerRules();

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 3)).toEqual([
      ['self', 6700n, 3350n],
      ['direct', 6700n, 670n],
      ['indirect', 6700n, 335n],
    ]);
    expect(await totalsAt(p.db, o, 3)).toEqual({
      n_total_fen: 8111n,
      pre_base_deduct_fen: 1411n,
      base_fen: 6700n,
      user_share_total_fen: 4355n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 3756n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#33][BR-CALC-13][BR-CALC-23] CREDITED 重算与预估同一算法：已没收的受益人份额为 0，留给平台，不转给别人，基数不变',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order(CREDITED);
    await f.event(o, 'direct', 'forfeited', 'banned');

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 3)).toEqual([
      ['self', 6800n, 3400n],
      ['direct', 6800n, 0n],
      ['indirect', 6800n, 340n],
    ]);
    expect(await totalsAt(p.db, o, 3)).toMatchObject({
      base_fen: 6800n,
      user_share_total_fen: 3740n,
    });
  },
  TIMEOUT,
);
