import { expect, it } from 'vitest';
import type { ConfigValue } from '../../../../apps/api/src/modules/content/index.ts';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ok,
  queryFields,
  sent as dataokeSent,
  setup as setupDataoke,
} from '../dataoke-core/kit.ts';
import { ctx, DETAIL, detailSetup, formOf, sent, unionFailure } from '../taobao-goods/kit.ts';
import { thirdPartyParseKey, thirdPartyParseSettings } from './settings.ts';

const goodsId = '9007199254740993123';
const itemId = 'Synthetic-SwitchItem01';
const inputs = [
  ['s.click 推广短链', 'https://s.click.taobao.com/t?e=SyntheticSwitch01'],
  ['uland 推广链接', 'https://uland.taobao.com/coupon/edetail?e=SyntheticSwitch01'],
  ['淘口令', '  【合成商品】￥SyntheticSwitch01￥\n'],
  ['m.tb.cn 短链', 'https://m.tb.cn/h.SyntheticSwitch01'],
] as const;
const disabledValues = [
  ['缺省', undefined],
  ['布尔 false', false],
  ['字符串 off', 'off'],
  ['字符串 true', 'true'],
  ['数字 1', 1],
  ['null', null],
] as const;
const blockedCases = disabledValues.flatMap(([setting, value]) =>
  inputs.map(([kind, raw]) => [setting, kind, value, raw] as const),
);
const resolved = { item: { platform: 'taobao', item_id: itemId } };

function setup(values: ReadonlyMap<string, ConfigValue>) {
  const settings = thirdPartyParseSettings(values);
  const dataoke = setupDataoke();
  dataoke.transport.mockResolvedValue(ok({ goodsId }));
  const taobao = detailSetup([{ item_id: itemId }], {
    orderSource: dataoke.client,
    ...settings,
  });
  expect(taobao.adapter.resolveLink).toBeTypeOf('function');
  return { taobao, dataoke, configValue: settings.config.configValue };
}

function expectNoUpstream({ taobao, dataoke }: ReturnType<typeof setup>) {
  expect(dataoke.credentials).not.toHaveBeenCalled();
  expect(dataoke.transport).not.toHaveBeenCalled();
  expect(dataoke.warn).not.toHaveBeenCalled();
  expect(taobao.credentials).not.toHaveBeenCalled();
  expect(taobao.transport).not.toHaveBeenCalled();
  expect(taobao.warn).not.toHaveBeenCalled();
}

async function expectFallback(
  { taobao, dataoke, configValue }: ReturnType<typeof setup>,
  raw: string,
  context: CallCtx,
) {
  const result = await taobao.adapter.resolveLink(raw, context).catch((error: unknown) => error);
  expect(result).toStrictEqual(resolved);
  expect(configValue).toHaveBeenCalledWith(context.appId, thirdPartyParseKey);
  expect(dataoke.transport).toHaveBeenCalledTimes(1);
  const request = dataokeSent(dataoke.transport);
  expect(new URL(request.url).pathname).toBe('/api/tb-service/parse-content');
  expect(request).toMatchObject({
    method: 'GET',
    archive: { appId: context.appId, kind: 'query' },
  });
  expect(queryFields(request)).toMatchObject({ content: raw, version: 'v1.0.0' });
  expect(taobao.transport).toHaveBeenCalledTimes(1);
  expect(formOf(sent(taobao.transport))).toMatchObject({ method: DETAIL, item_id: goodsId });
}

it.each(blockedCases)(
  '[AC-B1-04zzzzo#13] 品牌开关为%s时，%s停在本地，商品页仍官方直查',
  async (_setting, _kind, value, raw) => {
    const harness = setup(value === undefined ? new Map() : new Map([[ctx.appId, value]]));
    const { taobao, dataoke, configValue } = harness;

    await unionFailure(() => taobao.adapter.resolveLink(raw, ctx), 'adapter_unimplemented');
    expect(configValue).toHaveBeenCalledWith(ctx.appId, thirdPartyParseKey);
    expectNoUpstream(harness);

    const productUrl = `https://item.taobao.com/item.htm?id=${goodsId}`;
    await expect(taobao.adapter.resolveLink(productUrl, ctx)).resolves.toStrictEqual(resolved);
    expect(taobao.transport).toHaveBeenCalledTimes(1);
    expect(formOf(sent(taobao.transport))).toMatchObject({ method: DETAIL, item_id: goodsId });
    expect(dataoke.credentials).not.toHaveBeenCalled();
    expect(dataoke.transport).not.toHaveBeenCalled();
    expect(dataoke.warn).not.toHaveBeenCalled();
  },
);

it.each(inputs)(
  '[AC-B1-04zzzzo#14] 品牌开关打开后，Agent 的%s仍不调用大淘客',
  async (_kind, raw) => {
    const harness = setup(new Map([[ctx.appId, true]]));
    const { taobao, dataoke } = harness;
    await expectFallback(harness, raw, ctx);

    dataoke.credentials.mockClear();
    dataoke.transport.mockClear();
    taobao.credentials.mockClear();
    taobao.transport.mockClear();

    const agentContext = { ...ctx, origin: 'agent' } as const;
    await unionFailure(
      () => taobao.adapter.resolveLink(raw, agentContext),
      'adapter_unimplemented',
    );
    expectNoUpstream(harness);
  },
);

it.each(inputs)(
  '[AC-B1-04zzzzo#15] 品牌开关为 true 时，普通来源的%s可降级走大淘客',
  async (_kind, raw) => {
    const harness = setup(new Map([[ctx.appId, true]]));
    await expectFallback(harness, raw, ctx);
  },
);

it('[AC-B1-04zzzzo#16] 同一适配器处理 A 品牌开启和 B 品牌关闭的请求，各读自己的开关', async () => {
  const brandA = { ...ctx, appId: 'synthetic-switch-app-a' };
  const brandB = { ...ctx, appId: 'synthetic-switch-app-b' };
  const harness = setup(
    new Map([
      [brandA.appId, true],
      [brandB.appId, false],
    ]),
  );
  const { taobao, dataoke, configValue } = harness;
  const raw = inputs[2][1];
  await expectFallback(harness, raw, brandA);

  configValue.mockClear();
  dataoke.credentials.mockClear();
  dataoke.transport.mockClear();
  taobao.credentials.mockClear();
  taobao.transport.mockClear();

  await unionFailure(() => taobao.adapter.resolveLink(raw, brandB), 'adapter_unimplemented');
  expect(configValue).toHaveBeenCalledWith(brandB.appId, thirdPartyParseKey);
  expectNoUpstream(harness);
});
