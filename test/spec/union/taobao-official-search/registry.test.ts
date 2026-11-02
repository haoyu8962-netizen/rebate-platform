import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnionMode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  createUnionRegistry,
  type TaobaoLiveOptions,
} from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type {
  TaobaoSearchSlotReader,
  TaobaoSearchWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import { clock, endpoints, observeTaobao, outcome } from '../taobao-dataoke-switches/kit.ts';
import {
  APP_KEY,
  ctx,
  detailItemId,
  gateway,
  query,
  SECRET,
  SLOT_PID,
  unionFailure,
} from './official-harness.ts';

// 注册表：taobaoLive.searchSlot 原样交给淘宝适配器；不传时适配器选项里没有这一项。taobaoLive 本身缺失
// （没有官方凭据）时 taobao 保持 adapter_unimplemented。

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function registryOptions(mode: UnionMode = 'live') {
  return { endpoints: endpoints(mode), environment: 'staging' as const, seed: 'official', clock };
}

function live(
  transport: UnionTransport,
  extra: Partial<TaobaoLiveOptions> = {},
): TaobaoLiveOptions {
  return {
    credentials: async () => ({ appKey: APP_KEY, appSecret: SECRET }),
    transport,
    ...extra,
  };
}

it('[AC-B1-04zx#48] taobaoLive.searchSlot 原样交给淘宝适配器；不传时适配器选项里没有这一项；装配时不读推广位、不发请求', () => {
  const observed = observeTaobao();
  const transport = gateway(clock);
  createUnionRegistry({ ...registryOptions(), taobaoLive: live(transport) });
  expect(observed).toHaveBeenCalledTimes(1);
  expect(Object.hasOwn(observed.mock.calls[0]![0], 'searchSlot')).toBe(false);

  observed.mockClear();
  const searchSlot = vi.fn<TaobaoSearchSlotReader>(async () => SLOT_PID);
  createUnionRegistry({ ...registryOptions(), taobaoLive: live(transport, { searchSlot }) });
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed.mock.calls[0]![0].searchSlot).toBe(searchSlot);
  expect(searchSlot).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04zx#65] taobaoLive.searchWarn 原样交给淘宝适配器；不传时适配器选项里没有这一项', () => {
  const observed = observeTaobao();
  const transport = gateway(clock);
  const searchWarn = vi.fn<(event: TaobaoSearchWarning) => void>();
  createUnionRegistry({ ...registryOptions(), taobaoLive: live(transport, { searchWarn }) });
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed.mock.calls[0]![0].searchWarn).toBe(searchWarn);

  observed.mockClear();
  createUnionRegistry({ ...registryOptions(), taobaoLive: live(transport) });
  expect(Object.hasOwn(observed.mock.calls[0]![0], 'searchWarn')).toBe(false);
});

it('[AC-B1-04zx#49] 端到端（内存假传输）：经注册表拿到的适配器默认走官方搜索；没有 taobaoLive（缺官方凭据）保持 adapter_unimplemented', async () => {
  const transport = gateway(clock);
  const searchSlot = vi.fn<TaobaoSearchSlotReader>(async () => SLOT_PID);
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: live(transport, { searchSlot }),
  });
  const page = await outcome(() => registry.get('taobao').searchItems(query, ctx));
  expect(page, 'searchItems must succeed').not.toBeInstanceOf(Error);
  expect(page).toMatchObject({
    items: [1, 2, 3].map((n) => ({ item_id: detailItemId(n) })),
    nextCursor: null,
  });
  expect(searchSlot).toHaveBeenCalledTimes(1);

  const unconfigured = createUnionRegistry(registryOptions());
  await unionFailure(
    () => unconfigured.get('taobao').searchItems(query, ctx),
    'adapter_unimplemented',
  );
  expect(searchSlot).toHaveBeenCalledTimes(1);
});
