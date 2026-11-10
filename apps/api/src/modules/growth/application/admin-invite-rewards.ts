// B2-16d: growth's console read of the invite reward records (contracts
// adminListInviteRewards / adminGetInviteReward; 08 BR-INV-24 细则「资格记录与状态」④, BR-ID-33).
// Reads app.invite_rewards and app.invite_reward_budgets of one app only; phone numbers come masked
// through a port app.module fills with identity's MaskedPhoneReader (growth does not import
// identity); the +08:00 day of the budget comes from the injected Clock. Writes nothing, audits
// nothing, logs nothing. Never selects bind_ip_hmac or the voucher ids.
//
// Erasable syntax only, `import type` for type-only imports, relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type AdminInviteRewardView = Schema<'AdminInviteReward'>;
export type AdminInviteRewardPageView = Schema<'AdminInviteRewardPage'>;
export type AdminInviteRewardStatus = Schema<'AdminInviteRewardStatus'>;
type BudgetView = Schema<'AdminInviteRewardBudget'>;

/** The list's query once the route schema has checked it (dates are YYYY-MM-DD, +08:00 days). */
export interface AdminInviteRewardQuery {
  readonly page: number;
  readonly page_size: number;
  readonly invitee_id?: string;
  readonly inviter_id?: string;
  readonly status?: AdminInviteRewardStatus;
  readonly qualified_from?: string;
  readonly qualified_to?: string;
}

/** Masked phones of users of one app (identity's MaskedPhoneReader has this shape). */
export interface InviteRewardPhoneReader {
  maskedPhones(
    appId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

export interface AdminInviteRewardsDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly phones: InviteRewardPhoneReader;
}

/** Why a list query is refused before reading (→ 20001 with these fields). */
export interface AdminInviteRewardQueryInvalid {
  readonly kind: 'invalid';
  readonly fields: readonly string[];
}

export interface AdminInviteRewardsReader {
  /** One page of the app's records, latest qualified_at first, with the used budget. */
  list(
    appId: string,
    query: AdminInviteRewardQuery,
  ): Promise<AdminInviteRewardPageView | AdminInviteRewardQueryInvalid>;
  /** The app's record of this invitee, or null (→ 30701). */
  get(appId: string, inviteeId: string): Promise<AdminInviteRewardView | null>;
}

/** invite_reward_budgets.period of the campaign's running totals (BR-INV-24 ④). */
const TOTAL_PERIOD = 'total';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** invitee_id and inviter_id are uuid columns: any other text names no record. */
export function isInviteRewardUserId(value: string): boolean {
  return UUID.test(value);
}

/**
 * The [start, end) instants (YYYY-MM-DDT00:00:00+08:00 text) of the +08:00 days from `from` to `to`, both inclusive, or the fields
 * refused: a day that does not exist, or `from` later than `to` (→ [qualified_from, qualified_to]).
 */
export function qualifiedWindow(
  from: string | undefined,
  to: string | undefined,
): { start?: string; end?: string } | AdminInviteRewardQueryInvalid {
  const bad: string[] = [];
  const day = (value: string | undefined, field: string) => {
    if (value === undefined) return undefined;
    try {
      return chinaDayRange(value);
    } catch {
      bad.push(field);
      return undefined;
    }
  };
  const first = day(from, 'qualified_from');
  const last = day(to, 'qualified_to');
  if (bad.length > 0) return { kind: 'invalid', fields: bad };
  // YYYY-MM-DD strings order as their days do.
  if (from !== undefined && to !== undefined && from > to) {
    return { kind: 'invalid', fields: ['qualified_from', 'qualified_to'] };
  }
  return {
    ...(first === undefined ? {} : { start: first.start }),
    ...(last === undefined ? {} : { end: last.end }),
  };
}

const COLUMNS = [
  'invitee_id',
  'inviter_id',
  'amount_fen',
  'eligibility_days',
  'bind_source',
  'qualified_at',
  'trigger_order_id',
  'triggered_at',
  'status',
  'inviter_result',
  'invitee_result',
  'inviter_skip_reason',
  'invitee_skip_reason',
  'void_reason',
  'granted_at',
] as const;

/** The columns read: no bind_ip_hmac, no voucher ids, no row internals. */
export interface InviteRewardRow {
  readonly invitee_id: string;
  readonly inviter_id: string;
  readonly amount_fen: bigint;
  readonly eligibility_days: number;
  readonly bind_source: string;
  readonly qualified_at: Date;
  readonly trigger_order_id: string | null;
  readonly triggered_at: Date | null;
  readonly status: string;
  readonly inviter_result: string | null;
  readonly invitee_result: string | null;
  readonly inviter_skip_reason: string | null;
  readonly invitee_skip_reason: string | null;
  readonly void_reason: string | null;
  readonly granted_at: Date | null;
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/** One record as the contract's AdminInviteReward; phones masked by identity (absent → null). */
export function inviteRewardView(
  row: InviteRewardRow,
  phones: ReadonlyMap<string, string | null>,
): AdminInviteRewardView {
  type View = AdminInviteRewardView;
  return {
    invitee_id: row.invitee_id,
    inviter_id: row.inviter_id,
    invitee_phone_masked: phones.get(row.invitee_id) ?? null,
    inviter_phone_masked: phones.get(row.inviter_id) ?? null,
    amount_fen: fenToJsonNumber(row.amount_fen),
    eligibility_days: row.eligibility_days,
    bind_source: row.bind_source as View['bind_source'],
    qualified_at: row.qualified_at.toISOString(),
    trigger_order_id: row.trigger_order_id,
    triggered_at: iso(row.triggered_at),
    status: row.status as View['status'],
    inviter_result: row.inviter_result as View['inviter_result'],
    invitee_result: row.invitee_result as View['invitee_result'],
    inviter_skip_reason: row.inviter_skip_reason as View['inviter_skip_reason'],
    invitee_skip_reason: row.invitee_skip_reason as View['invitee_skip_reason'],
    void_reason: row.void_reason as View['void_reason'],
    granted_at: iso(row.granted_at),
  };
}

/** The used budget from the app's rows of `today` and 'total' (a missing row reads as 0). */
export function inviteRewardBudgetView(
  today: string,
  rows: readonly { period: string; reserved_fen: bigint; granted_fen: bigint }[],
): BudgetView {
  const day = rows.find((row) => row.period === today);
  const total = rows.find((row) => row.period === TOTAL_PERIOD);
  return {
    today: { date: today, granted_fen: fenToJsonNumber(day?.granted_fen ?? 0n) },
    total: {
      reserved_fen: fenToJsonNumber(total?.reserved_fen ?? 0n),
      granted_fen: fenToJsonNumber(total?.granted_fen ?? 0n),
    },
  };
}

export function createAdminInviteRewardsReader(
  deps: AdminInviteRewardsDeps,
): AdminInviteRewardsReader {
  const { db, clock, phones } = deps;
  const records = (appId: string) =>
    db.withSchema('app').selectFrom('invite_rewards').where('app_id', '=', appId);

  async function views(appId: string, rows: readonly InviteRewardRow[]) {
    if (rows.length === 0) return [];
    const masked = await phones.maskedPhones(
      appId,
      rows.flatMap((row) => [row.invitee_id, row.inviter_id]),
    );
    return rows.map((row) => inviteRewardView(row, masked));
  }

  async function budget(appId: string): Promise<BudgetView> {
    const today = accountingDate(clock.now());
    const rows = await db
      .withSchema('app')
      .selectFrom('invite_reward_budgets')
      .select(['period', 'reserved_fen', 'granted_fen'])
      .where('app_id', '=', appId)
      .where('period', 'in', [today, TOTAL_PERIOD])
      .execute();
    return inviteRewardBudgetView(today, rows);
  }

  return Object.freeze({
    async list(appId: string, query: AdminInviteRewardQuery) {
      const window = qualifiedWindow(query.qualified_from, query.qualified_to);
      if ('kind' in window) return window;
      const page = query.page;
      const pageSize = query.page_size;
      // A filter that is not a uuid names no record (and must not reach the uuid column).
      const none =
        (query.invitee_id !== undefined && !isInviteRewardUserId(query.invitee_id)) ||
        (query.inviter_id !== undefined && !isInviteRewardUserId(query.inviter_id));
      let filtered = records(appId);
      if (query.invitee_id !== undefined && !none) {
        filtered = filtered.where('invitee_id', '=', query.invitee_id);
      }
      if (query.inviter_id !== undefined && !none) {
        filtered = filtered.where('inviter_id', '=', query.inviter_id);
      }
      if (query.status !== undefined) filtered = filtered.where('status', '=', query.status);
      if (window.start !== undefined) {
        filtered = filtered.where('qualified_at', '>=', sql<Date>`${window.start}::timestamptz`);
      }
      if (window.end !== undefined) {
        filtered = filtered.where('qualified_at', '<', sql<Date>`${window.end}::timestamptz`);
      }
      let total = 0;
      if (!none) {
        const counted = await filtered
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow();
        total = Number(counted.n);
      }
      const offset = (page - 1) * pageSize;
      const rows: InviteRewardRow[] =
        offset >= total
          ? []
          : await filtered
              .select([...COLUMNS])
              // One record per invitee: invitee_id makes the order of equal instants stable.
              .orderBy('qualified_at', 'desc')
              .orderBy('invitee_id', 'desc')
              .limit(pageSize)
              .offset(offset)
              .execute();
      const [items, used] = await Promise.all([views(appId, rows), budget(appId)]);
      return { items, page, page_size: pageSize, total, budget: used };
    },

    async get(appId: string, inviteeId: string) {
      if (!isInviteRewardUserId(inviteeId)) return null;
      const row = await records(appId)
        .select([...COLUMNS])
        .where('invitee_id', '=', inviteeId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const [view] = await views(appId, [row]);
      return view ?? null;
    },
  });
}
