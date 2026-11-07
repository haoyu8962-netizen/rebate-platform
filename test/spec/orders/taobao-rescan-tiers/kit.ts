// B1-04zzr rule-test kit (FU-TB-RESCAN-TIERS; orchestrator rulings D10-798 / D10-804, brief
// w1-search-linking at SPEC_REF 3f2b91d). Values pinned by the brief, written out here independent
// of the code under test:
// - Taobao rescans in three tiers, one stream and one cursor each, scene '-':
//   day  'rescan'      30 days (order_sync.rescan.taobao.days), period 1 day,  update, on;
//   hour 'rescan_hour' 3 hours,                                 period 1 hour, pay,    on;
//   week 'rescan_week' 90 days,                                 period 7 days, pay,    off.
// - Window cap order_sync.rescan.taobao.window_minutes, default 180; order_sync.promo_mode on →
//   min(window_minutes, 20). Pace max(60, floor(P ÷ (D ÷ cap))) seconds.
// - Day and week tiers: a round starts at now − D + the start margin (one hour,
//   RESCAN_START_MARGIN_MS as in test/spec/orders/rescan/kit.ts roundStart), windows are the
//   effective cap.
// - Hour tier (orchestrator ruling on round 1, author-notes.md): no start margin, a round starts at
//   now − 3 h; its window is min(effective cap, 20 minutes), so 20 minutes at the defaults and its
//   pace max(60, floor(1 h ÷ (3 h ÷ 20 min))) = 400 s.
// - Every round ends at min(now, increment cursor); only full windows are sent, the one that does
//   not fit ends the round (D10-545), no short window.
// The fixture is test/spec/orders/rescan/kit.ts with one cursor per stream.
import type {
  OrderRescanWindow,
  RescanStream,
  SyncAccount,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import type {
  RescanQueryKind,
  RescanTimeBasis,
} from '../../../../apps/api/src/modules/orders/domain/platform-rules/rescan.ts';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW,
  NOW_MS,
  TAOBAO_ACCOUNT,
  account,
  fixture,
  iso,
} from '../rescan/kit.ts';

export { DAY_MS, HOUR_MS, MINUTE_MS, NOW, NOW_MS, TAOBAO_ACCOUNT, iso };

export const TAOBAO_ENABLED = 'order_sync.rescan.taobao.enabled';
export const TAOBAO_DAYS = 'order_sync.rescan.taobao.days';
export const HOUR_ENABLED = 'order_sync.rescan.taobao.hour.enabled';
export const WEEK_ENABLED = 'order_sync.rescan.taobao.week.enabled';
export const WINDOW_MINUTES = 'order_sync.rescan.taobao.window_minutes';
export const PROMO_MODE = 'order_sync.promo_mode';

/** Every key a Taobao round reads (D10-798 ③⑤). */
export const TAOBAO_TIER_KEYS = [
  TAOBAO_ENABLED,
  TAOBAO_DAYS,
  HOUR_ENABLED,
  WEEK_ENABLED,
  WINDOW_MINUTES,
  PROMO_MODE,
] as const;

/** Default window cap of the tiers (180 minutes) and the promo cap (20 minutes). */
export const DEFAULT_WINDOW_MS = 180 * MINUTE_MS;
export const PROMO_WINDOW_MS = 20 * MINUTE_MS;
/** The start margin of a round, spelled out (rescan/kit.ts roundStart uses the same hour). */
export const MARGIN_MS = HOUR_MS;

export const DAY_DEPTH_MS = 30 * DAY_MS;
export const HOUR_DEPTH_MS = 3 * HOUR_MS;
export const WEEK_DEPTH_MS = 90 * DAY_MS;

/** The tier kinds in a fixed order, to compare what a round sent. */
export const ALL_KINDS: readonly RescanQueryKind[] = ['rescan', 'rescan_hour', 'rescan_week'];

export const taobaoAccount: SyncAccount = {
  ...account,
  platform: 'taobao',
  union_account_id: TAOBAO_ACCOUNT,
};

/** The Taobao fixture account's stream of one tier. */
export function tierStream(kind: RescanQueryKind): RescanStream {
  return {
    app_id: account.app_id,
    platform: 'taobao',
    union_account_id: TAOBAO_ACCOUNT,
    query_kind: kind,
    scene: '-',
  };
}

/** A window of one tier of the Taobao fixture account. */
export function tierWindow(
  kind: RescanQueryKind,
  startMs: number,
  spanMs: number,
  timeBasis: RescanTimeBasis,
): OrderRescanWindow {
  return {
    ...tierStream(kind),
    window_start: iso(startMs),
    window_end: iso(startMs + spanMs),
    timeBasis,
  };
}

/** The first window of a fresh day tier (depth in days) at NOW. */
export function dayWindow(spanMs = DEFAULT_WINDOW_MS, days = 30): OrderRescanWindow {
  return tierWindow('rescan', NOW_MS - days * DAY_MS + MARGIN_MS, spanMs, 'update');
}

/** The first window of a fresh week tier at NOW. */
export function weekWindow(spanMs = DEFAULT_WINDOW_MS): OrderRescanWindow {
  return tierWindow('rescan_week', NOW_MS - WEEK_DEPTH_MS + MARGIN_MS, spanMs, 'pay');
}

/** The hour tier's window at the defaults: min(effective cap, 20 minutes). */
export const HOUR_WINDOW_MS = 20 * MINUTE_MS;

/** The first window of a fresh hour tier at NOW: from now − 3 hours, no start margin. */
export function hourWindow(spanMs = HOUR_WINDOW_MS): OrderRescanWindow {
  return tierWindow('rescan_hour', NOW_MS - HOUR_DEPTH_MS, spanMs, 'pay');
}

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

const streamKey = (s: {
  readonly platform: string;
  readonly union_account_id: string;
  readonly query_kind: string;
  readonly scene: string;
}): string => `${s.platform}:${s.union_account_id}:${s.query_kind}:${s.scene}`;

interface TierFixtureOptions {
  /** Rescan cursors by tier kind, for the Taobao fixture account; unset → no row. */
  readonly cursors?: Readonly<Partial<Record<RescanQueryKind, string>>>;
  /** The increment cursor; left out, the increment has caught up with the clock. */
  readonly increment?: string | null;
  readonly accounts?: readonly SyncAccount[];
  /** Read by key on every call: mutating it changes what the next read returns. */
  readonly config?: Record<string, unknown>;
}

/**
 * The rescan fixture (rescan/kit.ts) over Taobao, with one cursor per stream: reads, advances and
 * rewinds are compare-and-set on that stream's own value, as infra/sync-cursors.ts.
 */
export function tierFixture(options: TierFixtureOptions = {}) {
  const config = options.config ?? {};
  const f = fixture({
    accounts: options.accounts ?? [taobaoAccount],
    config,
    ...(options.increment === undefined ? {} : { increment: options.increment }),
  });
  const cursors = new Map<string, string>();
  for (const kind of ALL_KINDS) {
    const at = options.cursors?.[kind];
    if (at !== undefined) cursors.set(streamKey(tierStream(kind)), at);
  }
  const readIncrement = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (asked) =>
    asked.query_kind === 'increment'
      ? readIncrement(asked)
      : (cursors.get(streamKey(asked)) ?? null),
  );
  f.advance.mockImplementation(async (win) => {
    const current = cursors.get(streamKey(win));
    if (current !== undefined && !sameInstant(current, win.window_start)) return false;
    cursors.set(streamKey(win), win.window_end);
    return true;
  });
  f.rewind.mockImplementation(async (s, expected, to) => {
    const current = cursors.get(streamKey(s));
    if (current === undefined || !sameInstant(current, expected)) return false;
    cursors.set(streamKey(s), to);
    return true;
  });
  /** What was sent, by tier kind, for the Taobao fixture account. */
  const sentOf = (kind: RescanQueryKind): JobPayload[] =>
    f
      .sent()
      .filter(
        (win) =>
          win['platform'] === 'taobao' &&
          win['union_account_id'] === TAOBAO_ACCOUNT &&
          win['query_kind'] === kind,
      );
  /** The kinds sent for the Taobao fixture account, once each, in ALL_KINDS order. */
  const kindsSent = (): RescanQueryKind[] => ALL_KINDS.filter((kind) => sentOf(kind).length > 0);
  return {
    ...f,
    values: config,
    cursorOf: (kind: RescanQueryKind) => cursors.get(streamKey(tierStream(kind))) ?? null,
    sentOf,
    kindsSent,
  };
}
