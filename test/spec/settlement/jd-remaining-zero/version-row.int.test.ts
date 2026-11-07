// B2-04zzj（FU-B204ZZG-VERSION-ROW-TIGHTEN，D10-931 ②；BR-CALC-15「版本 ≥ 1 一定有金额行」、B2-03q、BR-FUND-07）：
// 收紧 B2-04zzg [AC-B2-04zzg#5]。开关开时，同一京东报文既退完（剩余数量 ≤ 0 → R6 → VOID，reason REFUND）又改了
// 预估佣金：orders 列把 commission_version 推到 2，版本 2 必须同时有金额行与四段金额（按新的 N 算），版本 1 的行不变；
// 作废不写凭证 / 分录、余额不动。对照：退完但预估没变，版本留在 1、没有版本 2 的行。
// kit 的每个 app：一名成员（L1，本人比例 50 %），京东预留 0，无上级；按归因码进来的单是分享单（角色 share），N 即 B，受益人金额 = B × 50 %。
// 期望值逐字手写。Task-local AC labels ([AC-B2-04zzj#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  amountsAt,
  portOrderOf,
  storedVersions,
  totalsAt,
} from '../../commission/estimate-port/kit.ts';
import {
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  touched,
  withWorker,
  type SyncedOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The amount rows / four amounts / stored versions of the synced order. */
function versionsOf(o: SyncedOrder) {
  const ref = async () => portOrderOf(await o.row());
  return {
    amounts: async (version: number) => amountsAt(p.db, await ref(), version),
    four: async (version: number) => totalsAt(p.db, await ref(), version),
    stored: async () => storedVersions(p.db, await ref()),
  };
}

const V1_AMOUNTS = [['share', 1000n, 500n]];
const V1_FOUR = {
  n_total_fen: 1000n,
  pre_base_deduct_fen: 0n,
  base_fen: 1000n,
  user_share_total_fen: 500n,
  tlj_redpacket_fen: 0n,
  platform_est_profit_fen: 500n,
};

/**
 * `status` jd order, switch on, then one report with 2 of 2 refunded and the estimate at `estAfter`:
 * VOID by R6 with reason REFUND, version 2 with the hand-written rows, version 1 untouched, no money.
 */
async function voidedWithNewVersion(
  status: 'ESTIMATED' | 'WAITING',
  estAfter: bigint,
  v2Amounts: readonly (readonly [string, bigint, bigint])[],
  v2Four: Record<string, bigint>,
): Promise<void> {
  await withWorker(p.db, async (w) => {
    const app = await w.app();
    const o = await precredit(w, app, 'jd', status);
    await w.setConfig(app, SWITCH, true);
    const v = versionsOf(o);
    expect(await o.row()).toMatchObject({ commission_version: 1, est_commission_fen: 1000n });
    expect(await v.stored()).toEqual({ amounts: [1], totals: [1] });
    expect(await v.amounts(1)).toEqual(V1_AMOUNTS);
    expect(await v.four(1)).toEqual(V1_FOUR);
    const ledgerBefore = await w.ledgerOf(app);
    expect(ledgerBefore.vouchers).toEqual([]);
    expect(ledgerBefore.entries).toEqual([]);

    await o.sync(
      touched(5, { ...counts(2, 2), est_commission_fen: estAfter, commission_fen: estAfter }),
    );

    expect(await o.row()).toMatchObject({
      rebate_status: 'VOID',
      reason: 'REFUND',
      reason_sub: null,
      quantity: 2,
      refunded_quantity: 2,
      est_commission_fen: estAfter,
      commission_version: 2,
      booked_base_fen: null,
      booked_n_fen: null,
    });
    expect(await o.voids()).toEqual([
      { from_status: status, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
    ]);
    expect((await o.invalidated()).map((e) => e.payload['reason'])).toEqual(['REFUND']);
    expect(await v.stored()).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await v.amounts(2)).toEqual(v2Amounts);
    expect(await v.four(2)).toEqual(v2Four);
    expect(await v.amounts(1)).toEqual(V1_AMOUNTS);
    expect(await v.four(1)).toEqual(V1_FOUR);
    const ledgerAfter = await w.ledgerOf(app);
    expect(ledgerAfter.vouchers).toEqual([]);
    expect(ledgerAfter.entries).toEqual([]);
    expect(ledgerAfter).toEqual(ledgerBefore);
  });
}

it(
  '[AC-B2-04zzj#1] 开关开：ESTIMATED 京东单同一报文退完且预估 1000 → 0：R6 → VOID（REFUND），commission_version 2，版本 2 有金额行（B 0、受益人 0）与四段金额，版本 1 不变，无凭证 / 分录、余额不变',
  async () => {
    await voidedWithNewVersion('ESTIMATED', 0n, [['share', 0n, 0n]], {
      n_total_fen: 0n,
      pre_base_deduct_fen: 0n,
      base_fen: 0n,
      user_share_total_fen: 0n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 0n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzj#2] 开关开：ESTIMATED 京东单同一报文退完且预估 1000 → 600：R6 → VOID（REFUND），commission_version 2，版本 2 金额行按 600 算（B 600、受益人 300），版本 1 不变，无凭证 / 分录',
  async () => {
    await voidedWithNewVersion('ESTIMATED', 600n, [['share', 600n, 300n]], {
      n_total_fen: 600n,
      pre_base_deduct_fen: 0n,
      base_fen: 600n,
      user_share_total_fen: 300n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 300n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzj#3] 开关开：WAITING 京东单同一报文退完且预估 1000 → 0：R6 → VOID（REFUND），commission_version 2，版本 2 有金额行（B 0、受益人 0）与四段金额，版本 1 不变，无凭证 / 分录、余额不变',
  async () => {
    await voidedWithNewVersion('WAITING', 0n, [['share', 0n, 0n]], {
      n_total_fen: 0n,
      pre_base_deduct_fen: 0n,
      base_fen: 0n,
      user_share_total_fen: 0n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 0n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzj#4] 对照：开关开、ESTIMATED 京东单退完但预估不变（1000）：R6 → VOID（REFUND），commission_version 仍为 1，没有版本 2 的金额行与四段金额',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'ESTIMATED');
      await w.setConfig(app, SWITCH, true);
      const v = versionsOf(o);
      const ledgerBefore = await w.ledgerOf(app);

      await o.sync(touched(5, counts(2, 2)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        est_commission_fen: 1000n,
        commission_version: 1,
      });
      expect(await o.voids()).toEqual([
        { from_status: 'ESTIMATED', event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
      ]);
      expect(await v.stored()).toEqual({ amounts: [1], totals: [1] });
      expect(await v.amounts(2)).toEqual([]);
      expect(await v.four(2)).toBeUndefined();
      expect(await v.amounts(1)).toEqual(V1_AMOUNTS);
      expect(await v.four(1)).toEqual(V1_FOUR);
      expect(await w.ledgerOf(app)).toEqual(ledgerBefore);
    });
  },
  TIMEOUT,
);
