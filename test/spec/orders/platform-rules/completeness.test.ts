import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import {
  PLATFORM_RULES,
  type ClaimAuthRule,
  type ItemIdField,
  type PlatformRules,
} from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import type {
  ItemRef,
  UnionOrderAttrParams,
} from '../../../../apps/api/src/modules/union/index.ts';
import { isPlatform } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  REGISTERED_PLATFORMS,
  RULE_KEYS,
  RULES_URL,
  rulesOf,
  type RegisteredPlatform,
  type RuleKey,
} from './kit.ts';

it('[AC-B1-08za#1] 每个已登记平台在 PLATFORM_RULES 里恰有一份、键齐全无多余；类型层缺平台或缺键即编译失败', () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    expect(Object.keys(rules).sort()).toEqual([...RULE_KEYS, 'missingLinkBuyTypeBasis'].sort());
    for (const key of [...RULE_KEYS, 'missingLinkBuyTypeBasis'] as const)
      expect(rules[key], `${platform}.${key}`).not.toBeUndefined();
  }
  expect(Object.keys(PLATFORM_RULES).sort()).toEqual([...REGISTERED_PLATFORMS].sort());
  // Type layer: a registered platform without an entry, or an entry without a key, does not compile.
  const table: Readonly<Record<RegisteredPlatform, PlatformRules>> = PLATFORM_RULES;
  expect(table).toBe(PLATFORM_RULES);
  expectTypeOf<keyof PlatformRules>().toEqualTypeOf<RuleKey | 'missingLinkBuyTypeBasis'>();
  expectTypeOf<PlatformRules['attribution']['kind']>().toEqualTypeOf<'attr_code' | 'relation_id'>();
  expectTypeOf<PlatformRules['parseLinkCode']>().toEqualTypeOf<
    (params: UnionOrderAttrParams) => string | null
  >();
  expectTypeOf<PlatformRules['sceneParamFallback']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlatformRules['serviceFeeDeducted']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlatformRules['taolijinPidScene']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlatformRules['orderNoStripHyphens']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlatformRules['claimAuth']>().toEqualTypeOf<ClaimAuthRule>();
  expectTypeOf<ClaimAuthRule>().toEqualTypeOf<'relation_id' | 'filing' | null>();
  expectTypeOf<PlatformRules['pushesProductKey']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlatformRules['syncWindowCapMs']>().toEqualTypeOf<number | null>();
  expectTypeOf<PlatformRules['itemIdField']>().toEqualTypeOf<ItemIdField>();
  expectTypeOf<ItemIdField>().toEqualTypeOf<Exclude<keyof ItemRef, 'platform'>>();
});

it('[AC-B1-08za#2] platform-rules/<platform>.ts 逐个已登记平台存在并导出表中那一份；目录里没有未登记平台的文件', async () => {
  const names = readdirSync(fileURLToPath(RULES_URL)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    expect(names, `platform-rules/${platform}.ts`).toContain(`${platform}.ts`);
    const file = (await import(new URL(`${platform}.ts`, RULES_URL).href)) as Record<
      string,
      unknown
    >;
    expect(file['rules'], `platform-rules/${platform}.ts rules`).toBe(rules);
  }
  const platformFiles = names.map((name) => name.slice(0, -'.ts'.length)).filter(isPlatform);
  expect(platformFiles.sort()).toEqual([...REGISTERED_PLATFORMS].sort());
});
