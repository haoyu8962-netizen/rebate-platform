import { expect, it } from 'vitest';
import { kit, noSearch } from './kit.ts';

it('[AC-B3-05n#150] 生产 stream/mount 的 body 装配实际接入新分流和订单工具', async () => {
  const h = kit();
  const out = await h.mounted('查一下我的订单');
  noSearch(h);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(out.events.some((e) => e.kind === 'card' && e.card.type === 'order_status')).toBe(true);
  expect(out.complete).not.toHaveBeenCalled();
  expect(out.traces.at(-1)?.model).toBeNull();
});

it('[AC-B3-05n#151] 生产装配传入页面配置，钱包问法不再落到搜索', async () => {
  const h = kit();
  const out = await h.mounted('钱包在哪');
  noSearch(h);
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(out.events).toContainEqual({
    kind: 'card',
    card: expect.objectContaining({
      type: 'page_guide',
      data: { route: 'Wallet', text_key: 'agent.guide.Wallet' },
    }),
  });
  expect(out.complete).not.toHaveBeenCalled();
});

it('[AC-B3-05n#152] 生产装配传递关闭的页面开关，不能只在新工厂里生效', async () => {
  const h = kit();
  h.settings.set('agent.page_guide.enabled', false);
  const out = await h.mounted('钱包在哪');
  noSearch(h);
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(out.events.some((e) => e.kind === 'card')).toBe(false);
  expect(h.text).toHaveBeenCalledWith('synthetic-app', 'agent.guide.unavailable');
});
