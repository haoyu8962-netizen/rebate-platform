// B1-05r: the detail's pool price (BR-PRICE-11, BR-PROD-07, TRADE-12). A dependency failure of the
// union with no usable cache reads the pool before it answers 50401: the app's online row of the key
// with age ≤ pool.max_age_sec and a commission rate, always stale=true, quoted_at the row's. Only a
// dependency failure falls back: off shelf (30141) and a refused raw ID (30143) keep their answers.
// getProduct over the detail kit's fakes and the real pool tables; the raw-ID steps before the union
// call are the detail's own and unchanged.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { markStaleDetail } from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { PriceSnapshotRecorder } from '../../../../apps/api/src/modules/catalog/price-history/types.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { PRODUCT_KEY, item } from '../detail/kit.ts';
import { rejection } from '../hot-rank/kit.ts';
import {
  ADDED_SEC,
  MAX_AGE_KEY,
  MAX_AGE_SEC,
  TIMEOUT,
  detailCase,
  expectExpiredRaw,
  newPoolId,
  secondsAgo,
  tenant,
  usePoolDatabase,
} from './kit.ts';

const h = usePoolDatabase(createTestDatabase);

const outage = (): UnionError =>
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');

/** Two prices apart from each other and from the detail kit's union item. */
const OLDER_PRICE = { price_fen: 5000n, coupon_fen: 500n, final_price_fen: 4500n };
const NEWER_PRICE = { price_fen: 6000n, coupon_fen: 600n, final_price_fen: 5400n };
/** The tapped card's link; the detail kit's entrySource reads it, the id itself is opaque here. */
const SOURCE_LINK = 'synthetic-source-link';

it.each([
  { label: 'UnionError upstream_unavailable', error: outage() },
  {
    label: 'UnionError rate_limited',
    error: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  },
  {
    label: 'GovernanceError timeout',
    error: new GovernanceError('timeout', 'union:taobao:online', 'synthetic slow'),
  },
  {
    label: 'GovernanceError circuit_open',
    error: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic open'),
  },
  {
    label: 'GovernanceError quota_exceeded',
    error: new GovernanceError('quota_exceeded', 'union:taobao:online', 'synthetic quota'),
  },
])(
  '[BR-PRICE-11][TRADE-12] 联盟依赖失败（$label）→ 用商品池价：stale=true，quoted_at 与 age_sec 取池里的行，报价和链接用池里的佣金率',
  async ({ error }) => {
    const f = await detailCase(h);
    const quotedAt = secondsAgo(f.clock, 2160);
    await f.item(await f.pool(), { quoted_at: quotedAt, commission_rate_bp: 350 });
    f.detail.mockRejectedValue(error);

    const card = await f.run();

    expect(card).toMatchObject({
      product_key: PRODUCT_KEY,
      price_fen: 8800,
      coupon_fen: 800,
      final_price_fen: 8000,
      stale: true,
      age_sec: 2160,
      availability: 'ok',
    });
    expect(Date.parse(card.quoted_at!)).toBe(quotedAt.getTime());
    expect(f.quote.mock.calls.map(([quoted]) => quoted.commission_rate_bp)).toEqual([350n]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.linkId).toBe(card.link_id);
    expect(f.rows[0]?.item.final_price_fen).toBe(8000n);
  },
  TIMEOUT,
);

// BR-PRICE-07 来源判定表, as the detail's own case [AC-B1-05e#8]: feed quotes normal, so the link's
// source is what tells feed from `detail`. B1-05zc: the base table's search row is the case below.
it.each([{ source: 'feed', basis: 'normal', min: 269 }])(
  '[BR-PRICE-07][TRADE-12] 回退出卡沿用来源卡：from_link_id 的入口是 $source → rebate_basis=$basis，链接记 $source',
  async ({ source, basis, min }) => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockRejectedValue(outage());
    f.entrySource.mockResolvedValue(source);

    const card = await f.run({ from_link_id: SOURCE_LINK });

    expect(card).toMatchObject({
      stale: true,
      rebate_basis: basis,
      rebate_min_fen: min,
      rebate_max_fen: 269,
    });
    expect(f.entrySource).toHaveBeenCalledWith(f.owner.appId, SOURCE_LINK);
    expect(f.rows.map((row) => row.entrySource)).toEqual([source]);
  },
  TIMEOUT,
);

// B1-05zc (D10-641, BR-PRICE-07 2026-11-05): entry_source no longer decides a compare risk. A search
// source card's fallback quotes one amount on the normal basis (the old range was 135–269); only the
// link's registered source tells it apart from feed.
it(
  '[BR-PRICE-07][TRADE-12] 回退出卡沿用来源卡：from_link_id 的入口是 search → rebate_basis=normal 单值，链接记 search',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockRejectedValue(outage());
    f.entrySource.mockResolvedValue('search');

    const card = await f.run({ from_link_id: SOURCE_LINK });

    expect(card).toMatchObject({
      stale: true,
      rebate_basis: 'normal',
      rebate_min_fen: 269,
      rebate_max_fen: 269,
    });
    expect(f.entrySource).toHaveBeenCalledWith(f.owner.appId, SOURCE_LINK);
    expect(f.rows.map((row) => row.entrySource)).toEqual(['search']);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-07][TRADE-12] 没有来源卡的回退按详情入口：rebate_basis=normal 单值，链接记 detail',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockRejectedValue(outage());

    const card = await f.run();

    // B1-05zc (D10-641): one amount, no compare range.
    expect(card).toMatchObject({
      stale: true,
      rebate_basis: 'normal',
      rebate_min_fen: 269,
      rebate_max_fen: 269,
    });
    expect(f.rows.map((row) => row.entrySource)).toEqual(['detail']);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05][BR-PROD-11] 刷新只动 quoted_at、不动原串：入池多日、10 分钟前刚刷新的行，卡片 quoted_at 是刷新时刻，item_ref 和链接带的取得时刻仍过期',
  async () => {
    const f = await detailCase(h);
    const quotedAt = secondsAgo(f.clock, 600);
    await f.item(await f.pool(), {
      created_at: secondsAgo(f.clock, ADDED_SEC),
      quoted_at: quotedAt,
    });
    f.detail.mockRejectedValue(outage());

    const card = await f.run();

    expect(Date.parse(card.quoted_at!)).toBe(quotedAt.getTime());
    const token = f.itemRefs.read(card.item_ref!, f.owner.appId);
    expect(token).toMatchObject({ productKey: PRODUCT_KEY });
    expectExpiredRaw(f.clock, token!.fetchedAt);
    expectExpiredRaw(f.clock, f.rows[0]!.ref.rawFetchedAt);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 商品池也没有合格的行 → 50401，不出卡、不登记',
  async () => {
    const f = await detailCase(h);
    f.detail.mockRejectedValue(outage());

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] age 正好 pool.max_age_sec 还能用，多一毫秒、多一秒都 → 50401；未配置按 7200',
  async () => {
    const f = await detailCase(h);
    const pool = await f.pool();
    await f.item(pool, { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC) });
    f.detail.mockRejectedValue(outage());

    expect(await f.run()).toMatchObject({ stale: true, age_sec: MAX_AGE_SEC });

    f.clock.advanceMs(1);
    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    f.clock.advanceMs(999);
    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] pool.max_age_sec 取配置：调成 100 后 101 秒的行 → 50401',
  async () => {
    const f = await detailCase(h);
    f.settings.set(MAX_AGE_KEY, 100);
    await f.item(await f.pool(), { quoted_at: secondsAgo(f.clock, 101) });
    f.detail.mockRejectedValue(outage());

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11][B1-05u] commission_rate_bp 为 NULL 的行不能用 → 50401，佣金率为 0 的行能用',
  async () => {
    const f = await detailCase(h);
    const pool = await f.pool();
    await f.item(pool, { commission_rate_bp: null });
    f.detail.mockRejectedValue(outage());
    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    await h.db
      .updateTable('pool_items')
      .set({ commission_rate_bp: 0 })
      .where('app_id', '=', f.owner.appId)
      .where('pool_id', '=', pool)
      .execute();
    expect(await f.run()).toMatchObject({ stale: true });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 只取 online 的行：下线的行 → 50401',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool(), { status: 'offline', invalid_reason: '联盟返回下架' });
    f.detail.mockRejectedValue(outage());

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 只取本 App 的行：别的 App 有同 key 的行 → 50401',
  async () => {
    const f = await detailCase(h);
    const other = await tenant(h.db);
    await f.item(await f.pool(other), {}, other);
    f.detail.mockRejectedValue(outage());

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
  },
  TIMEOUT,
);

it(
  '[TRADE-12] 多个池都有这个 key：取 quoted_at 最新的一行',
  async () => {
    const f = await detailCase(h);
    const newerAt = secondsAgo(f.clock, 300);
    await f.item(await f.pool(), { ...OLDER_PRICE, quoted_at: secondsAgo(f.clock, 900) });
    await f.item(await f.pool(), { ...NEWER_PRICE, quoted_at: newerAt });
    await f.item(await f.pool(), { ...OLDER_PRICE, quoted_at: secondsAgo(f.clock, 600) });
    f.detail.mockRejectedValue(outage());

    const card = await f.run();

    expect(card).toMatchObject({ final_price_fen: 5400, stale: true });
    expect(Date.parse(card.quoted_at!)).toBe(newerAt.getTime());
  },
  TIMEOUT,
);

it(
  '[TRADE-12] quoted_at 相同时按 pool_id 升序取第一行',
  async () => {
    const f = await detailCase(h);
    const [low, high] = [newPoolId(), newPoolId()].sort() as [string, string];
    const quotedAt = secondsAgo(f.clock, 300);
    await f.pool(f.owner, { pool_id: high });
    await f.pool(f.owner, { pool_id: low });
    await f.item(high, { ...OLDER_PRICE, quoted_at: quotedAt });
    await f.item(low, { ...NEWER_PRICE, quoted_at: quotedAt });
    f.detail.mockRejectedValue(outage());

    expect(await f.run()).toMatchObject({ final_price_fen: 5400 });
  },
  TIMEOUT,
);

it(
  '[TRADE-12] 更新的行不合格时取次新的合格行：佣金率空的、下线的都跳过',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool(), {
      ...NEWER_PRICE,
      quoted_at: secondsAgo(f.clock, 100),
      commission_rate_bp: null,
    });
    await f.item(await f.pool(), {
      ...NEWER_PRICE,
      quoted_at: secondsAgo(f.clock, 200),
      status: 'offline',
    });
    await f.item(await f.pool(), { ...OLDER_PRICE, quoted_at: secondsAgo(f.clock, 300) });
    f.detail.mockRejectedValue(outage());

    expect(await f.run()).toMatchObject({ final_price_fen: 4500 });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 池里的价格异常走主动查询口径：不出卡、不登记，50303，不改答 50401',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool(), { price_fen: 1000n, coupon_fen: 100n, final_price_fen: 800n });
    f.detail.mockRejectedValue(outage());

    expect(await rejection(() => f.run())).toMatchObject({ code: 50303 });
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  {
    label: '联盟明确下架',
    error: new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
    code: 30141,
  },
  {
    label: '演示下架',
    error: new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
    code: 30141,
  },
  {
    label: '联盟拒绝原串',
    error: new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
    code: 30143,
  },
  {
    label: '请求不合法',
    error: new UnionError('invalid_dto', 'synthetic invalid', 'taobao'),
    code: 30143,
  },
  {
    label: '链接认不出',
    error: new UnionError('link_unrecognized', 'synthetic unknown link', 'taobao'),
    code: 30143,
  },
])(
  '[BR-PROD-05] $label 不是依赖失败，不读商品池 → $code，不出卡',
  async ({ error, code }) => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code });
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] 联盟答了别的商品是引用失效 → 30143，不读商品池',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockResolvedValue(item({ item_id: 'synthetic-other' }));

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 联盟正常时不用池价：stale=false，价格取联盟的答复',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool());

    expect(await f.run()).toMatchObject({ stale: false, final_price_fen: 2990 });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] 还有可用的旧缓存时用缓存：缓存层答了就不走商品池',
  async () => {
    const f = await detailCase(h);
    await f.item(await f.pool());
    f.detail.mockResolvedValue(markStaleDetail(item()));

    expect(await f.run()).toMatchObject({ stale: true, final_price_fen: 2990 });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05][BR-WATCH-19] 池价不是联盟答复：不写 product_refs，不进价格历史',
  async () => {
    const record = vi.fn();
    const f = await detailCase(h, {
      priceHistory: { record } as unknown as PriceSnapshotRecorder,
    });
    await f.item(await f.pool());
    f.detail.mockRejectedValue(outage());

    expect(await f.run()).toMatchObject({ stale: true });
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  },
  TIMEOUT,
);
