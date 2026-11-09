// B1-05zo: adminAddPoolItem judges the category on this call's union answer, only when it carries
// the product's details (live, price_status=anomaly included): a hit → 30147, nothing written, and
// before the price check. An answer without details keeps the existing outcomes.
import { expect, it } from 'vitest';
import {
  addLink,
  addRef,
  bounds,
  foreignItem,
  itemRow,
  linkOf,
  member,
  OFF_SHELF_REASON,
  pick,
  rejected,
  searchAnswers,
  seedItem,
  seedPool,
  send,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  union,
  useHarness,
} from '../product-pool-admin/kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  anomalous,
  BLOCKED,
  BLOCKED_EVENT,
  blockRule,
  categoryBlocked,
  expectPoolAlert,
  goods,
  KEYWORD,
  MISSING_EVENT,
  OPEN,
  poolAlerts,
} from './fixtures.ts';

const h = useHarness();

const offShelf = () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
const refused = () => new UnionError('upstream_rejected', 'synthetic refusal', 'taobao');

it.each(['link_text', 'item_ref'] as const)(
  '[AC-B1-05zo#1] %s 新 key、联盟详情 live 且类目命中本 App 本平台 active 规则 → 422 30147，什么都不写，同键别的池条目不下架、别的 App 的不动，warn catalog_category_blocked（pool_admin:）',
  async (source) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const item = goods(f, stable, BLOCKED);
    // The pick happens before the rule exists: the candidates filter is not what this case tests.
    const ref = source === 'item_ref' ? (await pick(f, item)).item_ref : null;
    const key = `tb:${stable}`;
    await blockRule(h, f, { category: BLOCKED });
    const elsewhere = await seedPool(h, f);
    await seedItem(h, f, elsewhere, key, { sort: 5 });
    const foreign = await foreignItem(h, f, key);
    stubProduct(item);
    union.getItem.mockClear();
    const before = await snapshot(h, f.appId);
    const mark = f.lines.length;
    const sent =
      ref === null ? await addLink(f, pool, linkOf(item.item_id!)) : await addRef(f, pool, ref);
    await categoryBlocked(sent);
    expect(union.getItem).toHaveBeenCalled();
    expect(await itemRow(h, f, pool, key)).toBeUndefined();
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(await itemRow(h, foreign.app, foreign.pool, key)).toEqual(foreign.row);
    expectPoolAlert(f.lines.slice(mark), BLOCKED_EVENT, [item.title, stable, f.actor.id]);
  },
);

it.each(['online', 'offline'] as const)(
  '[AC-B1-05zo#2] 已在池的键（%s）再入库且类目命中 → 30147：原行一字不变（不覆盖三项、不回 online），同键别的池条目不动，不写审计',
  async (status) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const key = `tb:${stable}`;
    const item = goods(f, stable, BLOCKED);
    await seedItem(h, f, pool, key, {
      sort: 1,
      status,
      invalid_reason: status === 'offline' ? OFF_SHELF_REASON : null,
    });
    const elsewhere = await seedPool(h, f);
    await seedItem(h, f, elsewhere, key, { sort: 5 });
    await blockRule(h, f, { category: BLOCKED });
    f.clock.advanceMs(60_000);
    stubProduct({ ...item, final_price_fen: 2000n, quoted_at: f.clock.now().toISOString() });
    const before = await snapshot(h, f.appId);
    await categoryBlocked(await addLink(f, pool, linkOf(item.item_id!), bounds(9)));
    expect(union.getItem).toHaveBeenCalled();
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(['link_text', 'item_ref'] as const)(
  '[AC-B1-05zo#3] %s 联盟详情 price_status=anomaly 且类目命中 → 30147（先于 50401）：新 key 什么都不写；已在池的键也 30147，不走覆盖下架，原行一字不变',
  async (source) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const key = `tb:${stable}`;
    const item = goods(f, stable, BLOCKED);
    const ref = source === 'item_ref' ? (await pick(f, item)).item_ref : null;
    await blockRule(h, f, { category: BLOCKED });
    const elsewhere = await seedPool(h, f);
    await seedItem(h, f, elsewhere, key, { sort: 5 });
    stubProduct(anomalous(f, item));
    const add = (target: string) =>
      ref === null
        ? addLink(f, target, linkOf(item.item_id!), bounds(7))
        : addRef(f, target, ref, bounds(7));
    const before = await snapshot(h, f.appId);
    await categoryBlocked(await add(pool));
    expect(await itemRow(h, f, pool, key)).toBeUndefined();
    expect(await snapshot(h, f.appId)).toEqual(before);
    // The same key is in `elsewhere`: no overwrite, no offline with the anomaly reason.
    await categoryBlocked(await add(elsewhere));
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each([
  { name: '缺省', category: null },
  { name: '空串', category: '' },
] as const)(
  '[AC-B1-05zo#4] live 无类目（$name）：带关键词的规则命中标题 → 30147，什么都不写，warn catalog_category_blocked（pool_admin:，只带平台与计数）',
  async ({ category }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const item = goods(f, stable, category, { title: `合成商品 ${KEYWORD} ${stable}` });
    // Any category id: an item without one is judged by the keyword of every rule of its platform.
    await blockRule(h, f, { category: OPEN, keyword: KEYWORD });
    stubProduct(item);
    const before = await snapshot(h, f.appId);
    const mark = f.lines.length;
    await categoryBlocked(await addLink(f, pool, linkOf(item.item_id!)));
    expect(await snapshot(h, f.appId)).toEqual(before);
    expectPoolAlert(f.lines.slice(mark), BLOCKED_EVENT, [item.title, stable, f.actor.id]);
  },
);

it.each([
  { name: '缺省', category: null },
  { name: '空串', category: '' },
] as const)(
  '[AC-B1-05zo#5] live 无类目（$name）且标题不含任何关键词 → 放行入池 online，纯类目规则不拦；warn catalog_category_missing（pool_admin:，只带平台与计数，不带标题、键、操作者），不记 catalog_category_blocked',
  async ({ category }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const item = goods(f, stable, category);
    await blockRule(h, f, { category: BLOCKED });
    await blockRule(h, f, { category: BLOCKED, keyword: KEYWORD });
    stubProduct(item);
    const mark = f.lines.length;
    expect(await success(await addLink(f, pool, linkOf(item.item_id!)))).toMatchObject({
      product_key: `tb:${stable}`,
      status: 'online',
    });
    const lines = f.lines.slice(mark);
    expectPoolAlert(lines, MISSING_EVENT, [item.title, stable, f.actor.id]);
    expect(poolAlerts(lines, BLOCKED_EVENT)).toEqual([]);
  },
);

it('[AC-B1-05zo#6] 联盟答复不带商品详情照既有口径，即使类目在名单里：下架 → 30141 并下架同键别的池、已在池的键 200 offline 带原因、失效 → 30143、答不了 → 50401；同一名单下 live 命中才是 30147', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const expired = goods(f, stableId(), BLOCKED);
  const expiredRef = await pick(f, expired);
  await blockRule(h, f, { category: BLOCKED });

  // 下架，新 key：30141，本 App 别的池里同键的条目下架带原因。
  const goneStable = stableId();
  const gone = goods(f, goneStable, BLOCKED);
  const goneKey = `tb:${goneStable}`;
  const elsewhere = await seedPool(h, f);
  await seedItem(h, f, elsewhere, goneKey, { sort: 5 });
  stubProduct(gone);
  union.getItem.mockRejectedValue(offShelf());
  await rejected(await addLink(f, pool, linkOf(gone.item_id!)), 30141);
  expect(await itemRow(h, f, pool, goneKey)).toBeUndefined();
  expect(await itemRow(h, f, elsewhere, goneKey)).toMatchObject({
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
  });
  // 下架，已在池的键：覆盖照样生效，200 offline 带原因。
  const repeated = await success(await addLink(f, elsewhere, linkOf(gone.item_id!), bounds(7)));
  expect(repeated).toMatchObject({
    product_key: goneKey,
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
    sort: 7,
  });

  // 失效：新鲜 item_ref 的原串被联盟拒绝 → 30143，什么都不写。
  f.clock.advanceMs(60_000);
  searchAnswers([[]]);
  union.getItem.mockRejectedValue(refused());
  const beforeExpired = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, expiredRef.item_ref), 30143);
  expect(await snapshot(h, f.appId)).toEqual(beforeExpired);

  // 答不了 → 50401，什么都不写。
  const down = goods(f, stableId(), BLOCKED);
  stubProduct(down);
  union.getItem.mockRejectedValue(outage());
  const beforeDown = await snapshot(h, f.appId);
  await rejected(await addLink(f, pool, linkOf(down.item_id!)), 50401);
  expect(await snapshot(h, f.appId)).toEqual(beforeDown);

  // 同一名单下联盟带详情答复：30147。
  const live = goods(f, stableId(), BLOCKED);
  stubProduct(live);
  const beforeLive = await snapshot(h, f.appId);
  await categoryBlocked(await addLink(f, pool, linkOf(live.item_id!)));
  expect(await snapshot(h, f.appId)).toEqual(beforeLive);
});

it('[AC-B1-05zo#7] 参数与权限类先于联盟答复：命中名单的商品，未知池 → 30701、无 content.pool → 10403、缺 sort → 20001，均不问联盟、不写入；同一商品正常提交才是 30147', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const item = goods(f, stableId(), BLOCKED);
  await blockRule(h, f, { category: BLOCKED });
  stubProduct(item);
  const link = linkOf(item.item_id!);
  const outsider = await member(h, f, []);
  const before = await snapshot(h, f.appId);
  await rejected(await addLink(f, '0199f105-bbbb-7000-8000-000000000001', link), 30701);
  await rejected(
    await send(f, 'addItem', { pool }, { link_text: link, ...bounds() }, { token: outsider.token }),
    10403,
  );
  await rejected(
    await send(f, 'addItem', { pool }, { link_text: link, start_at: null, end_at: null }),
    20001,
  );
  expect(union.getItem).not.toHaveBeenCalled();
  expect(await snapshot(h, f.appId)).toEqual(before);
  await categoryBlocked(await addLink(f, pool, link));
  expect(await snapshot(h, f.appId)).toEqual(before);
});
