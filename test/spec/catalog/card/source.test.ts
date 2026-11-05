// price_unavailable 卡的 link_id 形状待契约同步（BR-PRICE-01 与 ProductCard.link_id 必填冲突），由后续契约任务与 B1-07a 覆盖。
// BR-PRICE-07 has no public entry_source enum. These names are the module's input convention.
// Sharing landing pages/posters are not ProductCard displays; their amount suppression is outside this task.
// B1-05zc (D10-641, BR-PRICE-07 2026-11-05): entry_source no longer decides a compare risk. Every
// source quotes on the normal basis (one amount); entry_source is still read, inherited and
// registered as before (link reuse and statistics only).
import { expect, it } from 'vitest';
import { fen, fixture, request, viewer } from './kit.ts';

it.each([
  { source: 'feed', basis: 'normal' },
  { source: 'pool', basis: 'normal' },
  { source: 'tlj_pool', basis: 'normal' },
])(
  '[AC-B1-05f#12] BR-PRICE-07：淘宝无预判结果，$source 按 $basis 报价',
  async ({ source, basis }) => {
    const f = fixture();
    const input = request({ entrySource: source });
    const card = await f.service.assemble(input);
    expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
      buyType: 'self',
      entrySource: source,
      rebateBasis: basis,
    });
    expect(card.rebate_basis).toBe(basis);
    expect(fen(card.rebate_max_fen)).toBe(433n);
    expect(fen(card.rebate_min_fen)).toBe(basis === 'normal' ? 433n : 211n);
    expect(f.entrySource).not.toHaveBeenCalled();
  },
);

// B1-05zc (D10-641): the rows the base table sent to price_compare_risk now quote one amount on the
// normal basis (433–433); the old range was 211–433.
it.each(['parse', 'search', 'agent', 'agent_refresh', 'detail', 'watch', null, 'unknown_source'])(
  '[AC-B1-05f#12] BR-PRICE-07：淘宝 %s 来源一律按 normal 单值报价',
  async (source) => {
    const f = fixture();
    const input = request({ entrySource: source });
    const card = await f.service.assemble(input);
    expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
      buyType: 'self',
      entrySource: source,
      rebateBasis: 'normal',
    });
    expect(card.rebate_basis).toBe('normal');
    expect(fen(card.rebate_max_fen)).toBe(433n);
    expect(fen(card.rebate_min_fen)).toBe(433n);
    expect(f.entrySource).not.toHaveBeenCalled();
  },
);

it.each([
  { origin: 'pool', basis: 'normal' },
  { origin: 'feed', basis: 'normal' },
  { origin: 'tlj_pool', basis: 'normal' },
  { origin: 'share_panel', basis: 'normal' },
  { origin: 'share_landing', basis: 'normal' },
])(
  '[AC-B1-05f#13] BR-PRICE-07：详情、提醒和派生请求继承服务端来源 $origin',
  async ({ origin, basis }) => {
    for (const entrySource of ['detail', 'watch', 'rebate_quote']) {
      const f = fixture();
      f.entrySource.mockResolvedValue(origin);
      const input = request({ entrySource, sourceLinkId: 'source-link' });
      const card = await f.service.assemble(input);
      expect(f.entrySource).toHaveBeenCalledExactlyOnceWith('card-app-a', 'source-link');
      expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
        buyType: 'self',
        entrySource: origin,
        rebateBasis: basis,
      });
      expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ entrySource: origin }));
      expect(card.rebate_basis).toBe(basis);
    }
  },
);

// B1-05zc (D10-641): origins the base table sent to price_compare_risk are still inherited and
// registered, but now quote on the normal basis.
it.each(['search', 'parse', 'agent', null])(
  '[AC-B1-05f#13] BR-PRICE-07：详情、提醒和派生请求继承服务端来源 %s 登记，报价一律 normal',
  async (origin) => {
    for (const entrySource of ['detail', 'watch', 'rebate_quote']) {
      const f = fixture();
      f.entrySource.mockResolvedValue(origin);
      const input = request({ entrySource, sourceLinkId: 'source-link' });
      const card = await f.service.assemble(input);
      expect(f.entrySource).toHaveBeenCalledExactlyOnceWith('card-app-a', 'source-link');
      expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
        buyType: 'self',
        entrySource: origin,
        rebateBasis: 'normal',
      });
      expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ entrySource: origin }));
      expect(card.rebate_basis).toBe('normal');
    }
  },
);

it('[AC-B1-05f#14] BR-PRICE-11：同商品换来源必须重新报价，两次都是单值且小字 rebate_estimate', async () => {
  const f = fixture();
  const input = request();
  const search = await f.service.assemble(input);
  const pool = await f.service.assemble({ ...input, entrySource: 'pool' });
  for (const card of [search, pool]) {
    expect(card.rebate_basis).toBe('normal');
    expect(fen(card.rebate_min_fen)).toBe(433n);
    expect(fen(card.rebate_max_fen)).toBe(433n);
    expect(card.disclaimer_keys).toEqual(['price_basis', 'rebate_estimate']);
  }
  expect(f.quoted).toHaveBeenCalledTimes(2);
  expect(f.quoted.mock.calls.map(([, , context]) => context?.entrySource)).toEqual([
    'search',
    'pool',
  ]);
});

it('[AC-B1-05f#15] 来源读取按服务端应用隔离，读不到时登记 null，报价仍按 normal 单值', async () => {
  const f = fixture();
  f.current.mockResolvedValue(viewer({ appId: 'card-app-b' }));
  const input = request({
    entrySource: 'detail',
    sourceLinkId: 'foreign-link',
    ref: { ...request().ref, appId: 'card-app-b' },
  });
  const card = await f.service.assemble(input);
  expect(f.entrySource).toHaveBeenCalledExactlyOnceWith('card-app-b', 'foreign-link');
  expect(card.rebate_basis).toBe('normal');
  expect(fen(card.rebate_min_fen)).toBe(fen(card.rebate_max_fen));
  expect(f.register).toHaveBeenCalledWith(
    expect.objectContaining({
      viewer: viewer({ appId: 'card-app-b' }),
      entrySource: null,
    }),
  );
});
