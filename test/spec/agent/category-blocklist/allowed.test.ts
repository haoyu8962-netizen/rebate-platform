// B1-04zzy (D10-860 ①③④⑤): the production stream assembly's category judgement of Agent search
// candidates goes through catalog's filterCategories (the provided `categories` port): same app,
// same platform, the candidate's level-one category and title; a candidate without a category is
// judged by catalog's rule for it (only its platform's rows with a keyword, by literal title
// substring). No cache. A failing port means not allowed, with a warn line that names no product.
// Without the port every candidate stays allowed (fixtures without it). Synthetic values.
import { afterEach, expect, it, vi } from 'vitest';
import {
  APP_A,
  APP_B,
  candidate,
  categoryPort,
  productionCategoryAllowed,
  verdict,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-04zzy#1] 装了 categories 端口：同应用同平台类目全等的启用行判禁，别的类目与别的平台放行；端口收到应用、平台、类目与标题；未装端口时同一候选放行', async () => {
  const catalog = categoryPort();
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9000101', keyword: null }]);
  const { allowed } = productionCategoryAllowed(catalog.port);

  const blocked = candidate('a1', { categoryId: '9000101', title: '合成商品 甲' });
  expect(await verdict(allowed, APP_A, blocked)).toBe(false);
  expect(catalog.calls).toEqual([
    {
      appId: APP_A,
      items: [{ platform: 'taobao', categoryId: '9000101', title: '合成商品 甲' }],
    },
  ]);
  expect(await verdict(allowed, APP_A, candidate('a2', { categoryId: '9000102' }))).toBe(true);
  expect(
    await verdict(allowed, APP_A, candidate('a3', { platform: 'jd', categoryId: '9000101' })),
  ).toBe(true);
  expect(catalog.calls.map((call) => call.items.map((item) => item.platform))).toEqual([
    ['taobao'],
    ['taobao'],
    ['jd'],
  ]);

  // Fixtures without the port keep the old behavior.
  const bare = productionCategoryAllowed();
  expect(await verdict(bare.allowed, APP_A, blocked)).toBe(true);
});

it('[AC-B1-04zzy#2] 类目行带关键词：标题字面含关键词才判禁，正则符号按字面', async () => {
  const catalog = categoryPort();
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9000201', keyword: 'x.y' }]);
  const { allowed } = productionCategoryAllowed(catalog.port);

  const row = (key: string, title: string) => candidate(key, { categoryId: '9000201', title });
  expect(await verdict(allowed, APP_A, row('b1', '合成 x.y 商品'))).toBe(false);
  expect(await verdict(allowed, APP_A, row('b2', '合成 xzy 商品'))).toBe(true);
  expect(await verdict(allowed, APP_A, row('b3', '合成商品'))).toBe(true);
});

it('[AC-B1-04zzy#3] 无类目候选（categoryId 为空）：只按同平台带关键词行的标题字面匹配，不带关键词的类目行与别平台行不生效', async () => {
  const catalog = categoryPort();
  catalog.rules.set(APP_A, [
    { platform: 'taobao', categoryId: '9000301', keyword: '合成违禁' },
    { platform: 'taobao', categoryId: '9000302', keyword: null },
    { platform: 'jd', categoryId: '9000303', keyword: '合成别平台' },
  ]);
  const { allowed } = productionCategoryAllowed(catalog.port);

  const bare = (key: string, title: string) => candidate(key, { categoryId: '', title });
  expect(await verdict(allowed, APP_A, bare('c1', '合成违禁 商品'))).toBe(false);
  expect(await verdict(allowed, APP_A, bare('c2', '合成普通 商品'))).toBe(true);
  expect(await verdict(allowed, APP_A, bare('c3', '合成别平台 商品'))).toBe(true);
  expect(catalog.calls.length).toBeGreaterThanOrEqual(3);
  for (const call of catalog.calls) {
    expect(call.appId).toBe(APP_A);
    for (const item of call.items) {
      expect(['', null]).toContain(item.categoryId);
      expect(item.platform).toBe('taobao');
    }
  }
});

it('[AC-B1-04zzy#4] 名单按请求的应用判：A 应用的行不影响 B 应用的同一候选', async () => {
  const catalog = categoryPort();
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9000401', keyword: null }]);
  const { allowed } = productionCategoryAllowed(catalog.port);

  const row = candidate('d1', { categoryId: '9000401' });
  expect(await verdict(allowed, APP_A, row)).toBe(false);
  expect(await verdict(allowed, APP_B, row)).toBe(true);
  expect(catalog.calls.map((call) => call.appId)).toEqual([APP_A, APP_B]);
});

it('[AC-B1-04zzy#5] 名单不加缓存：每次判定都读端口，行启用、停用在下一次判定即生效', async () => {
  const catalog = categoryPort();
  const { allowed } = productionCategoryAllowed(catalog.port);
  const row = candidate('e1', { categoryId: '9000501' });

  expect(await verdict(allowed, APP_A, row)).toBe(true);
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9000501', keyword: null }]);
  expect(await verdict(allowed, APP_A, row)).toBe(false);
  expect(await verdict(allowed, APP_A, row)).toBe(false);
  catalog.rules.set(APP_A, []);
  expect(await verdict(allowed, APP_A, row)).toBe(true);
  expect(catalog.calls.length).toBeGreaterThanOrEqual(4);
});

it('[AC-B1-04zzy#6] 读名单失败从严：端口抛错时该候选不放行，并记 warn；warn 不带商品 ID、商品键与标题；恢复后照常判', async () => {
  const catalog = categoryPort();
  catalog.state.fail = true;
  const { allowed, logs } = productionCategoryAllowed(catalog.port);
  const row = candidate('f1', {
    categoryId: '9000601',
    title: '合成商品 失败判定标题',
  });

  const built = logs.warnings().length;
  expect(await verdict(allowed, APP_A, row)).toBe(false);
  const warnings = logs.warnings();
  expect(warnings.length).toBeGreaterThan(built);
  for (const line of warnings) {
    for (const secret of [
      row.item.item_id!,
      row.ref.productKey,
      row.ref.rawItemId,
      row.item.title,
      '失败判定标题',
    ]) {
      expect(line).not.toContain(secret);
    }
  }

  catalog.state.fail = false;
  expect(await verdict(allowed, APP_A, row)).toBe(true);
  expect(catalog.calls.length).toBeGreaterThanOrEqual(2);
});
