// B2-03s · 已入账单（BR-CALC-23 (a)、迁移 R10 的金额行半边，FU-CREDITED-AMOUNT-ROWS，D10-578）：订单先经真实账单与批次
// 入账（booked 1000，本人 500），之后联盟结算额变化：版本 +1，新行等于 BR-CALC-23 (a) 的新应得（不是复制上一版本），
// 入账金额、分录、余额都不动。调整本身（SETTLE_ADJUST、补差候选）在 B2-04zi，这里不断言。手算：预留 0、本人 50 %，
// 结算 800 → 400，1200 → 600，1001 → 500（基数变了，份额向下取整后没变，新版本照写）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, moneyRows, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/**
 * What the app's ledger gained since `before` (approvals 50, D10-784): every voucher and line that
 * was there is still there unchanged; the new ones are returned as `uniq_key|kind` and
 * `uniq_key|subject|owner|amount|ledger_type|sub_type|sub_account`, sorted.
 */
async function ledgerSince(appId: string, before: Awaited<ReturnType<typeof moneyRows>>) {
  const after = await moneyRows(p.db, appId);
  const byId = <T extends { readonly id: unknown }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const oldVouchers = new Set(before.vouchers.map((v) => v.id));
  const oldLines = new Set(before.entries.map((e) => e.id));
  expect(byId(after.vouchers.filter((v) => oldVouchers.has(v.id)))).toEqual(byId(before.vouchers));
  expect(byId(after.entries.filter((e) => oldLines.has(e.id)))).toEqual(byId(before.entries));
  const accounts = await p.db
    .selectFrom('ledger_accounts')
    .select(['id', 'subject', 'owner_id'])
    .where('app_id', '=', appId)
    .execute();
  const accountOf = new Map(accounts.map((a) => [a.id, `${a.subject}|${a.owner_id}`] as const));
  const fresh = after.vouchers.filter((v) => !oldVouchers.has(v.id));
  const keyOf = new Map(fresh.map((v) => [v.id, v.uniq_key] as const));
  return {
    vouchers: fresh.map((v) => `${v.uniq_key}|${v.voucher_kind}`).sort(),
    lines: after.entries
      .filter((e) => !oldLines.has(e.id))
      .map(
        (e) =>
          `${keyOf.get(e.voucher_id)}|${accountOf.get(e.account_id)}|${e.amount_fen}|${e.ledger_type}|${e.sub_type}|${e.sub_account}`,
      )
      .sort(),
  };
}

/** One negative SETTLE_ADJUST (BR-FUND-09 ①): member and platform each debit, UNION_RECEIVABLE credits. */
function adjustment(
  subOrderId: string,
  userId: string,
  seq: number,
  user: bigint,
  platform: bigint,
) {
  const member = `pdd:${subOrderId}:${userId}:share:ADJ:${seq}`;
  const house = `pdd:${subOrderId}:PLATFORM:ADJ:${seq}`;
  return {
    vouchers: [`${member}|SETTLE_ADJUST`, `${house}|SETTLE_ADJUST`],
    lines: [
      `${member}|USER_BALANCE|${userId}|${user}|SETTLE_ADJUST|SETTLE_DIFF|available`,
      `${member}|UNION_RECEIVABLE:pdd|platform|${-user}|SETTLE_ADJUST|SETTLE_DIFF|available`,
      `${house}|COMMISSION_REVENUE|platform|${platform}|SETTLE_ADJUST|SETTLE_DIFF|available`,
      `${house}|UNION_RECEIVABLE:pdd|platform|${-platform}|SETTLE_ADJUST|SETTLE_DIFF|available`,
    ],
  };
}

it(
  '[AC-B2-03s#14][BR-CALC-23][BR-CALC-15][BR-FUND-09][BR-FUND-01] R10：已入账单结算额降到 800：版本 +1，新行等于新应得 400，不是复制；负差即时写 SETTLE_ADJUST（会员 100、平台 100），booked 成对改为 800 / 800，余额 400',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(800n, touched(1)));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: 800n,
        commission_version: 2,
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      expect(await o.amounts(2)).toEqual([[800n, 400n]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: 800n,
        pre_base_deduct_fen: 0n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 400n,
      });
      const adj2 = adjustment(o.subOrderId, app.userId, 2, 100n, 100n);
      expect(await ledgerSince(app.appId, money)).toEqual({
        vouchers: [...adj2.vouchers].sort(),
        lines: [...adj2.lines].sort(),
      });
      expect(await w.available(app)).toBe(400n);
      expect(w.moves().at(-1)).toBe(true);
    });
  },
  TIMEOUT,
);

it.each([
  [1200n, 600n],
  [1001n, 500n],
])(
  '[AC-B2-03s#14][BR-CALC-23][BR-CALC-15] R10：已入账单结算额变成 %s：版本 +1，新行等于新应得 %s，不是复制；booked、分录、余额不动',
  async (settleFen, shareFen) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(settleFen, touched(1)));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: settleFen,
        commission_version: 2,
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      expect(await o.amounts(2)).toEqual([[settleFen, shareFen]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: settleFen,
        pre_base_deduct_fen: 0n,
        base_fen: settleFen,
        user_share_total_fen: shareFen,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: settleFen - shareFen,
      });
      expect(await moneyRows(p.db, app.appId)).toEqual(money);
      expect(await w.available(app)).toBe(500n);
      expect(w.moves().at(-1)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#15][BR-CALC-15] R10 同值重放：不再推版本，新行只写一次；再变才到 v3，行按再变后的 N',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      expect(await w.available(app)).toBe(500n);

      await o.sync(settled(800n, touched(1)));
      expect((await o.row()).commission_version).toBe(2);
      const first = await moneyRows(p.db, app.appId);
      await o.sync(settled(800n, touched(2)));
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      // 同值重放不是新的结算记录（BR-FUND-09 seq 未变）：不新增凭证，ledger 一行不动。
      expect(await ledgerSince(app.appId, first)).toEqual({ vouchers: [], lines: [] });

      await o.sync(settled(700n, touched(3)));
      expect((await o.row()).commission_version).toBe(3);
      expect(await o.amounts(3)).toEqual([[700n, 350n]]);
      const adj2 = adjustment(o.subOrderId, app.userId, 2, 100n, 100n);
      const adj3 = adjustment(o.subOrderId, app.userId, 3, 50n, 50n);
      expect(await ledgerSince(app.appId, money)).toEqual({
        vouchers: [...adj2.vouchers, ...adj3.vouchers].sort(),
        lines: [...adj2.lines, ...adj3.lines].sort(),
      });
      expect(await w.available(app)).toBe(350n);
      expect(w.moves().slice(-3)).toEqual([true, false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#16][BR-CALC-15][BR-CALC-23] 已入账单结算记录没变、只有预估变：不推版本，没有新行，est 存档，booked、分录、余额不动',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(null, { ...touched(1), est_commission_fen: 2000n }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 2000n,
        settle_commission_fen: 1000n,
        commission_version: 1,
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await moneyRows(p.db, app.appId)).toEqual(money);
      expect(w.moves().at(-1)).toBe(false);
    });
  },
  TIMEOUT,
);
