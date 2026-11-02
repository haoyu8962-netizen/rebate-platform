import { expect, it } from 'vitest';
import {
  ctx,
  detailItemId,
  expectNothingSent,
  query,
  search,
  searchRequests,
  setup,
  unionFailure,
} from './official-harness.ts';

// 开关：searchSource 为 official（未设也是）且有官方依赖时走官方；dataoke 行为不变（走大淘客）；缺官方依赖
// 保持 adapter_unimplemented。适配器的 credentials 是必填项，冻结用例 AC-B1-04zh#8 在有淘宝凭据、无推广位
// 读者时要 adapter_unimplemented，所以这一层「缺官方依赖」就是没注入 searchSlot；注册表一层见 registry.test.ts。

it.each(['absent', 'official'] as const)(
  '[AC-B1-04zx#44] 开关 %s 且注入了推广位读者 → searchItems 走官方，不碰大淘客',
  async (searchSource) => {
    const h = setup({ searchSource, withDataoke: true });
    const page = await search(h);
    expect(page.items.map((item) => item.item_id)).toEqual([1, 2, 3].map(detailItemId));
    expect(searchRequests(h)).toHaveLength(1);
    expect(h.dataokeTransport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zx#45] 开关 dataoke 行为不变：走大淘客，不发官方搜索、不读推广位；同样的装配切 official 才走官方', async () => {
  const dataoke = setup({ searchSource: 'dataoke', withDataoke: true });
  const page = await search(dataoke);
  expect(page.items).toHaveLength(2);
  expect(dataoke.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(searchRequests(dataoke)).toEqual([]);
  expect(dataoke.searchSlot).not.toHaveBeenCalled();

  const official = setup({ searchSource: 'official', withDataoke: true });
  await search(official);
  expect(searchRequests(official)).toHaveLength(1);
  expect(official.searchSlot).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zx#46] 开关 dataoke 但没有大淘客客户端 → 仍 adapter_unimplemented，不回落官方；切 official 才搜索', async () => {
  const bare = setup({ searchSource: 'dataoke', withDataoke: false });
  await unionFailure(() => bare.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expect(bare.searchSlot).not.toHaveBeenCalled();
  expectNothingSent(bare);

  const official = setup({ searchSource: 'official', withDataoke: false });
  await search(official);
  expect(searchRequests(official)).toHaveLength(1);
});

it.each(['absent', 'official'] as const)(
  '[AC-B1-04zx#47] 开关 %s 但缺官方依赖（没有推广位读者）→ 保持 adapter_unimplemented，不取凭据、不发请求；注入后才搜索',
  async (searchSource) => {
    const missing = setup({ searchSource, withSlotReader: false });
    await unionFailure(() => missing.adapter.searchItems(query, ctx), 'adapter_unimplemented');
    expectNothingSent(missing);

    const wired = setup({ searchSource, withSlotReader: true });
    await search(wired);
    expect(searchRequests(wired)).toHaveLength(1);
  },
);
