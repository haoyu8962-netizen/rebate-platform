// B1-05zo: adminUpdatePoolItem. Only the offline → online re-check asks the union, and only its
// answer with details is judged by category: a hit → 30147, the item stays offline unchanged and
// nothing else in the request applies. A PATCH that does not re-check never answers 30147.
import { expect, it } from 'vitest';
import {
  hoursFromNow,
  itemRow,
  OFF_SHELF_REASON,
  seedItem,
  seedPool,
  seedRef,
  send,
  setup,
  snapshot,
  stableId,
  success,
  union,
  useHarness,
  type Setup,
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

/** An offline item with a fresh product_refs row of the same raw ID; the clock moves on a second. */
async function shelved(f: Setup, reason: string | null = OFF_SHELF_REASON) {
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  await seedItem(h, f, pool, key, { status: 'offline', invalid_reason: reason, sort: 1 });
  await seedRef(h, f, key, { raw_item_id: `rawA-${stable}` });
  f.clock.advanceMs(1000);
  return { pool, stable, key };
}

it('[AC-B1-05zo#8] offline→online 复核：联盟详情 live 且类目命中 → 30147，条目保持 offline 一字不变，同请求的排序改动不生效，不写审计与 product_refs；复核下架的照旧 200 offline 带原因', async () => {
  const f = await setup(h);
  await blockRule(h, f, { category: BLOCKED });

  // 对照：联盟明确下架（不带详情）照既有口径。
  const gone = await shelved(f, null);
  union.getItem.mockRejectedValue(offShelf());
  const change = { status: 'online' };
  expect(
    await success(await send(f, 'updateItem', { pool: gone.pool, key: gone.key }, change)),
  ).toMatchObject({ status: 'offline', invalid_reason: OFF_SHELF_REASON });

  const { pool, stable, key } = await shelved(f);
  union.getItem.mockReset();
  union.getItem.mockResolvedValue(goods(f, stable, BLOCKED, { final_price_fen: 2000n }));
  const before = await snapshot(h, f.appId);
  await categoryBlocked(await send(f, 'updateItem', { pool, key }, { status: 'online', sort: 9 }));
  expect(union.getItem).toHaveBeenCalled();
  expect(await itemRow(h, f, pool, key)).toEqual(before.items.find((i) => i.pool_id === pool));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05zo#9] offline→online 复核：联盟详情 price_status=anomaly 且类目命中 → 30147（先于价格判定），条目一字不变，不改写原因', async () => {
  const f = await setup(h);
  await blockRule(h, f, { category: BLOCKED });
  const { pool, stable, key } = await shelved(f, null);
  union.getItem.mockResolvedValue(anomalous(f, goods(f, stable, BLOCKED)));
  const before = await snapshot(h, f.appId);
  await categoryBlocked(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05zo#10] 不经复核的 PATCH 不受名单影响：改排序、时间窗、手动下架照常 200 且不问联盟；同一条目 offline→online 复核时才 30147', async () => {
  const f = await setup(h);
  await blockRule(h, f, { category: BLOCKED });
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  await seedItem(h, f, pool, key, { sort: 1 });
  await seedRef(h, f, key, { raw_item_id: `rawA-${stable}` });
  union.getItem.mockResolvedValue(goods(f, stable, BLOCKED));
  expect(await success(await send(f, 'updateItem', { pool, key }, { sort: 3 }))).toMatchObject({
    sort: 3,
    status: 'online',
  });
  const window = { start_at: hoursFromNow(f, 1), end_at: hoursFromNow(f, 2) };
  expect(await success(await send(f, 'updateItem', { pool, key }, window))).toMatchObject({
    status: 'online',
  });
  expect(
    await success(await send(f, 'updateItem', { pool, key }, { status: 'offline' })),
  ).toMatchObject({ status: 'offline', invalid_reason: null });
  expect(union.getItem).not.toHaveBeenCalled();

  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  await categoryBlocked(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(await itemRow(h, f, pool, key)).toMatchObject({ status: 'offline', sort: 3 });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05zo#11] 复核 live 无类目：标题含规则关键词 → 30147 且条目不变，warn catalog_category_blocked（pool_admin:）；不含 → 回到 online，warn catalog_category_missing（pool_admin:），不带标题、键、操作者', async () => {
  const f = await setup(h);
  await blockRule(h, f, { category: OPEN, keyword: KEYWORD });
  await blockRule(h, f, { category: BLOCKED });

  const hit = await shelved(f);
  const hitItem = goods(f, hit.stable, null, { title: `合成商品 ${KEYWORD} ${hit.stable}` });
  union.getItem.mockResolvedValue(hitItem);
  const before = await snapshot(h, f.appId);
  const mark = f.lines.length;
  const change = { status: 'online' };
  await categoryBlocked(await send(f, 'updateItem', { pool: hit.pool, key: hit.key }, change));
  expect(await snapshot(h, f.appId)).toEqual(before);
  expectPoolAlert(f.lines.slice(mark), BLOCKED_EVENT, [hitItem.title, hit.stable, f.actor.id]);

  const pass = await shelved(f);
  const passItem = goods(f, pass.stable, null);
  union.getItem.mockResolvedValue(passItem);
  const passMark = f.lines.length;
  expect(
    await success(await send(f, 'updateItem', { pool: pass.pool, key: pass.key }, change)),
  ).toMatchObject({ status: 'online', invalid_reason: null });
  const lines = f.lines.slice(passMark);
  expectPoolAlert(lines, MISSING_EVENT, [passItem.title, pass.stable, f.actor.id]);
  expect(poolAlerts(lines, BLOCKED_EVENT)).toEqual([]);
});
