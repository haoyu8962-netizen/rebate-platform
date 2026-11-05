import { expect, it, vi } from 'vitest';
import type { AuditInput } from '../../platform/index.ts';
import { CatalogError } from '../domain/rules.ts';
import {
  PoolAdmin,
  PoolConflictError,
  PoolFieldsError,
  PoolNotFoundError,
  type PoolAdminStore,
  type PoolAdminTx,
  type PoolItemRow,
  type PoolRow,
} from './pool-admin.ts';
import type { PoolProduct, PoolSource } from './pool-source.ts';

const NOW = new Date('2026-10-31T02:00:00.000Z');
const POOL_ID = '0199f105-aaaa-7000-8000-000000000001';
const ACTOR = { appId: 'app', adminId: 'admin', ip: null };
const POOL: PoolRow = {
  app_id: 'app',
  pool_id: POOL_ID,
  name: '池',
  status: 'active',
  revision: 3n,
  created_by: 'admin',
  created_at: NOW,
  updated_at: NOW,
};
const ITEM: PoolItemRow = {
  app_id: 'app',
  pool_id: POOL_ID,
  product_key: 'tb:K1',
  platform: 'taobao',
  raw_item_id: 'raw',
  title: '商品',
  image: null,
  price_fen: 8800n,
  coupon_fen: 800n,
  final_price_fen: 8000n,
  commission_rate_bp: 1500,
  shop_name: null,
  quoted_at: NOW,
  status: 'online',
  sort: 1,
  start_at: null,
  end_at: null,
  invalid_reason: null,
  created_by: 'creator',
  created_at: NOW,
  updated_at: NOW,
};
const LIVE: PoolProduct = {
  kind: 'live',
  productKey: 'tb:K1',
  platform: 'taobao',
  rawItemId: 'fresh',
  item: {
    platform: 'taobao',
    item_id: 'fresh',
    title: '新标题',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 100n,
    quoted_at: NOW.toISOString(),
  },
};
const OFF: PoolProduct = { kind: 'off_shelf', productKey: 'tb:K1' };
const EXPIRED: PoolProduct = {
  kind: 'not_passed',
  productKey: 'tb:K1',
  failure: 'ref_expired',
  refusal: new CatalogError(30143, 'expired'),
};
const ANOMALY: PoolProduct = {
  kind: 'not_passed',
  productKey: 'tb:K1',
  failure: 'price_anomaly',
  refusal: new CatalogError(50401, 'flagged'),
};

function harness(item: PoolItemRow | null, product: PoolProduct = LIVE) {
  const audits: AuditInput[] = [];
  const takeOffline = vi.fn(() => Promise.resolve());
  const registerProductRef = vi.fn(() => Promise.resolve());
  let insertLoses = false;
  const tx: PoolAdminTx = {
    insertPool: () => Promise.resolve(true),
    lockPool: () => Promise.resolve(POOL),
    updatePool: (row) => Promise.resolve(row),
    lockItem: vi.fn(() => Promise.resolve(item)),
    insertItem: (row) =>
      Promise.resolve(insertLoses ? null : ({ ...ITEM, ...row, quoted_at: NOW } as PoolItemRow)),
    updateItem: (row) => Promise.resolve({ ...ITEM, ...row, quoted_at: NOW } as PoolItemRow),
    deleteItem: () => Promise.resolve(item),
    takeOffline,
    registerProductRef,
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
  };
  const store: PoolAdminStore = {
    pools: () => Promise.resolve({ rows: [POOL], total: 1 }),
    pool: () => Promise.resolve(POOL),
    items: () => Promise.resolve({ rows: [ITEM], total: 1 }),
    item: () => Promise.resolve(item),
    transaction: (work) => work(tx) as never,
  };
  const source: PoolSource = {
    fromLink: () => Promise.resolve(product),
    fromItemRef: () => Promise.resolve(product),
    recheck: vi.fn(() => Promise.resolve(product)),
    current: () => Promise.resolve(product),
  };
  const dropDetailCache = vi.fn(() => Promise.resolve());
  const admin = new PoolAdmin({
    store,
    source,
    clock: { now: () => NOW },
    candidates: () => Promise.resolve({ items: [], next_cursor: null }),
    dropDetailCache,
  });
  return {
    admin,
    audits,
    takeOffline,
    registerProductRef,
    source,
    tx,
    dropDetailCache,
    loseInsert: () => {
      insertLoses = true;
    },
  };
}
const add = { link_text: 'x', sort: 9, start_at: null, end_at: null };

it('[AC-B1-05q-unit#10] 新建池校验 pool_id 与去空白后的 name', async () => {
  const { admin } = harness(null);
  await expect(admin.createPool(ACTOR, { pool_id: 'x', name: '池' })).rejects.toEqual(
    new PoolFieldsError(['pool_id']),
  );
  await expect(admin.createPool(ACTOR, { pool_id: POOL_ID, name: '  ' })).rejects.toMatchObject({
    fields: ['name'],
  });
  expect(await admin.createPool(ACTOR, { pool_id: POOL_ID, name: ' 池 ' })).toMatchObject({
    name: '池',
    status: 'active',
    revision: 0,
  });
});

it('[AC-B1-05q-unit#11] 改池 CAS：不符 → 冲突，相符 revision 加一', async () => {
  const { admin, audits } = harness(null);
  await expect(
    admin.updatePool(ACTOR, POOL_ID, { name: '新', expected_revision: 2 }),
  ).rejects.toBeInstanceOf(PoolConflictError);
  expect(audits).toEqual([]);
  expect(
    await admin.updatePool(ACTOR, POOL_ID, { status: 'disabled', expected_revision: 3 }),
  ).toMatchObject({ status: 'disabled', revision: 4 });
  expect(audits).toHaveLength(1);
});

it('[AC-B1-05q-unit#12] 非规范写法的 pool_id → 未找到，不进存储', async () => {
  const { admin } = harness(ITEM);
  await expect(admin.getPool('app', POOL_ID.toUpperCase())).rejects.toBeInstanceOf(
    PoolNotFoundError,
  );
  await expect(admin.removeItem(ACTOR, 'x', 'tb:K1')).rejects.toBeInstanceOf(PoolNotFoundError);
});

it('[AC-B1-05q-unit#13] 窗口不成立 → fields=[end_at]，联盟不被问', async () => {
  const { admin, source } = harness(null);
  const fromLink = vi.spyOn(source, 'fromLink');
  await expect(
    admin.addItem(ACTOR, POOL_ID, {
      ...add,
      start_at: '2026-11-01T00:00:00Z',
      end_at: '2026-11-01T00:00:00Z',
    }),
  ).rejects.toMatchObject({ fields: ['end_at'] });
  expect(fromLink).not.toHaveBeenCalled();
});

it('[AC-B1-05q-unit#14] 新 key 下架 → 30141，别的池下架、缓存删除、无审计', async () => {
  const { admin, audits, takeOffline, dropDetailCache } = harness(null, OFF);
  await expect(admin.addItem(ACTOR, POOL_ID, add)).rejects.toMatchObject({ code: 30141 });
  expect(takeOffline).toHaveBeenCalledWith('app', 'tb:K1', '联盟返回下架', NOW);
  expect(dropDetailCache).toHaveBeenCalledWith('app', 'tb:K1');
  expect(audits).toEqual([]);
});

it('[AC-B1-05q-unit#15] 重复入库下架：覆盖生效，价格、创建人不动，带原因', async () => {
  const { admin, audits } = harness(ITEM, OFF);
  expect(await admin.addItem(ACTOR, POOL_ID, add)).toMatchObject({
    sort: 9,
    status: 'offline',
    invalid_reason: '联盟返回下架',
    price_fen: 8800,
    created_by: 'creator',
  });
  expect(audits[0]).toMatchObject({ action: 'pool_item_add', before: { sort: 1 } });
});

it('[AC-B1-05q-unit#16] 重复入库通过：刷新价格与原串、清原因', async () => {
  const offline = { ...ITEM, status: 'offline', invalid_reason: '旧原因' };
  const { admin, registerProductRef } = harness(offline);
  expect(await admin.addItem(ACTOR, POOL_ID, add)).toMatchObject({
    status: 'online',
    invalid_reason: null,
    price_fen: 3990,
    title: '新标题',
    created_by: 'creator',
  });
  expect(registerProductRef).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05q-unit#17] 并发入库输掉唯一键：转为覆盖，审计带 before', async () => {
  const { admin, audits, tx, loseInsert } = harness(null);
  loseInsert();
  vi.mocked(tx.lockItem).mockResolvedValueOnce(null).mockResolvedValueOnce(ITEM);
  await admin.addItem(ACTOR, POOL_ID, add);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.before).not.toBeNull();
});

it('[AC-B1-05q-unit#18] 手动下架不复核不写原因；已 online 传 online 不复核', async () => {
  const { admin, source } = harness(ITEM);
  expect(await admin.updateItem(ACTOR, POOL_ID, 'tb:K1', { status: 'offline' })).toMatchObject({
    status: 'offline',
    invalid_reason: null,
  });
  expect(await admin.updateItem(ACTOR, POOL_ID, 'tb:K1', { status: 'online' })).toMatchObject({
    status: 'online',
  });
  expect(source.recheck).not.toHaveBeenCalled();
});

it('[AC-B1-05q-unit#19] 重新上架引用失效：仍 offline 带原因，不下架别的池', async () => {
  const offline = { ...ITEM, status: 'offline' };
  const { admin, takeOffline } = harness(offline, EXPIRED);
  expect(await admin.updateItem(ACTOR, POOL_ID, 'tb:K1', { status: 'online' })).toMatchObject({
    status: 'offline',
    invalid_reason: '商品信息已失效，请重新搜索',
  });
  expect(takeOffline).not.toHaveBeenCalled();
});

it('[AC-B1-05q-unit#27] 重新上架异常价：仍 offline 带原因，价格不动，不写引用', async () => {
  const offline = { ...ITEM, status: 'offline' };
  const { admin, registerProductRef, takeOffline } = harness(offline, ANOMALY);
  expect(await admin.updateItem(ACTOR, POOL_ID, 'tb:K1', { status: 'online' })).toMatchObject({
    status: 'offline',
    invalid_reason: '联盟返回的价格异常',
    price_fen: 8800,
  });
  expect(takeOffline).not.toHaveBeenCalled();
  expect(registerProductRef).not.toHaveBeenCalled();
});

it.each([
  ['引用失效', EXPIRED, '商品信息已失效，请重新搜索'],
  ['异常价', ANOMALY, '联盟返回的价格异常'],
])('[AC-B1-05q-unit#28] 重复入库%s：覆盖生效，只动这一行，价格不动', async (_, product, reason) => {
  const { admin, audits, takeOffline, registerProductRef, dropDetailCache } = harness(
    ITEM,
    product,
  );
  expect(await admin.addItem(ACTOR, POOL_ID, add)).toMatchObject({
    sort: 9,
    status: 'offline',
    invalid_reason: reason,
    price_fen: 8800,
    created_by: 'creator',
  });
  expect(audits).toHaveLength(1);
  expect(takeOffline).not.toHaveBeenCalled();
  expect(registerProductRef).not.toHaveBeenCalled();
  expect(dropDetailCache).not.toHaveBeenCalled();
});

it.each([
  ['引用失效', EXPIRED, 30143],
  ['异常价', ANOMALY, 50401],
])('[AC-B1-05q-unit#29] 新 key %s：按来源的码拒绝，什么都不写', async (_, product, code) => {
  const { admin, audits, tx, takeOffline } = harness(null, product);
  const insertItem = vi.spyOn(tx, 'insertItem');
  await expect(admin.addItem(ACTOR, POOL_ID, add)).rejects.toMatchObject({ code });
  expect(insertItem).not.toHaveBeenCalled();
  expect(takeOffline).not.toHaveBeenCalled();
  expect(audits).toEqual([]);
});

it.each([
  { label: '有店铺名原样写入', item: { ...LIVE.item, shop_name: '合成店' }, expected: '合成店' },
  { label: '无店铺名写 null', item: LIVE.item, expected: null },
])('[AC-B1-05zd-unit#3] 新 key 加池：$label', async ({ item, expected }) => {
  const { admin, tx } = harness(null, { ...LIVE, item } as PoolProduct);
  const insertItem = vi.spyOn(tx, 'insertItem');
  await admin.addItem(ACTOR, POOL_ID, add);
  expect(insertItem.mock.calls[0]?.[0]).toMatchObject({ shop_name: expected });
});

it.each([
  {
    label: '新店名覆盖',
    product: { ...LIVE, item: { ...LIVE.item, shop_name: '新店' } },
    expected: '新店',
  },
  { label: '最新详情无店名 → null', product: LIVE, expected: null },
  { label: '引用失效不动店名', product: EXPIRED, expected: '旧店' },
  { label: '异常价不动店名', product: ANOMALY, expected: '旧店' },
])('[AC-B1-05zd-unit#4] 重复加池：$label', async ({ product, expected }) => {
  const { admin, tx } = harness({ ...ITEM, shop_name: '旧店' }, product as PoolProduct);
  const updateItem = vi.spyOn(tx, 'updateItem');
  await admin.addItem(ACTOR, POOL_ID, add);
  expect(updateItem.mock.calls[0]?.[0]).toMatchObject({ shop_name: expected });
});

it('[AC-B1-05q-unit#20] 审计快照不含原串', async () => {
  const { admin, audits } = harness(ITEM);
  await admin.removeItem(ACTOR, POOL_ID, 'tb:K1');
  expect(audits[0]).toMatchObject({ action: 'pool_item_remove', after: null });
  expect(JSON.stringify(audits[0]?.before)).not.toContain('raw');
});
