import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  addRef,
  itemRow,
  pick,
  product,
  seedPool,
  setup,
  stableId,
  stubProduct,
  success,
  useHarness,
} from '../product-pool-admin/kit.ts';
import { TIMEOUT } from '../product-pool-read/kit.ts';
import { requireShopName, storedShopName } from './kit.ts';

// Real candidate search -> item_ref -> adminAddPoolItem -> PoolAdmin -> PostgreSQL.
// Only normalized union DTOs are synthetic; no platform payloads or replacement pool writer.
const h = useHarness();
const IMAGE = 'https://img.synthetic.invalid/pool/shop-add.jpg';

const ADD_CASES: readonly {
  ac: number;
  label: string;
  fields: Pick<UnionItemDetail, 'shop_name'>;
  expected: string | null;
}[] = [
  {
    ac: 1,
    label: '有店铺名原样写入',
    fields: { shop_name: '合成甲店 · A＆B' },
    expected: '合成甲店 · A＆B',
  },
  { ac: 2, label: '无店铺名写 NULL，不借标题或 nick', fields: {}, expected: null },
];

it.each(ADD_CASES)(
  '[AC-B1-05zd#$ac] 候选条目加池：$label，价格与主图仍按候选详情保存',
  async ({ fields, expected }) => {
    await requireShopName(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const item = {
      ...product(f, stable, {
        title: '标题中的合成旗舰店不能代替店铺名',
        main_image_url: IMAGE,
        ...fields,
      }),
      nick: '合成卖家昵称不能代替店铺名',
      seller_nick: '另一个合成昵称',
    };
    const candidate = await pick(f, item);
    stubProduct(item);

    await success(await addRef(f, pool, candidate.item_ref));

    expect(await storedShopName(h.db, f.appId, pool, `tb:${stable}`)).toBe(expected);
    expect(await itemRow(h, f, pool, `tb:${stable}`)).toMatchObject({
      title: item.title,
      image: IMAGE,
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      commission_rate_bp: 2000,
    });
  },
  TIMEOUT,
);

const REPEAT_CASES: typeof ADD_CASES = [
  { ac: 3, label: '新店名覆盖旧店名', fields: { shop_name: '合成乙店' }, expected: '合成乙店' },
  { ac: 4, label: '缺省清空旧店名', fields: {}, expected: null },
];

it.each(REPEAT_CASES)(
  '[AC-B1-05zd#$ac] 同一候选重复加池复核通过：$label',
  async ({ fields, expected }) => {
    await requireShopName(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const stable = stableId();
    const first = product(f, stable, { shop_name: '合成旧店', main_image_url: IMAGE });
    const candidate = await pick(f, first);
    stubProduct(first);
    await success(await addRef(f, pool, candidate.item_ref));
    expect(await storedShopName(h.db, f.appId, pool, `tb:${stable}`)).toBe('合成旧店');

    // Same valid item_ref; the latest union detail determines the replacement snapshot.
    const latest = product(f, stable, {
      title: '不能用新标题补店铺名',
      main_image_url: IMAGE,
      ...fields,
    });
    const latestWithNick = { ...latest, nick: '不能用昵称补店铺名' };
    stubProduct(latestWithNick);
    await success(await addRef(f, pool, candidate.item_ref));

    expect(await storedShopName(h.db, f.appId, pool, `tb:${stable}`)).toBe(expected);
    const rows = await h.db
      .selectFrom('pool_items')
      .select('product_key')
      .where('app_id', '=', f.appId)
      .where('pool_id', '=', pool)
      .execute();
    expect(rows).toEqual([{ product_key: `tb:${stable}` }]);
  },
  TIMEOUT,
);
