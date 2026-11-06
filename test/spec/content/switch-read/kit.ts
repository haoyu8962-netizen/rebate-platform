// F1-10b rule-test kit: the emergency switch registry and the switch read cache of the content
// module. Public shape under test (skeletons in apps/api/src/modules/content/, also re-exported
// from its index.ts):
//   domain/switch-registry.ts  switchRegistry(): readonly SwitchSpec[];
//                              switchSpecOf(key): SwitchSpec | null
//   domain/cache-policy.ts     switchCacheTtlMs(): number, in (0, 5000]
//   application/content-reader.ts CachedContentReader(store, clock).configValue(appId, key)
//
// Sources (SPEC_REF): 规划/04 §10.2 (every key / key pattern and its default column), §11.2
// (switch.all / switch.payout / switch.pay, per key), BR-INV-21 (growth.invite_bind.enabled: on,
// effective within 10 s), BR-WDR-17, BR-PROD-10, BR-AI-12; orchestrator rulings in task brief
// §9.2 (1)-(4). Local readings recorded here so the implementation does not have to guess:
//   - Defaults: on → true, off / false → false, enum and route defaults as written; a column
//     that reads 「on / off」 or 「见 BR-PROD-10 细则」 for one key is null (undecided).
//   - `payout.channel_enabled.<channel>` is one pattern whose defaults 04 fixes per channel:
//     defaultValue null, defaultOverrides { alipay: true, bank_card: false, wechat: false }
//     (wechat off as summarised in brief §9.1: kept off until 09 CAP-X-15 is verified).
//   - `agent.enabled` / `agent.whitelist_only` (default 「on / on（登记前）」) are two keys, both on.
//   - `agent.model_route`: value is a route selection object (agent's RouteSelection, BR-AI-21);
//     the default column's `primary` is not that shape, so its default is null (undecided),
//     orchestrator ruling 2026-10-16. SwitchDefault cannot hold an object, so an object-typed
//     switch always has a null default.
//   - Permissions are compared as sets; switch.payout and switch.pay never include each other.
//   - Cache: a registered switch key is cached for switchCacheTtlMs() and is read again from the
//     store once its age reaches that value (same age >= TTL rule as CONTENT_CACHE_TTL_MS); every
//     other key keeps 60,000 ms exactly as test/spec/content/read/** freezes.
//   - F1-02zm: F1-02zn appends the BR-INV-24 pair growth.invite_reward.enabled / payout_paused
//     (INVITE_SW below) after watch.enabled.<platform>; expectedNow is EXPECTED + INVITE_SW
//     (F1-02zt：过渡已收紧, the pair must be present); EXPECTED itself stays the 04 §10.2 table
//     verbatim.
//   - B1-05zj (D10-736): the five 04 §10.2 rows of 2026-11-05 (shop.entry / detail.sales /
//     detail.shop_scores / detail.coupon_end .enabled.<platform>, detail.jd_plus_note.enabled)
//     join EXPECTED in table order after search.enabled.<platform>, so watch.enabled.<platform>
//     stays EXPECTED's last row and the INVITE_SW pair stays last in the registry. feedback.enabled
//     stays a config item (FU-FEEDBACK-SWITCH-TABLE) and is not listed here.
import type { DB } from '@couli/db';
import { expect } from 'vitest';
import type {
  ContentConfig,
  ContentStore,
} from '../../../../apps/api/src/modules/content/application/content-reader.ts';
import {
  switchSpecOf,
  type SwitchDefault,
  type SwitchPermission,
  type SwitchValueType,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';

export const START = '2031-05-06T07:08:09.000Z';
export const CONFIG_CACHE_MS = 60_000;
export const SWITCH_CACHE_MAX_MS = 5_000;
export const SWITCH_EFFECTIVE_MS = 10_000;
export type Json = DB['config_items']['value'];

const ALL: readonly SwitchPermission[] = ['switch.all'];
const PAYOUT: readonly SwitchPermission[] = ['switch.all', 'switch.payout'];
const PAY: readonly SwitchPermission[] = ['switch.all', 'switch.pay'];
const BOOL: SwitchValueType = { kind: 'boolean' };

export interface ExpectedSwitch {
  readonly pattern: string;
  readonly valueType: SwitchValueType;
  readonly defaultValue: SwitchDefault;
  readonly defaultOverrides: Readonly<Record<string, SwitchDefault>>;
  readonly permissions: readonly SwitchPermission[];
  readonly adminEditable: boolean;
  readonly systemWritten: boolean;
  /** A concrete key of this pattern (the pattern itself when it has no placeholder). */
  readonly sample: string;
}

function entry(
  pattern: string,
  sample: string,
  valueType: SwitchValueType,
  defaultValue: SwitchDefault,
  permissions: readonly SwitchPermission[],
  extra: {
    readonly adminEditable?: boolean;
    readonly systemWritten?: boolean;
    readonly defaultOverrides?: Readonly<Record<string, SwitchDefault>>;
  } = {},
): ExpectedSwitch {
  return {
    pattern,
    sample,
    valueType,
    defaultValue,
    defaultOverrides: extra.defaultOverrides ?? {},
    permissions,
    adminEditable: extra.adminEditable ?? true,
    systemWritten: extra.systemWritten ?? false,
  };
}

/** Every row of 规划/04 §10.2, in table order. */
export const EXPECTED: readonly ExpectedSwitch[] = [
  entry('convert.enabled.<platform>', 'convert.enabled.taobao', BOOL, false, ALL),
  entry(
    'convert.off_reason.<platform>',
    'convert.off_reason.pdd',
    { kind: 'enum', values: ['not_launched', 'maintenance'] },
    'not_launched',
    ALL,
  ),
  entry('search.enabled.<platform>', 'search.enabled.jd', BOOL, null, ALL),
  // B1-05zj (D10-664 S-09, D10-736): 04 §10.2 rows added 2026-11-05 (商品详情 v3), in table
  // order; defaults per BR-PRICE-21 细则「进店」, BR-TEXT-13 细则「虚拟数据」, BR-PRICE-04 细则
  // 「商品详情的券标签」 (off) and BR-CALC-17 细则 (on); switch.all only (§11.2).
  entry('shop.entry.enabled.<platform>', 'shop.entry.enabled.pdd', BOOL, false, ALL),
  entry('detail.sales.enabled.<platform>', 'detail.sales.enabled.pdd', BOOL, false, ALL),
  entry(
    'detail.shop_scores.enabled.<platform>',
    'detail.shop_scores.enabled.taobao',
    BOOL,
    false,
    ALL,
  ),
  entry('detail.coupon_end.enabled.<platform>', 'detail.coupon_end.enabled.jd', BOOL, false, ALL),
  entry('detail.jd_plus_note.enabled', 'detail.jd_plus_note.enabled', BOOL, true, ALL),
  entry('parse.tpwd.enabled', 'parse.tpwd.enabled', BOOL, true, ALL),
  entry('pdd.direct_convert.enabled', 'pdd.direct_convert.enabled', BOOL, false, ALL),
  entry('agent.enabled', 'agent.enabled', BOOL, true, ALL),
  entry('agent.whitelist_only', 'agent.whitelist_only', BOOL, true, ALL, { adminEditable: false }),
  entry('agent.model_route', 'agent.model_route', { kind: 'object' }, null, ALL, {
    adminEditable: false,
  }),
  entry('agent.tools.<name>.enabled', 'agent.tools.get_my_earnings.enabled', BOOL, true, ALL),
  entry('agent.page_guide.enabled', 'agent.page_guide.enabled', BOOL, true, ALL),
  entry('withdraw.enabled', 'withdraw.enabled', BOOL, true, PAYOUT),
  entry('withdraw.auto_payout.enabled', 'withdraw.auto_payout.enabled', BOOL, false, ALL),
  entry('payout.enabled', 'payout.enabled', BOOL, true, PAYOUT),
  entry('payout.queue_paused', 'payout.queue_paused', BOOL, false, PAYOUT, {
    systemWritten: true,
  }),
  entry('payout.channel_enabled.<channel>', 'payout.channel_enabled.alipay', BOOL, null, PAYOUT, {
    defaultOverrides: { alipay: true, bank_card: false, wechat: false },
  }),
  entry('payout.channel_paused.<channel>', 'payout.channel_paused.bank_card', BOOL, false, PAYOUT, {
    systemWritten: true,
  }),
  entry('pay.enabled', 'pay.enabled', BOOL, null, PAY),
  entry('pay.channel_enabled.<pay_channel>', 'pay.channel_enabled.wechat_pay', BOOL, null, PAY),
  entry('settle.auto.enabled', 'settle.auto.enabled', BOOL, true, ALL, { systemWritten: true }),
  entry('credit.enabled.<platform>', 'credit.enabled.taobao', BOOL, false, ALL),
  entry('claims.enabled', 'claims.enabled', BOOL, true, ALL),
  entry('order_sync.promo_mode', 'order_sync.promo_mode', BOOL, false, ALL),
  entry('jev.enabled', 'jev.enabled', BOOL, false, ALL),
  entry('tlj.enabled', 'tlj.enabled', BOOL, false, ALL),
  entry('growth.invite_bind.enabled', 'growth.invite_bind.enabled', BOOL, true, ALL),
  entry('watch.enabled.<platform>', 'watch.enabled.pdd', BOOL, false, ALL),
];

// F1-02zm (F1-02zt：过渡已收紧, always registered).
// BR-INV-24 ① / ④ and 04 §10.2 l.956–957, §11.2 l.1001, as F1-02zn registers them (couli-runs/
// F1-02zn excerpt 9.2-2): the activity switch and the payout pause switch, both boolean, default
// off, switch.all only, editable from the console, never written by the system.
export const INVITE_SW: readonly ExpectedSwitch[] = [
  entry('growth.invite_reward.enabled', 'growth.invite_reward.enabled', BOOL, false, ALL),
  entry(
    'growth.invite_reward.payout_paused',
    'growth.invite_reward.payout_paused',
    BOOL,
    false,
    ALL,
  ),
];

/**
 * F1-02zm: the registry oracle, EXPECTED followed by INVITE_SW. F1-02zt：过渡已收紧, the pair
 * must be registered (one of the two alone or neither fails here).
 */
export function expectedNow(): readonly ExpectedSwitch[] {
  const present = INVITE_SW.filter((row) => switchSpecOf(row.sample) !== null).length;
  expect(present, 'growth.invite_reward.* switches registered whole').toBe(INVITE_SW.length);
  return [...EXPECTED, ...INVITE_SW];
}

export function expectedOf(pattern: string): ExpectedSwitch {
  const found = expectedNow().find((row) => row.pattern === pattern);
  if (found === undefined) throw new Error(`kit: no expected row for ${pattern}`);
  return found;
}

/** Keys that are not emergency switches (brief §9.2 (2), (4)), each with why. */
export const NOT_SWITCHES: readonly (readonly [string, string])[] = [
  ['payout.proven_success_writeoff.enabled', 'payout. prefix only'],
  ['agent.page_guide.routes', 'agent.page_guide config item'],
  ['external_hosts', 'config item'],
  ['search.enabled', 'pattern without its platform segment'],
  ['convert.enabled', 'pattern without its platform segment'],
  ['convert.enabled.taobao.x', 'one segment too many'],
  ['convert.enabled.', 'empty placeholder segment'],
  ['convert.enabled.Taobao', 'uppercase placeholder'],
  ['convert.enabled.tao-bao', 'hyphen in placeholder'],
  ['convert.enabled.tao bao', 'space in placeholder'],
  ['convert.enabled.<platform>', 'the pattern text itself'],
  ['convert.enabled.*', 'wildcard text'],
  ['agent.tools.enabled', 'tool name segment missing'],
  ['agent.tools.a.b.enabled', 'two segments for one placeholder'],
  ['agent.tools.get_my_earnings', 'trailing literal segment missing'],
  ['withdraw', 'prefix of a key'],
  ['withdraw.enabled.extra', 'literal key with an extra segment'],
  ['withdraw.enabled ', 'trailing space'],
  [' withdraw.enabled', 'leading space'],
  ['xwithdraw.enabled', 'longer first segment'],
  ['Withdraw.enabled', 'case differs'],
  ['parseXtpwdXenabled', 'dots are literal, not any character'],
  ['parse.tpwd.enabledx', 'longer last segment'],
  ['payout.channel_enabled', 'pattern without its channel segment'],
  ['payout.channel', 'prefix of a pattern'],
  ['pay.channel_enabled.', 'empty pay_channel segment'],
  ['growth.invite_bind', 'prefix of a key'],
  ['convert.enabled.taobao\n', 'trailing newline'],
  ['', 'empty key'],
  ['config.invite.backfill_hours', 'BR-INV-21 config item, not a switch'],
  ['invite.fail_limit_per_day', 'BR-INV-21 config item, not a switch'],
  ['config.invite.bind_phone_guide', 'BR-INV-21 reminder flag, not a §10.2 switch'],
  ['withdraw.account_enabled.SELF', 'removed by 04 §10.2 note'],
  ['indirect_enabled', 'rule version field, not a switch'],
];

/**
 * In-memory ContentStore: counts reads per (appId, key) and can fail on demand. holdNextRead()
 * suspends the next configItem call until the test finishes it, so the clock and the stored row
 * can move while that read is in flight (a slow PostgreSQL read).
 */
export class FakeStore implements ContentStore {
  private readonly rows = new Map<string, ContentConfig>();
  private readonly reads = new Map<string, number>();
  private holdNext = false;
  private readonly held: ((row: ContentConfig | null) => void)[] = [];
  failure: Error | null = null;

  /** The next configItem call stays pending until finishHeldRead() answers it. */
  holdNextRead(): void {
    this.holdNext = true;
  }

  /** How many held reads have started and are still pending. */
  heldReads(): number {
    return this.held.length;
  }

  /** Completes the oldest held read with `row` (what the database saw when the read ran). */
  finishHeldRead(row: ContentConfig | null): void {
    const finish = this.held.shift();
    if (finish === undefined) throw new Error('kit: no held read to finish');
    finish(row);
  }

  set(appId: string, key: string, value: Json, version: number): void {
    this.rows.set(storeKey(appId, key), { value, version });
  }

  remove(appId: string, key: string): void {
    this.rows.delete(storeKey(appId, key));
  }

  readsOf(appId: string, key: string): number {
    return this.reads.get(storeKey(appId, key)) ?? 0;
  }

  minSupportedVersionsByChannel(): Promise<ReadonlyMap<string, string | null>> {
    return Promise.resolve(new Map());
  }

  configItem(appId: string, key: string): Promise<ContentConfig | null> {
    const id = storeKey(appId, key);
    this.reads.set(id, (this.reads.get(id) ?? 0) + 1);
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.holdNext) {
      this.holdNext = false;
      return new Promise((resolve) => {
        this.held.push(resolve);
      });
    }
    const row = this.rows.get(id);
    return Promise.resolve(
      row === undefined ? null : { value: structuredClone(row.value), version: row.version },
    );
  }
}

function storeKey(appId: string, key: string): string {
  return JSON.stringify([appId, key]);
}

/** Lets pending microtasks and the reader's deferred load run (real event loop, no fake timers). */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
