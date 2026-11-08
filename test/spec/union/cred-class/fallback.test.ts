import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoCredentials,
  type TaobaoSearchFallbackWarning,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';
import {
  convertedBy,
  dataokeDefault,
  expectFallsBack,
} from '../taobao-search-fallback/fallback-harness.ts';
import {
  convertToDetail,
  ctx,
  DETAIL,
  endpoint,
  formOf,
  instant,
  KEYWORD,
  OFFICIAL_SEARCH,
  query,
  SLOT_PID,
  topError,
} from '../taobao-official-search/official-harness.ts';
import { DATAOKE_BASE, response, searched } from '../taobao-search/kit.ts';
import { outcome, PERMISSION_SUB_CODE } from './cred-kit.ts';

// 编排者补充第 8 条：official_first 下官方第 1 页遇 code 11（新码 upstream_misconfigured）仍回落大淘客，回落
// warn 的 reason 是新码；续页不回落。装配同 test/spec/union/taobao-search-fallback 的夹具，另接 fallbackWarn
// 与 warn 两个回调。

/** The adapter under official_first whose official search answers `official`. */
function officialFirst(official: () => UnionTransportResponse) {
  const clock = new FixedClock(instant);
  const scheduler = new ManualScheduler();
  const detail = convertedBy(convertToDetail);
  const transport = vi.fn<UnionTransport>(async (request) => {
    const method = formOf(request)['method'];
    if (method === OFFICIAL_SEARCH) return official();
    if (method === DETAIL) return detail(request, { clock, scheduler });
    return response(topError('synthetic-unexpected-method'));
  });
  const dataokeTransport = vi.fn<UnionTransport>(async () => dataokeDefault());
  const orderSource = new DataokeClient({
    credentials: vi.fn<() => Promise<DataokeCredentials>>(async () => ({
      appKey: 'fake-cred-fallback-dataoke-key',
      appSecret: 'cfdk-cfdk-cfdk-cfdk-cfdk',
    })),
    transport: dataokeTransport,
    clock,
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    baseUrl: DATAOKE_BASE,
  });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const fallbackWarn = vi.fn<(event: TaobaoSearchFallbackWarning) => void>();
  const adapter = new TaobaoUnionAdapter({
    credentials: vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
      appKey: 'fake-cred-fallback-key',
      appSecret: 'cfbk-cfbk-cfbk-cfbk-cfbk',
    })),
    transport,
    clock,
    endpoint,
    orderSource,
    scheduler,
    searchSlot: async () => SLOT_PID,
    searchSource: 'official_first',
    warn,
    fallbackWarn,
  });
  return { adapter, transport, dataokeTransport, warn, fallbackWarn };
}

const permissionRefused = () => response(topError(11, PERMISSION_SUB_CODE));

it('[AC-B1-04zzzx#12] official_first：官方第 1 页遇 code 11 → 回落大淘客、返回大淘客结果；权限告警仍一次；回落 warn 的 reason 是 upstream_misconfigured', async () => {
  const h = officialFirst(permissionRefused);
  const page = await searched(() => h.adapter.searchItems(query, ctx));
  expect(page.items.length).toBeGreaterThan(0);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.warn.mock.calls).toEqual([
    [{ method: OFFICIAL_SEARCH, code: '11', sub_code: PERMISSION_SUB_CODE }],
  ]);
  expect(h.fallbackWarn.mock.calls).toEqual([
    [{ event: 'taobao_search_fallback', source: 'official', reason: 'upstream_misconfigured' }],
  ]);
  expect(JSON.stringify(h.fallbackWarn.mock.calls)).not.toContain(KEYWORD);
});

it('[AC-B1-04zzzx#13] official_first 续页（官方游标）遇 code 11 → 原样抛 upstream_misconfigured，不回落、不问大淘客、不写回落 warn', async () => {
  // Control: the same kind of assembly falls back on a failed first page.
  await expectFallsBack();
  const h = officialFirst(permissionRefused);
  const error = await outcome(() =>
    h.adapter.searchItems({ keyword: KEYWORD, cursor: 'taobao-search:2' }, ctx),
  );
  expect(h.dataokeTransport).not.toHaveBeenCalled();
  expect(h.fallbackWarn).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code: 'upstream_misconfigured', platform: 'taobao' });
});
