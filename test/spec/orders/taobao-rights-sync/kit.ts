// B1-04zza 维权、违规进调度的夹具（不连库、不联网）。取值依据：规划/02 §7.1 淘宝行（每 30 分钟拉维权与处罚、
// 每天回扫近 60 天；处罚订单只能查近 30 天、不推水位）、编排 D10-645 / D10-676（任务书第 9 节：3 小时一窗，
// 水位 query_kind 新增 rights / punish，违规 occurred_at 取同步时刻，按能力判平台，对不上订单只计数）、
// 08 BR-FUND-06 / 08（rights.record 是 order_rights 的唯一写入口）。
// UnionRefund / UnionPunish 是联盟归一后的形状（合成值，不是平台报文）；单号是掩码形状的合成串。
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  JobPayload,
  JobQueue,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  Page,
  RegisteredPlatform,
  UnionAdapter,
  UnionPunish,
  UnionRefund,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  PunishSyncWindow,
  RightsCursorStore,
  RightsSyncRegistry,
  RightsSyncSchedulerDeps,
  RightsSyncWindow,
  RightsSyncWriter,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import type {
  SyncAccessPort,
  SyncAccount,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import type { RightsSyncHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';

export const NOW = '2026-11-06T04:00:00.000Z';
export const NOW_MS = Date.parse(NOW);
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** 02 §7.1：每 30 分钟拉一次维权与处罚。 */
export const ROUND_MS = 30 * MINUTE_MS;
/** 任务书第 9 节第 3 条：3 小时一窗。 */
export const WINDOW_MS = 3 * HOUR_MS;
/** 每天回扫近 60 天。 */
export const RESCAN_DAYS = 60;
/** 60 天 ÷ 3 小时 = 480 窗，一天走完：每 180 秒一窗。 */
export const RESCAN_TICK_MS = 180 * SECOND_MS;
/** 处罚只能查近 30 天：每轮 [now − 30 天, now)。 */
export const PUNISH_DAYS = 30;

export const RIGHTS_JOB = 'rights.window';
export const PUNISH_JOB = 'punish.window';
export const QUEUE = 'order-sync';

export const APP = 'rights-sync-spec';
export const TAOBAO_ACCOUNT = '20000000-0000-4000-8000-0000000000a1';
export const JD_ACCOUNT = '20000000-0000-4000-8000-0000000000a2';
export const PDD_ACCOUNT = '20000000-0000-4000-8000-0000000000a3';
export const OTHER_ACCOUNT = '20000000-0000-4000-8000-0000000000a4';
export const SYNC_START = '2026-10-01T00:00:00.000Z';

export const iso = (ms: number): string => new Date(ms).toISOString();
export const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

export const taobaoAccount: SyncAccount = {
  app_id: APP,
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
  sync_start_at: SYNC_START,
};
export const jdAccount: SyncAccount = {
  ...taobaoAccount,
  platform: 'jd',
  union_account_id: JD_ACCOUNT,
};
export const pddAccount: SyncAccount = {
  ...taobaoAccount,
  platform: 'pdd',
  union_account_id: PDD_ACCOUNT,
};

/** The sync_cursors key of a stream in the fake store. */
export function cursorKey(
  s: Pick<SyncStream, 'platform' | 'union_account_id' | 'query_kind' | 'scene'>,
) {
  return `${s.platform}:${s.union_account_id}:${s.query_kind}:${s.scene}`;
}
export const INCREMENT = cursorKey({
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
  query_kind: 'rights',
  scene: '-',
});
export const RESCAN = cursorKey({
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
  query_kind: 'rights',
  scene: 'rescan',
});

type WindowPatch<W extends RightsSyncWindow | PunishSyncWindow> = Partial<
  Pick<W, 'platform' | 'union_account_id' | 'scene' | 'window_start' | 'window_end'>
>;

/** A rights window of the taobao account, 3 hours from `start` unless `patch` says otherwise. */
export function rightsWindow(
  start: string,
  patch: WindowPatch<RightsSyncWindow> = {},
): RightsSyncWindow {
  return {
    app_id: APP,
    platform: 'taobao',
    union_account_id: TAOBAO_ACCOUNT,
    query_kind: 'rights',
    scene: '-',
    window_start: start,
    window_end: iso(Date.parse(start) + WINDOW_MS),
    ...patch,
  };
}

/** The punish window a round at NOW dispatches. */
export function punishWindow(patch: WindowPatch<PunishSyncWindow> = {}): PunishSyncWindow {
  return {
    app_id: APP,
    platform: 'taobao',
    union_account_id: TAOBAO_ACCOUNT,
    query_kind: 'punish',
    scene: '-',
    window_start: iso(NOW_MS - PUNISH_DAYS * DAY_MS),
    window_end: NOW,
    ...patch,
  };
}

export function job(name: string, payload: JobPayload, attempt = 1): ReceivedJob {
  return { id: 'synthetic-rights-job', queue: QUEUE, name, payload, attempt };
}

/** A refund told apart by `index`: PROCESSING, 0.71 yuan to deduct, created 2026-11-05 10:00 +08:00. */
export function refund(index: number, patch: Partial<UnionRefund> = {}): UnionRefund {
  return {
    order_id: `${2900000000000003000n + BigInt(index)}`,
    refund_id: `${3300000000000003000n + BigInt(index)}`,
    refund_fen: 71n,
    base_refund_fen: 71n,
    subsidy_refund_fen: 0n,
    show_return_fen: null,
    refund_status: '4',
    rights_status: 'PROCESSING',
    refund_created_at: new Date(Date.parse('2026-11-05T02:00:00.000Z') + index * MINUTE_MS),
    refund_finished_at: null,
    modified_at: new Date(Date.parse('2026-11-05T03:00:00.000Z') + index * MINUTE_MS),
    earning_at: null,
    ...patch,
  };
}

/** A punishment told apart by `index` (settle month 202610). */
export function punishment(index: number, patch: Partial<UnionPunish> = {}): UnionPunish {
  const orderId = `${2900000000000004000n + BigInt(index)}`;
  return {
    order_id: orderId,
    punishment_id: `${orderId}:202610`,
    deduction_fen: null,
    punish_status: '0',
    violation_type: '1',
    settle_month: '202610',
    ...patch,
  };
}

/** Page `index` of `pages`, the cursor of the next page being `page-<index + 1>`. */
function paged<T>(pages: readonly (readonly T[])[], cursor: string | undefined): Page<T> {
  const index = cursor === undefined ? 0 : Number(cursor.replace('page-', ''));
  return {
    items: pages[index] ?? [],
    nextCursor: index + 1 < pages.length ? `page-${index + 1}` : null,
  };
}

/** What a platform's adapter offers: both lists, one of them, none, or no adapter at all. */
export type Capability = 'both' | 'refunds' | 'punishments' | 'none' | 'missing';

export interface FixtureOptions {
  readonly accounts?: readonly SyncAccount[];
  /** cursor_at by cursorKey. */
  readonly cursors?: Readonly<Record<string, string>>;
  readonly capable?: Readonly<Partial<Record<RegisteredPlatform, Capability>>>;
  readonly refundPages?: readonly (readonly UnionRefund[])[];
  readonly punishPages?: readonly (readonly UnionPunish[])[];
}

interface MockLike {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** Every value of `field` that a pino-style call carried in its first argument. */
export function loggedValues(fn: MockLike, field: string): unknown[] {
  return fn.mock.calls
    .map((call) => call[0])
    .filter(
      (fields): fields is Record<string, unknown> => typeof fields === 'object' && fields !== null,
    )
    .filter((fields) => Object.hasOwn(fields, field))
    .map((fields) => fields[field]);
}

/** Everything the calls would print (bigint as text), for redaction checks. */
export function printed(...fns: MockLike[]): string {
  return JSON.stringify(
    fns.map((fn) => fn.mock.calls),
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

/** Scheduler and handler over fakes: cursors behave like infra/sync-cursors.ts (CAS). */
export function fixture(options: FixtureOptions = {}) {
  const clock = new FixedClock(NOW);
  const rows = new Map<string, string>(Object.entries(options.cursors ?? {}));
  const read = vi.fn<RightsCursorStore['read']>(
    async (stream) => rows.get(cursorKey(stream)) ?? null,
  );
  const advance = vi.fn<RightsCursorStore['advance']>(async (win) => {
    const current = rows.get(cursorKey(win));
    if (current !== undefined && !sameInstant(current, win.window_start)) return false;
    rows.set(cursorKey(win), win.window_end);
    return true;
  });
  const rewind = vi.fn<RightsCursorStore['rewind']>(async (stream, expected, to) => {
    const current = rows.get(cursorKey(stream));
    if (expected === null) {
      if (current !== undefined) return false;
    } else if (current === undefined || !sameInstant(current, expected)) {
      return false;
    }
    rows.set(cursorKey(stream), to);
    return true;
  });
  const cursors: RightsCursorStore = { read, advance, rewind };

  const send = vi.fn<JobQueue['send']>().mockResolvedValue('queued-rights');
  const listEnabledAccounts = vi
    .fn<SyncAccessPort['listEnabledAccounts']>()
    .mockResolvedValue(options.accounts ?? [taobaoAccount]);
  const siteAuthAvailable = vi.fn<SyncAccessPort['siteAuthAvailable']>().mockResolvedValue(true);
  const offlineCircuitOpen = vi.fn<SyncAccessPort['offlineCircuitOpen']>().mockResolvedValue(false);
  const owners: Readonly<Record<RegisteredPlatform, string>> = {
    taobao: TAOBAO_ACCOUNT,
    jd: JD_ACCOUNT,
    pdd: PDD_ACCOUNT,
  };
  const queryableAccount = vi.fn<NonNullable<SyncAccessPort['queryableAccount']>>(
    async (platform) => owners[platform],
  );
  const access: SyncAccessPort = {
    listEnabledAccounts,
    siteAuthAvailable,
    offlineCircuitOpen,
    queryableAccount,
  };

  const refundPages = options.refundPages ?? [[]];
  const punishPages = options.punishPages ?? [[]];
  const listRefunds = vi.fn<NonNullable<UnionAdapter['listRefunds']>>(async (_win, _ctx, opt) =>
    paged(refundPages, opt?.cursor),
  );
  const listPunishments = vi.fn<NonNullable<UnionAdapter['listPunishments']>>(
    async (_win, _ctx, opt) => paged(punishPages, opt?.cursor),
  );
  const capable = options.capable ?? { taobao: 'both' };
  const get = vi.fn<RightsSyncRegistry['get']>((platform) => {
    const kind = capable[platform] ?? 'missing';
    if (kind === 'missing') throw new Error(`union: no endpoint for ${platform}`);
    return {
      ...(kind === 'both' || kind === 'refunds' ? { listRefunds } : {}),
      ...(kind === 'both' || kind === 'punishments' ? { listPunishments } : {}),
    };
  });
  const registry: RightsSyncRegistry = { get };

  const write = vi.fn<RightsSyncWriter['write']>(async () => ({ kind: 'applied' }));
  const writer: RightsSyncWriter = { write };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const scheduler: RightsSyncSchedulerDeps = {
    clock,
    queue: { send },
    cursors,
    access,
    registry,
    logger,
  };
  const handler: RightsSyncHandlerDeps = { clock, access, cursors, registry, writer, logger };

  const sent = () =>
    send.mock.calls.map(([queue, name, payload, opts]) => ({ queue, name, payload, opts }));
  return {
    clock,
    rows,
    read,
    advance,
    rewind,
    send,
    listEnabledAccounts,
    siteAuthAvailable,
    offlineCircuitOpen,
    queryableAccount,
    listRefunds,
    listPunishments,
    get,
    write,
    logger,
    scheduler,
    handler,
    sent,
    /** Payloads sent under `name`. */
    payloads: (name: string) =>
      sent()
        .filter((call) => call.name === name)
        .map((c) => c.payload),
    /** Rights windows of one scene ('-' increment, 'rescan'). */
    rightsOf: (scene: string) =>
      sent()
        .filter((call) => call.name === RIGHTS_JOB && call.payload['scene'] === scene)
        .map((call) => call.payload),
    /** The writer's calls as [target, item]. */
    writes: () => write.mock.calls.map(([target, item]) => ({ target, item })),
  };
}
export type Fixture = ReturnType<typeof fixture>;
