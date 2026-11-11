// B1-18c（BR-CALC-25 细则）：「未单列」按平台配置 union.<platform>.subsidy_itemized（boolean，默认 true）判定。
// taobao / jd / pdd 三个键登记在配置注册表，类型 boolean；它们是配置项，不是应急开关。credit.enabled.<platform>
// 不动（开关注册表默认关）。默认值 true 由读取方在未设值时取，见 pipeline.int.test.ts。
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-18c#8][BR-CALC-25] union.%s.subsidy_itemized 登记为 boolean 配置项，只登记一次；true / false 合法，字符串与数字不合法',
  (platform) => {
    const key = `union.${platform}.subsidy_itemized`;
    const spec = configItemSpecOf(key);
    expect(spec).toMatchObject({ key, valueType: 'boolean', options: null });
    expect(configRegistry().filter((entry) => entry.key === key)).toHaveLength(1);
    const registered = spec!;
    expect(configValueFits(registered, true)).toBe(true);
    expect(configValueFits(registered, false)).toBe(true);
    expect(configValueFits(registered, 'false')).toBe(false);
    expect(configValueFits(registered, 0)).toBe(false);

    // 是配置项，不是应急开关；credit.enabled.<platform> 仍是默认关的开关，不随本单改变。
    expect(switchSpecOf(key)).toBeNull();
    expect(switchSpecOf(`credit.enabled.${platform}`)).toMatchObject({
      pattern: 'credit.enabled.<platform>',
      defaultValue: false,
    });
  },
);
