// B2-04zr rule tests, the member-facing books (claude-independent, SPEC_REF 6f50a051): 编排裁定 D10-538 —
// UNION_RECEIPT:* entries carry the placeholder ledger_type REBATE_CREDIT on platform subjects
// (specs/ledger-rules.md §7 第 3 条), and the readers by ledger_type take user accounts only. GET
// /v1/earnings/summary (BR-FUND-25) and GET /v1/wallet/ledger (BR-FUND-15), each through the real api
// entry of app couli, answer the same before an entry, after it and after its reversal, with the
// figures written by hand. The api entry's fixture is ../../ledger/earnings-summary/kit.ts and
// ../../ledger/wallet-ledger/kit.ts; the writes go through the real admin entry (kit.ts). Top-level
// it() only (规划/11 §4.3).
import { beforeAll, expect, it } from 'vitest';
import type { Account } from '../../db/ledger/invariants/kit.ts';
import {
  APP,
  books,
  column,
  counterAccount,
  credit,
  creditedOrder,
  referral,
  ruleVersion,
  summary,
  withDashboard,
} from '../../ledger/earnings-summary/kit.ts';
import {
  credit as walletCredit,
  everything as walletEntries,
  ledger,
  placed,
  row,
  withLedger,
} from '../../ledger/wallet-ledger/kit.ts';
import { entryBody, fixture, idOf, receiptOf, suite, withReceiptAdmin } from './kit.ts';

const TIMEOUT = 180_000;

const s = suite();
let rules: string;
let counter: Account;
beforeAll(async () => {
  rules = await ruleVersion(s.db());
  counter = await counterAccount(s.db());
}, TIMEOUT);

it(
  '[AC-B2-04zr#37] 收益看板：本人当日已结算 425，录入一笔 REBATE_CREDIT 占位的回款、再红冲，GET /v1/earnings/summary 的结果都不变（只算用户账户上的分录）',
  async () => {
    const at = '2026-11-12T02:00:00.000Z';
    const f = fixture(s, { instant: at, appId: APP });
    const db = s.db();
    await withDashboard(db, at, async (d) => {
      const me = d.me.uid;
      const people = [{ userId: me, role: 'self' as const, ratioBp: 5000 }];
      const orderKey = await creditedOrder(db, rules, me, people);
      const own = await books(db, me, counter);
      await credit(
        db,
        own,
        { orderKey, role: 'self', type: 'REBATE_CREDIT', fen: 425n },
        '2026-11-12',
      );

      const before = await summary(await d.get());
      expect(before).toEqual({
        as_of: before.as_of,
        self: column({ today: [0, 0, 425], this_month: [0, 0, 425] }),
        share: column(),
        referral: referral(),
      });

      await withReceiptAdmin(f, async (h) => {
        const id = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 900_000 }))));
        expect(await summary(await d.get())).toEqual(before);
        await receiptOf(await h.reverse(id));
        expect(await summary(await d.get())).toEqual(before);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zr#38] 余额流水：本人一条入账 800，录入一笔回款、再红冲，GET /v1/wallet/ledger 的条目都不变；别的用户仍是空的（平台科目分录不进流水）',
  async () => {
    const at = '2026-11-20T04:00:00.000Z';
    const f = fixture(s, { instant: at, appId: APP });
    const db = s.db();
    await withLedger(
      db,
      async (r) => {
        const me = await ledger(db, r.me.uid, counter);
        const people = [{ userId: r.me.uid, role: 'self' as const, ratioBp: 5000 }];
        const mine = await placed(db, rules, r.me.uid, people);
        walletCredit(me, 'REBATE_CREDIT', {
          order: mine,
          role: 'self',
          fen: 800n,
          at: '2026-11-05T10:00:00+08:00',
        });
        await me.flush();
        const expected = [row('REBATE_CREDIT', null, 800, '2026-11-05', 800, ['order', mine.id])];
        expect(await walletEntries(r)).toEqual(expected);
        expect(await walletEntries(r, r.someone)).toEqual([]);

        await withReceiptAdmin(f, async (h) => {
          const id = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 900_000 }))));
          expect(await walletEntries(r)).toEqual(expected);
          expect(await walletEntries(r, r.someone)).toEqual([]);
          await receiptOf(await h.reverse(id));
          expect(await walletEntries(r)).toEqual(expected);
          expect(await walletEntries(r, r.someone)).toEqual([]);
        });
      },
      at,
    );
  },
  TIMEOUT,
);
