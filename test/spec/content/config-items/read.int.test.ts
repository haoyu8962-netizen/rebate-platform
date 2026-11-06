// F1-10e ruling 15: GET /admin/v1/config-items, /{key}, /{key}/versions — registry order, current
// value read from the primary handle (no cache), never-written items, paging, app isolation.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { configRegistry } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import {
  ADVANCE_ALERT,
  AUTO_ENABLE_CHECK,
  AUTO_PAYOUT,
  AVATAR,
  BAD_DEBT,
  BRIDGE,
  EXPECTED,
  FEEDBACK,
  KEYS,
  LABOR,
  ORDER_RESCAN,
  PAYOUT,
  POOL,
  PROMO_LINK,
  QUOTE,
  RANK,
  REVERIFY,
  RETENTION,
  RISK_WITHDRAW,
  ROW_AT,
  SEARCH,
  SHARE,
  TAX,
  UNREGISTERED,
  call,
  expectedNow,
  getItem,
  historyPage,
  itemOf,
  keyInvalid,
  listAll,
  listPage,
  normalized,
  normalizedVersion,
  putRow,
  putVersion,
  rejected,
  setup,
  unwritten,
  written,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-10e#10] 列表按注册表顺序列出每个配置项，未写过的 value=null、version=0、无作者与时间', async () => {
  const f = await setup(h);
  const items = await listAll(f);
  expect(items.map((item) => item.key)).toStrictEqual(configRegistry().map((spec) => spec.key));
  expect(items.map(normalized)).toStrictEqual(configRegistry().map((spec) => unwritten(spec.key)));
  // F1-02zt：过渡已收紧, EXPECTED + settle.* + invite; B2-06bz: + the eight payout.* keys;
  // B2-11z: + the six risk.withdraw.* keys; B2-11y: + the seventeen withdraw.auto_payout.* keys;
  // B2-11dz: + the four payout.auto_enable_check.* keys; B1-28g: + rank.cache_ttl_seconds;
  // B1-05l: + search.hot_words and search.keyword_routes; B1-15zd: + the seven retention.* keys;
  // B2-08cz: + the three tax.SERVICE_FEE.* keys; B1-05s: + feed.fallback_pool_id and pool.*;
  // B1-02zs: + withdraw.dormant_reverify_days; B1-06ze: + the three Taobao promotion link keys;
  // B1-04zq: + the four order_sync.rescan.* keys; B2-04zo: + ledger.advance_alert_fen;
  // B1-28q: + feedback.enabled and feedback.daily_limit_per_device; B2-12e: + ledger.bad_debt_days
  // and ledger.bad_debt_min_fen.
  const tail = [
    ...PAYOUT,
    ...RISK_WITHDRAW,
    ...AUTO_PAYOUT,
    ...AUTO_ENABLE_CHECK,
    ...RANK,
    ...SEARCH,
    ...RETENTION,
    ...TAX,
    ...POOL,
    ...REVERIFY,
    ...PROMO_LINK,
    ...ORDER_RESCAN,
    ...ADVANCE_ALERT,
    ...QUOTE,
    ...SHARE,
    ...BRIDGE,
    ...AVATAR,
    ...LABOR,
    ...FEEDBACK,
    ...BAD_DEBT,
  ];
  expect(items).toHaveLength(expectedNow().length + tail.length);
  expect(items.slice(-tail.length).map((item) => item.key)).toStrictEqual(
    tail.map((entry) => entry.key),
  );
});

it('[AC-F1-10e#11] 列表与单项给出写过的当前值、version、作者快照与时间；种子行照常列出', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6], f.actor);
  await putRow(h, f.appId, KEYS.riskFlag, true); // seed-style row: version 1, no history
  const items = await listAll(f);
  const general = items.find((item) => item.key === KEYS.general)!;
  const expected = itemOf(KEYS.general, {
    value: 6,
    version: 2,
    updated_by: 'history-snapshot',
    updated_at: ROW_AT,
  });
  expect(normalized(general)).toStrictEqual(expected);
  expect(normalized(await getItem(f, KEYS.general))).toStrictEqual(expected);
  const seeded = items.find((item) => item.key === KEYS.riskFlag)!;
  expect(seeded).toMatchObject({ key: KEYS.riskFlag, value: true, version: 1 });
  expect(await getItem(f, KEYS.riskFlag)).toMatchObject({ value: true, version: 1 });
  for (const entry of EXPECTED.filter((e) => e.key !== KEYS.general && e.key !== KEYS.riskFlag)) {
    expect(normalized(items.find((item) => item.key === entry.key)!)).toStrictEqual(
      unwritten(entry.key),
    );
  }
  expect(normalized(await getItem(f, 'agent.page_guide.routes'))).toStrictEqual(
    unwritten('agent.page_guide.routes'),
  );
});

it('[AC-F1-10e#12] 当前值主库直读不走缓存：库里改值后紧接着的列表与单项即见新值', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.general, 3);
  expect(await getItem(f, KEYS.general)).toMatchObject({ value: 3, version: 1 });
  expect((await listAll(f)).find((i) => i.key === KEYS.general)).toMatchObject({ value: 3 });
  await h.db
    .updateTable('config_items')
    .set({ value: JSON.stringify(9), version: 2 })
    .where('app_id', '=', f.appId)
    .where('key', '=', KEYS.general)
    .execute();
  expect(await getItem(f, KEYS.general)).toMatchObject({ value: 9, version: 2 });
  expect((await listAll(f)).find((i) => i.key === KEYS.general)).toMatchObject({
    value: 9,
    version: 2,
  });
});

it('[AC-F1-10e#13] 列表页码分页：默认第 1 页 20 条，逐页拼接等于全表，越过末页为空，total 恒为注册表长度', async () => {
  const f = await setup(h);
  const all = configRegistry().map((spec) => spec.key);
  const first = await listPage(f);
  expect(first).toMatchObject({ page: 1, page_size: 20, total: all.length });
  expect(first.items.map((i) => i.key)).toStrictEqual(all.slice(0, 20));
  const pages: string[] = [];
  for (let page = 1; page <= Math.ceil(all.length / 7); page += 1) {
    const result = await listPage(f, `?page=${page}&page_size=7`);
    expect(result).toMatchObject({ page, page_size: 7, total: all.length });
    pages.push(...result.items.map((i) => i.key));
  }
  expect(pages).toStrictEqual(all);
  const beyond = await listPage(f, `?page=${Math.ceil(all.length / 7) + 1}&page_size=7`);
  expect(beyond).toMatchObject({ items: [], total: all.length });
  await rejected(await call(f, 'list', { query: '?page_size=201' }), 'list', 20001, {
    fields: ['page_size'],
  });
  await rejected(await call(f, 'list', { query: '?page=0' }), 'list', 20001, {
    fields: ['page'],
  });
});

it('[AC-F1-10e#14] 版本历史新在前、页码分页，带值、作者快照（无管理员 id 的系统写入为 null）与理由', async () => {
  const f = await setup(h);
  const times = [1, 2, 3, 4, 5].map((n) => `2026-10-0${n}T00:00:00.000Z`);
  for (const [index, at] of times.entries()) {
    await putVersion(
      h,
      f.appId,
      KEYS.general,
      index + 1,
      (index + 1) * 10,
      index === 0 ? null : f.actor,
      index % 2 === 0 ? null : `reason-${index + 1}`,
      at,
    );
  }
  await putRow(h, f.appId, KEYS.general, 50, 5, 'history-snapshot');
  const expected = [5, 4, 3, 2, 1].map((v) => ({
    version: v,
    value: v * 10,
    updated_by: v === 1 ? null : 'history-snapshot',
    reason: (v - 1) % 2 === 0 ? null : `reason-${v}`,
    created_at: times[v - 1]!,
  }));
  const whole = await historyPage(f, KEYS.general);
  expect(whole).toMatchObject({ page: 1, page_size: 20, total: 5 });
  expect(whole.items.map(normalizedVersion)).toStrictEqual(expected);
  const second = await historyPage(f, KEYS.general, '?page=2&page_size=2');
  expect(second).toMatchObject({ page: 2, page_size: 2, total: 5 });
  expect(second.items.map(normalizedVersion)).toStrictEqual(expected.slice(2, 4));
  const last = await historyPage(f, KEYS.general, '?page=3&page_size=2');
  expect(last.items.map(normalizedVersion)).toStrictEqual(expected.slice(4));
  await rejected(
    await call(f, 'versions', { key: KEYS.general, query: '?page_size=201' }),
    'versions',
    20001,
    { fields: ['page_size'] },
  );
});

it('[AC-F1-10e#15] 种子写入（有当前行、无历史行）与从未写过的项历史都为空', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.riskFlag, true);
  expect(await historyPage(f, KEYS.riskFlag)).toMatchObject({ items: [], total: 0 });
  expect(await historyPage(f, KEYS.general)).toMatchObject({ items: [], total: 0 });
});

it.each(UNREGISTERED)(
  '[AC-F1-10e#16] 注册表外的键 %s：单项与历史 20001 [key]，即使库里有这一行也不进列表',
  async (key) => {
    const f = await setup(h);
    if (!['constructor', '__proto__', 'toString'].includes(key)) {
      await putRow(h, f.appId, key, true);
      await putVersion(h, f.appId, key, 1, true, f.actor);
    }
    await keyInvalid(await call(f, 'get', { key }), 'get');
    await keyInvalid(await call(f, 'versions', { key }), 'versions');
    expect((await listAll(f)).map((item) => item.key)).not.toContain(key);
  },
);

it('[AC-F1-10e#17] 读按令牌的 app 隔离：别的 app 同键的当前值与历史不出现', async () => {
  const f = await setup(h);
  const otherApp = `f1-10e-other-${randomUUID()}`;
  const other = await seed(h, otherApp, { isSuper: true });
  await written(h, otherApp, KEYS.general, [7, 8, 9], other);
  await written(h, f.appId, KEYS.general, [1], f.actor);
  expect(await getItem(f, KEYS.general)).toMatchObject({ value: 1, version: 1 });
  expect((await listAll(f)).find((i) => i.key === KEYS.general)).toMatchObject({ value: 1 });
  const mine = await historyPage(f, KEYS.general);
  expect(mine.total).toBe(1);
  expect(mine.items.map((v) => v.value)).toStrictEqual([1]);
  expect(normalized(await getItem(f, KEYS.risk))).toStrictEqual(unwritten(KEYS.risk));
  const session = await signedIn(f, other);
  const theirs = { ...f, token: session.admin_token };
  expect(await getItem(theirs, KEYS.general)).toMatchObject({ value: 9, version: 3 });
  expect((await historyPage(theirs, KEYS.general)).total).toBe(3);
});
