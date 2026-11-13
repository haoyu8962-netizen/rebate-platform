// Workbench data (GET /admin/v1/dashboard, contracts adminGetDashboard): checks the answer's shape,
// keeps only the to-do cards this console knows, and formats counts, money and Beijing times.
// Amounts only go through @couli/money (integer fen, admin format BR-TEXT-10), never floats.
import type { Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen } from '@couli/money';
import { dashboardTexts, type DashboardTodoKey } from '../../texts/dashboard.ts';

export type Dashboard = Schema<'AdminDashboard'>;
export type DashboardStatus = Schema<'AdminDashboardStatus'>;

export const DASHBOARD_URL = '/admin/v1/dashboard';

/** Pages without a console route of their own yet (the status cards). */
export const STATUS_ROUTES = {
  queue: '/withdrawals',
  balance: '/fund-ledger',
  settle: '/switches',
} as const;

export interface TodoCard {
  readonly key: DashboardTodoKey;
  readonly count: number;
  readonly route: string;
  /** Second line: earliest waiting time or the known breakdown; undefined when neither. */
  readonly detail: string | undefined;
}

export interface YesterdayView {
  /** Accounting day of the latest row not later than yesterday; may be before yesterday. */
  readonly date: string;
  readonly day: string;
  readonly links: number;
  readonly orders: number;
  readonly rebate: string;
  readonly newUsers: number;
  readonly asOf: string;
}

export interface DashboardView {
  readonly todo: readonly TodoCard[];
  /** null: no aggregate row at all yet (the page shows no numbers and no as-of time). */
  readonly yesterday: YesterdayView | null;
  readonly status: DashboardStatus | undefined;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const two = (value: number): string => String(value).padStart(2, '0');

function beijing(iso: string): Date | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms + BEIJING_OFFSET_MS);
}

/** `YYYY-MM-DD HH:mm` in Beijing time; the raw text when it is not a date-time. */
export function beijingDateTime(iso: string): string {
  const date = beijing(iso);
  if (date === undefined) return iso;
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** Yesterday's accounting day (`YYYY-MM-DD`, +08:00) at the given instant (epoch ms). */
export function beijingYesterday(nowMs: number): string {
  const date = new Date(nowMs + BEIJING_OFFSET_MS - 24 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** `MM-DD HH:mm` in Beijing time; the raw text when it is not a date-time. */
export function beijingShort(iso: string): string {
  return beijingDateTime(iso).replace(/^\d{4}-/, '');
}

/** Whole numbers with ',' every three digits (≥ 1,000). */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/** Server routes open inside the console only: one leading slash, no scheme or backslash. */
export function isConsoleRoute(route: unknown): route is string {
  return typeof route === 'string' && /^\/(?![/\\])/.test(route) && !/[\\\s]/.test(route);
}

function isKnownTodo(key: unknown): key is DashboardTodoKey {
  return typeof key === 'string' && Object.hasOwn(dashboardTexts.todo.cards, key);
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function detailOf(key: DashboardTodoKey, item: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof item['oldest_at'] === 'string' && beijing(item['oldest_at']) !== undefined)
    parts.push(dashboardTexts.todo.oldest(beijingShort(item['oldest_at'])));
  const labels = dashboardTexts.todo.breakdown[key];
  if (labels !== undefined && Array.isArray(item['breakdown'])) {
    for (const entry of item['breakdown'] as unknown[]) {
      if (!isRecord(entry) || typeof entry['key'] !== 'string' || !isCount(entry['count']))
        continue;
      const label = Object.hasOwn(labels, entry['key']) ? labels[entry['key']] : undefined;
      if (label !== undefined) parts.push(`${label} ${formatCount(entry['count'])}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(dashboardTexts.todo.separator);
}

function statusOf(value: unknown): DashboardStatus | undefined {
  if (!isRecord(value)) return undefined;
  const channels = value['payout_channel_paused'];
  const expired = value['balance_w_expired'];
  if (
    typeof value['payout_queue_paused'] !== 'boolean' ||
    typeof value['settle_auto_enabled'] !== 'boolean' ||
    !Array.isArray(channels) ||
    !(expired === null || typeof expired === 'boolean')
  )
    throw new TypeError('dashboard status shape');
  return {
    payout_queue_paused: value['payout_queue_paused'],
    payout_channel_paused: channels.filter(
      (channel): channel is DashboardStatus['payout_channel_paused'][number] =>
        typeof channel === 'string' && Object.hasOwn(dashboardTexts.status.channelNames, channel),
    ),
    settle_auto_enabled: value['settle_auto_enabled'],
    balance_w_expired: expired,
  };
}

/**
 * The page's view of one answer. Unknown to-do keys (a newer server) are left out quietly; a
 * malformed answer throws, and the page shows its load failure instead of half a page. A null
 * yesterday (no aggregate row yet) is a valid answer, not a malformed one.
 */
export function toView(data: unknown): DashboardView {
  if (!isRecord(data) || !Array.isArray(data['todo'])) throw new TypeError('dashboard shape');
  const todo: TodoCard[] = [];
  for (const item of data['todo'] as unknown[]) {
    if (!isRecord(item) || !isKnownTodo(item['key'])) continue;
    if (!isCount(item['count']) || !isConsoleRoute(item['route'])) continue;
    todo.push({
      key: item['key'],
      count: item['count'],
      route: item['route'],
      detail: detailOf(item['key'], item),
    });
  }
  return { todo, yesterday: yesterdayOf(data['yesterday']), status: statusOf(data['status']) };
}

function yesterdayOf(y: unknown): YesterdayView | null {
  if (y === null) return null;
  if (
    !isRecord(y) ||
    typeof y['date'] !== 'string' ||
    typeof y['as_of'] !== 'string' ||
    !isCount(y['links']) ||
    !isCount(y['orders']) ||
    !isCount(y['new_users'])
  )
    throw new TypeError('dashboard yesterday shape');
  return {
    date: y['date'],
    day: y['date'].replace(/^\d{4}-/, ''),
    links: y['links'],
    orders: y['orders'],
    // parseFen rejects anything but an integer amount (no floats reach the display).
    rebate: formatYuanAdmin(parseFen(y['est_rebate_fen'])),
    newUsers: y['new_users'],
    asOf: beijingDateTime(y['as_of']),
  };
}
