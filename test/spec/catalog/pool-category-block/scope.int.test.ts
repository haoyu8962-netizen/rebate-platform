// B1-05zo: the list is the app's own, per platform, active rows only, read on every call (no
// cache). Each case adds a fresh key per step through the real admin route.
import { expect, it } from 'vitest';
import {
  addLink,
  linkOf,
  seedPool,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  useHarness,
  type Setup,
} from '../product-pool-admin/kit.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  BLOCKED,
  blockRule,
  categoryBlocked,
  goods,
  KEYWORD,
  OPEN,
  setRuleStatus,
} from './fixtures.ts';

const h = useHarness();

/** Adds a new key of this category (and title extra) to the pool, answered live by the union. */
async function attempt(f: Setup, pool: string, category: string | null, title?: string) {
  const stable = stableId();
  const item: UnionItemDetail = goods(
    f,
    stable,
    category,
    title === undefined ? {} : { title: `${title} ${stable}` },
  );
  stubProduct(item);
  return addLink(f, pool, linkOf(item.item_id!));
}

async function admitted(f: Setup, pool: string, category: string | null, title?: string) {
  expect(await success(await attempt(f, pool, category, title))).toMatchObject({
    status: 'online',
  });
}

async function refused(f: Setup, pool: string, category: string | null, title?: string) {
  const before = await snapshot(h, f.appId);
  await categoryBlocked(await attempt(f, pool, category, title));
  expect(await snapshot(h, f.appId)).toEqual(before);
}

it('[AC-B1-05zo#12] 名单按应用：别的 App 的 active 规则不拦本 App；本 App 同类目的 active 规则拦', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await blockRule(h, f, { category: BLOCKED, appId: `${f.appId}_other` });
  await admitted(f, pool, BLOCKED);
  await blockRule(h, f, { category: BLOCKED });
  await refused(f, pool, BLOCKED);
});

it('[AC-B1-05zo#13] 名单按平台：别的平台同类目 id 的规则不拦淘宝商品；淘宝的才拦', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await blockRule(h, f, { category: BLOCKED, platform: 'pdd' });
  await blockRule(h, f, { category: BLOCKED, platform: 'jd', keyword: KEYWORD });
  await admitted(f, pool, BLOCKED);
  await admitted(f, pool, null, `合成商品 ${KEYWORD}`);
  await blockRule(h, f, { category: BLOCKED });
  await refused(f, pool, BLOCKED);
});

it('[AC-B1-05zo#14] status 非 active 的规则不拦；名单改动下一次调用即生效（不缓存）：启用 → 30147，停用 → 放行，再启用 → 30147', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const rule = await blockRule(h, f, { category: BLOCKED, status: 'disabled' });
  await admitted(f, pool, BLOCKED);
  await setRuleStatus(h, f, rule, 'active');
  await refused(f, pool, BLOCKED);
  await setRuleStatus(h, f, rule, 'disabled');
  await admitted(f, pool, BLOCKED);
  await setRuleStatus(h, f, rule, 'active');
  await refused(f, pool, BLOCKED);
});

it('[AC-B1-05zo#15] 带关键词的类目规则：同类目且标题含关键词 → 30147；同类目不含关键词、别的类目含关键词都放行', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await blockRule(h, f, { category: BLOCKED, keyword: KEYWORD });
  await admitted(f, pool, BLOCKED);
  await admitted(f, pool, OPEN, `合成商品 ${KEYWORD}`);
  await refused(f, pool, BLOCKED, `合成商品 ${KEYWORD}`);
});
