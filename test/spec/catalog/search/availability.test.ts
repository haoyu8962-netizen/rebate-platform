import { expect, it, vi } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/index.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/http/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { candidate, fixture, observed } from './kit.ts';

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-05d#27] %s 搜索开关关闭返回 50304/search_disabled，不查联盟或物料',
  async (platform) => {
    const f = fixture();
    f.enabled.set(platform, false);
    await expect(f.run({ platform })).rejects.toMatchObject({
      code: 50304,
      data: { platform, reason: 'search_disabled' },
    });
    expect(f.configValue).toHaveBeenCalledWith('synthetic-app', `search.enabled.${platform}`);
    expect(f.search).not.toHaveBeenCalled();
    expect(f.materialFeed).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it.each([
  null,
  { value: false, version: 1 },
  { value: 'true', version: 1 },
  { value: 'on', version: 1 },
  { value: 1, version: 1 },
  { value: 0, version: 1 },
  { value: null, version: 1 },
  { value: {}, version: 1 },
  { value: [], version: 1 },
])('[AC-B1-05d#42] 搜索配置 %j 缺失或不是布尔 true 时默认关闭', async (entry) => {
  const f = fixture();
  const configValue = vi.fn(async () => entry);
  f.options.config.configValue = configValue;
  const result = await observed(() => f.run());
  expect(result).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
  if (result.kind === 'rejected')
    expect(result.error).toHaveProperty('data', {
      platform: 'taobao',
      reason: 'search_disabled',
    });
  expect(configValue).toHaveBeenCalledWith('synthetic-app', 'search.enabled.taobao');
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-05d#28] 每次请求重读开关，刚成功搜索后关闭也不能继续翻页', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: true });
  const first = await f.run({ limit: 1 });
  expect(first.items).toHaveLength(1);
  f.enabled.set('taobao', false);
  await expect(f.run({ limit: 1, cursor: first.next_cursor! })).rejects.toMatchObject({
    code: 50304,
    data: { platform: 'taobao', reason: 'search_disabled' },
  });
  expect(f.search).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05d#29] 搜索开启但转链关闭时仍出卡；只登记链接和报价，不转链', async () => {
  const f = fixture();
  // Fixture returns false for every convert.enabled key, true for search.enabled keys.
  f.pages.set(1, { items: [candidate('a')], hasMore: false });
  const result = await f.run();
  expect(result.items).toHaveLength(1);
  expect(f.assemble).toHaveBeenCalledWith(
    expect.objectContaining({ scene: 'retrieval', entrySource: 'search' }),
  );
  expect(f.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      viewer: { appId: 'synthetic-app', userId: 'synthetic-user', deviceId: 'synthetic-device' },
      entrySource: 'search',
      quote: expect.objectContaining({
        rebateMinFen: 20n,
        rebateMaxFen: 20n,
        rebateBasis: 'normal',
      }),
    }),
  );
  expect(result.items[0]?.link_id).toBe('00000000-0000-7000-8000-000000000001');
  expect(result.items[0]).not.toHaveProperty('click_url');
});

it('[AC-B1-05d#30] 搜索调用固定 query 推广位，不携带查看者身份或 relation_id', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: false });
  const result = await f.run();
  expect(result.items).toHaveLength(1);
  expect(f.getActivePid).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    pidScene: 'query',
    purpose: 'query',
  });
  expect(f.search).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    keyword: '合成纸巾',
    pageNo: 1,
    pageSize: 3,
    sort: 'relevance',
    promotionSlot: 'synthetic-query-pid',
  });
  expect(JSON.stringify(result)).not.toContain('synthetic-query-pid');
});

it('[AC-B1-05d#31] 没有 active query 推广位按任务默认返回 50304 并告警，不改用转链位', async () => {
  const f = fixture();
  f.getActivePid.mockResolvedValue(null);
  const result = await observed(() => f.run());
  expect(result).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
  if (result.kind === 'rejected')
    expect(result.error).toHaveProperty('data', { platform: 'taobao' });
  expect(f.warn).toHaveBeenCalled();
  expect(f.getActivePid.mock.calls.map(([input]) => input.pidScene)).toEqual(['query']);
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it.each([
  new GovernanceError('timeout', 'union.search', 'synthetic timeout'),
  new GovernanceError('circuit_open', 'union.search', 'synthetic circuit'),
  new GovernanceError('quota_exceeded', 'union.search', 'synthetic quota'),
  new UnionError('rate_limited', 'synthetic rate limit', 'taobao'),
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'),
])(
  '[AC-B1-05d#32] 联盟故障且无缓存 %s 返回 50304/platform，不伪装成空结果或物料',
  async (failure) => {
    const f = fixture();
    f.search.mockRejectedValue(failure);
    const result = await observed(() => f.run());
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
    if (result.kind === 'rejected')
      expect(result.error).toHaveProperty('data', { platform: 'taobao' });
    expect(f.materialFeed).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it('[AC-B1-05d#33] 平台本身没有搜索能力时保留 30131，不误报运行期开关关闭', async () => {
  const f = fixture();
  f.requirePlatform.mockRejectedValue(new CatalogError(30131, 'synthetic unsupported platform'));
  await expect(f.run({ platform: 'meituan' })).rejects.toMatchObject({ code: 30131 });
  expect(f.requirePlatform).toHaveBeenCalledWith('meituan', {
    parseEnabled: false,
    searchEnabled: true,
  });
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it('[AC-B1-05d#34] 卡片登记失败不可吞成无结果或错误的联盟 50304', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: false });
  const failure = new Error('synthetic link registration failure');
  f.register.mockRejectedValue(failure);
  await expect(f.run()).rejects.toBe(failure);
  expect(f.materialFeed).not.toHaveBeenCalled();
});
