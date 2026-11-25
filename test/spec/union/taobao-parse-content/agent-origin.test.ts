import { expect, it } from 'vitest';
import { ok, setup as setupDataoke } from '../dataoke-core/kit.ts';
import { ctx, DETAIL, detailSetup, formOf, sent, unionFailure } from '../taobao-goods/kit.ts';
import { enableThirdPartyParse } from './settings.ts';

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
  const taobao = detailSetup([{ item_id: itemId }], {
    orderSource: dataoke.client,
    ...enableThirdPartyParse(ctx.appId),
  });
  const agentContext = { ...ctx, origin: 'agent' } as const;

  // 主干会拒绝普通来源的推广链，让失败落在请求次数断言上。
  await taobao.adapter.resolveLink(raw, ctx).catch(() => undefined);
  expect(dataoke.transport).toHaveBeenCalledTimes(1);

  dataoke.credentials.mockClear();
  dataoke.transport.mockClear();
  taobao.credentials.mockClear();
  taobao.transport.mockClear();

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
