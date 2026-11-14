// B1-10w: the workbench of GET /admin/v1/dashboard (adminGetDashboard, contracts/openapi.yaml;
// 编排 D10-1401 / D10-1402 / D10-1403 ③). Read only: nothing is written, no audit row.
// - todo[]: the cards whose point the account holds (a super admin: all), in the order of enum
//   admin_dashboard_todo_key; each count is the owning module's exported count function (its
//   index.ts), no judgement of its own here. beneficiary_held_overdue is not returned in this task
//   (D10-1402). The count functions give no earliest time, so oldest_at is left out (optional).
// - yesterday: readDashboardYesterday (B1-34q) at the injected clock; null when there is no row.
// - status: only with fund.view; the three switches through content's config read, unset keys at
//   the switch registry's default; W (balance_w_expired) is null until W entry ships.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import { countOverdueAgentReports } from '../../agent/index.ts';
import { createContentReader, switchSpecOf } from '../../content/index.ts';
import { countReconDiffOpen } from '../../ledger/index.ts';
import { countClaimsPendingReview } from '../../orders/index.ts';
import { countWithdrawReviewPending } from '../../payout/index.ts';
import type { Clock } from '../../platform/index.ts';
import { countProcessingAppeals } from '../../risk/index.ts';
import { countSettleBillPending } from '../../settlement/index.ts';
import { countUnionAuthPending } from '../../union/index.ts';
import { readDashboardYesterday, type DashboardYesterday } from './dashboard-days.ts';

/** The response data (AdminDashboard). */
export type AdminDashboardView = Schema<'AdminDashboard'>;
type Todo = Schema<'AdminDashboardTodo'>;
type TodoKey = Schema<'AdminDashboardTodoKey'>;
type Channel = Schema<'AdminPayoutChannelCode'>;

/** Who asks: the app and the account's permission points (a super admin holds every point). */
export interface AdminDashboardPrincipal {
  readonly appId: string;
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
}

/** A config value of (appId, key); undefined when the key is not set. */
export type AdminDashboardConfig = (appId: string, key: string) => Promise<unknown>;

/** What the assembly reads with: the business database and the injected clock. */
export interface AdminDashboardDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's config read (a process-wide reader); a fresh content reader when left out. */
  readonly config?: AdminDashboardConfig;
}

/** The permission point that shows the status object. */
export const DASHBOARD_STATUS_POINT = 'fund.view';

interface CardSpec {
  readonly key: TodoKey;
  readonly point: string;
  readonly route: string;
  readonly count: (deps: AdminDashboardDeps, appId: string) => Promise<Omit<Todo, 'key' | 'route'>>;
}

function plain(count: (db: Kysely<DB>, appId: string) => Promise<number>): CardSpec['count'] {
  return async (deps, appId) => ({ count: countNumber(await count(deps.db, appId)) });
}

/**
 * The cards of this task in enum order, each with its point (contract description), its console
 * route and its count function. beneficiary_held_overdue (risk.freeze) is left out (D10-1402).
 */
const CARDS: readonly CardSpec[] = [
  {
    key: 'withdraw_review_pending',
    point: 'withdraw.review',
    route: '/withdrawals?status=PENDING_REVIEW',
    count: plain(countWithdrawReviewPending),
  },
  {
    key: 'claim_review_pending',
    point: 'order.claim',
    route: '/claims?status=manual_review',
    count: async (deps, appId) => {
      const claims = await countClaimsPendingReview(deps.db, appId);
      return {
        count: countNumber(claims.count),
        breakdown: [
          { key: 'auto_matched', count: countNumber(claims.breakdown.auto_matched) },
          { key: 'manual_review', count: countNumber(claims.breakdown.manual_review) },
        ],
      };
    },
  },
  {
    key: 'settle_bill_pending',
    point: 'settle.bill',
    route: '/settle-bills?awaiting_confirm=true',
    count: plain(countSettleBillPending),
  },
  {
    key: 'recon_diff_open',
    point: 'fund.recon',
    route: '/recon?status=open',
    count: plain(countReconDiffOpen),
  },
  {
    key: 'appeal_pending',
    point: 'risk.appeal',
    route: '/risk/appeals?status=processing',
    count: plain(countProcessingAppeals),
  },
  {
    key: 'agent_report_overdue',
    point: 'agent.report',
    route: '/agent/reports?overdue=true',
    count: async (deps, appId) => ({
      count: countNumber(await countOverdueAgentReports(deps.db, appId, deps.clock.now())),
    }),
  },
  {
    key: 'union_auth_expiring',
    point: 'union.account_auth',
    route: '/unions',
    count: plain(countUnionAuthPending),
  },
];

const QUEUE_PAUSED = 'payout.queue_paused';
const CHANNEL_PAUSED_PREFIX = 'payout.channel_paused.';
const SETTLE_AUTO = 'settle.auto.enabled';
/** enum payout_method (contract AdminPayoutChannelCode), in contract order. */
const CHANNELS: readonly Channel[] = ['alipay', 'bank_card', 'wechat'];

/** A count as a JSON integer (never a silently rounded one). */
function countNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('dashboard count must be a non-negative safe integer');
  }
  return value;
}

function bigCount(value: bigint): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('dashboard figure must be a non-negative safe integer');
  }
  return Number(value);
}

function holds(principal: AdminDashboardPrincipal, point: string): boolean {
  return principal.isSuper || principal.permissions.includes(point);
}

/** The switch's stored boolean, else its registry default (the placeholder's own default first). */
async function switchOn(deps: AdminDashboardDeps, appId: string, key: string): Promise<boolean> {
  const stored = await configOf(deps)(appId, key);
  if (typeof stored === 'boolean') return stored;
  const spec = switchSpecOf(key);
  if (spec === null) throw new Error(`dashboard: ${key} is not a registered switch`);
  const placeholder = key.slice(key.lastIndexOf('.') + 1);
  const fallback = Object.hasOwn(spec.defaultOverrides, placeholder)
    ? spec.defaultOverrides[placeholder]
    : spec.defaultValue;
  if (typeof fallback !== 'boolean') throw new Error(`dashboard: ${key} has no boolean default`);
  return fallback;
}

function configOf(deps: AdminDashboardDeps): AdminDashboardConfig {
  if (deps.config !== undefined) return deps.config;
  const reader = createContentReader({ db: deps.db, clock: deps.clock });
  return async (appId, key) => (await reader.configValue(appId, key))?.value;
}

async function readStatus(
  deps: AdminDashboardDeps,
  appId: string,
): Promise<Schema<'AdminDashboardStatus'>> {
  const config = configOf(deps);
  const scoped: AdminDashboardDeps = { ...deps, config };
  const paused: Channel[] = [];
  for (const channel of CHANNELS) {
    if (await switchOn(scoped, appId, `${CHANNEL_PAUSED_PREFIX}${channel}`)) paused.push(channel);
  }
  return {
    payout_queue_paused: await switchOn(scoped, appId, QUEUE_PAUSED),
    payout_channel_paused: paused,
    settle_auto_enabled: await switchOn(scoped, appId, SETTLE_AUTO),
    balance_w_expired: null,
  };
}

function yesterdayView(row: DashboardYesterday | null): AdminDashboardView['yesterday'] {
  if (row === null) return null;
  return {
    date: row.date,
    links: bigCount(row.links),
    orders: bigCount(row.orders),
    est_rebate_fen: fenToJsonNumber(row.est_rebate_fen),
    new_users: bigCount(row.new_users),
    as_of: row.as_of.toISOString(),
  };
}

/** The workbench of `principal`, trimmed to its points. */
export async function readAdminDashboard(
  deps: AdminDashboardDeps,
  principal: AdminDashboardPrincipal,
): Promise<AdminDashboardView> {
  const { appId } = principal;
  const todo: Todo[] = [];
  for (const card of CARDS) {
    if (!holds(principal, card.point)) continue;
    todo.push({ key: card.key, route: card.route, ...(await card.count(deps, appId)) });
  }
  const yesterday = yesterdayView(
    await readDashboardYesterday(deps.db, { appId, now: deps.clock.now() }),
  );
  if (!holds(principal, DASHBOARD_STATUS_POINT)) return { todo, yesterday };
  return { todo, yesterday, status: await readStatus(deps, appId) };
}
