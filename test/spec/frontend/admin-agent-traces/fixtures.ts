import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for F1-10ka (contracts/openapi.yaml, tag admin-agent-traces, CT-24zzi):
// adminListAgentSessions GET /admin/v1/agent-traces/sessions, adminGetAgentSession GET
// …/sessions/{session_id}, adminListAgentReports GET …/reports and adminHandleAgentReport POST
// …/reports/{message_id}/handle. All four are still x-implementation planned: the page is built on
// these fakes (no planned list is passed to the shell). The fake server checks in the order the
// descriptions give. Ids follow the contract examples' shape; texts are samples, message texts are
// already in the stored masked form.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const SESSIONS = '/admin/v1/agent-traces/sessions';
export const REPORTS = '/admin/v1/agent-traces/reports';
export const PREFIX = '/admin/v1/agent-traces';
/** The server's clock when it marks a report handled (2026-10-01 11:00 Beijing time). */
export const HANDLED_NOW = '2026-10-01T03:00:00Z';

export const sessionPath = (id: string): string => `${SESSIONS}/${id}`;
export const handlePath = (id: string): string => `${REPORTS}/${id}/handle`;

export type SessionItem = Schema<'AdminAgentSessionListItem'>;
export type SessionDetail = Schema<'AdminAgentSessionDetail'>;
export type TraceMessage = Schema<'AdminAgentTraceMessage'>;
export type TraceRun = Schema<'AdminAgentTraceRun'>;
export type Report = Schema<'AdminAgentReport'>;
export type ReportStatus = Schema<'AdminAgentReportStatus'>;
export type HandleBody = Schema<'AdminAgentReportHandleRequest'>;

/** Sessions: a member's (expired), a guest's (user_id null) and one after account deletion. */
export const SID = {
  member: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b02',
  guest: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b01',
  deleted: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b03',
} as const;
export const UID = {
  member: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04',
  deleted: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c05',
} as const;
/** Reported messages (the reports' message_id). */
export const MID = {
  /** Pending, overdue (guest session). */
  overdue: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c02',
  /** Pending, not overdue (account-deleted session). */
  fresh: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c06',
  /** Handled by 运营小王 (member session). */
  handled: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c05',
  /** Handled by an admin account deleted since (handler_name null). */
  orphan: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c07',
} as const;
/** Admin accounts: the one that handled the samples, and the signed-in one. */
export const HANDLER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
export const SELF = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02';
export const SELF_NAME = '运营甲';

/** Masked message texts as stored (shown as is, never in a list). */
export const TEXT = {
  guestAsk: '我的手机号是138****5678，现在有多少收益',
  guestReply: '这是你当时的收益概况，以钱包页为准。',
  memberAsk: '帮我找一下最近的订单',
  memberReply: '你最近 30 天有 2 笔订单，详情见订单页。',
} as const;
export const CARD_FALLBACK = '收益以钱包页显示为准。';
export const REASON = {
  overdue: '回答内容与事实不符',
  fresh: '推荐的商品和我问的不一样',
  orphan: '和上一条是同一个问题',
} as const;
export const NOTE = {
  handled: '已核对，答复口径已修正',
  orphan: '重复举报，已合并处理',
} as const;

function message(patch: Partial<TraceMessage> & Pick<TraceMessage, 'message_id'>): TraceMessage {
  return {
    role: 'user',
    text: null,
    card_ids: [],
    feedback: null,
    badcase: false,
    reported_at: null,
    report_reason: null,
    report_status: null,
    report_note: null,
    ...patch,
  };
}

function run(patch: Partial<TraceRun> & Pick<TraceRun, 'run_id'>): TraceRun {
  return {
    intent: 'earnings_query',
    model: 'qwen-plus',
    model_snapshot: 'qwen-plus-2026-09-01',
    prompt_version: 'p-2026-09-01',
    input_tokens: 1200,
    output_tokens: 300,
    cost_mfen: 4500,
    ttft_ms: 800,
    latency_ms: 3200,
    finish_reason: 'stop',
    filter_hits: [],
    accepted_at: '2026-09-29T01:55:00Z',
    ended_at: '2026-09-29T01:55:03Z',
    ...patch,
  };
}

/** The three sessions with their whole trace, newest first (started_at descending). */
export function sessions(): SessionDetail[] {
  return [
    {
      session_id: SID.member,
      user_id: UID.member,
      // 2026-09-29 11:20 / 11:26 Beijing time.
      started_at: '2026-09-29T03:20:00Z',
      last_active_at: '2026-09-29T03:26:00Z',
      expired: true,
      messages: [
        message({ message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c03', text: TEXT.memberAsk }),
        message({
          message_id: MID.handled,
          role: 'assistant',
          text: TEXT.memberReply,
          feedback: 'up',
          reported_at: '2026-09-28T01:00:00Z',
          report_reason: null,
          report_status: 'handled',
          report_note: NOTE.handled,
        }),
      ],
      runs: [
        run({
          run_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8d03',
          intent: 'order_query',
          prompt_version: 'p-2026-09-15',
          accepted_at: '2026-09-29T03:21:00Z',
          ended_at: '2026-09-29T03:21:02Z',
        }),
      ],
      tool_calls: [
        {
          run_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8d03',
          seq: 1,
          name: 'list_my_orders',
          args: { days: 30 },
          status: 'ok',
          latency_ms: 90,
        },
      ],
      cards: [],
    },
    {
      session_id: SID.guest,
      user_id: null,
      // 2026-09-29 09:50 / 10:05 Beijing time.
      started_at: '2026-09-29T01:50:00Z',
      last_active_at: '2026-09-29T02:05:00Z',
      expired: false,
      messages: [
        message({ message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c01', text: TEXT.guestAsk }),
        message({
          message_id: MID.overdue,
          role: 'assistant',
          text: TEXT.guestReply,
          card_ids: ['c1'],
          feedback: 'down',
          badcase: true,
          // 2026-09-29 10:00 Beijing time.
          reported_at: '2026-09-29T02:00:00Z',
          report_reason: REASON.overdue,
          report_status: 'pending',
          report_note: null,
        }),
      ],
      runs: [
        run({
          run_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8d01',
          prompt_version: 'p-2026-09-01',
          filter_hits: ['amount', 'url'],
          finish_reason: 'stop',
        }),
      ],
      tool_calls: [
        {
          run_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8d01',
          seq: 1,
          name: 'get_my_earnings',
          args: {},
          status: 'ok',
          latency_ms: 120,
        },
      ],
      cards: [
        {
          card_id: 'c1',
          type: 'earnings_summary',
          schema_version: 1,
          data: {
            as_of: '2026-09-29T09:55:02+08:00',
            actions: [{ route: 'Wallet', text_key: 'agent.earnings.open_wallet' }],
          },
          fallback_text: CARD_FALLBACK,
        },
      ],
    },
    {
      session_id: SID.deleted,
      user_id: UID.deleted,
      // 2026-09-28 08:15 / 08:40 Beijing time.
      started_at: '2026-09-28T00:15:00Z',
      last_active_at: '2026-09-28T00:40:00Z',
      expired: true,
      // After account deletion (BR-AI-22): the texts and the report reason are null, rows kept.
      messages: [
        message({ message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c04', text: null }),
        message({
          message_id: MID.fresh,
          role: 'assistant',
          text: null,
          reported_at: '2026-09-30T01:00:00Z',
          report_reason: null,
          report_status: 'pending',
        }),
      ],
      // A fallback run: no intent, no model was called.
      runs: [
        run({
          run_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8d04',
          intent: null,
          model: null,
          model_snapshot: null,
          prompt_version: 'p-2026-09-01',
          input_tokens: null,
          output_tokens: null,
          cost_mfen: null,
          ttft_ms: null,
          latency_ms: 40,
          finish_reason: 'fallback',
          accepted_at: '2026-09-28T00:16:00Z',
          ended_at: '2026-09-28T00:16:01Z',
        }),
      ],
      tool_calls: [],
      cards: [],
    },
  ];
}

/** The per-session counts of the list (independent samples: one distinct number per column). */
export const COUNTS: Readonly<
  Record<string, Pick<SessionItem, 'run_count' | 'badcase_count' | 'report_count'>>
> = {
  [SID.member]: { run_count: 7, badcase_count: 2, report_count: 0 },
  [SID.guest]: { run_count: 5, badcase_count: 1, report_count: 3 },
  [SID.deleted]: { run_count: 9, badcase_count: 0, report_count: 1 },
};

/** The four reports in the order the server lists them (pending oldest first, then handled). */
export function reports(): Report[] {
  return [
    {
      message_id: MID.overdue,
      session_id: SID.guest,
      user_id: null,
      // 2026-09-29 10:00, deadline 2026-10-01 10:00 Beijing time.
      reported_at: '2026-09-29T02:00:00Z',
      report_reason: REASON.overdue,
      report_status: 'pending',
      deadline_at: '2026-10-01T02:00:00Z',
      overdue: true,
      handled_at: null,
      handler_id: null,
      handler_name: null,
      report_note: null,
      row_version: 1,
    },
    {
      message_id: MID.fresh,
      session_id: SID.deleted,
      user_id: UID.deleted,
      // 2026-09-30 09:00, deadline 2026-10-02 09:00 Beijing time.
      reported_at: '2026-09-30T01:00:00Z',
      report_reason: REASON.fresh,
      report_status: 'pending',
      deadline_at: '2026-10-02T01:00:00Z',
      overdue: false,
      handled_at: null,
      handler_id: null,
      handler_name: null,
      report_note: null,
      row_version: 3,
    },
    {
      message_id: MID.handled,
      session_id: SID.member,
      user_id: UID.member,
      // 2026-09-28 09:00; handled 2026-09-28 15:30 Beijing time. Reason deleted with the data.
      reported_at: '2026-09-28T01:00:00Z',
      report_reason: null,
      report_status: 'handled',
      deadline_at: '2026-09-30T01:00:00Z',
      overdue: false,
      handled_at: '2026-09-28T07:30:00Z',
      handler_id: HANDLER,
      handler_name: '运营小王',
      report_note: NOTE.handled,
      row_version: 2,
    },
    {
      message_id: MID.orphan,
      session_id: SID.deleted,
      user_id: UID.deleted,
      // 2026-09-27 09:00; handled 2026-09-27 18:45 by an admin account deleted since.
      reported_at: '2026-09-27T01:00:00Z',
      report_reason: REASON.orphan,
      report_status: 'handled',
      deadline_at: '2026-09-29T01:00:00Z',
      overdue: false,
      handled_at: '2026-09-27T10:45:00Z',
      handler_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b09',
      handler_name: null,
      report_note: NOTE.orphan,
      row_version: 5,
    },
  ];
}

/**
 * What tells each report row apart on the page (a row need not show message_id): its session id
 * where only that report has it, else its reason.
 */
export const REPORT_ROW = {
  overdue: SID.guest,
  fresh: REASON.fresh,
  handled: SID.member,
  orphan: REASON.orphan,
} as const;

/** The same reports with `patch` applied to the report `id`. */
export function withReport(id: string, patch: Partial<Report>): Report[] {
  return reports().map((row) => (row.message_id === id ? { ...row, ...patch } : row));
}

/** `count` older guest sessions after the three samples (for paging; ids …8e0001 …). */
export function withFiller(count: number): SessionDetail[] {
  const filler = Array.from({ length: count }, (_, index): SessionDetail => {
    const n = String(index + 1).padStart(4, '0');
    return {
      session_id: `0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f${n}`,
      user_id: null,
      started_at: '2026-09-01T01:00:00Z',
      last_active_at: '2026-09-01T01:05:00Z',
      expired: true,
      messages: [],
      runs: [],
      tool_calls: [],
      cards: [],
    };
  });
  return [...sessions(), ...filler];
}

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** agent.trace and agent.report: reads both lists and the trace, marks reports handled. */
export const BOTH: Grants = ['agent.trace', 'agent.report'];
/** agent.trace only: reads, cannot mark handled. */
export const TRACE_ONLY: Grants = ['agent.trace'];
/** agent.report only: shows the menu, cannot read the lists. */
export const REPORT_ONLY: Grants = ['agent.report'];

/** Permission snapshot; none of these points needs a step-up. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions) stepUp[point] = { tier: null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};
/** An error envelope; `data` is left out when undefined. */
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
export function conflict(): Response {
  return failure(20902, { resource: 'agent_report' }, '状态已变化，请刷新后重试');
}
/** A dropped connection (what fetch throws when the network fails). */
export function networkDown(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** Reports in the server's order (default reports()). */
  readonly reports?: Report[];
}

/** Every query parameter adminListAgentSessions takes. */
export const SESSION_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'user_id',
  'session_id',
  'from',
  'to',
  'badcase',
  'reported',
];
/** Every query parameter adminListAgentReports takes. */
export const REPORT_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'status',
  'overdue',
  'from',
  'to',
];
const POSITIVE = /^[1-9][0-9]*$/;
const BOOLEAN = /^(?:true|false)$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DETAIL = /^\/admin\/v1\/agent-traces\/sessions\/([^/]+)$/;
const HANDLE = /^\/admin\/v1\/agent-traces\/reports\/([^/]+)\/handle$/;

function listItem(detail: SessionDetail): SessionItem {
  const counts = COUNTS[detail.session_id] ?? { run_count: 0, badcase_count: 0, report_count: 0 };
  return {
    session_id: detail.session_id,
    user_id: detail.user_id,
    started_at: detail.started_at,
    last_active_at: detail.last_active_at,
    expired: detail.expired,
    ...counts,
  };
}

/** The checks shared by both lists: paging, the time window and undeclared parameters. */
function commonInvalid(query: Record<string, string>, allowed: readonly string[]): string[] {
  const { page, page_size: size, from, to } = query;
  return [
    ...Object.keys(query).filter((name) => !allowed.includes(name)),
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
    ...(from === undefined || WITH_OFFSET.test(from) ? [] : ['from']),
    ...(to === undefined || WITH_OFFSET.test(to) ? [] : ['to']),
  ];
}
function windowInvalid(query: Record<string, string>): boolean {
  const { from, to } = query;
  return from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to);
}
function inWindow(time: string, query: Record<string, string>): boolean {
  const { from, to } = query;
  const at = Date.parse(time);
  return (
    (from === undefined || at >= Date.parse(from)) && (to === undefined || at < Date.parse(to))
  );
}
function paged<T>(rows: readonly T[], query: Record<string, string>): Response {
  const pageNo = query['page'] === undefined ? 1 : Number(query['page']);
  const pageSize = query['page_size'] === undefined ? 20 : Number(query['page_size']);
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return ok({ items, page: pageNo, page_size: pageSize, total: rows.length });
}

/** Fake /admin/v1 server with the CT-24zzi checks. */
export function createServer(initial: SessionDetail[] = sessions(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const reportState = structuredClone(options.reports ?? reports());
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const permissions = options.permissions ?? BOTH;
  let inFlight = 0;

  const has = (point: KnownPermission): boolean => permissions.includes(point);
  const findReport = (id: string): Report | undefined =>
    reportState.find((row) => row.message_id === id);

  function listSessions(query: Record<string, string>): Response {
    if (!has('agent.trace')) return denied();
    const { user_id: user, session_id: session, badcase, reported } = query;
    const invalid = [
      ...commonInvalid(query, SESSION_PARAMS),
      ...(badcase === undefined || BOOLEAN.test(badcase) ? [] : ['badcase']),
      ...(reported === undefined || BOOLEAN.test(reported) ? [] : ['reported']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (windowInvalid(query)) return rejected(['from', 'to']);
    const rows = state
      .map(listItem)
      .filter(
        (row) =>
          (user === undefined || row.user_id === user) &&
          (session === undefined || row.session_id === session) &&
          (badcase === undefined || row.badcase_count > 0 === (badcase === 'true')) &&
          (reported === undefined || row.report_count > 0 === (reported === 'true')) &&
          inWindow(row.started_at, query),
      )
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    return paged(rows, query);
  }

  function getSession(id: string): Response {
    if (!has('agent.trace')) return denied();
    const found = state.find((row) => row.session_id === id);
    if (found === undefined) return rejected(['session_id']);
    return ok(found);
  }

  function listReports(query: Record<string, string>): Response {
    if (!has('agent.trace')) return denied();
    const { status, overdue } = query;
    const invalid = [
      ...commonInvalid(query, REPORT_PARAMS),
      ...(status === undefined || status === 'pending' || status === 'handled' ? [] : ['status']),
      ...(overdue === undefined || BOOLEAN.test(overdue) ? [] : ['overdue']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (windowInvalid(query)) return rejected(['from', 'to']);
    // The server's own order is kept as is (the page must not reorder it).
    const rows = reportState.filter(
      (row) =>
        (status === undefined || row.report_status === status) &&
        (overdue === undefined || row.overdue === (overdue === 'true')) &&
        inWindow(row.reported_at, query),
    );
    return paged(rows, query);
  }

  function handle(id: string, request: RequestLog): Response {
    if (!has('agent.report')) return denied();
    const body =
      typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const unknown = Object.keys(body).filter(
      (name) => name !== 'note' && name !== 'expected_row_version',
    );
    if (unknown.length > 0) return rejected(unknown);
    const note = body['note'];
    const expected = body['expected_row_version'];
    if (typeof note !== 'string') return rejected(['note']);
    const length = Array.from(note.trim()).length;
    if (Array.from(note).length > 500 || length < 1 || length > 500) return rejected(['note']);
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      return rejected(['expected_row_version']);
    }
    const found = findReport(id);
    if (found === undefined) return rejected(['message_id']);
    if (found.report_status !== 'pending' || found.row_version !== expected) return conflict();
    found.report_status = 'handled';
    found.overdue = false;
    found.handled_at = HANDLED_NOW;
    found.handler_id = SELF;
    found.handler_name = SELF_NAME;
    found.report_note = note.trim();
    found.row_version += 1;
    return ok(structuredClone(found));
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === SESSIONS) return listSessions(request.query);
    if (method === 'GET' && path === REPORTS) return listReports(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return getSession(decodeURIComponent(one[1] ?? ''));
    const handling = HANDLE.exec(path);
    if (method === 'POST' && handling !== null) {
      return handle(decodeURIComponent(handling[1] ?? ''), request);
    }
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      const override = index < 0 ? undefined : overrides.splice(index, 1)[0];
      return await (override === undefined ? normal(request) : override.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    reportState,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** GET …/sessions (the session list). */
    sessionReads() {
      return log.filter((r) => r.method === 'GET' && r.path === SESSIONS);
    },
    /** GET …/reports (the report list). */
    reportReads() {
      return log.filter((r) => r.method === 'GET' && r.path === REPORTS);
    },
    /** GET …/sessions/{id} (every id when none is given): each one is an audited trace view. */
    detailReads(id?: string) {
      return log.filter(
        (r) =>
          r.method === 'GET' &&
          (id === undefined ? DETAIL.test(r.path) : r.path === sessionPath(id)),
      );
    },
    /** POST …/reports/{id}/handle (every id when none is given). */
    handles(id?: string) {
      const wanted = (path: string): boolean =>
        id === undefined ? HANDLE.test(path) : path === handlePath(id);
      return log.filter((r) => r.method === 'POST' && wanted(r.path));
    },
    /** Every request to /admin/v1/agent-traces or below it. */
    traceRequests() {
      return log.filter((r) => r.path === PREFIX || r.path.startsWith(`${PREFIX}/`));
    },
    report(id: string): Report {
      const found = findReport(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      return found;
    },
    /** Another admin handles the report behind the page's back. */
    handledElsewhere(id: string, note: string) {
      const found = findReport(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      found.report_status = 'handled';
      found.overdue = false;
      found.handled_at = '2026-10-01T02:30:00Z';
      found.handler_id = HANDLER;
      found.handler_name = '运营小王';
      found.report_note = note;
      found.row_version += 1;
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
  };
}
export type Server = ReturnType<typeof createServer>;
