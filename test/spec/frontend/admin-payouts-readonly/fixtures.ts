import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  BASE_URL,
  PHONE,
  REVIEWER,
  USER,
  allowedRequest,
  createServer,
  denied,
  detailPath,
  failure,
  ok,
  rejected,
  samples,
  snapshot,
  type Grants,
  type RequestLog,
  type RequestMatch,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

// Contract-shaped fixtures for the read-only payout tabs of /withdrawals (F1-08ba; contracts/
// openapi.yaml, tag admin-withdrawals): adminGetPayoutOverview GET /admin/v1/payout-overview
// (payout.execute or fund.view, no parameters), adminListUnknownPayouts GET
// /admin/v1/unknown-payouts (payout.execute, AdminPage / AdminPageSize), and the frozen fake server
// of listAdminWithdrawals / getAdminWithdrawal (admin-withdrawals/fixtures.ts) underneath. Ids are
// obvious fake UUIDs; numbers, amounts and admins are samples.
export { BASE_URL, denied, detailPath, failure, ok, snapshot };
export type { Grants, RequestLog, RequestMatch, Withdrawal };

export const LIST = '/admin/v1/withdrawals';
export const OVERVIEW = '/admin/v1/payout-overview';
export const UNKNOWN = '/admin/v1/unknown-payouts';

export type Overview = Schema<'AdminPayoutOverview'>;
export type OverviewChannel = Schema<'AdminPayoutOverviewChannel'>;
export type UnknownItem = Schema<'AdminUnknownPayoutItem'>;
type Attempt = Withdrawal['payout_attempts'][number];

/** Every grant of a full finance account (writes included; this page still offers none). */
export const ALL: Grants = [
  'withdraw.review',
  'fund.view',
  'payout.execute',
  'payout.manual_entry',
  'export',
  'config.business',
  'pii.reveal_identity',
  'pii.reveal_phone',
];
export const VIEW: Grants = ['fund.view'];
export const EXECUTE: Grants = ['payout.execute'];
export const VIEW_EXECUTE: Grants = ['fund.view', 'payout.execute'];
export const REVIEW: Grants = ['withdraw.review'];
export const LOOKUP: Grants = ['user.lookup'];

export const QID = {
  /** APPROVED, alipay, manual review (待执行). */
  approvedA: 'e2000001-0000-4000-8000-000000000001',
  /** PAYING, alipay, three attempts (transfer unknown, query unknown, query pending). */
  paying: 'e2000002-0000-4000-8000-000000000002',
  /** PENDING_REVIEW: not part of the queue. */
  pending: 'e2000003-0000-4000-8000-000000000003',
  /** APPROVED, bank card, fee and tax, no attempt (待执行). */
  approvedB: 'e2000004-0000-4000-8000-000000000004',
  /** PAYING, needs_manual (T+24h passed): listed in 结果待确认 too. */
  stuck: 'e2000005-0000-4000-8000-000000000005',
  /** PAID_API: not part of the queue. */
  paid: 'e2000006-0000-4000-8000-000000000006',
  /** PAYING, needs_manual, no transfer attempt (no T). */
  untried: 'e2000007-0000-4000-8000-000000000007',
  /** PAYING with an attempt whose kind and result have no dictionary row (own server only). */
  odd: 'e2000008-0000-4000-8000-000000000008',
} as const;
export const QNO = {
  approvedA: 'W20261113000201',
  paying: 'W20261113000202',
  pending: 'W20261113000203',
  approvedB: 'W20261112000204',
  stuck: 'W20261112000205',
  paid: 'W20261111000206',
  untried: 'W20261111000207',
  odd: 'W20261110000208',
} as const;
export const BATCH_PAYING = 'b2000002-0000-4000-8000-000000000002';
export const ENTERED_BY = 'ad000003-0000-4000-8000-0000000000a3';

/** A clean detail: manual review, no marks, no batch, no attempt (fields set by each sample). */
function base(): Withdrawal {
  return {
    ...samples()[0]!,
    user: { user_id: USER.a, phone_masked: PHONE.a },
    review_mode: 'manual',
    payout_channel: 'alipay',
    payout_method: 'alipay',
    fee_fen: 0,
    tax_fen: 0,
    auto_decision: null,
    hold_reason: null,
    blocked_reason: null,
    needs_manual: false,
    reviewer_id: REVIEWER,
    risk_flags: [],
    review_deadline: null,
    batch_id: null,
    batch: null,
    batch_items: [],
    payout_attempts: [],
    holds: [],
    payee: { masked_account: 'zh***@example.com', masked_name: '**明', bank_name: null },
  };
}

function attempt(
  n: string,
  kind: Attempt['kind'],
  result: Attempt['result'],
  at: string,
  code: string | null = null,
  sub: string | null = null,
): Attempt {
  return {
    attempt_id: `a3000000-0000-4000-8000-0000000000${n}`,
    kind,
    result,
    resp_code: code,
    resp_sub_code: sub,
    at,
  };
}

/** The queue samples and two withdrawals outside the queue, newest applied first. */
export function queueSamples(): Withdrawal[] {
  return [
    {
      ...base(),
      withdrawal_id: QID.approvedA,
      out_biz_no: QNO.approvedA,
      status: 'APPROVED',
      display_status: 'pending_review',
      amount_fen: 50000,
      net_fen: 50000,
      reviewed_at: '2026-11-13T10:30:00+08:00',
      created_at: '2026-11-13T10:00:00+08:00',
      updated_at: '2026-11-13T10:30:00+08:00',
    },
    {
      ...base(),
      withdrawal_id: QID.paying,
      out_biz_no: QNO.paying,
      user: { user_id: USER.b, phone_masked: PHONE.b },
      status: 'PAYING',
      display_status: 'paying',
      amount_fen: 10000,
      fee_fen: 200,
      net_fen: 9800,
      reviewed_at: '2026-11-13T09:00:01+08:00',
      batch_id: BATCH_PAYING,
      batch: { batch_id: BATCH_PAYING, kind: 'manual', created_at: '2026-11-13T09:00:02+08:00' },
      batch_items: [
        {
          batch_id: BATCH_PAYING,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-11-13T09:00:03+08:00',
        },
      ],
      executed_at: '2026-11-13T09:00:03+08:00',
      execute_seq: 1,
      payout_attempts: [
        attempt('21', 'transfer', 'unknown', '2026-11-13T09:00:05+08:00'),
        attempt('22', 'query', 'unknown', '2026-11-13T09:01:05+08:00', 'SYSTEM_ERROR'),
        attempt('23', 'query', 'pending', '2026-11-13T09:05:05+08:00', '10000', 'PROCESSING'),
      ],
      created_at: '2026-11-13T09:00:00+08:00',
      updated_at: '2026-11-13T09:05:05+08:00',
    },
    {
      ...base(),
      withdrawal_id: QID.pending,
      out_biz_no: QNO.pending,
      status: 'PENDING_REVIEW',
      display_status: 'pending_review',
      amount_fen: 30000,
      net_fen: 30000,
      reviewer_id: null,
      reviewed_at: null,
      created_at: '2026-11-13T08:00:00+08:00',
      updated_at: '2026-11-13T08:00:00+08:00',
    },
    {
      ...base(),
      withdrawal_id: QID.approvedB,
      out_biz_no: QNO.approvedB,
      user: { user_id: USER.c, phone_masked: PHONE.c },
      status: 'APPROVED',
      display_status: 'pending_review',
      payout_channel: 'bank_card',
      payout_method: 'bank_card',
      amount_fen: 123456,
      fee_fen: 100,
      tax_fen: 2345,
      net_fen: 121011,
      reviewed_at: '2026-11-12T11:30:00+08:00',
      created_at: '2026-11-12T11:00:00+08:00',
      updated_at: '2026-11-12T11:30:00+08:00',
      payee: { masked_account: '尾号 1234', masked_name: '**三', bank_name: '招商银行' },
    },
    {
      ...base(),
      withdrawal_id: QID.stuck,
      out_biz_no: QNO.stuck,
      status: 'PAYING',
      display_status: 'paying',
      amount_fen: 10000,
      net_fen: 10000,
      needs_manual: true,
      reviewed_at: '2026-11-12T09:30:00+08:00',
      executed_at: '2026-11-12T10:00:00+08:00',
      execute_seq: 1,
      payout_attempts: [
        attempt('51', 'transfer', 'unknown', '2026-11-12T10:00:05+08:00'),
        attempt('52', 'query', 'unknown', '2026-11-13T10:00:05+08:00'),
      ],
      created_at: '2026-11-12T09:00:00+08:00',
      updated_at: '2026-11-13T10:00:05+08:00',
    },
    {
      ...base(),
      withdrawal_id: QID.paid,
      out_biz_no: QNO.paid,
      status: 'PAID_API',
      display_status: 'paid_auto_review',
      amount_fen: 8800,
      net_fen: 8800,
      reviewed_at: '2026-11-11T10:30:00+08:00',
      executed_at: '2026-11-11T10:31:00+08:00',
      execute_seq: 1,
      paid_at: '2026-11-11T10:32:00+08:00',
      channel_order_id: '20261111220014009',
      payout_attempts: [attempt('61', 'transfer', 'success', '2026-11-11T10:31:05+08:00')],
      created_at: '2026-11-11T10:00:00+08:00',
      updated_at: '2026-11-11T10:32:00+08:00',
    },
    {
      ...base(),
      withdrawal_id: QID.untried,
      out_biz_no: QNO.untried,
      user: { user_id: USER.b, phone_masked: PHONE.b },
      status: 'PAYING',
      display_status: 'paying',
      amount_fen: 20000,
      net_fen: 20000,
      needs_manual: true,
      reviewed_at: '2026-11-11T09:30:00+08:00',
      created_at: '2026-11-11T09:00:00+08:00',
      updated_at: '2026-11-12T09:30:00+08:00',
    },
  ];
}

interface Codes {
  readonly kind: string;
  readonly result: string;
  readonly code: string;
}
/** The codes of an attempt the console dictionary has no row for (a later enum value). */
export const UNLISTED: Codes = { kind: 'reverse', result: 'timeout', code: 'X_PENDING' };

/** A PAYING withdrawal whose only attempt carries an unlisted kind and result. */
export function oddSample(): Withdrawal {
  return {
    ...base(),
    withdrawal_id: QID.odd,
    out_biz_no: QNO.odd,
    status: 'PAYING',
    display_status: 'paying',
    amount_fen: 5000,
    net_fen: 5000,
    reviewed_at: '2026-11-10T09:30:00+08:00',
    payout_attempts: [
      {
        ...attempt('81', 'transfer', 'pending', '2026-11-10T10:00:05+08:00'),
        kind: UNLISTED.kind as Attempt['kind'],
        result: UNLISTED.result as Attempt['result'],
        resp_code: UNLISTED.code,
      },
    ],
    created_at: '2026-11-10T09:00:00+08:00',
    updated_at: '2026-11-10T10:00:05+08:00',
  };
}

/** `count` older APPROVED rows (W202611010003nn, n = 1…count, newest first). */
export function approvedFiller(count: number): Withdrawal[] {
  return Array.from({ length: count }, (_, index): Withdrawal => {
    const n = String(index + 1).padStart(2, '0');
    const minute = String(59 - index - 1).padStart(2, '0');
    return {
      ...base(),
      withdrawal_id: `e2f00000-0000-4000-8000-0000000000${n}`,
      out_biz_no: fillerNo(index + 1),
      status: 'APPROVED',
      display_status: 'pending_review',
      amount_fen: 1000,
      net_fen: 1000,
      reviewed_at: '2026-11-01T10:00:00+08:00',
      created_at: `2026-11-01T09:${minute}:00+08:00`,
      updated_at: '2026-11-01T10:00:00+08:00',
    };
  });
}
/** The out_biz_no of filler row `n` (1-based) of approvedFiller. */
export const fillerNo = (n: number): string => `W202611010003${String(n).padStart(2, '0')}`;

/** The overview sample: switches on, alipay W entered and low, bank card off, wechat paused. */
export function overview(): Overview {
  return {
    as_of: '2026-11-14T10:00:00+08:00',
    payout_enabled: true,
    queue_paused: false,
    single_cap_fen: 500000,
    daily_cap_fen: 5000000,
    daily_sent_fen: 123456,
    watermark_usable_bp: 9000,
    channels: [
      {
        channel: 'alipay',
        enabled: true,
        paused: false,
        watermark: {
          available_fen: 3000000,
          measured_at: '2026-11-14T09:00:00+08:00',
          entered_by: ENTERED_BY,
          entered_by_name: 'ops01',
        },
        forecast_withdrawal_fen: 2100000,
        water_level: 'low',
      },
      {
        channel: 'bank_card',
        enabled: false,
        paused: false,
        watermark: null,
        forecast_withdrawal_fen: 0,
        water_level: null,
      },
      {
        channel: 'wechat',
        enabled: true,
        paused: true,
        watermark: null,
        forecast_withdrawal_fen: 0,
        water_level: null,
      },
    ],
  };
}

/**
 * Other switches and limits than the sample (none of the sample's figures): payout off, queue
 * paused, alipay paused with no W (null, never a default) and so no conclusion.
 */
export function pausedOverview(): Overview {
  const sample = overview();
  return {
    ...sample,
    payout_enabled: false,
    queue_paused: true,
    single_cap_fen: 300000,
    daily_cap_fen: 4000000,
    daily_sent_fen: 0,
    watermark_usable_bp: 8500,
    channels: [
      {
        channel: 'alipay',
        enabled: true,
        paused: true,
        watermark: null,
        forecast_withdrawal_fen: 0,
        water_level: null,
      },
      sample.channels[1]!,
      sample.channels[2]!,
    ],
  };
}

/** The sample with the alipay channel's W and conclusion replaced. */
export function overviewWith(
  watermark: OverviewChannel['watermark'],
  level: OverviewChannel['water_level'],
): Overview {
  const sample = overview();
  return {
    ...sample,
    channels: [
      { ...sample.channels[0]!, watermark, water_level: level },
      sample.channels[1]!,
      sample.channels[2]!,
    ],
  };
}

/** The 结果待确认 rows (longest waiting first; the row without a T last). */
export function unknownItems(): UnknownItem[] {
  return [
    {
      withdrawal_id: QID.stuck,
      out_biz_no: QNO.stuck,
      user: { user_id: USER.a, phone_masked: PHONE.a },
      payout_channel: 'alipay',
      amount_fen: 10000,
      net_fen: 10000,
      first_transfer_at: '2026-11-12T10:00:05+08:00',
      latest_query: {
        result: 'unknown',
        at: '2026-11-13T10:00:05+08:00',
        resp_code: null,
        resp_sub_code: null,
        channel_status: null,
        channel_order_id: null,
        paid_at: null,
      },
      fail_blockers: ['resolve_bill_unverifiable', 'resolve_query_unverifiable'],
    },
    {
      withdrawal_id: QID.untried,
      out_biz_no: QNO.untried,
      user: { user_id: USER.b, phone_masked: PHONE.b },
      payout_channel: 'alipay',
      amount_fen: 20000,
      net_fen: 20000,
      first_transfer_at: null,
      latest_query: null,
      fail_blockers: [
        'resolve_too_early',
        'resolve_bill_unverifiable',
        'resolve_query_unverifiable',
      ],
    },
  ];
}

// ---- what the page shows (independent full-copy expectations, not imports of its texts) -----

/** admin_dict.withdrawal_status.* (BR-TEXT-25). */
export const STATUS_SHOWN = { APPROVED: '已通过待打款', PAYING: '打款中' } as const;
/** The attempt kinds and results by name (the page's attempt dictionary); unlisted → the code. */
export const KIND_SHOWN = { transfer: '转账', query: '查询', cancel: '撤销' } as const;
export const RESULT_SHOWN = {
  pending: '处理中',
  success: '成功',
  fail: '失败',
  unknown: '结果未知（只查询、不重发）',
} as const;
/** admin_dict.admin_fund_water_level.* (BR-TEXT-25). */
export const LEVEL_SHOWN = { low: '水位低', normal: '正常' } as const;
/** Fixed words of the cards (the page's own copy, written out here). */
export const CARD_SHOWN = {
  unentered: '未录入',
  payoutOn: '已开启',
  payoutOff: '已关闭',
  queueRunning: '运行中',
  queuePaused: '已暂停',
  channelOn: '已开通',
  channelOff: '未开通',
  channelPaused: '已暂停',
  channelRunning: '未暂停',
} as const;
/** The dash of an empty time or code. */
export const DASH = '—';

// ---- the fake server -------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;
interface Rule {
  readonly match: RequestMatch;
  readonly reply: Reply;
  readonly once: boolean;
}

export interface PayoutServerOptions {
  /** Defaults to queueSamples(). */
  readonly withdrawals?: readonly Withdrawal[];
  /** Defaults to overview(). */
  readonly overview?: Overview;
  /** Defaults to unknownItems(). */
  readonly unknown?: readonly UnknownItem[];
  /** Permission points the server checks; defaults to fund.view + payout.execute. */
  readonly permissions?: Grants;
}

const POSITIVE = /^[1-9][0-9]*$/;
/** The statuses of the payout queue: 待执行 (APPROVED) and 打款中 (PAYING). */
const QUEUE_STATUSES: readonly string[] = ['APPROVED', 'PAYING'];

/** The only requests these read-only tabs may send: the frozen reads plus the two new GETs. */
export function allowedHere(request: RequestLog): boolean {
  return (
    allowedRequest(request) ||
    (request.method === 'GET' && (request.path === OVERVIEW || request.path === UNKNOWN))
  );
}

/**
 * The frozen withdrawals server (list and detail, its own permission checks) with the payout
 * overview and the unknown results on top. One log of every request; scripted replies first.
 */
export function createPayoutServer(options: PayoutServerOptions = {}) {
  const permissions = options.permissions ?? VIEW_EXECUTE;
  const underlying = createServer([...(options.withdrawals ?? queueSamples())], { permissions });
  const current: Overview = structuredClone(options.overview ?? overview());
  const waiting: UnknownItem[] = structuredClone([...(options.unknown ?? unknownItems())]);
  const log: RequestLog[] = [];
  const rules: Rule[] = [];
  let inFlight = 0;
  const holds = (point: string): boolean => (permissions as readonly string[]).includes(point);

  function unknownPage(query: Readonly<Record<string, string>>): Response {
    if (!holds('payout.execute')) return denied();
    const page = query['page'];
    const size = query['page_size'];
    const invalid = [
      ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
      ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const pageNo = page === undefined ? 1 : Number(page);
    const pageSize = size === undefined ? 20 : Number(size);
    const items = waiting.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    return ok({ items, page: pageNo, page_size: pageSize, total: waiting.length });
  }

  async function normal(request: RequestLog): Promise<Response> {
    if (request.method === 'GET' && (request.path === OVERVIEW || request.path === UNKNOWN)) {
      if (request.headers.get('Authorization') !== 'Bearer example-admin-token')
        return failure(10001, undefined, '未登录');
      if (request.path === UNKNOWN) return unknownPage(request.query);
      if (!holds('payout.execute') && !holds('fund.view')) return denied();
      return ok(current);
    }
    const search = new URLSearchParams(request.query).toString();
    return underlying.fetch(`${BASE_URL}${request.path}${search === '' ? '' : `?${search}`}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = rules.findIndex((rule) => rule.match(request));
      if (index < 0) return await normal(request);
      const rule = rules[index]!;
      if (rule.once) rules.splice(index, 1);
      return await rule.reply(request);
    } finally {
      inFlight -= 1;
    }
  };

  const gets = (path: string): RequestLog[] =>
    log.filter((request) => request.method === 'GET' && request.path === path);

  return {
    state: underlying.state,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    /** GET /admin/v1/payout-overview. */
    overviewReads: () => gets(OVERVIEW),
    /** GET /admin/v1/unknown-payouts. */
    unknownReads: () => gets(UNKNOWN),
    /** GET /admin/v1/withdrawals with status APPROVED or PAYING (the queue table's reads). */
    queueReads: () =>
      gets(LIST).filter((request) => QUEUE_STATUSES.includes(request.query['status'] ?? '')),
    /** GET /admin/v1/withdrawals (every list read). */
    listReads: () => gets(LIST),
    /** GET /admin/v1/withdrawals/{id}. */
    detailReads: (id: string) => gets(detailPath(id)),
    /** Every request that is not a GET. */
    writes: () => log.filter((request) => request.method !== 'GET'),
    /** The next request matching `match` gets `reply`; every other request is answered normally. */
    onceWhere(match: RequestMatch, reply: Reply) {
      rules.push({ match, reply, once: true });
    },
    /** Requests matching `match` wait until the returned release is called, then are answered. */
    holdWhere(match: RequestMatch) {
      const gate = Promise.withResolvers<void>();
      const rule: Rule = {
        match,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
        once: false,
      };
      rules.push(rule);
      return () => {
        const index = rules.indexOf(rule);
        if (index >= 0) rules.splice(index, 1);
        gate.resolve();
      };
    },
  };
}
export type PayoutServer = ReturnType<typeof createPayoutServer>;

/** Matches the GETs of `path`. */
export const getOf =
  (path: string): RequestMatch =>
  (request) =>
    request.method === 'GET' && request.path === path;
