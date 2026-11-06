// B1-05zk 第 2 次 (spec-test r1 S1; D10-736 ⑦): the three detail switches are read when the card
// goes out, on a cache hit and on a stale entry alike. The cached entry keeps the union's values
// whatever the switches said when it was written: switches on at write and off at read give
// null / null / []; off at write and on at read give the union's values, without a union call on a
// hit. shop_logo has no switch and shop_entry stays false (S-17 not landed).
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { detailCache } from '../cache/kit.ts';
import {
  COUPON_SWITCH,
  ENTRY_SOURCE,
  ENTRY_SWITCH,
  SALES_SWITCH,
  SCORES_SWITCH,
  expected,
  extras,
  extrasItem,
  ownKeys,
} from './kit.ts';

const ALL_ON = { coupon: true, sales: true, scores: true } as const;
const ALL_OWN = [true, true, true, true, true];
const DETAIL_SWITCHES = [COUPON_SWITCH, SALES_SWITCH, SCORES_SWITCH] as const;

type Values = Map<string, string | number | boolean>;
type Mode = 'hit' | 'stale';

function setDetailSwitches(values: Values, on: boolean): void {
  for (const key of DETAIL_SWITCHES) values.set(key, on);
  values.set(ENTRY_SWITCH, true);
  values.set(ENTRY_SOURCE, 'dataoke');
}

/**
 * Caches the union detail under `write` switches, flips them to `read`, then reads the same entry
 * again: as a fresh hit (no union call) or, 301 s later with the union down, as a stale entry.
 */
async function cachedThenRead(
  mode: Mode,
  write: (values: Values) => void,
  read: (values: Values) => void,
) {
  const f = detailCache();
  if (mode === 'stale') f.values.set('search.cache.stale_max_age_s', 900);
  write(f.values);
  f.getItem.mockResolvedValue(extrasItem());
  const first = await f.get();
  read(f.values);
  if (mode === 'stale') {
    f.clock.advanceMs(301_000);
    f.getItem.mockRejectedValue(
      new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    );
  }
  const second = await f.get();
  return { f, first, second };
}

it.each([
  { name: '命中缓存', mode: 'hit' as const, calls: 1, stale: false },
  { name: '联盟故障用过期缓存（stale）', mode: 'stale' as const, calls: 2, stale: true },
])(
  '[AC-B1-05zk#19] 开关全开时进缓存、之后把三个详情开关关掉，$name 出卡 coupon_end_at null、sales_text null、shop_scores []，shop_logo 照存的值，shop_entry false',
  async ({ mode, calls, stale }) => {
    const { f, first, second } = await cachedThenRead(
      mode,
      (values) => setDetailSwitches(values, true),
      (values) => setDetailSwitches(values, false),
    );
    expect(extras(first)).toEqual(expected(ALL_ON));
    expect(f.getItem).toHaveBeenCalledTimes(calls);
    expect(second.stale).toBe(stale);
    expect(ownKeys(second)).toEqual(ALL_OWN);
    expect(extras(second)).toEqual(expected({}));
  },
);

it.each([
  { name: '命中缓存', mode: 'hit' as const, calls: 1, stale: false },
  { name: '联盟故障用过期缓存（stale）', mode: 'stale' as const, calls: 2, stale: true },
])(
  '[AC-B1-05zk#20] 开关显式为 false 时进缓存、之后三个详情开关打开，$name 出卡带联盟原值（缓存存的是原始联盟数据）',
  async ({ mode, calls, stale }) => {
    const { f, first, second } = await cachedThenRead(
      mode,
      (values) => setDetailSwitches(values, false),
      (values) => setDetailSwitches(values, true),
    );
    expect(extras(first)).toEqual(expected({}));
    expect(f.getItem).toHaveBeenCalledTimes(calls);
    expect(second.stale).toBe(stale);
    expect(ownKeys(second)).toEqual(ALL_OWN);
    expect(extras(second)).toEqual(expected(ALL_ON));
  },
);

it.each([
  { name: 'detail.coupon_end.enabled', key: COUPON_SWITCH, on: { coupon: true } },
  { name: 'detail.sales.enabled', key: SALES_SWITCH, on: { sales: true } },
  { name: 'detail.shop_scores.enabled', key: SCORES_SWITCH, on: { scores: true } },
])(
  '[AC-B1-05zk#21] 开关全关时进缓存，命中前只打开 $name.taobao：命中出卡只有它管的字段取存下的联盟原值，另两个仍置空',
  async ({ key, on }) => {
    const { f, second } = await cachedThenRead(
      'hit',
      (values) => setDetailSwitches(values, false),
      (values) => values.set(key, true),
    );
    expect(f.getItem).toHaveBeenCalledTimes(1);
    expect(ownKeys(second)).toEqual(ALL_OWN);
    expect(extras(second)).toEqual(expected(on));
  },
);

it.each([
  { name: 'detail.coupon_end.enabled', key: COUPON_SWITCH, on: { sales: true, scores: true } },
  { name: 'detail.sales.enabled', key: SALES_SWITCH, on: { coupon: true, scores: true } },
  { name: 'detail.shop_scores.enabled', key: SCORES_SWITCH, on: { coupon: true, sales: true } },
])(
  '[AC-B1-05zk#22] 开关全开时进缓存，过期后联盟故障前只关掉 $name.taobao：stale 出卡只有它管的字段置空，另两个照存的值',
  async ({ key, on }) => {
    const { second } = await cachedThenRead(
      'stale',
      (values) => setDetailSwitches(values, true),
      (values) => values.set(key, false),
    );
    expect(second.stale).toBe(true);
    expect(ownKeys(second)).toEqual(ALL_OWN);
    expect(extras(second)).toEqual(expected(on));
  },
);
