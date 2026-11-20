// B2-02zb / BR-FUND-19 ⑦ (D10-2219 new ticket C). Top-level it() only (规划/11 §4.3).
// Not pinned here (D10-2219, status quo only): ⑦ reads the whole history, so one difference is
// reported again by every daily run; de-duplication belongs to new ticket B.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { APP, OTHER_APP } from '../invariants/kit.ts';
import {
  BASELINE,
  DAYS,
  LEGACY,
  REPLACEMENT,
  TIMEOUT,
  active,
  book,
  cache,
  drift,
  empty,
  expectedRow,
  openPlatform,
  openUser,
  recalc,
  registration,
  registry,
  reported,
  scenario,
  userEntries,
  type Booked,
  type Line,
  type PlatformAccount,
  type UserAccount,
} from './kit.ts';

it(
  '[AC-B2-02zb#1] ⑦ 余额缓存按分录重算下调到负数后，下一笔正常入账（余额回升但仍为负）不报；同场景下真扣款与首笔为负照报（含早于校验日的扣款 10 → −1、校验日回升到 1 后仍报），CLAWBACK / SETTLE_ADJUST / ADMIN_ADJUST 与改派红冲降到负照旧不报；空账本只出一条 none 行且 checked_rows = 0，有数据时 checked_rows = 用户分录数',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const file = active();
      // Before any fixture: one none row with zero checked rows from each version.
      empty(await check([LEGACY, file]));

      const counters = new Map<string, PlatformAccount>();
      for (const app of [APP, OTHER_APP]) counters.set(app, await openPlatform(db, app));
      const counter = (app: string) => counters.get(app)!;
      const all: Booked[] = [];
      async function post(voucher: {
        appId: string;
        lines: readonly Line[];
        uniqKey?: string;
        date?: string;
      }): Promise<Booked> {
        const booked = await book(db, { ...voucher, counter: counter(voucher.appId) });
        all.push(booked);
        return booked;
      }

      // Post +100 (balance_after 100); the cache is changed to 400 and a CLAWBACK of 300 is
      // posted on it (balance_after 100, entries now total −200); the recalculation writes the
      // entry total back: the cache drops from 100 to −200 with no voucher and no entry.
      async function recalculated(app: string = APP): Promise<UserAccount> {
        const a = await openUser(db, app);
        await post({
          appId: app,
          lines: [{ account: a, sub: 'available', amount: -100n, type: 'REBATE_CREDIT' }],
        });
        await drift(db, a, 400n);
        await post({
          appId: app,
          lines: [{ account: a, sub: 'available', amount: 300n, type: 'CLAWBACK' }],
        });
        expect(await cache(db, a)).toMatchObject({ available: 100n, frozen: 0n });
        expect(await recalc(db, a)).toMatchObject({ available: -200n, frozen: 0n });
        return a;
      }

      // The case under test: a normal credit of 50 after the recalculation (−200 → −150), then
      // another credit (−150 → −130). The balance went up both times.
      const credited = await recalculated();
      const credit = await post({
        appId: APP,
        lines: [{ account: credited, sub: 'available', amount: -50n, type: 'REBATE_CREDIT' }],
      });
      await post({
        appId: APP,
        lines: [{ account: credited, sub: 'available', amount: -20n, type: 'SHARE_CREDIT' }],
      });
      expect(await cache(db, credited)).toMatchObject({ available: -130n });

      // Same in another app, so the result is not one app's accident.
      const elsewhere = await recalculated(OTHER_APP);
      const elsewhereCredit = await post({
        appId: OTHER_APP,
        lines: [{ account: elsewhere, sub: 'available', amount: -10n, type: 'REFERRAL_CREDIT' }],
      });

      // A net credit of 50 whose first line is a fee of 10: still a credit to the account.
      const mixedAccount = await recalculated();
      const mixed = await post({
        appId: APP,
        lines: [
          { account: mixedAccount, sub: 'available', amount: 10n, type: 'WITHDRAW_FEE' },
          { account: mixedAccount, sub: 'available', amount: -60n, type: 'REBATE_CREDIT' },
        ],
      });
      expect(await cache(db, mixedAccount)).toMatchObject({ available: -150n });

      // Control: a real deduction of 30 after the recalculation (−200 → −230), two fee lines; the
      // voucher's first line in the sub-account is the one reported.
      const charged = await recalculated();
      const deduction = await post({
        appId: APP,
        lines: [
          { account: charged, sub: 'available', amount: 20n, type: 'WITHDRAW_FEE' },
          { account: charged, sub: 'available', amount: 10n, type: 'TAX_WITHHOLD' },
        ],
      });

      // Control: the three allowed types still take the balance further below zero unreported.
      for (const type of ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'] as const) {
        const a = await recalculated();
        await post({
          appId: APP,
          lines: [{ account: a, sub: 'available', amount: 30n, type }],
        });
      }

      // Control: a reassignment reversal (key contains :REASSIGN_REV:) keeps the original type.
      const reassigned = await recalculated();
      await post({
        appId: APP,
        uniqKey: `taobao:recalc:${reassigned.owner_id}:self:REASSIGN_REV:event`,
        lines: [{ account: reassigned, sub: 'available', amount: 30n, type: 'REBATE_CREDIT' }],
      });

      // Control: the very first voucher of an account takes it below zero (0 → −5).
      const fresh = await openUser(db, APP);
      const first = await post({
        appId: APP,
        lines: [{ account: fresh, sub: 'available', amount: 5n, type: 'WITHDRAW_FEE' }],
      });

      // Control on dates: a credit of 10 two days before the check date, a real deduction of 11
      // the day before (10 → −1), a credit of 2 on the check date (−1 → 1). The balance is no
      // longer negative on the check date; the earlier deduction is still reported, as 07 does.
      const early = await openUser(db, APP);
      await post({
        appId: APP,
        date: DAYS[0],
        lines: [{ account: early, sub: 'available', amount: -10n, type: 'REBATE_CREDIT' }],
      });
      const earlyDeduction = await post({
        appId: APP,
        date: DAYS[1],
        lines: [{ account: early, sub: 'available', amount: 11n, type: 'WITHDRAW_FEE' }],
      });
      await post({
        appId: APP,
        date: DAYS[2],
        lines: [{ account: early, sub: 'available', amount: -2n, type: 'REBATE_CREDIT' }],
      });
      expect(await cache(db, early)).toMatchObject({ available: 1n, frozen: 0n });

      const expected = [
        expectedRow(charged, deduction),
        expectedRow(fresh, first),
        expectedRow(early, earlyDeduction),
      ].sort();
      const falsePositives = [
        expectedRow(credited, credit),
        expectedRow(elsewhere, elsewhereCredit),
        expectedRow(mixedAccount, mixed),
      ];

      const [legacy, current] = await check([LEGACY, file]);
      // Confirms the mechanism: 07 compares with the previous balance_after_fen, which was taken
      // from the cache before the recalculation (100), so each credit above reads as a drop.
      expect(reported(legacy!)).toEqual([...expected, ...falsePositives].sort());
      for (const row of legacy!) expect(row.checked_rows).toBe(userEntries(all));
      // The check the daily run loads today must report exactly the real deductions, over the
      // same user entries.
      expect(reported(current!), `${file}: differences after a recalculation`).toEqual(expected);
      for (const row of current!) {
        expect(row.checked_rows, `${file}: checked user entries`).toBe(userEntries(all));
      }
    });
  },
  TIMEOUT,
);

it('[AC-B2-02zb#4] superseded.json 在主干登记原样保留的基础上只新增 07 → 11 一项（理由非空），07 原文件仍在且未改、仍是唯一的 07_ 文件；11 是唯一的 11_ 文件，目录装载生效的负余额来源自检即 11', () => {
  const entry = registration();
  expect(entry).toMatchObject({ file: LEGACY, replaced_by: REPLACEMENT });
  expect(registry()).toEqual(
    expect.arrayContaining([
      ...BASELINE,
      { file: LEGACY, replaced_by: REPLACEMENT, reason: entry.reason },
    ]),
  );
  expect(registry()).toHaveLength(BASELINE.length + 1);
  expect(active()).toBe(REPLACEMENT);
});
