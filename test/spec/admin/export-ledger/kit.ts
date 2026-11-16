// CT-24zzm rule-test kit (claude-independent, SPEC_REF ba6655b1; 规划/08 BR-ID-42 后台导出任务,
// BR-FUND-16; 04 §11.1 export / fund.view / user.lookup; contract adminCreateExport with the new
// export_resource value `ledger`, filters = the query parameters of adminListLedgerEntries without
// paging, columns = its response fields; task notes D10-1740 / D10-1742).
// Real pieces, nothing of the code under test is replaced:
//   admin   createHttpApp('admin') through ../tax-export/kit.ts `open` (exports' setup, real queue);
//   worker  createWorkerContext('worker') over the same config, clock, logger and database, and
//           whatever app.module assembles for the export queue (so the ledger read port is the
//           real one);
//   books   users rows written directly (identity's table, as other ledger rule tests do), the
//           user's balance account and every voucher posted through the real ledger
//           (createLedger), on a clock of its own: booked_at and accounting dates lie days before
//           the console's clock, so no admin session has to be moved forward over a day;
//   oracle  GET /admin/v1/ledger on the same admin entry, as the same creator, with the same
//           filters: the file must hold exactly the rows and values the list answers.
// Ledger tasks are only ever created over HTTP: until the implementation opens the resource, the
// route schema refuses it and the table's CHECK does too, and a red must be an assertion.
// Provisioners are passed in by the *.int.test.ts files.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createLedger, type PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { Harness, Response } from '../auth/kit.ts';
import { parseCsv } from '../export-worker/kit.ts';
import { error, ok, type View } from '../exports/kit.ts';
import { open, type Tax } from '../tax-export/kit.ts';
import { user } from '../../payment/orders/kit.ts';

export { harness, setMaxRows, colleague, untouched } from '../tax-export/kit.ts';

export const LEDGER_PATH = '/admin/v1/ledger';
/** 04 §11.1 / adminListLedgerEntries: either read point opens the source list. */
export const VIEW = 'fund.view';
export const LOOKUP = 'user.lookup';
export const EXPORT = 'export';
export const DENIED = { reason: 'admin_permission_denied' } as const;
/** BR-ID-42: each link lives at most 5 minutes; the file 24 hours after generation. */
export const LINK_TTL_MS = 300_000;
export const DAY_MS = 86_400_000;
/** Every pii point of 04 §11.1: none of them may change a ledger file. */
export const PII_POINTS = ['pii.reveal_phone', 'pii.reveal_identity'] as const;
/** Internal texts the books carry; none may reach a file (adminListLedgerEntries: 不含内部备注). */
export const INTERNAL_TEXT = 'ct24zzm-internal';

/**
 * Column order of the file (task notes D10-1742: the item fields of adminListLedgerEntries one by
 * one). The header spelling of the nested fields is not fixed by the notes, so each header cell is
 * matched by the field it must name.
 */
export const HEADER: readonly RegExp[] = [
  /entry_id/,
  /booked_at/,
  /accounting_date/,
  /ledger_type/,
  /sub_type/,
  /sub_account/,
  /amount_fen/,
  /balance_after_fen/,
  /voucher_id/,
  /uniq_key/,
  /biz_type/,
  /biz_id/,
  /link.?type/,
  /link.?id/,
];
export const COLUMN = {
  entryId: 0,
  bookedAt: 1,
  accountingDate: 2,
  ledgerType: 3,
  subType: 4,
  subAccount: 5,
  amount: 6,
  balanceAfter: 7,
  voucherId: 8,
  uniqKey: 9,
  bizType: 10,
  bizId: 11,
  linkType: 12,
  linkId: 13,
} as const;

// ---------------------------------------------------------------------------------------------
// The books: one ledger on its own clock. Instants are +08:00 accounting days before the console's
// clock (test/spec/admin/auth/kit.ts NOW = 2026-10-09 10:00 +08:00).

/** 2026-10-07 10:00 +08:00. */
export const AT_1 = '2026-10-07T02:00:00.000Z';
/** 2026-10-08 11:00 +08:00. */
export const AT_2 = '2026-10-08T03:00:00.000Z';
/** 2026-10-08 13:00 +08:00. */
export const AT_3 = '2026-10-08T05:00:00.000Z';
/** 2026-10-09 09:00 +08:00 (two vouchers at this same instant). */
export const AT_4 = '2026-10-09T01:00:00.000Z';
// Around the +08:00 day cut (BR-FUND-16: 00:00 +08:00): the UTC date of these instants is 10-08
// while the accounting date of the last two is 10-09.
/** 2026-10-08 23:59:59 +08:00, accounting date 2026-10-08. */
export const LAST_SECOND = '2026-10-08T15:59:59.000Z';
/** 2026-10-09 00:00:00 +08:00, accounting date 2026-10-09 (UTC date 2026-10-08). */
export const MIDNIGHT = '2026-10-08T16:00:00.000Z';
/** 2026-10-09 07:30 +08:00, accounting date 2026-10-09 (UTC date 2026-10-08). */
export const EARLY = '2026-10-08T23:30:00.000Z';

export interface Owner {
  readonly userId: string;
  readonly accountId: string;
}

export interface UserLine {
  readonly sub: 'available' | 'frozen';
  /** Storage sign: a user entry is debit positive, so a credit to the user is negative. */
  readonly fen: bigint;
}

export interface VoucherSeed {
  readonly ledgerType: string;
  readonly subType?: string | null;
  readonly lines: readonly UserLine[];
  readonly bizType?: string;
  readonly bizId?: string;
  readonly uniqKey?: string;
  readonly operator?: string;
  readonly memo?: string | null;
}

export interface Posted {
  readonly voucherId: string;
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
}

export function books(h: Harness, appId: string) {
  const clock = new FixedClock(AT_1);
  const ledger = createLedger({ clock });

  /** A user of the app with an open balance account and no entries. */
  async function member(targetApp = appId): Promise<Owner> {
    const userId = await user(h.db, targetApp, clock);
    const account = await h.db
      .transaction()
      .execute((trx) => ledger.openUserAccount(trx, { appId: targetApp, userId }));
    return { userId, accountId: account.account_id };
  }

  /** One voucher of `who` at `at`: the user lines, then the platform balancing line. */
  async function post(who: Owner, at: string, seed: VoucherSeed, targetApp = appId) {
    clock.set(at);
    return h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId: targetApp, userIds: [who.userId] });
      return postIn(trx, who, seed, targetApp);
    });
  }

  /**
   * One credit of `who` per amount, all in one transaction: the ledger books every voucher of a
   * transaction at the same instant, so they all carry booked_at `at` (entry ids in this order).
   */
  async function burst(who: Owner, at: string, fens: readonly bigint[]): Promise<Posted[]> {
    clock.set(at);
    return h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [who.userId] });
      const posted: Posted[] = [];
      for (const fen of fens) {
        posted.push(
          await postIn(
            trx,
            who,
            { ledgerType: 'REBATE_CREDIT', lines: [{ sub: 'available', fen: -fen }] },
            appId,
          ),
        );
      }
      return posted;
    });
  }

  async function postIn(
    trx: Transaction<DB>,
    who: Owner,
    seed: VoucherSeed,
    targetApp: string,
  ): Promise<Posted> {
    const bizId = seed.bizId ?? randomUUID();
    const bizType = seed.bizType ?? 'FIXTURE';
    const uniqKey = seed.uniqKey ?? `fixture:${randomUUID()}`;
    const subType = seed.subType ?? null;
    const entries: PostingEntry[] = seed.lines.map((line): PostingEntry => ({
      account: { ownerType: 'user', accountId: who.accountId },
      sub_account: line.sub,
      amount_fen: line.fen,
      ledger_type: seed.ledgerType,
      sub_type: subType,
      income_type: 'SERVICE_FEE',
    }));
    const net = seed.lines.reduce((sum, line) => sum + line.fen, 0n);
    if (net !== 0n) {
      entries.push({
        account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
        sub_account: 'available',
        amount_fen: -net,
        ledger_type: seed.ledgerType,
        sub_type: subType,
        income_type: null,
      });
    }
    const result = await ledger.post(trx, {
      appId: targetApp,
      uniqKey,
      bizType,
      bizId,
      operator: seed.operator ?? 'system',
      memo: seed.memo ?? null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
    expect(result.kind).toBe('posted');
    return { voucherId: result.voucherId, uniqKey, bizType, bizId } satisfies Posted;
  }

  /** Raises the user's available by `fen` (REBATE_CREDIT unless given). */
  const credit = (who: Owner, at: string, fen: bigint, seed: Partial<VoucherSeed> = {}) =>
    post(who, at, {
      ledgerType: 'REBATE_CREDIT',
      ...seed,
      lines: [{ sub: 'available', fen: -fen }],
    });

  return { clock, ledger, member, post, burst, credit };
}
export type Books = ReturnType<typeof books>;

export interface Story {
  readonly a: Owner;
  /** A neighbour in the same app; none of its entries may reach a's file. */
  readonly b: Owner;
  /** REBATE_CREDIT +1000 on 2026-10-07 (biz FIXTURE, no link). */
  readonly v1: Posted;
  /** REFERRAL_CREDIT / DIRECT +300 on 2026-10-08. */
  readonly v2: Posted;
  /** b: REBATE_CREDIT +700 on 2026-10-08. */
  readonly vb: Posted;
  /** WITHDRAW_FREEZE 500, available → frozen, on 2026-10-08 (biz withdrawal; two user entries). */
  readonly v3: Posted;
  /** ADMIN_ADJUST +200 on 2026-10-09 with an internal memo and operator (biz admin_adjustment). */
  readonly v4: Posted;
  /** CLAWBACK / FULL −100 on 2026-10-09, the same instant as v4. */
  readonly v5: Posted;
}

/** a's six entries over three accounting days, and a neighbour's one. */
export async function seedStory(b: Books): Promise<Story> {
  const a = await b.member();
  const other = await b.member();
  const v1 = await b.credit(a, AT_1, 1_000n);
  const v2 = await b.credit(a, AT_2, 300n, { ledgerType: 'REFERRAL_CREDIT', subType: 'DIRECT' });
  const vb = await b.credit(other, AT_2, 700n);
  const withdrawalId = randomUUID();
  const v3 = await b.post(a, AT_3, {
    ledgerType: 'WITHDRAW_FREEZE',
    lines: [
      { sub: 'available', fen: 500n },
      { sub: 'frozen', fen: -500n },
    ],
    bizType: 'withdrawal',
    bizId: withdrawalId,
    uniqKey: `WITHDRAW_FREEZE:${withdrawalId}`,
  });
  const adjustId = randomUUID();
  const v4 = await b.credit(a, AT_4, 200n, {
    ledgerType: 'ADMIN_ADJUST',
    bizType: 'admin_adjustment',
    bizId: adjustId,
    uniqKey: `ADJ:${adjustId}`,
    operator: `admin:${INTERNAL_TEXT}-operator`,
    memo: `${INTERNAL_TEXT}-memo`,
  });
  const v5 = await b.post(a, AT_4, {
    ledgerType: 'CLAWBACK',
    subType: 'FULL',
    lines: [{ sub: 'available', fen: 100n }],
  });
  return { a, b: other, v1, v2, vb, v3, v4, v5 };
}

// ---------------------------------------------------------------------------------------------
// The console.

/** exports' setup (the worker entry booted on first use), for an account holding `points`. */
export function openConsole(h: Harness, points: readonly string[], isSuper = false) {
  return open(h, points, isSuper);
}
export type Console = Tax;

export function ledgerBody(filters: Readonly<Record<string, string>>) {
  return { resource: 'ledger', filters } as const;
}

/** Creates the export over HTTP (202 and the contract), then runs the generate job it enqueued. */
export async function exported(
  f: Console,
  filters: Readonly<Record<string, string>>,
  token?: string,
): Promise<{ readonly view: View; readonly row: Awaited<ReturnType<Console['read']>> }> {
  const response =
    token === undefined
      ? await f.create(ledgerBody(filters))
      : await f.request('POST', '/admin/v1/exports', ledgerBody(filters), undefined, token);
  const view = await ok<View>(response);
  expect(view).toMatchObject({ resource: 'ledger', masked: true, status: 'pending' });
  const row = await f.generate(view.id);
  return { view, row };
}

export interface LedgerFile {
  readonly header: readonly string[];
  readonly rows: readonly string[][];
}

/** The stored CSV of a done task (BOM, text/csv and the object key checked by the tax kit). */
export async function fileOf(f: Console, publicId: string): Promise<LedgerFile> {
  const [header, ...rows] = parseCsv(await f.stored(publicId));
  expect(header, '第一行须是表头').toBeDefined();
  expect(header!.length, `表头列数：${JSON.stringify(header)}`).toBe(HEADER.length);
  HEADER.forEach((pattern, index) => {
    expect(header![index], `第 ${index + 1} 列表头`).toMatch(pattern);
  });
  for (const row of rows) expect(row, JSON.stringify(row)).toHaveLength(HEADER.length);
  return { header: header!, rows };
}

export interface LedgerItem {
  readonly entry_id: string;
  readonly booked_at: string;
  readonly accounting_date: string;
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly sub_account: string;
  readonly amount_fen: number;
  readonly balance_after_fen: number | null;
  readonly voucher: {
    readonly voucher_id: string;
    readonly uniq_key: string;
    readonly biz_type: string;
    readonly biz_id: string;
  };
  readonly link: { readonly type: string; readonly id: string } | null;
}

/** The list's largest page (adminListLedgerEntries page_size ≤ 200). */
const LIST_PAGE = 200;

/**
 * GET /admin/v1/ledger with the filters as the creator, every row: pages 1, 2, … of page_size 200
 * (the maximum) concatenated, until the list's total is reached.
 */
export async function listed(
  f: Console,
  filters: Readonly<Record<string, string>>,
  token?: string,
): Promise<{ readonly items: readonly LedgerItem[]; readonly total: number }> {
  const items: LedgerItem[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      ...filters,
      page: String(page),
      page_size: String(LIST_PAGE),
    }).toString();
    const response: Response = await f.request(
      'GET',
      `${LEDGER_PATH}?${query}`,
      undefined,
      undefined,
      token,
    );
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    const data = response.json<{ code: number; data: { items: LedgerItem[]; total: number } }>();
    expect(data.code).toBe(0);
    total = data.data.total;
    items.push(...data.data.items);
    if (data.data.items.length < LIST_PAGE || items.length >= total) break;
  }
  expect(items, '列表逐页拼起来须正好是 total 条').toHaveLength(total);
  expect(new Set(items.map((item) => item.entry_id)).size, '列表各页不得重复').toBe(total);
  return { items, total };
}

/** The cells a list item must become: values as the response gives them, null as empty. */
export function cellsOf(item: LedgerItem): string[] {
  return [
    item.entry_id,
    item.booked_at,
    item.accounting_date,
    item.ledger_type,
    item.sub_type ?? '',
    item.sub_account,
    String(item.amount_fen),
    item.balance_after_fen === null ? '' : String(item.balance_after_fen),
    item.voucher.voucher_id,
    item.voucher.uniq_key,
    item.voucher.biz_type,
    item.voucher.biz_id,
    item.link?.type ?? '',
    item.link?.id ?? '',
  ];
}

/**
 * A row with booked_at as epoch milliseconds: the instant must be the list's, written with its
 * offset (Z or ±hh:mm), whichever of the two the file uses.
 */
export function comparable(cells: readonly string[]): string[] {
  const booked = cells[COLUMN.bookedAt] ?? '';
  expect(booked, `booked_at 须带时区：${booked}`).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  const copy = [...cells];
  copy[COLUMN.bookedAt] = String(Date.parse(booked));
  return copy;
}

/** The file holds exactly the rows the list shows for the same filters, in the list's order. */
export async function expectSameAsList(
  f: Console,
  publicId: string,
  filters: Readonly<Record<string, string>>,
  token?: string,
): Promise<LedgerFile> {
  const file = await fileOf(f, publicId);
  const list = await listed(f, filters, token);
  expect(file.rows.map(comparable)).toEqual(list.items.map(cellsOf).map(comparable));
  expect((await f.tasks()).find((task) => task.public_id === publicId)?.row_count).toBe(list.total);
  return file;
}

/** The rows of one voucher in a file. */
export function rowsOf(file: LedgerFile, voucher: Posted): string[][] {
  return file.rows.filter((row) => row[COLUMN.voucherId] === voucher.voucherId);
}

/** 20001 whose fields name exactly these filters, bare or under `filters.`. */
export async function filtersRefused(response: Response, names: readonly string[]) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  const fields = response.json<{ data: { fields: string[] } }>().data.fields;
  expect(fields.map((field) => field.replace(/^filters\./, '')).sort()).toEqual([...names].sort());
}

/** A refusal by the request's shape: 20001 with at least one field named, valid envelope. */
export async function shapeRefused(response: Response) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  const fields = response.json<{ data: { fields: string[] } }>().data.fields;
  expect(Array.isArray(fields) && fields.length > 0, JSON.stringify(response.json())).toBe(true);
}

/** 10403 admin_permission_denied, through the contract. */
export function denied(response: Response) {
  return error(response, 10403, DENIED);
}
