import { expect, it } from 'vitest';
import { ok, setup as setupDataoke } from '../dataoke-core/kit.ts';
import { ctx, DETAIL, detailSetup, formOf, sent, unionFailure } from '../taobao-goods/kit.ts';

const goodsId = '9007199254740993123';
const itemId = 'Synthetic-AgentItem01';

it.each([
  ['s.click 推广短链', 'https://s.click.taobao.com/t?e=SyntheticAgent01'],
  ['uland 推广链接', 'https://uland.taobao.com/coupon/edetail?e=SyntheticAgent01'],
  ['淘口令', '￥SyntheticAgent01￥'],
  ['m.tb.cn 短链', 'https://m.tb.cn/h.SyntheticAgent01'],
])('[AC-B1-04zzzzo#11] Agent 的 %s 不走大淘客，商品页仍可官方直查', async (_kind, raw) => {
  const dataoke = setupDataoke();
  dataoke.transport.mockResolvedValue(ok({ goodsId }));
  const taobao = detailSetup([{ item_id: itemId }], { orderSource: dataoke.client });
  const agentContext = { ...ctx, origin: 'agent' } as const;

  await unionFailure(() => taobao.adapter.resolveLink(raw, agentContext), 'adapter_unimplemented');
  expect(dataoke.credentials).not.toHaveBeenCalled();
  expect(dataoke.transport).not.toHaveBeenCalled();
  expect(taobao.credentials).not.toHaveBeenCalled();
  expect(taobao.transport).not.toHaveBeenCalled();

  const productUrl = `https://item.taobao.com/item.htm?id=${goodsId}`;
  await expect(taobao.adapter.resolveLink(productUrl, agentContext)).resolves.toStrictEqual({
    item: { platform: 'taobao', item_id: itemId },
  });
  expect(taobao.transport).toHaveBeenCalledTimes(1);
  expect(formOf(sent(taobao.transport))).toMatchObject({ method: DETAIL, item_id: goodsId });
  expect(dataoke.credentials).not.toHaveBeenCalled();
  expect(dataoke.transport).not.toHaveBeenCalled();
});
