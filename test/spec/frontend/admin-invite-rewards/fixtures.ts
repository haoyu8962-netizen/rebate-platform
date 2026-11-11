// F1-15b fixtures: contract-shaped invite reward records (AdminInviteReward, BR-INV-24), the used
// budget (AdminInviteRewardBudget) and one in-memory HTTP boundary. Config items and step-up go
// to the frozen configuration-center server; GET /admin/v1/invite-rewards and
// GET /admin/v1/invite-rewards/{invitee_id} are answered here. Assertions read real requests.
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { TRACE_ID } from '../admin-data/fixtures.ts';
import {
  TARGET,
  createServer as createConfigServer,
  item,
  type ConfigRow,
  type RequestLog,
} from '../admin-config-center/fixtures.ts';
import {
  AMOUNT,
  DAILY,
  ELIGIBILITY,
  INVITE_NEIGHBOUR,
  IP_WINDOW,
  MIN_PAID,
  TOTAL,
  VALUES,
} from '../admin-invite-reward-config/helpers.ts';

export type Reward = Schema<'AdminInviteReward'>;
/** A fixture record: the contract allows a null masked phone; every fixture here has both. */
export type FixtureReward = Reward & {
  invitee_phone_masked: string;
  inviter_phone_masked: string;
};
export type Budget = Schema<'AdminInviteRewardBudget'>;
export type RewardStatus = Schema<'AdminInviteRewardStatus'>;

export const REWARDS = '/admin/v1/invite-rewards';
export const INVITER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
export const INVITER_PHONE = '138****5678';
export const OTHER_INVITER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c06';
export const OTHER_INVITER_PHONE = '133****4444';

export function reward(
  invitee: string,
  phone: string,
  patch: Partial<FixtureReward> = {},
): FixtureReward {
  return {
    invitee_id: invitee,
    inviter_id: INVITER,
    invitee_phone_masked: phone,
    inviter_phone_masked: INVITER_PHONE,
    amount_fen: 1000,
    eligibility_days: 30,
    bind_source: 'landing',
    qualified_at: '2026-10-10T10:00:00+08:00',
    trigger_order_id: null,
    triggered_at: null,
    status: 'qualified',
    inviter_result: null,
    invitee_result: null,
    inviter_skip_reason: null,
    invitee_skip_reason: null,
    void_reason: null,
    granted_at: null,
    ...patch,
  };
}

/** Processed: the inviter is not paid (risk_restricted), the invitee is paid (contract example). */
export const PROCESSED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02', '139****0000', {
  bind_source: 'landing',
  qualified_at: '2026-10-20T10:00:00+08:00',
  trigger_order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01',
  triggered_at: '2026-11-25T09:00:00+08:00',
  status: 'processed',
  inviter_result: 'skipped',
  invitee_result: 'granted',
  inviter_skip_reason: 'risk_restricted',
  granted_at: '2026-11-25T09:00:05+08:00',
});
/** Qualified, waiting for the trigger (contract example). */
export const QUALIFIED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c03', '137****1111', {
  bind_source: 'register',
  qualified_at: '2026-10-19T20:30:00+08:00',
});
/** Voided: the trigger order was clawed back before payout (contract example). */
export const VOIDED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04', '136****2222', {
  bind_source: 'backfill',
  qualified_at: '2026-10-21T08:15:00+08:00',
  trigger_order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a02',
  triggered_at: '2026-11-25T09:00:00+08:00',
  status: 'voided',
  void_reason: 'order_clawed_back',
});
/** Processed, both parties not paid (same device), another inviter, 12.34 yuan each. */
export const BOTH_SKIPPED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c05', '135****3333', {
  inviter_id: OTHER_INVITER,
  inviter_phone_masked: OTHER_INVITER_PHONE,
  amount_fen: 1234,
  bind_source: 'landing',
  qualified_at: '2026-10-18T09:00:00+08:00',
  trigger_order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a03',
  triggered_at: '2026-11-20T10:00:00+08:00',
  status: 'processed',
  inviter_result: 'skipped',
  invitee_result: 'skipped',
  inviter_skip_reason: 'same_device',
  invitee_skip_reason: 'same_device',
});
/** Deferred: triggered, the daily budget was not enough. */
export const DEFERRED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c07', '132****5555', {
  bind_source: 'register',
  qualified_at: '2026-10-17T12:00:00+08:00',
  trigger_order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a04',
  triggered_at: '2026-11-24T11:00:00+08:00',
  status: 'deferred',
});
/** Expired: no qualifying own order within the locked eligibility days. */
export const EXPIRED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c08', '131****6666', {
  bind_source: 'landing',
  qualified_at: '2026-09-01T10:00:00+08:00',
  status: 'expired',
});

/**
 * Processed the other way round from PROCESSED: the inviter is paid, the invitee is not (minor).
 * Deferred after the trigger and posted the next day, so 到账 and 触发 differ in day and minute.
 * Not in rewards(); tests that need it pass their own record list.
 */
export const MIRRORED = reward('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c09', '134****7777', {
  bind_source: 'register',
  qualified_at: '2026-10-22T16:00:00+08:00',
  trigger_order_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a05',
  triggered_at: '2026-11-22T14:00:00+08:00',
  status: 'processed',
  inviter_result: 'granted',
  invitee_result: 'skipped',
  invitee_skip_reason: 'minor',
  granted_at: '2026-11-23T00:05:30+08:00',
});

export function rewards(): FixtureReward[] {
  return [PROCESSED, QUALIFIED, VOIDED, BOTH_SKIPPED, DEFERRED, EXPIRED];
}

/** `count` deferred records of INVITER, phones 130****0000, 131****0001, … */
export function manyRewards(count: number): FixtureReward[] {
  return Array.from({ length: count }, (_, index) =>
    reward(
      `0199a3b4-5c6d-7e8f-9a0b-${String(index).padStart(12, '0')}`,
      `${130 + (index % 10)}****${String(index).padStart(4, '0')}`,
      {
        bind_source: 'register',
        trigger_order_id: `0199a3b4-5c6d-7e8f-9a0c-${String(index).padStart(12, '0')}`,
        triggered_at: '2026-11-24T11:00:00+08:00',
        status: 'deferred',
      },
    ),
  );
}

/** Used amounts: today 30.00 granted; in total 120.00 reserved and 450.00 granted. */
export const BUDGET: Budget = {
  today: { date: '2026-11-25', granted_fen: 3000 },
  total: { reserved_fen: 12000, granted_fen: 45000 },
};

/** The invite group rows of F1-15a with the two budget limits given (integer fen). */
export function configRows(daily = VALUES[DAILY], total = VALUES[TOTAL]): ConfigRow[] {
  return [
    item(TARGET),
    item(INVITE_NEIGHBOUR, { value: true, value_type: 'boolean', permission: 'config.general' }),
    item(AMOUNT, { value: VALUES[AMOUNT] }),
    item(DAILY, { value: daily }),
    item(TOTAL, { value: total }),
    item(MIN_PAID, { value: VALUES[MIN_PAID] }),
    item(IP_WINDOW, { value: VALUES[IP_WINDOW], permission: 'config.risk' }),
    item(ELIGIBILITY, { value: VALUES[ELIGIBILITY] }),
  ];
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
export function failure(code: number, data: unknown = null, msg = '操作失败'): Response {
  const status = code === 10403 ? 403 : code === 30701 ? 404 : 400;
  return Response.json({ code, msg, data, trace_id: TRACE_ID }, { status });
}

type Reply = (request: RequestLog) => Response | Promise<Response>;
const QUERY_NAMES = [
  'page',
  'page_size',
  'invitee_id',
  'inviter_id',
  'status',
  'qualified_from',
  'qualified_to',
];
const STATUSES: readonly string[] = ['qualified', 'deferred', 'processed', 'voided', 'expired'];
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ServerOptions {
  readonly records?: Reward[];
  readonly budget?: Budget;
  readonly rows?: ConfigRow[];
}

export function createRewardServer(options: ServerOptions = {}) {
  const config = createConfigServer(options.rows ?? configRows());
  const state = {
    records: structuredClone(options.records ?? rewards()),
    budget: structuredClone(options.budget ?? BUDGET),
  };
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let pending = 0;

  function invalid(...fields: string[]): Response {
    return failure(20001, { fields }, '参数错误');
  }

  function list(request: RequestLog): Response {
    const query = request.query;
    const unknown = Object.keys(query).filter((name) => !QUERY_NAMES.includes(name));
    if (unknown.length > 0) return invalid(...unknown);
    const page = Number(query['page'] ?? 1);
    const size = Number(query['page_size'] ?? 20);
    if (!Number.isInteger(page) || page < 1) return invalid('page');
    if (!Number.isInteger(size) || size < 1 || size > 200) return invalid('page_size');
    const status = query['status'];
    if (status !== undefined && !STATUSES.includes(status)) return invalid('status');
    const from = query['qualified_from'];
    const to = query['qualified_to'];
    if (from !== undefined && !CALENDAR_DAY.test(from)) return invalid('qualified_from');
    if (to !== undefined && !CALENDAR_DAY.test(to)) return invalid('qualified_to');
    if (from !== undefined && to !== undefined && from > to)
      return invalid('qualified_from', 'qualified_to');
    // Every fixture time carries +08:00, so its first ten characters are its +08:00 calendar day.
    const items = state.records
      .filter(
        (record) =>
          (query['invitee_id'] === undefined || record.invitee_id === query['invitee_id']) &&
          (query['inviter_id'] === undefined || record.inviter_id === query['inviter_id']) &&
          (status === undefined || record.status === status) &&
          (from === undefined || record.qualified_at.slice(0, 10) >= from) &&
          (to === undefined || record.qualified_at.slice(0, 10) <= to),
      )
      .sort((a, b) => b.qualified_at.localeCompare(a.qualified_at));
    return ok({
      items: items.slice((page - 1) * size, page * size),
      page,
      page_size: size,
      total: items.length,
      budget: state.budget,
    });
  }

  function normal(request: RequestLog): Response {
    if (request.method !== 'GET') return invalid('path');
    if (request.path === REWARDS) return list(request);
    const invitee = decodeURIComponent(request.path.slice(REWARDS.length + 1));
    const found = state.records.find((record) => record.invitee_id === invitee);
    return found === undefined ? failure(30701, null, '内容不存在') : ok(found);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      if (request.path !== REWARDS && !request.path.startsWith(`${REWARDS}/`))
        return await config.fetch(input, init);
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };

  return {
    /** The frozen configuration-center server behind /admin/v1/config-items. */
    config,
    state,
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path: string) {
      return log.filter((request) => request.method === method && request.path === path);
    },
    /** Every request to /admin/v1/invite-rewards or one of its records. */
    rewardRequests() {
      return log.filter(
        (request) => request.path === REWARDS || request.path.startsWith(`${REWARDS}/`),
      );
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
  };
}
export type RewardServer = ReturnType<typeof createRewardServer>;
