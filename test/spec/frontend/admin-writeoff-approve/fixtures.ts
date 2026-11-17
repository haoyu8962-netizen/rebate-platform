import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  ADJUSTMENTS,
  ADMIN,
  USER,
  WO,
  WRITEOFFS,
  adjustments,
  ok,
  writeoffs,
  type Adjustment,
  type Grants,
  type RequestLog,
  type When,
  type Writeoff,
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

// Contract of the write of this task (contracts/openapi.yaml, tag admin-adjustments):
// adminApproveBadDebtWriteoff POST /admin/v1/bad-debt-writeoffs/{id}/approve — permission point
// fund.writeoff (one person completes it, ADD-05); sms-tier step-up (BR-ID-34, X-Step-Up-Token; an
// account without a verify phone gets 10003 data.reason=verify_phone_missing); the body is the
// empty object (no amount: candidate_fen is not used, the amount is −available read at approval).
// Checks in order: fund.writeoff (10403) → step-up (10003) → body (20001) → unknown id (20001
// data.fields=[id]) → not PENDING (20902 data.resource=bad_debt_writeoff, refresh) → frozen above 0
// while ledger.bad_debt_require_no_frozen.enabled is on (20001 data.fields=[id],
// data.reason=writeoff_frozen_pending; nothing written, the candidate stays PENDING). Effects:
// available below 0 → APPROVED, available 0, written_off_fen = −available; available at 0 or
// above → CANCELLED, still 200 with written_off_fen=0. Idempotency-Key required (same key and body
// → the first result; same key, another body → 20901; still running → 40901).
// adminListBadDebtWriteoffs reads available_fen / frozen_fen / approve_blocked as they are now; the
// fake server below keeps the candidates and the balances it writes, so the list reads them back.
export {
  ADJUSTMENTS,
  ADMIN,
  OTP,
  SMS_CODES,
  USER,
  VERIFY,
  WO,
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
  type Writeoff,
};
export {
  ADJUSTMENT_ORDER,
  COLUMN,
  TEXT as READ_TEXT,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  writeoffStatusName,
  yuan,
} from '../admin-adjustments-readonly/fixtures.ts';
export { stillRunning, unavailable } from '../admin-adjustment-create/fixtures.ts';

export type WriteoffApproved = Schema<'AdminBadDebtWriteoffApprove'>;

export const approvePath = (id: string): string => `${WRITEOFFS}/${id}/approve`;

// ---- what the page shows (fixed texts this task decides; texts/adjustments.ts holds them) ---

/**
 * Fixed texts of the write-off approval, compared as whole strings (whitespace collapsed and
 * trimmed). Buttons are matched by their text without spaces (or aria-label).
 */
export const TEXT = {
  /** Entry on a PENDING row of the 坏账核销 table (fund.writeoff only, super admins included). */
  approveEntry: '批准核销',
  /** Title of the approval dialog. */
  title: '批准坏账核销',
  /** The dialog's decision (opens the sms-tier StepUpModal) and its close button. */
  approve: '批准核销',
  cancel: '取消',
  /** The amount is read at approval (BR-FUND-12: −当前 available_fen, not candidate_fen). */
  amountNotice:
    '核销金额按批准时重新读取的可用余额计算，不用生成时金额；批准时可用余额已不小于 0 的，候选单改为已取消，不记坏账。',
  /** Consequence notice (BR-FUND-12 effects; risk marks of the linked accounts). */
  consequence:
    '批准后立即记坏账（借 坏账 / 贷 用户可用余额），用户可用余额回到 0，不可撤回，之后的入账照常计入余额；关联账户将被打上风控标记，只留痕，不改变提现判定。',
  /**
   * The member still has frozen money (a withdrawal not in a terminal state): shown in the dialog
   * of a candidate whose row says approve_blocked, and after 20001 writeoff_frozen_pending. No
   * switch name or configured value appears in it.
   */
  frozenPending:
    '该用户有冻结中的提现金额（提现单未到终态），暂不能核销：请先把提现单处理到终态，候选单保持待批准。',
  /** 200 with status APPROVED: the candidate and written_off_fen (through @couli/money). */
  approved: (id: string, amount: string): string => `已核销，候选单号 ${id}，核销金额 ${amount}`,
  /** 200 with status CANCELLED (written_off_fen=0): the balance was back at 0 or above. */
  cancelled: (id: string): string => `可用余额已回正，候选单已取消，未记坏账，候选单号 ${id}`,
} as const;

/** Labels of the dialog's read-only summary items (each label followed by its value). */
export const SUMMARY = {
  id: '候选单号',
  user: '用户',
  since: '负余额起始日',
  days: '负余额天数',
  candidate: '生成时金额',
  available: '当前可用余额',
  frozen: '冻结',
} as const;
export const SUMMARY_LABELS: readonly string[] = Object.values(SUMMARY);

/** The contract's refusals, as shown. */
export const ERROR = {
  /** 20001 data.reason=writeoff_frozen_pending (the dialog stays, the candidate stays PENDING). */
  frozenPending: TEXT.frozenPending,
  /** 20001 data.fields=[id] without a reason. */
  missing: '核销候选单不存在或已不可见，请刷新后重试',
  /**
   * 20902 data.resource=bad_debt_writeoff, or the refresh after an unknown outcome found the
   * candidate no longer PENDING: the list is read again, nothing more is sent.
   */
  stale: '该核销候选单已不是待批准状态，已刷新',
  /** 10403. */
  forbidden: '无权限执行坏账核销',
  /** 20901, 40901, a network failure or a 5xx: nothing is resent by itself. */
  failed: CREATE_ERROR.failed,
  /** BR-TEXT-14 table B error.10003.verify_phone_missing (texts/step-up.ts verifyPhoneMissing). */
  verifyPhoneMissing: CREATE_ERROR.verifyPhoneMissing,
} as const;

// ---- permissions ---------------------------------------------------------------------------

/** A non-super snapshot of `points`; fund.writeoff and fund.adjust carry the sms tier. */
export function snapshotOf(points: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of points) {
    const sms = point === 'fund.writeoff' || point === 'fund.adjust';
    stepUp[point] = { tier: sms ? 'sms' : null, operations: {} };
  }
  return { isSuper: false, permissions: points, stepUp };
}
/** fund.writeoff only (sms tier, 04 §11). */
export const WRITEOFFER: PermissionSnapshot = snapshotOf(['fund.writeoff']);
export const SUPER_ADMIN: PermissionSnapshot = {
  isSuper: true,
  permissions: [],
  stepUp: {
    'fund.adjust': { tier: 'sms', operations: {} },
    'fund.writeoff': { tier: 'sms', operations: {} },
  },
};
export const ALL_FUND: Grants = ['fund.adjust', 'fund.view', 'fund.writeoff'];

// ---- samples -------------------------------------------------------------------------------

/** The PENDING candidates of the samples, in list order. */
export const PENDING: readonly string[] = [WO.recent, WO.blocked];
/** The decided candidates of the samples (APPROVED, CANCELLED). */
export const DECIDED: readonly string[] = [WO.writtenOff, WO.cancelled];

// ---- envelopes -----------------------------------------------------------------------------

export function frozenPendingReply(): Response {
  return rejected(['id'], 'writeoff_frozen_pending');
}
export function unknownCandidate(): Response {
  return rejected(['id']);
}
export function stateChanged(): Response {
  return failure(20902, { resource: 'bad_debt_writeoff' }, '状态已变化，请刷新后重试');
}
export function networkDown(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}

// ---- fake server ---------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;

export interface WriteoffServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** false: the account has no registered verify phone (10003 verify_phone_missing). */
  readonly verifyPhone?: boolean;
  /** ledger.bad_debt_require_no_frozen.enabled (default on). */
  readonly requireNoFrozen?: boolean;
}

interface Balance {
  available: number;
  frozen: number;
}

const POSITIVE = /^[1-9][0-9]*$/;
const DETAIL = /^\/admin\/v1\/adjustments\/([^/]+)$/;
const APPROVE = /^\/admin\/v1\/bad-debt-writeoffs\/([^/]+)\/approve$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pageOf<T>(rows: readonly T[], page: string | undefined, size: string | undefined) {
  const pageNo = page !== undefined && POSITIVE.test(page) ? Number(page) : 1;
  const pageSize = size !== undefined && POSITIVE.test(size) ? Math.min(Number(size), 200) : 20;
  const items = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return { items, page: pageNo, page_size: pageSize, total: rows.length };
}
function newestFirst(a: string, b: string, aId: string, bId: string): number {
  const diff = Date.parse(b) - Date.parse(a);
  if (diff !== 0) return diff;
  return aId < bId ? 1 : aId > bId ? -1 : 0;
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
function isApproval(request: RequestLog): boolean {
  return request.method === 'POST' && APPROVE.test(request.path);
}
/** The sms step-up pair or adminApproveBadDebtWriteoff. */
function isApproveFlow(request: RequestLog): boolean {
  if (request.method !== 'POST') return false;
  return request.path === SMS_CODES || request.path === VERIFY || APPROVE.test(request.path);
}

/**
 * Fake /admin/v1 server: the three reads of F1-08ca (the 坏账核销 list over mutable candidates
 * and balances), the sms step-up pair and adminApproveBadDebtWriteoff. Its shape is a superset of
 * the frozen read-only server, so the frozen mount / settled helpers take it.
 */
export function createWriteoffServer(options: WriteoffServerOptions = {}) {
  const forms: Adjustment[] = structuredClone(adjustments());
  const candidates: Writeoff[] = structuredClone(writeoffs());
  const balances = new Map<string, Balance>();
  for (const row of candidates)
    balances.set(row.user_id, { available: row.available_fen, frozen: row.frozen_fen });
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; when: When | undefined; reply: Reply }[] = [];
  const permissions: Grants = options.permissions ?? ['fund.writeoff'];
  const verifyPhone = options.verifyPhone ?? true;
  const requireNoFrozen = options.requireNoFrozen ?? true;
  /** Step-up passes issued and not used yet (a pass serves one write). */
  const passes = new Set<string>();
  const results = new Map<string, { body: string; response: Response }>();
  let verified = 0;
  let decided = 0;
  let inFlight = 0;

  const holds = (point: KnownPermission): boolean => permissions.includes(point);
  const readsAdjustments = (): boolean => holds('fund.adjust') || holds('fund.view');
  const readsWriteoffs = (): boolean => holds('fund.writeoff') || holds('fund.view');
  const balanceOf = (user: string): Balance => {
    const found = balances.get(user);
    if (found !== undefined) return found;
    const fresh = { available: 0, frozen: 0 };
    balances.set(user, fresh);
    return fresh;
  };

  /** The row as the list reads it now (balance and approve_blocked read with the row). */
  function rowOf(candidate: Writeoff): Writeoff {
    const { available, frozen } = balanceOf(candidate.user_id);
    return {
      ...structuredClone(candidate),
      available_fen: available,
      frozen_fen: frozen,
      approve_blocked: candidate.status === 'PENDING' && requireNoFrozen && frozen > 0,
    };
  }

  function listAdjustments(query: Record<string, string>): Response {
    if (!readsAdjustments()) return denied();
    const matching = forms
      .filter((form) => query['status'] === undefined || form.status === query['status'])
      .sort((a, b) => newestFirst(a.created_at, b.created_at, a.adjust_id, b.adjust_id));
    return ok(pageOf(matching, query['page'], query['page_size']));
  }

  function getAdjustment(adjustId: string): Response {
    if (!readsAdjustments()) return denied();
    const found = forms.find((form) => form.adjust_id === adjustId);
    if (found === undefined) return rejected(['adjust_id']);
    return ok({ adjustment: found, balance_preview: null });
  }

  function listWriteoffs(query: Record<string, string>): Response {
    if (!readsWriteoffs()) return denied();
    const matching = candidates
      .filter((row) => query['status'] === undefined || row.status === query['status'])
      .sort((a, b) => newestFirst(a.created_at, b.created_at, a.id, b.id))
      .map(rowOf);
    return ok(pageOf(matching, query['page'], query['page_size']));
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

  /** Decides `candidate` as the contract describes (amount = −available now). */
  function decide(candidate: Writeoff, admin: string): WriteoffApproved {
    const balance = balanceOf(candidate.user_id);
    decided += 1;
    if (balance.available >= 0) {
      candidate.status = 'CANCELLED';
      return { writeoff: rowOf(candidate), written_off_fen: 0 };
    }
    const amount = -balance.available;
    balance.available = 0;
    candidate.status = 'APPROVED';
    candidate.approver_id = admin;
    candidate.approved_at = `2027-02-${String(18 + decided).padStart(2, '0')}T10:30:00+08:00`;
    candidate.voucher_id = `f400000${decided}-0000-4000-8000-000000000000`;
    return { writeoff: rowOf(candidate), written_off_fen: amount };
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

  function approve(request: RequestLog, id: string): Response {
    if (!holds('fund.writeoff')) return denied();
    if (!verifyPhone) return phoneMissing();
    const pass = request.headers.get('X-Step-Up-Token');
    if (pass === null || !passes.has(pass)) return stepUpRequired();
    passes.delete(pass);
    const replay = replayed(request);
    if (replay !== undefined) return replay;
    const body = request.body;
    const empty = isRecord(body) && Object.getOwnPropertyNames(body).length === 0;
    const candidate = candidates.find((one) => one.id === id);
    let response: Response;
    if (!empty) response = rejected(['body']);
    else if (candidate === undefined) response = unknownCandidate();
    else if (candidate.status !== 'PENDING') response = stateChanged();
    else if (requireNoFrozen && balanceOf(candidate.user_id).frozen > 0)
      response = frozenPendingReply();
    else response = ok(decide(candidate, ADMIN.first));
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
    const approval = APPROVE.exec(path);
    if (method === 'POST' && approval !== null)
      return approve(request, decodeURIComponent(approval[1]!));
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

  return {
    log,
    fetch,
    permissions,
    /** The candidates as the server holds them now (balances aside). */
    candidates,
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
      return log.filter((r) => r.method === 'GET' && r.path === `${ADJUSTMENTS}/${adjustId}`);
    },
    others() {
      return log.filter((r) => !isRead(r));
    },
    /** POST …/bad-debt-writeoffs/{id}/approve (adminApproveBadDebtWriteoff), any candidate. */
    approvals() {
      return log.filter(isApproval);
    },
    /** POST /admin/v1/auth/step-up/sms-codes. */
    codeSends() {
      return log.filter((r) => r.method === 'POST' && r.path === SMS_CODES);
    },
    /** POST /admin/v1/auth/step-up. */
    verifications() {
      return log.filter((r) => r.method === 'POST' && r.path === VERIFY);
    },
    /** Requests other than the reads of the page, the step-up pair and the approval. */
    unexpected() {
      return log.filter((r) => !isRead(r) && !isApproveFlow(r));
    },
    /** Sets the member's available and frozen (in fen) from now on. */
    setBalance(user: string, available: number, frozen: number): void {
      balances.set(user, { available, frozen });
    },
    /** Someone else approves `id` meanwhile (the race behind 20902). */
    approveElsewhere(id: string): void {
      const candidate = candidates.find((one) => one.id === id);
      if (candidate !== undefined) decide(candidate, ADMIN.second);
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
export type WriteoffServer = ReturnType<typeof createWriteoffServer>;

/** A table read of the 坏账核销 list (count reads with page_size=1 aside). */
export function writeoffRead(): When {
  return (request) => isTableRead(request, WRITEOFFS);
}
