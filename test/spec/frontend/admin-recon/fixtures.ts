import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-24v / CT-24w (contracts/openapi.yaml, tag
// admin-recon): listAdminReconDiffs GET /admin/v1/recon-diffs, getAdminReconDiff GET
// /admin/v1/recon-diffs/{recon_diff_id} and closeAdminReconDiff POST …/{recon_diff_id}/close. The
// fake server checks in the order the descriptions give. Ids are obvious fake UUIDs; references,
// amounts and reasons are samples. Chinese names are transcribed from the console dictionary
// (contracts/texts.admin.default.json, BR-TEXT-25) as an independent oracle.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/recon-diffs';
export const VERIFY = '/admin/v1/auth/step-up';
/** The server's clock when it closes a difference. */
export const NOW = '2026-10-30T10:00:00+08:00';

export const detailPath = (id: string): string => `${LIST}/${id}`;
export const closePath = (id: string): string => `${LIST}/${id}/close`;

export type Diff = Schema<'AdminReconDiff'>;
export type DiffDetail = Schema<'AdminReconDiffDetail'>;
export type DiffType = Schema<'AdminReconDiffType'>;
export type DiffSource = Schema<'AdminReconDiffSource'>;
export type DiffStatus = Schema<'AdminReconDiffStatus'>;

/**
 * admin_dict.recon_diff_type.* of the nine R1–R3 types shown by the console (AdminReconDiffType).
 * blacklist_after_credit is widened by CT-24zzf; its name and filter option join with the console
 * ticket of B2-04zzl, so the cast keeps these nine compiling on both sides of that widening.
 */
export const TYPE_NAME = {
  union_mismatch: '联盟对账不一致',
  channel_mismatch: '通道对账不一致',
  ledger_mismatch: '账实不符',
  platform_restore: '平台恢复',
  month_end_unbalanced: '月末三项不平',
  settle_amount_mismatch: '月结金额不一致',
  settle_missing: '应结未结',
  appeal_restore: '申诉恢复',
  estimate_changed_after_credit: '入账后预估变化',
} as Readonly<Record<DiffType, string>>;
/** admin_dict.recon_diffs.source.R1–R3 (R4 is not a value of this list). */
export const SOURCE_NAME: Readonly<Record<DiffSource, string>> = {
  R1: '联盟对账',
  R2: '通道对账',
  R3: '内部日终',
};
/** admin_dict.recon_diff_status.* */
export const STATUS_NAME: Readonly<Record<DiffStatus, string>> = {
  open: '待处理',
  processing: '处理中',
  adjusted: '已调账',
  written_off: '已核销',
  closed: '已关闭（不处理）',
};
/** Dictionary names of the R4 rows that must not be offered here. */
export const R4_NAMES = {
  source: '收款对账',
  payMismatch: '收款对账不一致',
  payAnomaly: '收款异常',
} as const;

export const ID = {
  /** R3 ledger_mismatch, open, one withdrawal hold. */
  ledger: 'd1000001-0000-4000-8000-000000000001',
  /** R2 channel_mismatch, processing, two withdrawal holds. */
  channel: 'd1000002-0000-4000-8000-000000000002',
  /** R1 union_mismatch, closed (with a resolution). */
  union: 'd1000003-0000-4000-8000-000000000003',
  /** R3 month_end_unbalanced, adjusted, negative difference. */
  monthEnd: 'd1000004-0000-4000-8000-000000000004',
  /** R1 settle_amount_mismatch, written_off. */
  settle: 'd1000005-0000-4000-8000-000000000005',
  /** R1 appeal_restore, open, no withdrawal hold, negative difference. */
  appeal: 'd1000006-0000-4000-8000-000000000006',
} as const;
export const REF = {
  ledger: 'acct-test-0001',
  channel: 'wd-test-0002',
  union: 'taobao:5550003',
  monthEnd: 'month-test-0004',
  settle: 'bill-test-0005',
  appeal: 'jd:7770006',
} as const;
/** The admin who handled the processing / closed / adjusted / written-off samples. */
export const HANDLER = 'ad000001-0000-4000-8000-0000000000a1';
/** The signed-in admin (handler_id after a close). */
export const SELF = 'ad000002-0000-4000-8000-0000000000a2';
export const RESOLUTION_REASON = '联盟结算明细已核对，差额由联盟侧调整';

/** Withdrawal holds whose source is each sample (released by a close). */
export const HOLDS: Readonly<Record<string, number>> = {
  [ID.ledger]: 1,
  [ID.channel]: 2,
  [ID.appeal]: 0,
};

/** The six samples, newest first (created_at descending, the list's order). */
export function diffs(): DiffDetail[] {
  return [
    {
      recon_diff_id: ID.ledger,
      source: 'R3',
      type: 'ledger_mismatch',
      period: '2026-10-20',
      ref_type: 'account',
      ref_id: REF.ledger,
      expected_fen: 12000,
      actual_fen: 11800,
      diff_fen: 200,
      status: 'open',
      created_at: '2026-10-21T01:05:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-10-21T01:05:00+08:00',
      resolution: null,
    },
    {
      recon_diff_id: ID.channel,
      source: 'R2',
      type: 'channel_mismatch',
      period: '2026-10-19',
      ref_type: 'withdrawal',
      ref_id: REF.channel,
      expected_fen: 50000,
      actual_fen: 0,
      diff_fen: 50000,
      status: 'processing',
      created_at: '2026-10-20T23:40:00+08:00',
      closed_at: null,
      handler_id: HANDLER,
      updated_at: '2026-10-21T09:00:00+08:00',
      resolution: null,
    },
    {
      recon_diff_id: ID.union,
      source: 'R1',
      type: 'union_mismatch',
      period: '2026-09',
      ref_type: 'order',
      ref_id: REF.union,
      expected_fen: 1234,
      actual_fen: 1200,
      diff_fen: 34,
      status: 'closed',
      created_at: '2026-10-20T10:00:00+08:00',
      closed_at: '2026-10-20T16:30:00+08:00',
      handler_id: HANDLER,
      updated_at: '2026-10-20T16:30:00+08:00',
      // Keys are not fixed by the contract: only `reason` is shown, the rest is ignored.
      resolution: { reason: RESOLUTION_REASON, note_ref: 'sample-note' },
    },
    {
      recon_diff_id: ID.appeal,
      source: 'R1',
      type: 'appeal_restore',
      period: '2026-10',
      ref_type: 'order',
      ref_id: REF.appeal,
      expected_fen: 0,
      actual_fen: 1500,
      diff_fen: -1500,
      status: 'open',
      created_at: '2026-10-15T08:00:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-10-15T08:00:00+08:00',
      resolution: null,
    },
    {
      recon_diff_id: ID.monthEnd,
      source: 'R3',
      type: 'month_end_unbalanced',
      period: '2026-09',
      ref_type: 'month_end',
      ref_id: REF.monthEnd,
      expected_fen: 123456789,
      actual_fen: 123457000,
      diff_fen: -211,
      status: 'adjusted',
      created_at: '2026-10-02T09:00:00+08:00',
      closed_at: '2026-10-03T11:00:00+08:00',
      handler_id: HANDLER,
      updated_at: '2026-10-03T11:00:00+08:00',
      resolution: { adjustment_ref: 'adj-test-0004' },
    },
    {
      recon_diff_id: ID.settle,
      source: 'R1',
      type: 'settle_amount_mismatch',
      period: '2026-08',
      ref_type: 'settle_bill',
      ref_id: REF.settle,
      expected_fen: 880000,
      actual_fen: 870000,
      diff_fen: 10000,
      status: 'written_off',
      created_at: '2026-09-05T11:00:00+08:00',
      closed_at: '2026-09-06T15:00:00+08:00',
      handler_id: HANDLER,
      updated_at: '2026-09-06T15:00:00+08:00',
      resolution: null,
    },
  ];
}

/** `count` older open R3 rows after the six samples (for paging; refs fill-0001 …). */
export function withFiller(count: number): DiffDetail[] {
  const filler = Array.from({ length: count }, (_, index): DiffDetail => {
    const n = String(index + 1).padStart(4, '0');
    return {
      recon_diff_id: `f0000000-0000-4000-8000-00000000${n}`,
      source: 'R3',
      type: 'ledger_mismatch',
      period: '2026-07-01',
      ref_type: 'account',
      ref_id: `fill-${n}`,
      expected_fen: 100,
      actual_fen: 90,
      diff_fen: 10,
      status: 'open',
      created_at: '2026-07-02T09:00:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-07-02T09:00:00+08:00',
      resolution: null,
    };
  });
  return [...diffs(), ...filler];
}

/** The same samples with `patch` applied to the row `id`. */
export function withDiff(id: string, patch: Partial<DiffDetail>): DiffDetail[] {
  return diffs().map((row) => (row.recon_diff_id === id ? { ...row, ...patch } : row));
}

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** fund.recon: reads and closes. */
export const RECON_GRANTS: Grants = ['fund.recon'];
/** fund.view: reads only. */
export const VIEW_GRANTS: Grants = ['fund.view'];
/** Neither fund.recon nor fund.view. */
export const OTHER_GRANTS: Grants = ['user.lookup'];

/** Permission snapshot; none of these points needs a step-up for what this page does. */
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
  20901: 409,
  20902: 409,
  40901: 409,
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
  return failure(20902, { resource: 'recon_diff' }, '状态已变化，请刷新后重试');
}
export function changedBody(): Response {
  return failure(20901, undefined, '请求内容有变化，请重新提交');
}
export function inProgress(): Response {
  return failure(40901, undefined, '请求处理中，请稍后');
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
  /** Unreleased withdrawal holds per difference. */
  readonly holds?: Readonly<Record<string, number>>;
}

const TYPES: readonly string[] = Object.keys(TYPE_NAME);
const SOURCES: readonly string[] = Object.keys(SOURCE_NAME);
const STATUSES: readonly string[] = Object.keys(STATUS_NAME);
const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/;
const POSITIVE = /^[1-9][0-9]*$/;
/** Every query parameter listAdminReconDiffs takes. */
export const LIST_PARAMS: readonly string[] = [
  'page',
  'page_size',
  'type',
  'source',
  'status',
  'ref_id',
  'period_from',
  'period_to',
];
/** The filter parameters (everything but paging). */
export const FILTER_PARAMS: readonly string[] = LIST_PARAMS.slice(2);
const DETAIL = /^\/admin\/v1\/recon-diffs\/([^/]+)$/;
const CLOSE = /^\/admin\/v1\/recon-diffs\/([^/]+)\/close$/;

/** A list row: the detail without handler_id, updated_at and resolution. */
function rowOf(item: DiffDetail): Diff {
  return {
    recon_diff_id: item.recon_diff_id,
    source: item.source,
    type: item.type,
    period: item.period,
    ref_type: item.ref_type,
    ref_id: item.ref_id,
    expected_fen: item.expected_fen,
    actual_fen: item.actual_fen,
    diff_fen: item.diff_fen,
    status: item.status,
    created_at: item.created_at,
    closed_at: item.closed_at,
  };
}
function newestFirst(a: DiffDetail, b: DiffDetail): number {
  const time = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (time !== 0) return time;
  return a.recon_diff_id < b.recon_diff_id ? 1 : a.recon_diff_id > b.recon_diff_id ? -1 : 0;
}

/** Fake /admin/v1 server with the CT-24v / CT-24w checks. */
export function createServer(initial: DiffDetail[] = diffs(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const holds = new Map<string, number>(Object.entries(options.holds ?? HOLDS));
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  /** First results of each Idempotency-Key: the request it answered and the data returned. */
  const results = new Map<string, { request: string; data: unknown }>();
  const permissions = options.permissions ?? RECON_GRANTS;
  let inFlight = 0;

  const has = (point: KnownPermission): boolean => permissions.includes(point);
  const canRead = (): boolean => has('fund.recon') || has('fund.view');
  const find = (id: string): DiffDetail | undefined =>
    state.find((item) => item.recon_diff_id === id);

  function list(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { type, source, status, ref_id: ref } = query;
    const { period_from: from, period_to: to, page, page_size: size } = query;
    const invalid = [
      ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
      ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
      ...(type === undefined || TYPES.includes(type) ? [] : ['type']),
      ...(source === undefined || SOURCES.includes(source) ? [] : ['source']),
      ...(status === undefined || STATUSES.includes(status) ? [] : ['status']),
      ...(ref === undefined || (ref.length >= 1 && ref.length <= 64) ? [] : ['ref_id']),
      ...(from === undefined || PERIOD.test(from) ? [] : ['period_from']),
      ...(to === undefined || PERIOD.test(to) ? [] : ['period_to']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (from !== undefined && to !== undefined && from > to) {
      return rejected(['period_from', 'period_to']);
    }
    const matching = state
      .filter(
        (item) =>
          (type === undefined || item.type === type) &&
          (source === undefined || item.source === source) &&
          (status === undefined || item.status === status) &&
          (ref === undefined || item.ref_id === ref) &&
          (from === undefined || item.period >= from) &&
          (to === undefined || item.period <= to),
      )
      .sort(newestFirst);
    const pageNo = page === undefined ? 1 : Number(page);
    const pageSize = size === undefined ? 20 : Number(size);
    const items = matching.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(rowOf);
    return ok({ items, page: pageNo, page_size: pageSize, total: matching.length });
  }

  function detail(id: string): Response {
    if (!canRead()) return denied();
    const found = find(id);
    if (found === undefined) return rejected(['recon_diff_id']);
    return ok(found);
  }

  function close(id: string, request: RequestLog): Response {
    if (!has('fund.recon')) return denied();
    const idempotency = request.headers.get('Idempotency-Key');
    if (idempotency === null || idempotency.trim() === '') return rejected(['Idempotency-Key']);
    const fingerprint = `${id} ${JSON.stringify(request.body ?? null)}`;
    const first = results.get(idempotency);
    if (first !== undefined) return first.request === fingerprint ? ok(first.data) : changedBody();
    const body =
      typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const unknown = Object.keys(body).filter((name) => name !== 'reason');
    if (unknown.length > 0) return rejected(unknown);
    const reason = body['reason'];
    if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 200) {
      return rejected(['reason']);
    }
    const found = find(id);
    if (found === undefined) return rejected(['recon_diff_id']);
    if (found.status !== 'open' && found.status !== 'processing') return conflict();
    const released = holds.get(id) ?? 0;
    holds.set(id, 0);
    found.status = 'closed';
    found.closed_at = NOW;
    found.updated_at = NOW;
    found.handler_id = SELF;
    found.resolution = { reason: reason.trim() };
    const data = { recon_diff: structuredClone(found), released_hold_count: released };
    results.set(idempotency, { request: fingerprint, data });
    return ok(data);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    const closing = CLOSE.exec(path);
    if (method === 'POST' && closing !== null) {
      return close(decodeURIComponent(closing[1]!), request);
    }
    return rejected(['path']);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
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
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** GET /admin/v1/recon-diffs (the list). */
    reads() {
      return log.filter((r) => r.method === 'GET' && r.path === LIST);
    },
    /** Every request to /admin/v1/recon-diffs or below it. */
    diffRequests() {
      return log.filter((r) => r.path === LIST || r.path.startsWith(`${LIST}/`));
    },
    /** POST …/{id}/close (every id when none is given). */
    closes(id?: string) {
      const wanted = (path: string): boolean =>
        id === undefined ? CLOSE.test(path) : path === closePath(id);
      return log.filter((r) => r.method === 'POST' && wanted(r.path));
    },
    item(id: string): DiffDetail {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      return found;
    },
    holdsOf(id: string): number {
      return holds.get(id) ?? 0;
    },
    /** Changes a row behind the page's back (another admin handled it meanwhile). */
    setStatus(id: string, status: DiffStatus) {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      found.status = status;
      found.handler_id = HANDLER;
      found.updated_at = NOW;
      if (status !== 'open' && status !== 'processing') found.closed_at = NOW;
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string, reply: Reply = normal) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;

/** Yuan with two decimals of integer fen, without grouping (the page may group with commas). */
export function yuan(fen: number): string {
  const magnitude = Math.abs(fen);
  const body = `${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
  return fen < 0 ? `-${body}` : body;
}
