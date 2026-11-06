// B1-04zzh（D10-692 S2）：推广位读取器返回空集合是配置错误（凑狸总有登记过的淘宝推广位，含 pending /
// active / retired），listOrders 必须抛错，不能 resolve 成 `{ items: [], nextCursor: null }` 让同步把窗口当成
// 「没有订单」推进水位。错误码按实现定；配置错误在取凭据、发请求之前发现。
import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import { govern, win } from '../taobao-orders/kit.ts';
import { COLLECT, good, guarded, MODES, refusal } from './guard-kit.ts';

it.each(MODES)(
  '[AC-B1-04zzh#3] $mode：推广位读取器返回空集合 → listOrders reject（不返回空页），不取凭据、不发请求',
  async ({ call }) => {
    const s = guarded([good(1)], { slots: [] });
    await refusal(() => s.adapter.listOrders(win, {}, call));
    expect(s.orderSlots).toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzh#3] 经治理包装：推广位读取器返回空集合同样 reject，不返回空页、不发请求', async () => {
  const s = guarded([good(1)], { slots: [] });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  await refusal(() => govern(s.adapter, take).listOrders(win, {}, COLLECT));
  expect(s.orderSlots).toHaveBeenCalled();
  expect(s.transport).not.toHaveBeenCalled();
});
