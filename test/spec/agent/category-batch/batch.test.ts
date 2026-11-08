// B1-04zzzv (D10-946, FU-AGENT-CATEGORY-BATCH): the production categoryAllowed judges the
// candidates started in one synchronous run (the search pipeline's Promise.all over a round) with
// one filterCategories call per app, holding {platform, categoryId, title} of every candidate in
// the order they were started; requests awaited one by one stay one call each. Each verdict equals
// the candidate's verdict alone. A failing port blocks the whole batch with one warn line naming
// only the event, the batch's platforms (distinct, sorted, comma-joined) and the error name. No
// port: everything allowed, no warn. No cache between batches. Different apps never share a batch.
// Synthetic values only.
import { afterEach, expect, it, vi } from 'vitest';
import { APP_A, APP_B, candidate, productionCategoryAllowed } from '../category-blocklist/kit.ts';
import {
  BLOCKLIST_EVENT,
  ERROR_NAME,
  ITEM_FIELDS,
  batchPort,
  oneByOne,
  productValues,
  sent,
  together,
  warnFields,
  warningsSince,
  type BatchCall,
  type Judgement,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

const byApp = (calls: readonly BatchCall[]): BatchCall[] =>
  [...calls].sort((left, right) => (left.appId < right.appId ? -1 : 1));

it('[AC-B1-04zzzv#1] 同一轮并发判定合成一次端口调用（端口每项只有平台、类目、标题，依发起顺序），结果逐一等于依次 await 逐个判定的结果；逐个判定仍各自一次调用', async () => {
  const catalog = batchPort();
  catalog.rules.set(APP_A, [
    { platform: 'taobao', categoryId: '9200101', keyword: null },
    { platform: 'taobao', categoryId: '9200109', keyword: '合成禁词' },
  ]);
  const { allowed, logs } = productionCategoryAllowed(catalog.port);
  const rows = [
    candidate('g1', { categoryId: '9200101', title: '合成商品 甲' }),
    candidate('g2', { categoryId: '9200102', title: '合成商品 乙' }),
    candidate('g3', { platform: 'jd', categoryId: '9200101', title: '合成商品 丙' }),
    candidate('g4', { categoryId: '', title: '合成禁词 商品丁' }),
    candidate('g5', { categoryId: '', title: '合成商品 戊' }),
    candidate('g6', { categoryId: '9200101', title: '合成商品 甲' }),
  ];
  const requests = rows.map((row): Judgement => [APP_A, row]);
  const warned = logs.warnings().length;

  const batched = await together(allowed, requests);
  expect(batched).toEqual([false, true, true, false, true, false]);
  expect(catalog.calls, 'one round, one app: one port call').toHaveLength(1);
  expect(catalog.calls[0]).toEqual({
    appId: APP_A,
    fields: rows.map(() => ITEM_FIELDS),
    items: rows.map(sent),
  });

  const alone = await oneByOne(allowed, requests);
  expect(alone).toEqual(batched);
  expect(catalog.calls.slice(1)).toEqual(
    rows.map((row) => ({ appId: APP_A, fields: [ITEM_FIELDS], items: [sent(row)] })),
  );
  expect(warningsSince(logs, warned)).toEqual([]);
});

it('[AC-B1-04zzzv#2] 端口拒绝或同步抛错：该批全部候选判禁，每批恰好一条 warn，只含事件、批内平台（去重、字典序、逗号连接）与错误名，不带任何商品信息；端口恢复后下一批照常判', async () => {
  const catalog = batchPort();
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9200201', keyword: null }]);
  catalog.failing.set(APP_A, 'reject');
  const { allowed, logs } = productionCategoryAllowed(catalog.port);
  const first = [
    candidate('h1', { platform: 'taobao', categoryId: '9200201', title: '合成商品 失败批甲' }),
    candidate('h2', { platform: 'pdd', categoryId: '9200202', title: '合成商品 失败批乙' }),
    candidate('h3', { platform: 'jd', categoryId: '9200201', title: '合成商品 失败批丙' }),
    candidate('h4', { platform: 'taobao', categoryId: '', title: '合成商品 失败批丁' }),
  ];
  const second = [
    candidate('h5', { platform: 'jd', categoryId: '9200203', title: '合成商品 失败批戊' }),
    candidate('h6', { platform: 'jd', categoryId: '', title: '合成商品 失败批己' }),
    candidate('h7', { platform: 'jd', categoryId: '9200201', title: '合成商品 失败批庚' }),
  ];
  const requestsOf = (rows: typeof first): Judgement[] =>
    rows.map((row): Judgement => [APP_A, row]);

  // Rejected: the whole batch blocked, one warn line.
  const before = logs.warnings().length;
  expect(await together(allowed, requestsOf(first))).toEqual([false, false, false, false]);
  expect(catalog.calls, 'one failing batch, one port call').toHaveLength(1);
  const firstWarnings = warningsSince(logs, before);
  expect(firstWarnings, 'one warn line per failing batch').toHaveLength(1);
  expect(warnFields(firstWarnings[0]!)).toEqual({
    event: BLOCKLIST_EVENT,
    platform: 'jd,pdd,taobao',
    error_name: ERROR_NAME,
  });
  for (const row of first) {
    for (const value of [...productValues(row), '失败批']) {
      expect(firstWarnings[0]).not.toContain(value);
    }
  }

  // Thrown synchronously: the same, with the one platform of this batch.
  catalog.failing.set(APP_A, 'throw');
  const middle = logs.warnings().length;
  expect(await together(allowed, requestsOf(second))).toEqual([false, false, false]);
  expect(catalog.calls).toHaveLength(2);
  const secondWarnings = warningsSince(logs, middle);
  expect(secondWarnings).toHaveLength(1);
  expect(warnFields(secondWarnings[0]!)).toEqual({
    event: BLOCKLIST_EVENT,
    platform: 'jd',
    error_name: ERROR_NAME,
  });
  for (const row of second) {
    for (const value of [...productValues(row), '失败批']) {
      expect(secondWarnings[0]).not.toContain(value);
    }
  }

  // Recovered: the next batch is judged as usual, with no warn.
  catalog.failing.delete(APP_A);
  const after = logs.warnings().length;
  const all = [...first, ...second];
  expect(await together(allowed, requestsOf(all))).toEqual([
    false,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(catalog.calls).toHaveLength(3);
  expect(catalog.calls[2]?.items).toEqual(all.map(sent));
  expect(warningsSince(logs, after)).toEqual([]);
});

it('[AC-B1-04zzzv#3] 未装 categories 端口：一批并发候选全部放行、无 warn；装了端口时同一批只调用端口一次', async () => {
  const rows = [
    candidate('i1', { categoryId: '9200301', title: '合成商品 甲' }),
    candidate('i2', { platform: 'jd', categoryId: '9200301', title: '合成商品 乙' }),
    candidate('i3', { categoryId: '', title: '合成禁词 商品丙' }),
    candidate('i4', { categoryId: '9200302', title: '合成商品 丁' }),
  ];
  const requests = rows.map((row): Judgement => [APP_A, row]);

  const catalog = batchPort();
  catalog.rules.set(APP_A, [
    { platform: 'taobao', categoryId: '9200301', keyword: null },
    { platform: 'taobao', categoryId: '9200309', keyword: '合成禁词' },
  ]);
  const wired = productionCategoryAllowed(catalog.port);
  expect(await together(wired.allowed, requests)).toEqual([false, true, false, true]);
  expect(catalog.calls, 'with the port: one call for the batch').toHaveLength(1);

  const bare = productionCategoryAllowed();
  const before = bare.logs.warnings().length;
  expect(await together(bare.allowed, requests)).toEqual([true, true, true, true]);
  const otherApp = rows.map((row): Judgement => [APP_B, row]);
  expect(await together(bare.allowed, otherApp)).toEqual([true, true, true, true]);
  expect(warningsSince(bare.logs, before)).toEqual([]);
  expect(catalog.calls, 'the bare assembly never reaches a port').toHaveLength(1);
});

it('[AC-B1-04zzzv#4] 不同应用在同一轮发起：各自一批、按各自名单判、互不混批；一个应用的端口失败只禁该应用的那一批', async () => {
  const catalog = batchPort();
  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9200401', keyword: null }]);
  catalog.rules.set(APP_B, [{ platform: 'taobao', categoryId: '9200402', keyword: null }]);
  const { allowed, logs } = productionCategoryAllowed(catalog.port);
  const r1 = candidate('j1', { categoryId: '9200401', title: '合成商品 甲' });
  const r2 = candidate('j2', { categoryId: '9200402', title: '合成商品 乙' });
  const r3 = candidate('j3', { platform: 'jd', categoryId: '', title: '合成商品 丙' });
  const interleaved: Judgement[] = [
    [APP_A, r1],
    [APP_B, r1],
    [APP_A, r2],
    [APP_B, r2],
    [APP_A, r3],
    [APP_B, r3],
  ];

  expect(await together(allowed, interleaved)).toEqual([false, true, true, false, true, true]);
  expect(catalog.calls, 'one call per app in the round').toHaveLength(2);
  const appAItems = [r1, r2, r3].map(sent);
  expect(byApp(catalog.calls)).toEqual([
    { appId: APP_A, fields: [ITEM_FIELDS, ITEM_FIELDS, ITEM_FIELDS], items: appAItems },
    { appId: APP_B, fields: [ITEM_FIELDS, ITEM_FIELDS, ITEM_FIELDS], items: appAItems },
  ]);

  // B's port read fails in the next round: only B's batch is blocked, with one warn line.
  catalog.failing.set(APP_B, 'reject');
  const before = logs.warnings().length;
  expect(await together(allowed, interleaved)).toEqual([false, false, true, false, true, false]);
  expect(catalog.calls).toHaveLength(4);
  expect(byApp(catalog.calls.slice(2)).map((call) => call.appId)).toEqual([APP_A, APP_B]);
  const warnings = warningsSince(logs, before);
  expect(warnings).toHaveLength(1);
  expect(warnFields(warnings[0]!)).toEqual({
    event: BLOCKLIST_EVENT,
    platform: 'jd,taobao',
    error_name: ERROR_NAME,
  });
});

it('[AC-B1-04zzzv#5] 名单不加缓存：两批之间改名单，下一批按新名单判，每批各调用端口一次', async () => {
  const catalog = batchPort();
  const { allowed } = productionCategoryAllowed(catalog.port);
  const rows = [
    candidate('k1', { categoryId: '9200501', title: '合成商品 甲' }),
    candidate('k2', { categoryId: '9200502', title: '合成商品 乙' }),
    candidate('k3', { categoryId: '', title: '合成禁词 商品丙' }),
  ];
  const requests = rows.map((row): Judgement => [APP_A, row]);

  expect(await together(allowed, requests)).toEqual([true, true, true]);
  expect(catalog.calls).toHaveLength(1);

  catalog.rules.set(APP_A, [
    { platform: 'taobao', categoryId: '9200501', keyword: null },
    { platform: 'taobao', categoryId: '9200509', keyword: '合成禁词' },
  ]);
  expect(await together(allowed, requests)).toEqual([false, true, false]);
  expect(catalog.calls).toHaveLength(2);

  catalog.rules.set(APP_A, [{ platform: 'taobao', categoryId: '9200502', keyword: null }]);
  expect(await together(allowed, requests)).toEqual([true, false, true]);
  expect(catalog.calls).toHaveLength(3);
  expect(catalog.calls.map((call) => call.items.length)).toEqual([3, 3, 3]);
});
