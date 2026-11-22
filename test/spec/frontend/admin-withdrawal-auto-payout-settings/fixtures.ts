import { yuanStrToFen } from '@couli/money';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  ALL,
  allowedHere,
  createPayoutServer,
  type PayoutServer,
} from '../admin-payouts-readonly/fixtures.ts';
import {
  TRACE_ID,
  type Grants,
  type RequestLog,
  type RequestMatch,
} from '../admin-withdrawals/fixtures.ts';

// Contract-shaped fixtures of the 「自动到账设置」 tab of /withdrawals (F1-08ap; BR-WDR-30 细则
// 「后台配置页」; contracts/openapi.yaml): adminListConfigItems GET /admin/v1/config-items (any
// config.* point, page / page_size ≤ 200 only, every registered key in registry order with its
// version; value null = never written, the server's default applies), adminBatchUpdateConfigItems
// POST /admin/v1/config-items/batch ({items:[{key,value,expected_version}], reason?}; one point per
// batch, config.business asks for the totp tier → 10003 data.tier=totp without a valid
// X-Step-Up-Token; first every key and value is checked → 20001 data.fields lists the failing keys;
// then versions → 20902 data.resource=config_item; all or nothing; answers every item of the batch as
// it is now, in request order; no Idempotency-Key), adminListKillSwitches GET /admin/v1/kill-switches
// (switch.all / switch.payout / switch.pay) for the read-only master switch
// withdraw.auto_payout.enabled, and the frozen withdrawals / payout reads underneath. Values,
// versions and admins are samples, chosen apart from the 08 defaults so a page that writes the
// defaults in instead of reading them is caught.
export type { Grants, PayoutServer, RequestLog, RequestMatch };

export const ITEMS = '/admin/v1/config-items';
export const BATCH = '/admin/v1/config-items/batch';
export const SWITCHES = '/admin/v1/kill-switches';
export const VERIFY = '/admin/v1/auth/step-up';

export type ConfigRow = Schema<'AdminConfigItem'>;
export type BatchRequest = Schema<'AdminConfigItemBatchRequest'>;
export type BatchEntry = Schema<'AdminConfigItemBatchEntry'>;
export type Switch = Schema<'AdminKillSwitch'>;

/** The prefix of every key of this tab. */
export const PREFIX = 'withdraw.auto_payout.';
export const KEY = {
  maxAmount: `${PREFIX}max_amount_fen`,
  windowStart: `${PREFIX}window_start`,
  windowEnd: `${PREFIX}window_end`,
  windowLimit: `${PREFIX}window_limit_enabled`,
  firstLimit: `${PREFIX}first_withdrawal_limit_enabled`,
  frozen: `${PREFIX}frozen_balance_policy`,
  sameDay: `${PREFIX}same_day_policy`,
  payeeDaily: `${PREFIX}payee_daily_max_count`,
  payeeMonthly: `${PREFIX}payee_monthly_max_count`,
  userDaily: `${PREFIX}user_daily_max_count`,
  userMonthly: `${PREFIX}user_monthly_max_count`,
  warnRate: `${PREFIX}warn.high_commission_rate_bp`,
  warnOrders: `${PREFIX}warn.high_commission_order_ratio_bp`,
  warnInvalid: `${PREFIX}warn.invalid_ratio_bp`,
  warnReceived: `${PREFIX}warn.withdraw_received_ratio_bp`,
  platformDaily: `${PREFIX}platform_daily_max_fen`,
  riskFlags: `${PREFIX}risk_block_flags`,
} as const;
/** The master switch (a kill switch, read only on this tab). */
export const MASTER = `${PREFIX}enabled`;

/** The whole hours of window_start / window_end (09–22, the registry's options). */
export const HOURS = Array.from({ length: 14 }, (_, index) => String(9 + index).padStart(2, '0'));
export const STARTS = HOURS.map((hour) => `${hour}:00:00`);
export const ENDS = HOURS.map((hour) => `${hour}:59:59`);

/** BR-WDR-29 label codes a save may put into risk_block_flags (blacklist_hit is fixed). */
export const FLAG_CODES = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'blacklist_hit',
  'payee_prev_other_user',
  'risk_calc_failed',
] as const;

// ---- accounts --------------------------------------------------------------------------------

/** A snapshot of `grants`; config.business and the switch points ask for the totp tier. */
export function accountOf(grants: Grants): PermissionSnapshot {
  const totp: readonly KnownPermission[] = ['config.business', 'switch.all', 'switch.payout'];
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of grants)
    stepUp[point] = { tier: totp.includes(point) ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions: grants, stepUp };
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
/** What the fake server lets a super admin do. */
export const SUPER_GRANTS: Grants = [...ALL, 'switch.all', 'switch.payout', 'switch.pay'];
/** A finance account: the review list, the payout tabs and config.business, no switch point. */
export const BUSINESS_GRANTS: Grants = ['withdraw.review', 'fund.view', 'config.business'];
/** The same without config.business. */
export const VIEW_GRANTS: Grants = ['withdraw.review', 'fund.view'];
/** Another config point only (the list read allows it, the tab does not show for it). */
export const GENERAL_GRANTS: Grants = ['withdraw.review', 'fund.view', 'config.general'];
export const RISK_GRANTS: Grants = ['withdraw.review', 'fund.view', 'config.risk'];

// ---- the configuration registry --------------------------------------------------------------

function item(
  key: string,
  value: ConfigRow['value'],
  version: number,
  patch: Partial<ConfigRow> = {},
): ConfigRow {
  const unwritten = version === 0;
  const type: ConfigRow['value_type'] =
    typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'object';
  return {
    key,
    value: unwritten ? null : value,
    value_type: type,
    options: null,
    permission: 'config.business',
    admin_editable: true,
    version,
    updated_by: unwritten ? null : 'ops-yi',
    updated_at: unwritten ? null : '2026-11-19T10:00:00+08:00',
    ...patch,
  };
}
function enumItem(
  key: string,
  value: string,
  options: readonly string[],
  version: number,
  editable = true,
): ConfigRow {
  return item(key, value, version, {
    value_type: 'enum',
    options: [...options],
    admin_editable: editable,
  });
}

/** The sample values of the tab's keys (version 0 = never written: shown as unset). */
export const SAMPLE = {
  maxAmount: 25050,
  windowStart: '10:00:00',
  windowEnd: '20:59:59',
  payeeDaily: 2,
  payeeMonthly: 4,
  userDaily: 3,
  riskFlags: ['same_device_multi_account', 'had_negative', 'recon_diff'],
} as const;
export const VERSION = { maxAmount: 3, windowStart: 1, windowEnd: 1, userDaily: 2, flags: 4 };

/**
 * Every registered config item in registry order: ten keys of other groups first (so the tab's keys
 * run over page 1 at the default page_size of 20), then withdraw.auto_payout.*, then the enable
 * checks. user_monthly_max_count and platform_daily_max_fen were never written (value null).
 */
export function registry(): ConfigRow[] {
  const others = [
    item('withdraw.daily_count_per_user', 3, 2),
    item('withdraw.monthly_count_per_user', 10, 1),
    item('withdraw.payee_daily_count', 1, 0),
    item('favorites.max_per_user', 200, 1, { permission: 'config.general' }),
    item('payout.single_cap_fen', 500000, 1),
    item('payout.daily_cap_fen', 5000000, 1),
    item('payout.watermark_usable_bp', 9000, 1),
    item('risk.withdraw.invalid_ratio_bp', 3000, 1, { permission: 'config.risk' }),
    item('risk.withdraw.min_orders', 5, 1, { permission: 'config.risk' }),
    item('risk.withdraw.withdraw_received_ratio_bp', 5000, 1, { permission: 'config.risk' }),
  ];
  const auto = [
    item(KEY.maxAmount, SAMPLE.maxAmount, VERSION.maxAmount),
    enumItem(KEY.windowStart, SAMPLE.windowStart, STARTS, VERSION.windowStart),
    enumItem(KEY.windowEnd, SAMPLE.windowEnd, ENDS, VERSION.windowEnd),
    item(KEY.windowLimit, true, 2),
    item(KEY.firstLimit, false, 1),
    enumItem(KEY.frozen, 'no_auto', ['no_auto'], 0, false),
    enumItem(KEY.sameDay, 'no_auto', ['no_auto'], 0, false),
    item(KEY.payeeDaily, SAMPLE.payeeDaily, 1),
    item(KEY.payeeMonthly, SAMPLE.payeeMonthly, 1),
    item(KEY.userDaily, SAMPLE.userDaily, VERSION.userDaily),
    item(KEY.userMonthly, 1, 0),
    item(KEY.warnRate, 9000, 1),
    item(KEY.warnOrders, 8000, 1),
    item(KEY.warnInvalid, 7000, 1),
    item(KEY.warnReceived, 500, 1),
    item(KEY.platformDaily, 200000, 0),
    item(KEY.riskFlags, [...SAMPLE.riskFlags], VERSION.flags, { value_type: 'object' }),
  ];
  const checks = [
    item('payout.auto_enable_check.limits_supported', false, 1),
    item('payout.auto_enable_check.status_codes_supported', false, 1),
    item('payout.auto_enable_check.bill_out_biz_no_supported', false, 1),
    item('payout.auto_enable_check.recon_required_days', 7, 0),
  ];
  return [...others, ...auto, ...checks];
}

/** The integer range of each number key of the tab (as the registry checks it). */
const RANGE: Readonly<Record<string, readonly [number, number]>> = {
  [KEY.maxAmount]: [0, 1000000],
  [KEY.payeeDaily]: [0, 2147483647],
  [KEY.payeeMonthly]: [0, 2147483647],
  [KEY.userDaily]: [0, 2147483647],
  [KEY.userMonthly]: [0, 2147483647],
  [KEY.warnRate]: [0, 10000],
  [KEY.warnOrders]: [0, 10000],
  [KEY.warnInvalid]: [0, 10000],
  [KEY.warnReceived]: [0, 10000],
  [KEY.platformDaily]: [0, 2147483647],
};

// ---- the kill switches -----------------------------------------------------------------------

function switchRow(key: string, value: boolean, fallback: boolean, version: number): Switch {
  const unwritten = version === 0;
  const allOnly = key === MASTER || key.startsWith('convert.');
  return {
    key,
    value: unwritten ? null : value,
    default: fallback,
    value_type: 'boolean',
    options: null,
    permissions: allOnly ? ['switch.all'] : ['switch.all', 'switch.payout'],
    admin_editable: true,
    version,
    updated_by: unwritten ? null : 'ops-yi',
    updated_at: unwritten ? null : '2026-11-18T18:00:00+08:00',
  };
}
/** The switch list with the master switch at `master` (false and never written by default). */
export function switchList(master: boolean): Switch[] {
  return [
    switchRow('convert.enabled.taobao', true, true, 2),
    switchRow('withdraw.enabled', true, true, 6),
    switchRow(MASTER, master, false, master ? 1 : 0),
    switchRow('payout.enabled', true, true, 2),
    switchRow('payout.queue_paused', false, false, 7),
  ];
}

// ---- answers ---------------------------------------------------------------------------------

const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};
export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
/** An error envelope with its contract HTTP status. */
export function failedWith(code: number, data: unknown = {}, msg = ''): Response {
  return Response.json({ code, msg, data, trace_id: TRACE_ID }, { status: STATUS[code] ?? 400 });
}
export const CODE = '123456';
export const passOf = (n: number): string => `auto-payout-pass-${n}`;
export function verified(n: number): Response {
  return ok({ ['step_up_token']: passOf(n), tier: 'totp', expire_at: '2099-01-01T00:00:00Z' });
}

export const getOf =
  (path: string): RequestMatch =>
  (request) =>
    request.method === 'GET' && request.path === path;
export const postOf =
  (path: string): RequestMatch =>
  (request) =>
    request.method === 'POST' && request.path === path;

/** The requests this page may send: the frozen reads, the two lists, the step-up, the batch. */
export function allowedHereToo(request: RequestLog): boolean {
  return (
    allowedHere(request) ||
    (request.method === 'GET' && (request.path === ITEMS || request.path === SWITCHES)) ||
    (request.method === 'POST' && (request.path === VERIFY || request.path === BATCH))
  );
}

// ---- the fake server -------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;

interface State {
  readonly items: ConfigRow[];
  readonly switches: Switch[];
  readonly permissions: Grants;
  /** Scripted answers of the next batch POSTs, in order (then the contract's answer). */
  readonly batches: Reply[];
  /** Scripted answers of the next config-item list reads, in order. */
  readonly reads: Reply[];
  /** Step-up passes a successful (unscripted) batch has used up: each pass is good for one save. */
  readonly consumed: Set<string>;
}
const states = new WeakMap<PayoutServer, State>();

function stateOf(server: PayoutServer): State {
  const state = states.get(server);
  if (state === undefined) throw new Error('not a server of serverFor');
  return state;
}

const POSITIVE = /^[1-9][0-9]*$/;
const signedIn = (request: RequestLog): boolean =>
  request.headers.get('Authorization') === 'Bearer example-admin-token';

function paged<T>(items: readonly T[], request: RequestLog): Response {
  const page = request.query['page'];
  const size = request.query['page_size'];
  const extra = Object.keys(request.query).filter((name) => !['page', 'page_size'].includes(name));
  const invalid = [
    ...extra,
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
  ];
  if (invalid.length > 0) return failedWith(20001, { fields: invalid });
  const pageNo = page === undefined ? 1 : Number(page);
  const pageSize = size === undefined ? 20 : Number(size);
  return ok({
    items: structuredClone(items.slice((pageNo - 1) * pageSize, pageNo * pageSize)),
    page: pageNo,
    page_size: pageSize,
    total: items.length,
  });
}

function validValue(row: ConfigRow, value: unknown): boolean {
  if (row.value_type === 'boolean') return typeof value === 'boolean';
  if (row.value_type === 'enum')
    return typeof value === 'string' && (row.options ?? []).includes(value);
  if (row.value_type === 'number') {
    const range = RANGE[row.key] ?? [0, 2147483647];
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    return value >= range[0] && value <= range[1];
  }
  if (row.key === KEY.riskFlags)
    return (
      Array.isArray(value) &&
      value.every((code) => (FLAG_CODES as readonly unknown[]).includes(code)) &&
      new Set(value).size === value.length
    );
  return typeof value === 'object' && value !== null;
}

function issued(server: PayoutServer): string[] {
  const count = server.log.filter(postOf(VERIFY)).length;
  return Array.from({ length: count }, (_, index) => passOf(index + 1));
}

/** adminBatchUpdateConfigItems as the contract describes it. */
function batch(server: PayoutServer, state: State, request: RequestLog): Response {
  if (!signedIn(request)) return failedWith(10001, undefined, '未登录');
  if (!state.permissions.includes('config.business'))
    return failedWith(10403, { reason: 'admin_permission_denied' });
  const pass = request.headers.get('X-Step-Up-Token') ?? '';
  if (!issued(server).includes(pass) || state.consumed.has(pass))
    return failedWith(10003, { tier: 'totp' });
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return failedWith(20001, { fields: ['items'] });
  const members = Object.keys(body);
  if (members.some((member) => !['items', 'reason'].includes(member)))
    return failedWith(20001, { fields: ['items'] });
  const sent = body as Partial<BatchRequest>;
  const reason: unknown = sent.reason;
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || Array.from(reason).length < 1 || Array.from(reason).length > 200)
  )
    return failedWith(20001, { fields: ['reason'] });
  const entries: unknown = sent.items;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200)
    return failedWith(20001, { fields: ['items'] });
  const keys: string[] = [];
  const failing: string[] = [];
  for (const entry of entries as unknown[]) {
    if (typeof entry !== 'object' || entry === null)
      return failedWith(20001, { fields: ['items'] });
    const names = Object.keys(entry).sort();
    if (names.join(',') !== 'expected_version,key,value')
      return failedWith(20001, { fields: ['items'] });
    const one = entry as BatchEntry;
    const version: unknown = one.expected_version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0)
      return failedWith(20001, { fields: ['items'] });
    if (keys.includes(one.key)) return failedWith(20001, { fields: ['items'] });
    keys.push(one.key);
    const row = state.items.find((candidate) => candidate.key === one.key);
    if (row === undefined || !row.admin_editable || !validValue(row, one.value))
      failing.push(one.key);
    else if (row.permission !== 'config.business') return failedWith(20001, { fields: ['items'] });
  }
  if (failing.length > 0) return failedWith(20001, { fields: failing });
  const typed = entries as BatchEntry[];
  for (const one of typed) {
    const row = state.items.find((candidate) => candidate.key === one.key)!;
    if (row.version !== one.expected_version)
      return failedWith(20902, { resource: 'config_item' }, '配置已被他人修改');
  }
  const answered = typed.map((one) => {
    const row = state.items.find((candidate) => candidate.key === one.key)!;
    if (JSON.stringify(row.value) !== JSON.stringify(one.value)) {
      row.value = one.value;
      row.version += 1;
      row.updated_by = 'fin-yi';
      row.updated_at = '2026-11-21T10:05:00+08:00';
    }
    return structuredClone(row);
  });
  return ok({ items: answered });
}

export interface Setup {
  /** Permission points the server checks; defaults to every point of a super admin. */
  readonly permissions?: Grants;
  /** The master switch's value (default false). */
  readonly master?: boolean;
  /** How many verified dynamic codes the server answers (passes 1…n); defaults to 4. */
  readonly passes?: number;
  readonly items?: readonly ConfigRow[];
}

/**
 * The frozen payout server with the config-item list and batch, the switch list and `passes`
 * scripted verifications on top.
 */
export function serverFor(setup: Setup = {}): PayoutServer {
  const permissions = setup.permissions ?? SUPER_GRANTS;
  const server = createPayoutServer({ permissions });
  const state: State = {
    items: structuredClone([...(setup.items ?? registry())]),
    switches: switchList(setup.master ?? false),
    permissions,
    batches: [],
    reads: [],
    consumed: new Set(),
  };
  states.set(server, state);
  const holds = (point: string): boolean => (permissions as readonly string[]).includes(point);
  const answerItems: Reply = async (request) => {
    server.onceWhere(getOf(ITEMS), answerItems);
    const scripted = state.reads.shift();
    if (scripted !== undefined) return scripted(request);
    if (!signedIn(request)) return failedWith(10001, undefined, '未登录');
    if (!['config.general', 'config.risk', 'config.business'].some(holds))
      return failedWith(10403, { reason: 'admin_permission_denied' });
    return paged(state.items, request);
  };
  const answerSwitches: Reply = (request) => {
    server.onceWhere(getOf(SWITCHES), answerSwitches);
    if (!signedIn(request)) return failedWith(10001, undefined, '未登录');
    if (!['switch.all', 'switch.payout', 'switch.pay'].some(holds))
      return failedWith(10403, { reason: 'admin_permission_denied' });
    return paged(state.switches, request);
  };
  const answerBatch: Reply = async (request) => {
    server.onceWhere(postOf(BATCH), answerBatch);
    const scripted = state.batches.shift();
    if (scripted !== undefined) return scripted(request);
    const answer = batch(server, state, request);
    // A pass that carried a save through is used up (the server refuses it again with 10003).
    if (answer.status === 200) state.consumed.add(request.headers.get('X-Step-Up-Token') ?? '');
    return answer;
  };
  server.onceWhere(getOf(ITEMS), answerItems);
  server.onceWhere(getOf(SWITCHES), answerSwitches);
  server.onceWhere(postOf(BATCH), answerBatch);
  for (let n = 1; n <= (setup.passes ?? 4); n += 1)
    server.onceWhere(postOf(VERIFY), () => verified(n));
  return server;
}

/** The next batch POST gets `reply` (answerNormally gives the contract's answer). */
export function scriptBatch(server: PayoutServer, reply: Reply): void {
  stateOf(server).batches.push(reply);
}
/** The next config-item list read gets `reply`. */
export function scriptRead(server: PayoutServer, reply: Reply): void {
  stateOf(server).reads.push(reply);
}
/** The contract's answer to the batch `request` on the current state. */
export function answerNormally(server: PayoutServer, request: RequestLog): Response {
  return batch(server, stateOf(server), request);
}
/** The row the server holds now for `key`. */
export function rowOf(server: PayoutServer, key: string): ConfigRow {
  const found = stateOf(server).items.find((row) => row.key === key);
  if (found === undefined) throw new Error(`no config item ${key}`);
  return found;
}
/** Another admin changes `key` to `value` (its version moves on by one). */
export function changedElsewhere(
  server: PayoutServer,
  key: string,
  value: ConfigRow['value'],
): void {
  const row = rowOf(server, key);
  row.value = value;
  row.version += 1;
  row.updated_by = 'ops-er';
  row.updated_at = '2026-11-21T10:04:00+08:00';
}

/** A request that never gets an answer the page can read (a dropped connection). */
export function dropped(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'));
}
/** A 5xx with the unified envelope. */
export function serverError(): Response {
  return failedWith(50001, {}, '服务异常');
}

/** Integer fen of a yuan text shown in an input (only through @couli/money). */
export function fenOfShown(text: string): number {
  return Number(yuanStrToFen(text.replace(/[,，¥￥\s]/g, '')));
}

// ---- what the page shows (independent full-copy expectations, not imports of its texts) -----

export const TAB = {
  review: '审核列表',
  queue: '打款队列',
  unknown: '结果待确认',
  auto: '自动到账设置',
} as const;

/** Field labels (whole label, an optional unit 「（元）」「（次）」「（%）」 and colon). */
function label(words: string): RegExp {
  return new RegExp(`^(?:${words})(?:[（(](?:元|次|%)[)）])?[:：]?$`);
}
export const LABEL = {
  /** ① the master switch: a read-only field. */
  master: label('自动到账(?:总开关)?|自动到账开关'),
  /** ② in yuan. */
  maxAmount: label('金额上限|金额限制|单笔金额上限'),
  /** ③ */
  windowLimit: label('时段限制'),
  windowStart: label('开始时间|时段开始|开启时段开始'),
  windowEnd: label('结束时间|时段结束|开启时段结束'),
  /** ④ */
  firstLimit: label('首提限制'),
  /** ⑤ ⑥ read only. */
  frozen: label('冻结金额'),
  sameDay: label('当日提现'),
  /** ⑦ */
  payeeDaily: label('同一收款账号每日(?:最多)?(?:自动到账)?(?:次数)?'),
  payeeMonthly: label('同一收款账号每月(?:最多)?(?:自动到账)?(?:次数)?'),
  userDaily: label('同一会员每日(?:最多)?(?:自动到账)?(?:次数)?'),
  userMonthly: label('同一会员每月(?:最多)?(?:自动到账)?(?:次数)?'),
  /** ⑨ in yuan. */
  platformDaily: label('全平台(?:当日|每日)自动到账(?:合计)?(?:上限)?'),
} as const;

/** The section titles. */
export const GROUP = {
  main: /^自动到账设置$/,
  extra: /^本系统附加/,
} as const;
/** The note of the 「本系统附加」 group. */
export const EXTRA_NOTE = '花卷云无此项';
/** ⑤ ⑥ are shown as this text, never as an input. */
export const NO_AUTO = '不自动到账';
/** The master switch's states. */
export const MASTER_SHOWN = { on: '已开启', off: '已关闭' } as const;
/** The entry to the emergency switch page. */
export const SWITCH_ENTRY = '去紧急开关页';
/** A key never written (value null): unset, the system default applies. */
export const UNSET = /未设置/;
/** No switch point: the master switch's state is not readable. */
export const NO_PERMISSION_TO_VIEW = /无权限/;
/** The BR-WDR-30 细则「开启前置检查」 heading and the words its items carry. */
export const ENABLE_CHECK_TITLE = /开启前置检查/;
export const ENABLE_CHECK_WORDS = [
  /单笔.*单日限额|限额/,
  /失败码|查询状态/,
  /账单|out_biz_no/,
  /对账/,
];

export const SAVE = '保存';
export const RETRY = '原样重试';
export const RECHECK = '刷新核对';
export const STEP_TITLE = '二次验证 · 动态码';
export const STEP_FIELD = '动态码';
export const STEP_SUBMIT = '验证并继续';

export const NOTICE = {
  /** 20902 on the first submit. */
  conflict: /已被他人修改/,
  /** Every kind of unknown result. */
  unknown: /结果未知/,
  forbidden: /无权限/,
  saved: /已保存|保存成功/,
} as const;

/** Risk flag names (admin_dict.withdrawals.risk_flags.*) used by the tests. */
export const FLAG_NAME = {
  first_withdrawal: '首次提现',
  credited_today: '当日有入账',
  same_device_multi_account: '同设备多账号',
  had_negative: '曾负余额',
  recon_diff: '有对账差错',
  blacklist_hit: '命中黑名单',
  payee_prev_other_user: '收款账号曾属他人',
  risk_calc_failed: '风险计算失败',
  invalid_ratio_60d: '60 天失效占比高',
  high_commission_ratio_60d: '60 天高佣占比高',
  withdraw_vs_received: '30 天提现额与 60 天确认收货返利比例异常',
} as const;

/** ⑧ labels (whole label, an optional 「（%）」 and colon; spaces ignored by the regex). */
function percentLabel(words: string): RegExp {
  return new RegExp(`^(?:${words})(?:\\s*[（(][%％][)）])?[:：]?$`);
}
const DAYS_60 = '(?:60\\s*天内?\\s*)?';
const DAYS_30 = '(?:30\\s*天内?\\s*)?';
const RIGHTS = '(?:\\s*[（(]含维权失效[)）])?';
export const WARN_LABEL = {
  rate: percentLabel(`${DAYS_60}(?:订单)?高?佣金比例(?:阈值)?`),
  orders: percentLabel(`${DAYS_60}高佣金?(?:比例)?订单占(?:总订单)?比?(?:例|阈值)?`),
  invalid: percentLabel(`${DAYS_60}失效${RIGHTS}\\s*订单占比(?:阈值)?`),
  received: percentLabel(`${DAYS_30}提现金额占\\s*${DAYS_60}确认收货佣金(?:比例)?`),
} as const;

/**
 * Each item of BR-WDR-30 细则「开启前置检查」 with the words it must carry, all inside the one list
 * item of that check: BR-WDR-22 ② single and daily limits, ⑤ failure codes and query status, ⑧ the
 * daily bill carrying out_biz_no, and the daily channel reconciliation (BR-WDR-23) run through for
 * consecutive days (「每日」 may not be left out).
 */
export const ENABLE_CHECK_ITEMS: readonly (readonly RegExp[])[] = [
  [/单笔/, /单日/, /限额/],
  [/失败码/, /查询状态/],
  [/(?:按日|每日|日)账单/, /out_biz_no/],
  [/每日/, /通道对账/, /连续跑通/],
];

/** The title of the emergency switch page (texts/kill-switches.ts, frozen). */
export const SWITCH_PAGE_TITLE = '紧急开关';
