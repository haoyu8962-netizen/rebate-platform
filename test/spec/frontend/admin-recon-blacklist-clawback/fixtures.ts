import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for 【确认扣回】 of a blacklist_after_credit difference (CT-24zzf
// blacklistClawbackAdminReconDiff, POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback)
// next to the reads of CT-24v (listAdminReconDiffs, getAdminReconDiff). The fake server checks in
// the order the contract description gives: order.blacklist_clawback (10403) → totp step-up (10003)
// → Idempotency-Key replay → body (20001 [note]) → id (20001 [recon_diff_id]) → status (20902
// recon_diff) → type (blacklist_clawback_not_supported) → the switch (blacklist_clawback_disabled)
// → the order still CREDITED (20902 order). Ids are obvious fake UUIDs; order keys, amounts and
// notes are samples. Chinese names of the dictionary types and statuses are transcribed from
// contracts/texts.admin.default.json (BR-TEXT-25) as an independent oracle.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/recon-diffs';
export const VERIFY = '/admin/v1/auth/step-up';
/** The bearer value the data provider sends (a readable sample). */
export const BEARER = 'example-admin-token';
/** The totp code the fake step-up accepts. */
export const TOTP_CODE = '123456';
/** The server's clock when it claws an order back. */
export const NOW = '2026-11-09T10:00:00+08:00';
/** The new type (contracts/enums/fund.yaml recon_diff_type). */
export const BLACKLIST_TYPE = 'blacklist_after_credit';

export const detailPath = (id: string): string => `${LIST}/${id}`;
export const clawbackPath = (id: string): string => `${LIST}/${id}/blacklist-clawback`;
/** The n-th step-up value the fake server hands out (low entropy, readable). */
export const stepUpValue = (n: number): string => `stepup-totp-${n}`;

export type DiffDetail = Schema<'AdminReconDiffDetail'>;
export type Diff = Schema<'AdminReconDiff'>;
export type DiffStatus = Schema<'AdminReconDiffStatus'>;
export type RebateStatus = Schema<'AdminOrderRebateStatus'>;

/** admin_dict.recon_diff_status.* */
export const STATUS_NAME: Readonly<Record<DiffStatus, string>> = {
  open: '待处理',
  processing: '处理中',
  adjusted: '已调账',
  written_off: '已核销',
  closed: '已关闭（不处理）',
};
/** admin_dict.recon_diff_type.* of the two other samples (unchanged by this ticket). */
export const OTHER_TYPE_NAME = {
  ledger_mismatch: '账实不符',
  channel_mismatch: '通道对账不一致',
} as const;

export const ID = {
  /** blacklist_after_credit, open, two hit dimensions, the order still CREDITED. */
  open: 'b1000001-0000-4000-8000-000000000001',
  /** blacklist_after_credit, processing, one hit dimension, the order still CREDITED. */
  busy: 'b1000002-0000-4000-8000-000000000002',
  /** blacklist_after_credit, adjusted (already clawed back). */
  done: 'b1000003-0000-4000-8000-000000000003',
  /** blacklist_after_credit, closed (the review concluded 「不扣回」). */
  closed: 'b1000004-0000-4000-8000-000000000004',
  /** R3 ledger_mismatch, open (another type: no 【确认扣回】). */
  ledger: 'b1000005-0000-4000-8000-000000000005',
  /** R2 channel_mismatch, open (another type: no 【确认扣回】). */
  channel: 'b1000006-0000-4000-8000-000000000006',
} as const;

/** The order_key part of each blacklist sample's ref_id (before `#BLACKLIST#`). */
export const ORDER_KEY = {
  open: 'taobao:5550041',
  busy: 'taobao:5550042',
  done: 'taobao:5550043',
  closed: 'taobao:5550044',
} as const;

export const REF = {
  open: `${ORDER_KEY.open}#BLACKLIST#channel,order_no_suffix`,
  busy: `${ORDER_KEY.busy}#BLACKLIST#channel`,
  done: `${ORDER_KEY.done}#BLACKLIST#order_no_suffix`,
  closed: `${ORDER_KEY.closed}#BLACKLIST#channel`,
  ledger: 'acct-test-0045',
  channel: 'wd-test-0046',
} as const;

/** expected_fen of the open / processing samples (the order's booked_n_fen when registered). */
export const EXPECTED = {
  open: 123456,
  busy: 2000,
} as const;
/** What the server takes back (calculated by R8; never expected_fen as is). */
export const CLAWED: Readonly<Record<string, number>> = {
  [ID.open]: 98765,
  [ID.busy]: 0,
};

/** The admin who handled the processing / finished samples. */
export const HANDLER = 'ad000001-0000-4000-8000-0000000000a1';
/** The signed-in admin (handler_id after a clawback). */
export const SELF = 'ad000002-0000-4000-8000-0000000000a2';

function blacklist(
  id: string,
  ref: string,
  status: DiffStatus,
  expected: number,
  dimensions: readonly string[],
  created: string,
): DiffDetail {
  const finished = status !== 'open' && status !== 'processing';
  return {
    recon_diff_id: id,
    source: 'R3',
    type: BLACKLIST_TYPE,
    period: '2026-11',
    ref_type: 'order',
    ref_id: ref,
    expected_fen: expected,
    actual_fen: 0,
    diff_fen: expected,
    status,
    created_at: created,
    closed_at: finished ? '2026-11-06T10:00:00+08:00' : null,
    handler_id: status === 'open' ? null : HANDLER,
    updated_at: finished ? '2026-11-06T10:00:00+08:00' : created,
    resolution: { dimensions: [...dimensions] },
  };
}

/** The six samples, newest first (created_at descending, the list's order). */
export function diffs(): DiffDetail[] {
  return [
    blacklist(
      ID.open,
      REF.open,
      'open',
      EXPECTED.open,
      ['channel', 'order_no_suffix'],
      '2026-11-08T10:00:00+08:00',
    ),
    blacklist(
      ID.busy,
      REF.busy,
      'processing',
      EXPECTED.busy,
      ['channel'],
      '2026-11-08T09:00:00+08:00',
    ),
    {
      recon_diff_id: ID.ledger,
      source: 'R3',
      type: 'ledger_mismatch',
      period: '2026-11-07',
      ref_type: 'account',
      ref_id: REF.ledger,
      expected_fen: 12000,
      actual_fen: 11800,
      diff_fen: 200,
      status: 'open',
      created_at: '2026-11-08T01:05:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-11-08T01:05:00+08:00',
      resolution: null,
    },
    {
      recon_diff_id: ID.channel,
      source: 'R2',
      type: 'channel_mismatch',
      period: '2026-11-07',
      ref_type: 'withdrawal',
      ref_id: REF.channel,
      expected_fen: 50000,
      actual_fen: 0,
      diff_fen: 50000,
      status: 'open',
      created_at: '2026-11-08T01:00:00+08:00',
      closed_at: null,
      handler_id: null,
      updated_at: '2026-11-08T01:00:00+08:00',
      resolution: null,
    },
    {
      ...blacklist(
        ID.done,
        REF.done,
        'adjusted',
        5000,
        ['order_no_suffix'],
        '2026-11-05T10:00:00+08:00',
      ),
      resolution: {
        dimensions: ['order_no_suffix'],
        clawback: {
          operator: HANDLER,
          clawed_back_at: '2026-11-06T10:00:00+08:00',
          clawed_back_fen: 4000,
        },
      },
    },
    blacklist(ID.closed, REF.closed, 'closed', 3000, ['channel'], '2026-11-04T10:00:00+08:00'),
  ];
}

/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** fund.recon and order.blacklist_clawback: reads, closes and claws back. */
export const CLAW_GRANTS: Grants = ['fund.recon', 'order.blacklist_clawback'];
/** fund.view and order.blacklist_clawback: reads and claws back (no close). */
export const VIEW_CLAW_GRANTS: Grants = ['fund.view', 'order.blacklist_clawback'];
/** fund.recon only (the F1-08e sample account): no 【确认扣回】. */
export const RECON_GRANTS: Grants = ['fund.recon'];

/** Permission snapshot: order.blacklist_clawback needs the totp tier, the others none. */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of permissions)
    stepUp[point] = { tier: point === 'order.blacklist_clawback' ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const HTTP: Record<number, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
};
/** An error envelope; `data` is left out when undefined. */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: HTTP[code] ?? 400 });
}
export function rejected(fields: readonly string[]): Response {
  return failure(20001, { fields });
}
/** 20001 [recon_diff_id] with data.reason=blacklist_clawback_not_supported. */
export function notSupported(): Response {
  return failure(20001, {
    fields: ['recon_diff_id'],
    reason: 'blacklist_clawback_not_supported',
  });
}
/** 20001 [recon_diff_id] with data.reason=blacklist_clawback_disabled (the switch is off). */
export function switchedOff(): Response {
  return failure(20001, { fields: ['recon_diff_id'], reason: 'blacklist_clawback_disabled' });
}
export function stepUpRequired(): Response {
  return failure(10003, { tier: 'totp' }, '需要二次验证');
}
export function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
export function diffConflict(): Response {
  return failure(20902, { resource: 'recon_diff' }, '状态已变化，请刷新后重试');
}
export function orderConflict(): Response {
  return failure(20902, { resource: 'order' }, '状态已变化，请刷新后重试');
}
export function changedBody(): Response {
  return failure(20901, undefined, '请求内容有变化，请重新提交');
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
  /** order.blacklist_clawback.enabled (the console never turns it on; on unless given). */
  readonly enabled?: boolean;
}

const TYPES: readonly string[] = [
  'union_mismatch',
  'channel_mismatch',
  'ledger_mismatch',
  'platform_restore',
  'month_end_unbalanced',
  'settle_amount_mismatch',
  'settle_missing',
  'appeal_restore',
  'estimate_changed_after_credit',
  BLACKLIST_TYPE,
];
const SOURCES: readonly string[] = ['R1', 'R2', 'R3'];
const STATUSES: readonly string[] = Object.keys(STATUS_NAME);
const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/recon-diffs\/([^/]+)$/;
const CLAWBACK = /^\/admin\/v1\/recon-diffs\/([^/]+)\/blacklist-clawback$/;
/** Requests this page may send: the F1-08e reads, the totp step-up and the clawback. */
const ALLOWED: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/admin\/v1\/recon-diffs$/ },
  { method: 'GET', path: DETAIL },
  { method: 'POST', path: /^\/admin\/v1\/auth\/step-up$/ },
  { method: 'POST', path: CLAWBACK },
];

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

/** What the after-test check reads of a server. */
export interface Checked {
  unexpected(): RequestLog[];
}
/** Servers created by the current test (checked against the request whitelist after it). */
export const created: Checked[] = [];

/** Fake /admin/v1 server with the CT-24v reads, the totp step-up and the CT-24zzf clawback. */
export function createServer(initial: DiffDetail[] = diffs(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const orders = new Map<string, RebateStatus>(
    state
      .filter((item) => item.type === BLACKLIST_TYPE)
      .map((item): [string, RebateStatus] => [
        item.recon_diff_id,
        item.status === 'adjusted' ? 'CLAWED_BACK' : 'CREDITED',
      ]),
  );
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  /** First results of each Idempotency-Key: the request it answered and the data returned. */
  const results = new Map<string, { request: string; data: unknown }>();
  /** Step-up values handed out, in order. */
  const issued: string[] = [];
  const permissions = options.permissions ?? CLAW_GRANTS;
  const enabled = options.enabled ?? true;
  let inFlight = 0;

  const has = (point: KnownPermission): boolean => permissions.includes(point);
  const canRead = (): boolean => has('fund.recon') || has('fund.view');
  const find = (id: string): DiffDetail | undefined =>
    state.find((item) => item.recon_diff_id === id);

  function list(query: Record<string, string>): Response {
    if (!canRead()) return denied();
    const { source, status, type, ref_id: ref, page, page_size: size } = query;
    const invalid = [
      ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
      ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
      ...(type === undefined || TYPES.includes(type) ? [] : ['type']),
      ...(source === undefined || SOURCES.includes(source) ? [] : ['source']),
      ...(status === undefined || STATUSES.includes(status) ? [] : ['status']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    const matching = state
      .filter(
        (item) =>
          (type === undefined || item.type === type) &&
          (source === undefined || item.source === source) &&
          (status === undefined || item.status === status) &&
          (ref === undefined || item.ref_id === ref),
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

  function verify(request: RequestLog): Response {
    const body = request.body as Partial<Schema<'AdminStepUpRequest'>> | undefined;
    if (body?.tier !== 'totp') return rejected(['tier']);
    if (body.code !== TOTP_CODE) return failure(20002, undefined, '验证码错误');
    issued.push(stepUpValue(issued.length + 1));
    return ok({ step_up_token: issued.at(-1), tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
  }

  function clawback(id: string, request: RequestLog): Response {
    if (!has('order.blacklist_clawback')) return denied();
    const presented = request.headers.get('X-Step-Up-Token');
    if (presented === null || !issued.includes(presented)) return stepUpRequired();
    const idempotency = request.headers.get('Idempotency-Key');
    if (idempotency === null || idempotency.trim() === '') return rejected(['Idempotency-Key']);
    // The step-up value is a header, not part of the body hash.
    const fingerprint = `${id} ${JSON.stringify(request.body ?? null)}`;
    const first = results.get(idempotency);
    if (first !== undefined) return first.request === fingerprint ? ok(first.data) : changedBody();
    const body =
      typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : undefined;
    // The body is required ({} without a note) and takes nothing but the note.
    if (body === undefined) return rejected(['body']);
    const unknown = Object.keys(body).filter((name) => name !== 'note');
    if (unknown.length > 0) return rejected(unknown);
    const note = body['note'];
    if (
      note !== undefined &&
      (typeof note !== 'string' || note.trim() === '' || note.trim().length > 200)
    ) {
      return rejected(['note']);
    }
    const found = find(id);
    if (found === undefined) return rejected(['recon_diff_id']);
    if (found.status !== 'open' && found.status !== 'processing') return diffConflict();
    if (found.type !== BLACKLIST_TYPE) return notSupported();
    if (!enabled) return switchedOff();
    if (orders.get(id) !== 'CREDITED') return orderConflict();
    const clawed = CLAWED[id] ?? 0;
    orders.set(id, 'CLAWED_BACK');
    found.status = 'adjusted';
    found.closed_at = NOW;
    found.updated_at = NOW;
    found.handler_id = SELF;
    found.resolution = {
      ...(found.resolution ?? {}),
      clawback: { operator: SELF, clawed_back_at: NOW, clawed_back_fen: clawed },
      ...(typeof note === 'string' ? { note: note.trim() } : {}),
    };
    const data: Schema<'AdminReconDiffBlacklistClawback'> = {
      recon_diff: structuredClone(found),
      clawed_back_fen: clawed,
      rebate_status_after: 'CLAWED_BACK',
    };
    results.set(idempotency, { request: fingerprint, data });
    return ok(data);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== `Bearer ${BEARER}`) {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === LIST) return list(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return detail(decodeURIComponent(one[1]!));
    if (method === 'POST' && path === VERIFY) return verify(request);
    const clawing = CLAWBACK.exec(path);
    if (method === 'POST' && clawing !== null) {
      return clawback(decodeURIComponent(clawing[1]!), request);
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

  const server = {
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
    /** GET …/{id} of one difference. */
    detailReads(id: string) {
      return log.filter((r) => r.method === 'GET' && r.path === detailPath(id));
    },
    /** POST …/{id}/blacklist-clawback (every id when none is given). */
    clawbacks(id?: string) {
      const wanted = (path: string): boolean =>
        id === undefined ? CLAWBACK.test(path) : path === clawbackPath(id);
      return log.filter((r) => r.method === 'POST' && wanted(r.path));
    },
    /** POST /admin/v1/auth/step-up. */
    verifies() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Requests outside the whitelist of this page. */
    unexpected() {
      return log.filter(
        (r) => !ALLOWED.some((entry) => entry.method === r.method && entry.path.test(r.path)),
      );
    },
    /** Step-up values handed out so far. */
    issued(): readonly string[] {
      return issued;
    },
    item(id: string): DiffDetail {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      return found;
    },
    /** rebate_status of the order a blacklist sample names. */
    orderOf(id: string): RebateStatus | undefined {
      return orders.get(id);
    },
    /** Another admin handled the difference meanwhile. */
    setStatus(id: string, status: DiffStatus) {
      const found = find(id);
      if (found === undefined) throw new Error(`fixture ${id}`);
      found.status = status;
      found.handler_id = HANDLER;
      found.updated_at = NOW;
      if (status !== 'open' && status !== 'processing') found.closed_at = NOW;
    },
    /** The order moved meanwhile (another difference of it was clawed back, or it was voided). */
    setOrder(id: string, status: RebateStatus) {
      orders.set(id, status);
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    /** Holds the next matching request until the returned function is called. */
    hold(method: string, path: string) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
  };
  created.push(server);
  return server;
}
export type Server = ReturnType<typeof createServer>;

/** Yuan with two decimals of integer fen, without grouping (the page may group with commas). */
export function yuan(fen: number): string {
  const magnitude = Math.abs(fen);
  const body = `${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
  return fen < 0 ? `-${body}` : body;
}
