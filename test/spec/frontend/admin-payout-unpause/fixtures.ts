import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  CANCEL,
  CHANNEL_NAME,
  CODE,
  STEP_FIELD,
  STEP_SUBMIT,
  STEP_TITLE,
  VERIFY,
  ok,
  passOf,
  postOf,
  verified,
  type Grants,
  type Overview,
  type OverviewChannel,
  type RequestLog,
} from '../admin-payout-execute/fixtures.ts';
import {
  ALL,
  OVERVIEW,
  allowedHere,
  getOf,
  overview,
  pausedOverview,
} from '../admin-payouts-readonly/fixtures.ts';
import { TRACE_ID } from '../admin-withdrawals/fixtures.ts';

// Contract-shaped fixtures of 【暂停队列】 / 【解除暂停】 / 【解除通道暂停】 on the 打款队列 tab
// (F1-08bd; contracts/openapi.yaml adminUpdateKillSwitch PUT /admin/v1/kill-switches/{key}:
// payout.queue_paused and payout.channel_paused.<channel> need switch.all or switch.payout, totp
// step-up X-Step-Up-Token for every key (clearing included), body AdminKillSwitchUpdateRequest
// {value, expected_version, reason optional 1–200}, CAS: expected_version is the switch's version
// the console showed (0 = never written), a mismatch is 20902 data.resource=kill_switch, writing the
// value it already has with a matching version succeeds without change; no Idempotency-Key.
// adminListKillSwitches GET /admin/v1/kill-switches: switch.all / switch.payout / switch.pay, one
// row per registered key in registry order, page by page (page_size ≤ 200), with its version).
// The payout overview (adminGetPayoutOverview) shows queue_paused and channels[].paused, which are
// these switches. Admin names, versions and times are samples.
export { CANCEL, CHANNEL_NAME, CODE, STEP_FIELD, STEP_SUBMIT, STEP_TITLE, VERIFY };
export { ALL, OVERVIEW, getOf, ok, overview, passOf, pausedOverview, postOf, verified };
export type { Grants, Overview, OverviewChannel, RequestLog };

export const SWITCHES = '/admin/v1/kill-switches';

export type Switch = Schema<'AdminKillSwitch'>;
export type SwitchUpdate = Schema<'AdminKillSwitchUpdateRequest'>;
export type PayoutChannel = OverviewChannel['channel'];

/** The queue switch (BR-WDR-17). */
export const QUEUE = 'payout.queue_paused';
/** The pause switch of one payout channel (BR-WDR-33 ①: set by the system, cleared by a person). */
export const pausedOf = (channel: PayoutChannel): string => `payout.channel_paused.${channel}`;
/** PUT /admin/v1/kill-switches/{key} of the switch `name`. */
export const switchPath = (name: string): string => `${SWITCHES}/${name}`;

const CHANNELS: readonly PayoutChannel[] = ['alipay', 'bank_card', 'wechat'];
/** The only switch writes this page may send. */
export const WRITABLE: readonly string[] = [QUEUE, ...CHANNELS.map(pausedOf)].map(switchPath);

// ---- accounts --------------------------------------------------------------------------------

/** Points whose writes ask for the totp tier (BR-ID-34). */
const TOTP: readonly KnownPermission[] = [
  'fund.cash_entry',
  'payout.execute',
  'switch.all',
  'switch.payout',
  'switch.pay',
];

/** A snapshot of `grants` with their step-up annotations. */
export function accountOf(grants: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const point of grants)
    stepUp[point] = { tier: TOTP.includes(point) ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions: grants, stepUp };
}

/** fund.view (the page and the overview) + switch.payout (the payout switches). */
export const SWITCHER_GRANTS: Grants = ['fund.view', 'switch.payout'];
export const SWITCHER: PermissionSnapshot = accountOf(SWITCHER_GRANTS);
/** fund.view + switch.all (every switch). */
export const SWITCH_ALL_GRANTS: Grants = ['fund.view', 'switch.all'];
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
/** What the server lets a super admin do (every point). */
export const SUPER_GRANTS: Grants = [
  ...ALL,
  'fund.cash_entry',
  'switch.all',
  'switch.payout',
  'switch.pay',
];

// ---- the switch registry ---------------------------------------------------------------------

const PAYOUT_POINTS = ['switch.all', 'switch.payout'];
const PAY_POINTS = ['switch.all', 'switch.pay'];
const ALL_POINTS = ['switch.all'];

function row(
  name: string,
  value: boolean,
  fallback: boolean,
  version: number,
  points: readonly string[],
  by: string | null = 'ops-yi',
): Switch {
  const unwritten = version === 0;
  return {
    ['key']: name,
    value: unwritten ? null : value,
    default: fallback,
    value_type: 'boolean',
    options: null,
    permissions: [...points],
    admin_editable: true,
    version,
    updated_by: unwritten ? null : by,
    updated_at: unwritten ? null : '2026-11-13T18:00:00+08:00',
  };
}

/** A payout switch showing `value`; its version from `versions`, else 0 at the default, else 1. */
function payoutRow(
  name: string,
  value: boolean,
  fallback: boolean,
  versions: Readonly<Record<string, number>>,
  by: string | null = 'ops-yi',
): Switch {
  const version = versions[name] ?? (value === fallback ? 0 : 1);
  return row(name, value, fallback, version, PAYOUT_POINTS, by);
}

/** Versions of the sample pause switches: the queue's was written by admins, the others by the system. */
export const VERSION = { queue: 7, alipay: 3, wechat: 5 } as const;
/**
 * Versions of the payout switches in the samples (the others: 0 when the overview shows the
 * default, else 1).
 */
export const VERSIONS: Readonly<Record<string, number>> = {
  'payout.enabled': 2,
  [QUEUE]: VERSION.queue,
  [pausedOf('alipay')]: VERSION.alipay,
  [pausedOf('wechat')]: VERSION.wechat,
};

/**
 * Every registered switch in registry order (25 rows: the payout keys from row 17 on, the queue and
 * channel pauses from row 21, so they are on page 2 at the default page_size of 20). The payout
 * values follow `view`; `versions` (on top of VERSIONS) gives their versions, 0 = never written.
 */
export function switchesFor(
  view: Overview,
  versions: Readonly<Record<string, number>> = {},
): Switch[] {
  const all = { ...VERSIONS, ...versions };
  const channel = (item: PayoutChannel): OverviewChannel => {
    const found = view.channels.find((one) => one.channel === item);
    if (found === undefined) throw new Error(`the overview has no channel ${item}`);
    return found;
  };
  const enum_: Switch = {
    ['key']: 'convert.off_reason.pdd',
    value: null,
    default: 'not_launched',
    value_type: 'enum',
    options: ['not_launched', 'maintenance'],
    permissions: [...ALL_POINTS],
    admin_editable: true,
    version: 0,
    updated_by: null,
    updated_at: null,
  };
  return [
    row('convert.enabled.taobao', true, true, 2, ALL_POINTS),
    row('convert.enabled.jd', true, true, 0, ALL_POINTS),
    row('convert.enabled.pdd', false, true, 3, ALL_POINTS),
    enum_,
    row('search.enabled.taobao', true, true, 0, ALL_POINTS),
    row('search.enabled.jd', true, true, 0, ALL_POINTS),
    row('search.enabled.pdd', false, true, 1, ALL_POINTS),
    row('credit.enabled.taobao', true, true, 0, ALL_POINTS),
    row('credit.enabled.jd', true, true, 0, ALL_POINTS),
    row('credit.enabled.pdd', true, true, 0, ALL_POINTS),
    { ...row('agent.whitelist_only', true, true, 1, ALL_POINTS, null), admin_editable: false },
    row('pay.enabled', true, true, 0, PAY_POINTS),
    row('pay.channel_enabled.alipay', true, false, 1, PAY_POINTS),
    row('pay.channel_enabled.wechat', false, false, 0, PAY_POINTS),
    row('withdraw.enabled', true, true, 6, PAYOUT_POINTS),
    row('withdraw.auto_payout.enabled', false, false, 0, ALL_POINTS),
    payoutRow('payout.enabled', view.payout_enabled, true, all),
    ...CHANNELS.map((item) =>
      payoutRow(`payout.channel_enabled.${item}`, channel(item).enabled, false, all),
    ),
    payoutRow(QUEUE, view.queue_paused, false, all),
    ...CHANNELS.map((item) => payoutRow(pausedOf(item), channel(item).paused, false, all, null)),
    row('payout.proven_success_writeoff.enabled', true, true, 0, PAYOUT_POINTS),
  ];
}

// ---- answers ---------------------------------------------------------------------------------

// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};
/** An error envelope with its contract HTTP status. */
export function failedWith(code: number, data: unknown = {}, msg = ''): Response {
  return Response.json({ code, msg, data, trace_id: TRACE_ID }, { status: STATUS[code] ?? 400 });
}

/** The requests of this page: the read-only tab's reads, the verification, the switch list and writes. */
export function allowedHereToo(request: RequestLog): boolean {
  return (
    allowedHere(request) ||
    (request.method === 'POST' && request.path === VERIFY) ||
    (request.method === 'GET' && request.path === SWITCHES) ||
    (request.method === 'PUT' && WRITABLE.includes(request.path))
  );
}

/** Code points of `text` (the contract's maxLength counts them, F1-08ed). */
export const codePoints = (text: string): number => Array.from(text).length;
/** A reason of exactly 200 code points (199 CJK characters and one outside the BMP). */
export const REASON_200 = `${'停'.repeat(199)}𠮷`;
/** A reason of 201 code points. */
export const REASON_201 = `${'停'.repeat(200)}𠮷`;

// ---- what the page shows (independent full-copy expectations, not imports of its texts) -----

/** The entries (exact accessible names, spaces ignored). */
export const ENTRY = {
  /** The title row while the queue runs (overview queue_paused=false). */
  pause: '暂停队列',
  /** The title row while the queue is paused. */
  resume: '解除暂停',
  /** A channel card whose channel is paused. */
  channel: '解除通道暂停',
} as const;

/** One write of this page: its entry, where it is, its dialog and the PUT it sends. */
export interface Action {
  readonly entry: string;
  /** The channel card holding the entry; undefined: the title row (the queue). */
  readonly channel: PayoutChannel | undefined;
  /** The switch the PUT changes. */
  readonly name: string;
  /** The value the PUT sets. */
  readonly value: boolean;
  /** The dialog title. */
  readonly title: string;
  /** The consequence the dialog explains (one paragraph). */
  readonly text: string;
  /** The confirm button (opens the totp StepUpModal). */
  readonly submit: string;
  /** The notice after the change is made. */
  readonly done: string;
}

const CHECKED =
  '执行时仍要通过水位检查（所在通道的余额 W 未录入、已过期或低于预计提现 P 时仍会被拒绝）。';

export const PAUSE: Action = {
  entry: ENTRY.pause,
  channel: undefined,
  name: QUEUE,
  value: true,
  title: '暂停打款队列',
  text: '暂停后【执行所选】不可用，不再发起新的转账；已投递但还没发出转账的单回到待执行，已发出转账的单照常查询。',
  submit: '确认暂停',
  done: '打款队列已暂停',
};
export const RESUME: Action = {
  entry: ENTRY.resume,
  channel: undefined,
  name: QUEUE,
  value: false,
  title: '解除打款队列暂停',
  text: `解除后可以重新执行待执行的单；${CHECKED}已暂停的通道不随队列解除，需在通道卡上分别解除。`,
  submit: '确认解除',
  done: '打款队列已解除暂停',
};
/** 【解除通道暂停】 of the channel `channel`. */
export function resumeChannel(channel: PayoutChannel): Action {
  const name = CHANNEL_NAME[channel];
  return {
    entry: ENTRY.channel,
    channel,
    name: pausedOf(channel),
    value: false,
    title: `解除通道暂停 · ${name}`,
    text: `解除后${name}通道恢复发起转账，其他通道不受影响；打款队列的暂停不随通道解除。${CHECKED}`,
    submit: '确认解除',
    done: `${name}通道已解除暂停`,
  };
}

/** The reason input of the dialog (its label starts with these). */
export const REASON_LABEL = /^(?:原因|操作说明)/;

/** Notices (the same wording as the other payout writes of this console). */
export const NOTICE = {
  again: '动态码凭证已失效，请重新输入动态码',
  forbidden: '无权限执行此操作（需要 switch.payout 或 switch.all 权限点）',
  /** 20902: the switch's version moved on (someone else changed it). */
  conflict: '开关状态已被他人修改，已刷新为最新状态，请核对后重试',
  invalid: '提交内容有误，请检查后重试',
  failed: '提交失败，请稍后重试',
  network: '网络错误，请检查网络后重试；未确认前不会重复提交',
} as const;
/** 20001 data.fields=[reason], at the reason field. */
export const SERVER_REASON = '原因不符合要求（1–200 字），请修改后再提交';
