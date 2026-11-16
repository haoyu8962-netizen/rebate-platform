// F1-08fa fixtures: contract-shaped data and a fake /admin/v1 server for the read-only 余额流水 page
// (资金 / 余额流水, menu id `ledger`). Operations as merged in contracts/openapi.yaml (CT-24zzc,
// implemented by B2-02u):
//   adminGetUserFundSummary  GET /admin/v1/users/{user_id}/fund-summary
//   adminListLedgerEntries   GET /admin/v1/ledger?user_id=…
// Both: fund.view or user.lookup (either one), else 10403 admin_permission_denied; an unknown
// user_id (or one of another app, or malformed) is 20001 with data.fields=[user_id]; page_size at
// most 200; accounting_date_from later than accounting_date_to is 20001 with both fields. The fake
// server checks in that order and answers the entries in the order given (latest first).
// Names of ledger_type / ledger_sub_account / withdraw_hold_kind come from the console dictionary
// (BR-TEXT-25 `admin_dict.<enum>.<code>`, contracts/texts.admin.default.json) and fall back to the
// code when the dictionary has no row; the expected values below read the dictionary when the test
// runs (so a dictionary mocked by a test file is the one used). Amounts only go through
// @couli/money (BR-TEXT-10 admin format).
import dictionary from '../../../../contracts/texts.admin.default.json' with { type: 'json' };
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';

export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const ROUTE = '/ledger';
export const EXPORTS_ROUTE = '/exports';
export const LEDGER = '/admin/v1/ledger';
export const EXPORTS = '/admin/v1/exports';
/** The page's page_size (the contract's default; ≤ 200). */
export const PAGE_SIZE = '20';

export type Entry = Schema<'AdminLedgerEntry'>;
export type Summary = Schema<'AdminUserFundSummary'>;
export type LedgerType = Schema<'AdminLedgerType'>;
export type SubAccount = Schema<'AdminLedgerSubAccount'>;

/** contracts AdminLedgerType, in enum order. */
export const LEDGER_TYPES: readonly LedgerType[] = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
];
export const SUB_ACCOUNTS: readonly SubAccount[] = ['available', 'frozen'];

export function summaryPath(userId: string): string {
  return `/admin/v1/users/${userId}/fund-summary`;
}

// ---- fixed copy (no texts/ledger.ts yet; written here from the task's meaning) ----------------

/** Visible copy the page shows; each value is compared as a whole string. */
export const COPY = {
  title: '余额流水',
  uidLabel: '用户 UID',
  query: '查询',
  reset: '重置',
  retry: '重试',
  exportsEntry: '导出记录',
  uidRequired: '请输入用户 UID',
  /** 20001 data.fields=[user_id]: unknown, malformed or of another app (contract). */
  uidUnknown: 'UID 不存在或格式不对',
  forbiddenTitle: '无权限查看余额流水',
  forbiddenDescription: '当前账号没有资金查看权限点（fund.view 或 user.lookup），请联系超管勾选。',
  ledgerFailed: '余额流水加载失败',
  summaryFailed: '资金摘要加载失败',
  empty: '暂无余额流水',
  /** Local check before any request (from later than to; contract would answer 20001). */
  dateRange: '会计日起不能晚于会计日止',
  dash: '—',
  noHold: '无',
  holdJoiner: '、',
} as const;

/** Summary labels (adminGetUserFundSummary), in display order. */
export const SUMMARY_LABEL = {
  userId: '用户 UID',
  available: '可用余额',
  frozen: '冻结金额',
  negativeSince: '负余额起始日',
  withdrawn: '已提现',
  block: '提现限制',
} as const;

/** Column titles of the ledger table (adminListLedgerEntries), in display order. */
export const COLUMNS: readonly string[] = [
  '记账时间',
  '会计日',
  '流水类型',
  '子类型',
  '子户',
  '金额',
  '变动后余额',
  '凭证号',
  '业务单号',
];

/** Labels of the filter fields (the filter form, shown once a user was queried). */
export const FILTER_LABEL = {
  ledgerType: '流水类型',
  subType: '子类型',
  subAccount: '子户',
  dateFrom: '会计日起',
  dateTo: '会计日止',
  ref: '业务单号',
} as const;

// ---- dictionary oracle ---------------------------------------------------------------------

function dictTexts(): Readonly<Record<string, string>> {
  return (dictionary as { texts?: Record<string, string> }).texts ?? {};
}
function dictName(key: string, code: string): string {
  const texts = dictTexts();
  const name = Object.hasOwn(texts, key) ? texts[key] : undefined;
  return typeof name === 'string' && name !== '' ? name : code;
}
/** admin_dict.ledger_type.<code>, else the code. */
export function typeName(code: string): string {
  return dictName(`admin_dict.ledger_type.${code}`, code);
}
/** admin_dict.ledger_sub_account.<code>, else the code. */
export function subAccountName(code: string): string {
  return dictName(`admin_dict.ledger_sub_account.${code}`, code);
}
/** admin_dict.withdraw_hold_kind.<code>, else the code. */
export function holdName(code: string): string {
  return dictName(`admin_dict.withdraw_hold_kind.${code}`, code);
}

// ---- amounts -------------------------------------------------------------------------------

/** An entry amount as shown: user's view, signed (+ for credits, - for debits, none for 0). */
export function signedYuan(fen: number): string {
  return formatYuanAdmin(BigInt(fen), { signed: true });
}
/** A balance as shown (minus only when negative). */
export function yuan(fen: number): string {
  return formatYuanAdmin(BigInt(fen));
}

// ---- users ---------------------------------------------------------------------------------

/** Negative balance, two holds, six entries of both sub-accounts. */
export const UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04';
/** Positive balance, no hold, no entry at all (empty list). */
export const PLAIN_UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c05';
/** 25 entries (two pages of 20). */
export const MANY_UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c06';
/** Well formed, but no user of this app (unknown or of another app): 20001 [user_id]. */
export const UNKNOWN_UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c99';
/** Not an id at all: the server answers 20001 [user_id] (the contract checks the format). */
export const MALFORMED_UID = 'not-a-uid';

export const SUMMARIES: Readonly<Record<string, Summary>> = {
  [UID]: {
    user_id: UID,
    available_fen: -1200,
    frozen_fen: 5000,
    negative_since: '2026-10-30',
    withdrawn_fen: 30000,
    withdraw_block: { blocked: true, hold_kinds: ['manual', 'recon_diff'] },
  },
  [PLAIN_UID]: {
    user_id: PLAIN_UID,
    available_fen: 1200,
    frozen_fen: 0,
    negative_since: null,
    withdrawn_fen: 0,
    withdraw_block: { blocked: false, hold_kinds: [] },
  },
  [MANY_UID]: {
    user_id: MANY_UID,
    available_fen: 1234567,
    frozen_fen: 0,
    negative_since: null,
    withdrawn_fen: 89000,
    withdraw_block: { blocked: false, hold_kinds: [] },
  },
};

/** The summary of `userId` as label / value pairs, in display order. */
export function summaryShown(userId: string): [string, string][] {
  const summary = SUMMARIES[userId]!;
  const holds = summary.withdraw_block.hold_kinds.map((kind) => holdName(kind));
  return [
    [SUMMARY_LABEL.userId, summary.user_id],
    [SUMMARY_LABEL.available, yuan(summary.available_fen)],
    [SUMMARY_LABEL.frozen, yuan(summary.frozen_fen)],
    [SUMMARY_LABEL.negativeSince, summary.negative_since ?? COPY.dash],
    [SUMMARY_LABEL.withdrawn, yuan(summary.withdrawn_fen)],
    [
      SUMMARY_LABEL.block,
      summary.withdraw_block.blocked ? holds.join(COPY.holdJoiner) : COPY.noHold,
    ],
  ];
}

// ---- entries of UID (latest booked_at first, then entry_id descending) ---------------------

const ORDER_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c06';
const WITHDRAWAL_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c02';
const REWARD_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c05';
const REFERRAL_ORDER_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c07';

/** After-sale partial refund: negative amount and negative balance; booked in UTC (Z). */
export const CLAWED: Entry = {
  entry_id: '1006',
  booked_at: '2026-11-06T01:15:30Z',
  accounting_date: '2026-11-06',
  ledger_type: 'CLAWBACK',
  sub_type: 'PART_REFUND',
  sub_account: 'available',
  amount_fen: -123456,
  balance_after_fen: -1200,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b06',
    uniq_key: `CLAWBACK:PART_REFUND:${ORDER_ID}`,
    biz_type: 'order',
    biz_id: ORDER_ID,
  },
  link: { type: 'order', id: ORDER_ID },
};
const FREEZE_VOUCHER = {
  voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b02',
  uniq_key: `WITHDRAW_FREEZE:${WITHDRAWAL_ID}`,
  biz_type: 'withdrawal',
  biz_id: WITHDRAWAL_ID,
};
/** The frozen side of a withdrawal freeze (credit of the frozen sub-account). */
export const FROZE: Entry = {
  entry_id: '1002',
  booked_at: '2026-11-05T10:00:00+08:00',
  accounting_date: '2026-11-05',
  ledger_type: 'WITHDRAW_FREEZE',
  sub_type: null,
  sub_account: 'frozen',
  amount_fen: 5000,
  balance_after_fen: 5000,
  voucher: FREEZE_VOUCHER,
  link: { type: 'withdrawal', id: WITHDRAWAL_ID },
};
/** The available side of the same voucher. */
export const FREED: Entry = {
  entry_id: '1001',
  booked_at: '2026-11-05T10:00:00+08:00',
  accounting_date: '2026-11-05',
  ledger_type: 'WITHDRAW_FREEZE',
  sub_type: null,
  sub_account: 'available',
  amount_fen: -5000,
  balance_after_fen: 1200,
  voucher: FREEZE_VOUCHER,
  link: { type: 'withdrawal', id: WITHDRAWAL_ID },
};
/** A zero fee: amount 0 without a sign, balance 0 shown as an amount (not the empty mark). */
export const FEE: Entry = {
  entry_id: '1000',
  booked_at: '2026-11-04T23:59:59+08:00',
  accounting_date: '2026-11-04',
  ledger_type: 'WITHDRAW_FEE',
  sub_type: null,
  sub_account: 'frozen',
  amount_fen: 0,
  balance_after_fen: 0,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b03',
    uniq_key: `WITHDRAW_FEE:${WITHDRAWAL_ID}`,
    biz_type: 'withdrawal',
    biz_id: WITHDRAWAL_ID,
  },
  link: { type: 'withdrawal', id: WITHDRAWAL_ID },
};
/** balance_after_fen not recorded (null): the empty mark, never ¥0.00. */
export const REWARDED: Entry = {
  entry_id: '998',
  booked_at: '2026-11-01T09:00:00+08:00',
  accounting_date: '2026-11-01',
  ledger_type: 'REWARD',
  sub_type: 'invite',
  sub_account: 'available',
  amount_fen: 800,
  balance_after_fen: null,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b05',
    uniq_key: `REWARD:invite:${REWARD_ID}`,
    biz_type: 'reward',
    biz_id: REWARD_ID,
  },
  link: null,
};
/** Indirect referral share; booked just after midnight Beijing time (16:30:05Z the day before). */
export const REFERRED: Entry = {
  entry_id: '997',
  booked_at: '2026-10-31T16:30:05Z',
  accounting_date: '2026-11-01',
  ledger_type: 'REFERRAL_CREDIT',
  sub_type: 'INDIRECT',
  sub_account: 'available',
  amount_fen: 61,
  balance_after_fen: 6200,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b07',
    uniq_key: `REFERRAL_CREDIT:INDIRECT:${REFERRAL_ORDER_ID}`,
    biz_type: 'order',
    biz_id: REFERRAL_ORDER_ID,
  },
  link: { type: 'order', id: REFERRAL_ORDER_ID },
};

export const ENTRIES: readonly Entry[] = [CLAWED, FROZE, FREED, FEE, REWARDED, REFERRED];

/** Beijing booking times of the samples (hand-computed from booked_at). */
const BOOKED_SHOWN: Readonly<Record<string, string>> = {
  [CLAWED.entry_id]: '2026-11-06 09:15:30',
  [FROZE.entry_id]: '2026-11-05 10:00:00',
  [FREED.entry_id]: '2026-11-05 10:00:00',
  [FEE.entry_id]: '2026-11-04 23:59:59',
  [REWARDED.entry_id]: '2026-11-01 09:00:00',
  [REFERRED.entry_id]: '2026-11-01 00:30:05',
};

/** `count` entries of MANY_UID, latest first (one per hour backwards from 2026-11-10 20:00 +08). */
export function manyEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index): Entry => {
    const hour = String(20 - (index % 20)).padStart(2, '0');
    const day = String(10 - Math.floor(index / 20)).padStart(2, '0');
    const stamp = `2026-11-${day}T${hour}:00:00+08:00`;
    const ref = `0199a3b4-5c6d-7e8f-9a0b-${String(100000000000 + index)}`;
    return {
      entry_id: String(5000 - index),
      booked_at: stamp,
      accounting_date: stamp.slice(0, 10),
      ledger_type: 'REBATE_CREDIT',
      sub_type: null,
      sub_account: 'available',
      amount_fen: 100 + index,
      balance_after_fen: 10000 + index,
      voucher: {
        voucher_id: `0199a3b4-5c6d-7e8f-9a0b-${String(200000000000 + index)}`,
        uniq_key: `REBATE_CREDIT:${ref}`,
        biz_type: 'order',
        biz_id: ref,
      },
      link: { type: 'order', id: ref },
    };
  });
}
export const MANY_TOTAL = 25;

/** The Beijing time an entry of manyEntries shows (its +08:00 stamp, written out). */
function manyShown(entry: Entry): string {
  return `${entry.booked_at.slice(0, 10)} ${entry.booked_at.slice(11, 19)}`;
}

/** One table row as shown, cell by cell (COLUMNS order). */
export function rowShown(entry: Entry): string[] {
  return [
    BOOKED_SHOWN[entry.entry_id] ?? manyShown(entry),
    entry.accounting_date,
    typeName(entry.ledger_type),
    entry.sub_type ?? COPY.dash,
    subAccountName(entry.sub_account),
    signedYuan(entry.amount_fen),
    entry.balance_after_fen === null ? COPY.dash : yuan(entry.balance_after_fen),
    entry.voucher.uniq_key,
    entry.voucher.biz_id,
  ];
}

// ---- permissions ---------------------------------------------------------------------------

export function grants(...permissions: string[]): PermissionSnapshot {
  return { isSuper: false, permissions };
}
/** Sees the menu (fund.view) and reads. */
export const FUND_VIEW = grants('fund.view');
/** No menu (the menu only knows fund.view), but the contract lets it read. */
export const LOOKUP_ONLY = grants('user.lookup');
/** Neither read point. */
export const NO_READ = grants('order.view');
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- envelopes -----------------------------------------------------------------------------

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10403: 403,
  20001: 400,
  50001: 500,
};
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: STATUS[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
export function unavailable(): Response {
  return failure(50001, undefined, '服务暂时不可用');
}

// ---- fake server ---------------------------------------------------------------------------

export interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
interface Override {
  readonly method: string;
  readonly path: string | RegExp;
  readonly reply: Reply;
  readonly persistent: boolean;
}

export interface ServerOptions {
  /** Permission points the server checks (fund.view or user.lookup reads). */
  readonly permissions?: readonly string[];
  readonly isSuper?: boolean;
}

const POSITIVE = /^[1-9][0-9]*$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const SUMMARY_PATH = /^\/admin\/v1\/users\/([^/]+)\/fund-summary$/;

function isDay(value: string): boolean {
  const found = DATE.exec(value);
  if (found === null) return false;
  const real = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return real.toISOString().slice(0, 10) === value;
}

/** Every query parameter adminListLedgerEntries takes. */
export const LEDGER_PARAMS: readonly string[] = [
  'user_id',
  'ledger_type',
  'sub_type',
  'sub_account',
  'accounting_date_from',
  'accounting_date_to',
  'ref',
  'page',
  'page_size',
];

export function createServer(options: ServerOptions = {}) {
  const entries: Record<string, readonly Entry[]> = {
    [UID]: ENTRIES,
    [PLAIN_UID]: [],
    [MANY_UID]: manyEntries(MANY_TOTAL),
  };
  const log: RequestLog[] = [];
  const overrides: Override[] = [];
  const permissions = options.permissions ?? ['fund.view'];
  const canRead =
    options.isSuper === true ||
    permissions.includes('fund.view') ||
    permissions.includes('user.lookup');
  let inFlight = 0;

  function known(userId: string): boolean {
    return Object.hasOwn(SUMMARIES, userId);
  }

  function summary(userId: string): Response {
    if (!canRead) return denied();
    if (!known(userId)) return rejected(['user_id']);
    return ok(SUMMARIES[userId]);
  }

  function ledger(query: Record<string, string>): Response {
    if (!canRead) return denied();
    const userId = query['user_id'];
    if (userId === undefined || !known(userId)) return rejected(['user_id']);
    const { page, page_size: size } = query;
    const from = query['accounting_date_from'];
    const to = query['accounting_date_to'];
    const type = query['ledger_type'];
    const account = query['sub_account'];
    const typeOk = type === undefined || LEDGER_TYPES.some((one) => one === type);
    const accountOk = account === undefined || SUB_ACCOUNTS.some((one) => one === account);
    const invalid = [
      ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
      ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
      ...(typeOk ? [] : ['ledger_type']),
      ...(accountOk ? [] : ['sub_account']),
      ...(from === undefined || isDay(from) ? [] : ['accounting_date_from']),
      ...(to === undefined || isDay(to) ? [] : ['accounting_date_to']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (from !== undefined && to !== undefined && from > to)
      return rejected(['accounting_date_from', 'accounting_date_to']);
    const matching = (entries[userId] ?? []).filter(
      (entry) =>
        (type === undefined || entry.ledger_type === type) &&
        (query['sub_type'] === undefined || entry.sub_type === query['sub_type']) &&
        (account === undefined || entry.sub_account === account) &&
        (from === undefined || entry.accounting_date >= from) &&
        (to === undefined || entry.accounting_date <= to) &&
        (query['ref'] === undefined || entry.voucher.biz_id === query['ref']),
    );
    const pageNo = page === undefined ? 1 : Number(page);
    const pageSize = size === undefined ? 20 : Number(size);
    return ok({
      items: matching.slice((pageNo - 1) * pageSize, pageNo * pageSize),
      page: pageNo,
      page_size: pageSize,
      total: matching.length,
    });
  }

  function normal(request: RequestLog, authorization: string | null): Response {
    if (authorization !== 'Bearer example-admin-token') return failure(10001, undefined, '未登录');
    if (request.method !== 'GET') return rejected(['path']);
    const found = SUMMARY_PATH.exec(request.path);
    if (found !== null) return summary(decodeURIComponent(found[1]!));
    if (request.path === LEDGER) return ledger(request.query);
    // The 导出记录 page reached through 【导出记录】: an empty list.
    if (request.path === EXPORTS) return ok({ items: [], page: 1, page_size: 20, total: 0 });
    return rejected(['path']);
  }

  function matches(entry: Override, request: RequestLog): boolean {
    if (entry.method !== request.method) return false;
    const { path } = entry;
    return typeof path === 'string' ? path === request.path : path.test(request.path);
  }
  function remove(entry: Override): void {
    const index = overrides.indexOf(entry);
    if (index >= 0) overrides.splice(index, 1);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const request: RequestLog = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    log.push(request);
    inFlight += 1;
    try {
      const entry = overrides.find((one) => matches(one, request));
      if (entry === undefined) return normal(request, headers.get('Authorization'));
      if (!entry.persistent) remove(entry);
      return await entry.reply(request);
    } finally {
      inFlight -= 1;
    }
  };

  return {
    log,
    fetch,
    get pending() {
      return inFlight;
    },
    /** Queries of GET /admin/v1/ledger, in order. */
    ledgerQueries(): Record<string, string>[] {
      return log.filter((r) => r.method === 'GET' && r.path === LEDGER).map((r) => r.query);
    },
    /** GET …/fund-summary requests, in order. */
    summaryReads(): RequestLog[] {
      return log.filter((r) => r.method === 'GET' && SUMMARY_PATH.test(r.path));
    },
    /** Requests to either operation of this page. */
    pageReads(): RequestLog[] {
      return log.filter((r) => r.path === LEDGER || SUMMARY_PATH.test(r.path));
    },
    /** Every request whose method is not GET. */
    writes(): RequestLog[] {
      return log.filter((r) => r.method !== 'GET');
    },
    /** Answers the next request of `method` `path` with `reply`. */
    once(method: string, path: string | RegExp, reply: Reply) {
      overrides.push({ method, path, reply, persistent: false });
    },
    /** Answers every request of `method` `path` with `reply` until the returned call. */
    always(method: string, path: string | RegExp, reply: Reply) {
      const entry: Override = { method, path, reply, persistent: true };
      overrides.push(entry);
      return () => remove(entry);
    },
    /** Holds every request of `method` `path` until the returned call, then answers as usual. */
    hold(method: string, path: string | RegExp) {
      const gate = Promise.withResolvers<void>();
      const entry: Override = {
        method,
        path,
        persistent: true,
        reply: async (request) => {
          await gate.promise;
          return normal(request, 'Bearer example-admin-token');
        },
      };
      overrides.push(entry);
      return () => {
        remove(entry);
        gate.resolve();
      };
    },
  };
}
export type Server = ReturnType<typeof createServer>;

/** Matches GET …/fund-summary of any user. */
export const ANY_SUMMARY = SUMMARY_PATH;
