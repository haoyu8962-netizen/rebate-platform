import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { KnownPermission } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  ADJ,
  ADJUSTMENTS,
  ADMIN,
  DOC,
  USER,
  WRITEOFFS,
  adjustments,
  ok,
  writeoffs,
  type Adjustment,
  type AdjustmentDetail,
  type Grants,
  type RequestLog,
  type When,
} from '../admin-adjustments-readonly/fixtures.ts';
import {
  ERROR as CREATE_ERROR,
  OTP,
  SMS_CODES,
  VERIFY,
  conflict,
  denied,
  failure,
  passOf,
  phoneMissing,
  rejected,
  stepUpRequired,
} from '../admin-adjustment-create/fixtures.ts';

// Contract of the two writes of this task (contracts/openapi.yaml, tag admin-adjustments):
// - adminApproveAdjustment POST /admin/v1/adjustments/{adjust_id}/approve: fund.adjust; sms-tier
//   step-up (BR-ID-34, X-Step-Up-Token; an account without a verify phone gets 10003
//   data.reason=verify_phone_missing); the body is the empty object (the console sends no amount:
//   amount_fen is the member's available when the approval runs, which may differ from the
//   preview); checks in order fund.adjust → step-up → body → unknown id (20001 fields=[adjust_id])
//   → not PENDING (20902 data.resource=admin_adjustment) → available not above 0 (20001
//   fields=[adjust_id], reason=adjust_no_balance; nothing written, the form stays PENDING).
// - adminRejectAdjustment POST /admin/v1/adjustments/{adjust_id}/reject: fund.adjust; no step-up
//   of either tier; the body is `reason` only (1–200 characters after trimming, else 20001
//   fields=[reason]); unknown id 20001 fields=[adjust_id]; not PENDING 20902.
// - Both: Idempotency-Key required (same key and body → the first result; same key, another body
//   → 20901; still running → 40901).
// adminGetAdjustment gives a PENDING form its balance_preview: the amount is the current
// available (0 when it is not above 0). The fake server keeps the forms and the balances it writes,
// so the list and the detail read them back.
export {
  ADJ,
  ADJUSTMENTS,
  ADMIN,
  DOC,
  OTP,
  SMS_CODES,
  USER,
  VERIFY,
  WRITEOFFS,
  conflict,
  denied,
  failure,
  ok,
  passOf,
  phoneMissing,
  rejected,
  stepUpRequired,
  type RequestLog,
};
export {
  ADJUSTMENT_ORDER,
  COLUMN,
  DIRECTION_NAME,
  FIELD,
  REF_TYPE_NAME,
  SUBJECT_NAME,
  TEXT as READ_TEXT,
  reasonName,
  statusName,
  yuan,
} from '../admin-adjustments-readonly/fixtures.ts';
export {
  ADJUSTER,
  ALL_FUND,
  READER,
  SUPER_ADMIN,
  WRITEOFF_ONLY,
  stillRunning,
  unavailable,
} from '../admin-adjustment-create/fixtures.ts';

export type Executed = Schema<'AdminAdjustmentExecuted'>;
export type Rejection = Schema<'AdminAdjustmentReject'>;

export const approvePath = (adjustId: string): string => `${ADJUSTMENTS}/${adjustId}/approve`;
export const rejectPath = (adjustId: string): string => `${ADJUSTMENTS}/${adjustId}/reject`;
export const detailPath = (adjustId: string): string => `${ADJUSTMENTS}/${adjustId}`;

// ---- what the page shows (fixed texts this task decides; texts/adjustments.ts holds them) ---

/**
 * Fixed texts of the approval dialog, compared as whole strings (whitespace collapsed and
 * trimmed). Buttons are matched by their text without spaces (or aria-label).
 */
export const TEXT = {
  /** Entry on a PENDING row and in the detail of a PENDING form (fund.adjust only). */
  approveEntry: '批准',
  /** Title of the approval dialog. */
  approveTitle: '批准调账单',
  /** The two decisions of the dialog and its close button. */
  approve: '批准并短信验证',
  reject: '驳回',
  cancel: '取消',
  /** Consequence notice of the dialog (BR-FUND-24 ⑥⑧; adminRejectAdjustment effects). */
  consequence:
    '批准后按批准时的可用余额整笔调减，转入平台佣金收入并立即记账，不可撤回；驳回不记账，注销仍待处理，系统次日重新预填。',
  /** Next to the balance preview: the preview is a reading, the approval reads again. */
  actualAmount: '实际调减金额以批准时的可用余额为准，可能与预览不同。',
  /** Success prompts: the form's adjust_id, and for an approval the amount actually taken. */
  approved: (adjustId: string, amount: string): string =>
    `已批准，调账单号 ${adjustId}，实际调减 ${amount}`,
  rejected: (adjustId: string): string => `已驳回，调账单号 ${adjustId}`,
} as const;

/** The dialog's only input (used by 【驳回】 only). */
export const LABEL = { rejectReason: '驳回原因' } as const;

/** Labels of the dialog's read-only summary items (each label followed by its value). */
export const SUMMARY = {
  id: '调账单号',
  user: '用户',
  direction: '方向',
  reason: '原因',
  subject: '对方科目',
  creator: '创建人',
  created: '创建时间',
} as const;
export const SUMMARY_LABELS: readonly string[] = Object.values(SUMMARY);

/** The balance preview lines (adminGetAdjustment balance_preview, only through @couli/money). */
export const BALANCE = {
  before: '批准前可用余额',
  amount: '预计调减金额',
  after: '批准后可用余额',
} as const;
export const BALANCE_LABELS: readonly string[] = Object.values(BALANCE);

/** Local checks (nothing is sent while one fails) and the contract's refusals, as shown. */
export const ERROR = {
  rejectReasonRequired: '请填写驳回原因',
  rejectReasonTooLong: '驳回原因最多 200 字',
  /** 20001 data.fields=[reason] from the server. */
  rejectReasonInvalid: '驳回原因须为 1–200 字，请修改后重试',
  /** 20001 data.reason=adjust_no_balance (the form stays PENDING; the operator rejects it). */
  noBalance: '可用余额不大于 0，不能批准，请驳回',
  /** 20001 data.fields=[adjust_id] without a reason. */
  missing: '调账单不存在或已不可见，请刷新后重试',
  /**
   * 20902 data.resource=admin_adjustment, or the refresh after an unknown outcome found the form
   * no longer PENDING: the list (and an open detail) is read again, nothing is sent.
   */
  stale: '该调账单已不是待批准状态，已刷新',
  /** 10403. */
  forbidden: CREATE_ERROR.forbidden,
  /** 20901, 40901, a network failure or a 5xx: nothing is resent by itself. */
  failed: CREATE_ERROR.failed,
  /** BR-TEXT-14 table B error.10003.verify_phone_missing (texts/step-up.ts verifyPhoneMissing). */
  verifyPhoneMissing: CREATE_ERROR.verifyPhoneMissing,
} as const;

// ---- samples of this task ------------------------------------------------------------------

/** available of the deleting member when nothing else is set (the contract example). */
export const DELETING_AVAILABLE = 2000;
/** A rejection reason (the contract example). */
export const REASON = '预填金额与核对结果不一致，次日按系统补建的新单处理';

/** A second prefilled PENDING form (pass it as `extra`; newest, so it lists first). */
export const SECOND = 'ad100010-0000-4000-8000-000000000010';
export const SECOND_USER = 'c1000007-0000-4000-8000-000000000007';
export const SECOND_DELETION = 'de100004-0000-4000-8000-000000000004';
export const SECOND_AVAILABLE = 345;
export function secondPending(): Adjustment {
  return {
    adjust_id: SECOND,
    user_id: SECOND_USER,
    direction: 'decrease',
    amount_fen: null,
    reason_code: 'ACCOUNT_CLOSED',
    status: 'PENDING',
    refs: [{ ref_type: 'account_deletion', ref_id: SECOND_DELETION }],
    contra_subject: 'COMMISSION_REVENUE',
    contra_platform: null,
    note: null,
    reverses_adjust_id: null,
    reversed_by_adjust_id: null,
    created_by: null,
    created_at: '2026-12-02T02:00:00+08:00',
    reviewed_by: null,
    reviewed_at: null,
    reject_note: null,
    voucher_id: null,
  };
}

// ---- envelopes -----------------------------------------------------------------------------

export function stateChanged(): Response {
  return failure(20902, { resource: 'admin_adjustment' }, '状态已变化，请刷新后重试');
}
export function noBalance(): Response {
  return rejected(['adjust_id'], 'adjust_no_balance');
}
export function unknownForm(): Response {
  return rejected(['adjust_id']);
}
export function reasonInvalid(): Response {
  return rejected(['reason']);
}
export function networkDown(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}

// ---- fake server ---------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface ApproveServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** false: the account has no registered verify phone (10003 verify_phone_missing). */
  readonly verifyPhone?: boolean;
  /** Further forms after the eight samples (e.g. secondPending()). */
  readonly extra?: readonly Adjustment[];
}

const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/adjustments\/([^/]+)$/;
const DECISION = /^\/admin\/v1\/adjustments\/([^/]+)\/(approve|reject)$/;
/** available of every member the server holds when nothing else is set. */
const OTHER_AVAILABLE = 50000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** created_at descending, then the id descending. */
function newestFirst(a: Adjustment, b: Adjustment): number {
  const diff = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (diff !== 0) return diff;
  return a.adjust_id < b.adjust_id ? 1 : a.adjust_id > b.adjust_id ? -1 : 0;
}
function pageOf<T>(rows: readonly T[], page: string | undefined, size: string | undefined) {
  const pageNo = page !== undefined && POSITIVE.test(page) ? Number(page) : 1;
  const pageSize = size !== undefined && POSITIVE.test(size) ? Math.min(Number(size), 200) : 20;
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return { items, page: pageNo, page_size: pageSize, total: rows.length };
}
function isTableRead(request: RequestLog, path: string): boolean {
  return request.method === 'GET' && request.path === path && request.query['page_size'] !== '1';
}
/** One of the three reads of the page. */
function isRead(request: RequestLog): boolean {
  if (request.method !== 'GET') return false;
  const { path } = request;
  return path === ADJUSTMENTS || DETAIL.test(path) || path === WRITEOFFS;
}
/** The sms step-up pair, adminApproveAdjustment or adminRejectAdjustment. */
function isDecisionFlow(request: RequestLog): boolean {
  if (request.method !== 'POST') return false;
  return request.path === SMS_CODES || request.path === VERIFY || DECISION.test(request.path);
}
function isApproval(request: RequestLog): boolean {
  return request.method === 'POST' && DECISION.exec(request.path)?.[2] === 'approve';
}
function isRejection(request: RequestLog): boolean {
  return request.method === 'POST' && DECISION.exec(request.path)?.[2] === 'reject';
}
/** The reason as the contract checks it: a string of 1–200 characters after trimming. */
function validReason(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 200;
}

/**
 * Fake /admin/v1 server: the three reads of F1-08ca over a mutable set of forms and balances, the
 * sms step-up pair, adminApproveAdjustment and adminRejectAdjustment. Its shape is a superset of
 * the frozen read-only server, so the frozen mount / openDetail / settled helpers take it.
 */
export function createApproveServer(options: ApproveServerOptions = {}) {
  const forms: Adjustment[] = structuredClone([...adjustments(), ...(options.extra ?? [])]);
  const candidates = structuredClone(writeoffs());
  const balances = new Map<string, number>([
    [USER.deleting, DELETING_AVAILABLE],
    [SECOND_USER, SECOND_AVAILABLE],
  ]);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions: Grants = options.permissions ?? ['fund.adjust'];
  const verifyPhone = options.verifyPhone ?? true;
  /** Step-up passes issued and not used yet (a pass serves one write). */
  const passes = new Set<string>();
  const results = new Map<string, { body: string; response: Response }>();
  let verified = 0;
  let decided = 0;
  let inFlight = 0;

  const holds = (point: KnownPermission): boolean => permissions.includes(point);
  const readsAdjustments = (): boolean => holds('fund.adjust') || holds('fund.view');
  const readsWriteoffs = (): boolean => holds('fund.writeoff') || holds('fund.view');
  const availableOf = (user: string): number => balances.get(user) ?? OTHER_AVAILABLE;

  function listAdjustments(query: Record<string, string>): Response {
    if (!readsAdjustments()) return denied();
    const { page, page_size: size, reason_code: reason, status, user_id: user } = query;
    const matching = forms
      .filter(
        (form) =>
          (reason === undefined || form.reason_code === reason) &&
          (status === undefined || form.status === status) &&
          (user === undefined || form.user_id === user),
      )
      .sort(newestFirst);
    return ok(pageOf(matching, page, size));
  }

  function previewOf(form: Adjustment): AdjustmentDetail['balance_preview'] {
    const available = availableOf(form.user_id);
    if (form.status === 'PENDING') {
      const amount = available > 0 ? available : 0;
      return {
        direction: 'decrease',
        amount_fen: amount,
        available_before_fen: available,
        available_after_fen: available - amount,
      };
    }
    const open =
      form.status === 'APPROVED' &&
      form.reverses_adjust_id === null &&
      form.reversed_by_adjust_id === null &&
      form.amount_fen !== null;
    if (!open || form.amount_fen === null) return null;
    const direction = form.direction === 'increase' ? 'decrease' : 'increase';
    const after =
      direction === 'increase' ? available + form.amount_fen : available - form.amount_fen;
    return {
      direction,
      amount_fen: form.amount_fen,
      available_before_fen: available,
      available_after_fen: after,
    };
  }

  function getAdjustment(adjustId: string): Response {
    if (!readsAdjustments()) return denied();
    const found = forms.find((form) => form.adjust_id === adjustId);
    if (found === undefined) return unknownForm();
    const detail: AdjustmentDetail = { adjustment: found, balance_preview: previewOf(found) };
    return ok(detail);
  }

  function listWriteoffs(query: Record<string, string>): Response {
    if (!readsWriteoffs()) return denied();
    return ok(pageOf(candidates, query['page'], query['page_size']));
  }

  function sendCode(): Response {
    if (!verifyPhone) return phoneMissing();
    return ok({ resend_after_sec: 60, expires_in_sec: 300 });
  }

  function verify(body: unknown): Response {
    if (!isRecord(body) || body['tier'] !== 'sms' || typeof body['code'] !== 'string')
      return rejected(['tier']);
    if (!verifyPhone) return phoneMissing();
    if (body['code'] !== OTP) return failure(20002, undefined, '验证码错误');
    verified += 1;
    const pass = passOf(verified);
    passes.add(pass);
    return ok({ ['step_up_token']: pass, tier: 'sms', expire_at: '2099-01-01T00:00:00Z' });
  }

  /** The time a decision is recorded at (each one a day later). */
  function decisionTime(): string {
    decided += 1;
    return `2026-12-${String(10 + decided).padStart(2, '0')}T09:30:00+08:00`;
  }

  /** Approves `form` as the contract describes (amount = available now, taken to 0). */
  function approveForm(form: Adjustment, admin: string): Executed {
    const before = availableOf(form.user_id);
    const at = decisionTime();
    form.amount_fen = before;
    form.status = 'APPROVED';
    form.reviewed_by = admin;
    form.reviewed_at = at;
    form.voucher_id = `f300000${decided}-0000-4000-8000-000000000000`;
    balances.set(form.user_id, 0);
    return {
      adjustment: structuredClone(form),
      available_before_fen: before,
      available_after_fen: 0,
    };
  }

  /** Rejects `form` with the trimmed `reason`. */
  function rejectForm(form: Adjustment, reason: string, admin: string): Rejection {
    form.status = 'REJECTED';
    form.reject_note = reason.trim();
    form.reviewed_by = admin;
    form.reviewed_at = decisionTime();
    return { adjustment: structuredClone(form) };
  }

  /** Same key and body → the first result; same key, another body → 20901. */
  function replayed(request: RequestLog): Response | undefined {
    const idem = request.headers.get('Idempotency-Key') ?? '';
    if (idem === '') return rejected(['Idempotency-Key']);
    const first = results.get(`${request.path} ${idem}`);
    if (first === undefined) return undefined;
    return first.body === JSON.stringify(request.body) ? first.response.clone() : conflict();
  }
  function remember(request: RequestLog, response: Response): Response {
    const idem = request.headers.get('Idempotency-Key') ?? '';
    const body = JSON.stringify(request.body);
    results.set(`${request.path} ${idem}`, { body, response: response.clone() });
    return response;
  }

  function approve(request: RequestLog, adjustId: string): Response {
    if (!holds('fund.adjust')) return denied();
    if (!verifyPhone) return phoneMissing();
    const pass = request.headers.get('X-Step-Up-Token');
    if (pass === null || !passes.has(pass)) return stepUpRequired();
    passes.delete(pass);
    const replay = replayed(request);
    if (replay !== undefined) return replay;
    const body = request.body;
    let response: Response;
    const form = forms.find((one) => one.adjust_id === adjustId);
    const empty = isRecord(body) && Object.getOwnPropertyNames(body).length === 0;
    if (!empty) response = rejected(['body']);
    else if (form === undefined) response = unknownForm();
    else if (form.status !== 'PENDING') response = stateChanged();
    else if (availableOf(form.user_id) <= 0) response = noBalance();
    else response = ok(approveForm(form, ADMIN.first));
    return remember(request, response);
  }

  function reject(request: RequestLog, adjustId: string): Response {
    if (!holds('fund.adjust')) return denied();
    const replay = replayed(request);
    if (replay !== undefined) return replay;
    const body = request.body;
    let response: Response;
    const form = forms.find((one) => one.adjust_id === adjustId);
    const names = isRecord(body) ? Object.getOwnPropertyNames(body) : ['body'];
    const reason = isRecord(body) ? body['reason'] : undefined;
    const extra = names.some((name) => name !== 'reason');
    if (extra || !validReason(reason)) response = reasonInvalid();
    else if (form === undefined) response = unknownForm();
    else if (form.status !== 'PENDING') response = stateChanged();
    else response = ok(rejectForm(form, reason, ADMIN.first));
    return remember(request, response);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === ADJUSTMENTS) return listAdjustments(request.query);
    const one = DETAIL.exec(path);
    if (method === 'GET' && one !== null) return getAdjustment(decodeURIComponent(one[1]!));
    if (method === 'GET' && path === WRITEOFFS) return listWriteoffs(request.query);
    if (method === 'POST' && path === SMS_CODES) return sendCode();
    if (method === 'POST' && path === VERIFY) return verify(request.body);
    const decision = DECISION.exec(path);
    if (method === 'POST' && decision !== null) {
      const adjustId = decodeURIComponent(decision[1]!);
      return decision[2] === 'approve' ? approve(request, adjustId) : reject(request, adjustId);
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
        (entry) =>
          entry.method === request.method &&
          entry.path === request.path &&
          (entry.when === undefined || entry.when(request)),
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  const find = (adjustId: string): Adjustment | undefined =>
    forms.find((form) => form.adjust_id === adjustId);

  return {
    log,
    fetch,
    permissions,
    /** The forms as the server holds them now. */
    forms,
    get pending() {
      return inFlight;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    requestsUnder(path: string) {
      return log.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
    },
    tableReads(path: string) {
      return log.filter((r) => isTableRead(r, path));
    },
    detailReads(adjustId: string) {
      return log.filter((r) => r.method === 'GET' && r.path === detailPath(adjustId));
    },
    others() {
      return log.filter((r) => !isRead(r));
    },
    /** POST …/approve (adminApproveAdjustment), any form. */
    approvals() {
      return log.filter(isApproval);
    },
    /** POST …/reject (adminRejectAdjustment), any form. */
    rejections() {
      return log.filter(isRejection);
    },
    /** POST /admin/v1/adjustments (adminCreateAdjustment; never sent by this task). */
    creations() {
      return log.filter((r) => r.method === 'POST' && r.path === ADJUSTMENTS);
    },
    /** POST /admin/v1/auth/step-up/sms-codes. */
    codeSends() {
      return log.filter((r) => r.method === 'POST' && r.path === SMS_CODES);
    },
    /** POST /admin/v1/auth/step-up. */
    verifications() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Requests other than the reads of the page, the step-up pair and the two decisions. */
    unexpected() {
      return log.filter((r) => !isRead(r) && !isDecisionFlow(r));
    },
    /** Sets the member's available (in fen) from now on. */
    setAvailable(user: string, fen: number): void {
      balances.set(user, fen);
    },
    /** Someone else approves `adjustId` meanwhile (the race behind 20902). */
    approveElsewhere(adjustId: string): void {
      const form = find(adjustId);
      if (form !== undefined) approveForm(form, ADMIN.second);
    },
    /** Someone else rejects `adjustId` meanwhile (the race behind 20902). */
    rejectElsewhere(adjustId: string): void {
      const form = find(adjustId);
      if (form !== undefined) rejectForm(form, REASON, ADMIN.second);
    },
    once(method: string, path: string, reply: Reply, when?: When) {
      overrides.push({ method, path, when, reply });
    },
    hold(method: string, path: string, when?: When) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        when,
        reply: async (request) => {
          await gate.promise;
          return normal(request);
        },
      });
      return gate.resolve;
    },
    /** The next `method` `path` is carried out, but its answer is lost (a network failure). */
    lose(method: string, path: string) {
      overrides.push({
        method,
        path,
        when: undefined,
        reply: (request) => {
          normal(request);
          return networkDown();
        },
      });
    },
  };
}
export type ApproveServer = ReturnType<typeof createApproveServer>;
