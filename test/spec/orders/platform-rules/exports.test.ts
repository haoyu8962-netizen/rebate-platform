// B1-08za: the exports frozen tests import directly keep their names, modules and signatures
// (type layer: tsc), and each agrees with the rule table (runtime). The frozen tests' own
// behaviour assertions are not repeated here.
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import { expect, expectTypeOf, it } from 'vitest';
import { storedUnionOrder } from '../../../../apps/api/src/modules/orders/application/claim-review.ts';
import {
  classifyBuyType,
  parseAttrCode,
  type BuyTypeDecision,
} from '../../../../apps/api/src/modules/orders/domain/attribution.ts';
import { claimCompareValue } from '../../../../apps/api/src/modules/orders/domain/claim-rules.ts';
import {
  PID_SCENE_PLATFORM,
  SERVICE_FEE_PLATFORM,
} from '../../../../apps/api/src/modules/orders/domain/snapshot-retry.ts';
import { parseLinkCode as parseLinkCodeOfDomain } from '../../../../apps/api/src/modules/orders/domain/source-backfill.ts';
import {
  INCREMENT_WINDOW_CAP_MS,
  scheduledPlatforms,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { parseLinkCode } from '../../../../apps/api/src/modules/orders/index.ts';
import { normalizeOrderNo } from '../../../../apps/api/src/modules/orders/infra/rights-order-lookup.ts';
import type {
  UnionOrder,
  UnionOrderAttrParams,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  PARAM_SAMPLES,
  REGISTERED_PLATFORMS,
  rulesOf,
  tableAttrCode,
  type RegisteredPlatform,
} from './kit.ts';

it('[AC-B1-08za#20] parseAttrCode / classifyBuyType 仍从 domain/attribution.ts 导出、签名不变，且与规则表逐样本一致', () => {
  expectTypeOf(parseAttrCode).toEqualTypeOf<
    (platform: RegisteredPlatform, params: UnionOrderAttrParams) => string | null
  >();
  expectTypeOf(classifyBuyType).toEqualTypeOf<
    (
      platform: RegisteredPlatform,
      pidScene: string,
      customParameters: string | null,
    ) => BuyTypeDecision
  >();
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    for (const sample of PARAM_SAMPLES) {
      const label = `${platform} ${JSON.stringify(sample)}`;
      expect(parseAttrCode(platform, sample), label).toBe(tableAttrCode(rules, sample));
      if (!rules.sceneParamFallback) {
        expect(classifyBuyType(platform, 'fallback', sample.custom_parameters), label).toEqual({
          buy_type: 'self',
          scene_basis: 'fallback',
        });
      }
    }
  }
});

it('[AC-B1-08za#21] parseLinkCode 仍从 orders/index.ts 与 domain/source-backfill.ts 导出（同一函数）、签名不变，且与规则表逐样本一致', () => {
  expect(parseLinkCode).toBe(parseLinkCodeOfDomain);
  expectTypeOf(parseLinkCode).toEqualTypeOf<
    (platform: RegisteredPlatform, attrParams: UnionOrderAttrParams) => string | null
  >();
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    for (const sample of PARAM_SAMPLES) {
      expect(parseLinkCode(platform, sample), `${platform} ${JSON.stringify(sample)}`).toBe(
        rules.parseLinkCode(sample),
      );
    }
  }
});

it('[AC-B1-08za#22] SERVICE_FEE_PLATFORM / PID_SCENE_PLATFORM 仍从 domain/snapshot-retry.ts 导出、字面量类型不变；服务费项规则表里拼多多与淘宝打开，场景项淘宝是唯一打开的平台', () => {
  expectTypeOf(SERVICE_FEE_PLATFORM).toEqualTypeOf<'pdd'>();
  expectTypeOf(PID_SCENE_PLATFORM).toEqualTypeOf<'taobao'>();
  const deducting = REGISTERED_PLATFORMS.filter((p) => rulesOf(p).serviceFeeDeducted);
  const byScene = REGISTERED_PLATFORMS.filter((p) => rulesOf(p).taolijinPidScene);
  expect(deducting.sort()).toEqual([SERVICE_FEE_PLATFORM, 'taobao']);
  expect(byScene).toEqual([PID_SCENE_PLATFORM]);
});

it('[AC-B1-08za#23] scheduledPlatforms / INCREMENT_WINDOW_CAP_MS 仍从 domain/sync-window.ts 导出、签名不变，且与规则表的同步窗口上限一致', () => {
  expectTypeOf(scheduledPlatforms).toEqualTypeOf<() => readonly RegisteredPlatform[]>();
  expectTypeOf(INCREMENT_WINDOW_CAP_MS).toEqualTypeOf<
    Readonly<Partial<Record<RegisteredPlatform, number>>>
  >();
  const capped: RegisteredPlatform[] = [];
  for (const platform of REGISTERED_PLATFORMS) {
    const cap = rulesOf(platform).syncWindowCapMs;
    expect(INCREMENT_WINDOW_CAP_MS[platform], platform).toBe(cap ?? undefined);
    if (cap !== null) capped.push(platform);
  }
  expect([...scheduledPlatforms()].sort()).toEqual(capped.sort());
});

it('[AC-B1-08za#24] normalizeOrderNo / claimCompareValue 仍从原模块导出、签名不变，且与规则表的单号规范化一致', () => {
  expectTypeOf(normalizeOrderNo).toEqualTypeOf<
    (platform: RegisteredPlatform, platformOrderNo: string) => string
  >();
  expectTypeOf(claimCompareValue).toEqualTypeOf<(platform: string, orderNo: string) => string>();
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    for (const no of ['1-2345--6', '000123-456789', '123456', '-']) {
      const expected = rules.orderNoStripHyphens ? no.replaceAll('-', '') : no;
      expect(normalizeOrderNo(platform, no), `${platform} ${no}`).toBe(expected);
      expect(claimCompareValue(platform, no), `${platform} ${no}`).toBe(expected);
    }
  }
});

it('[AC-B1-08za#25] storedUnionOrder 仍从 application/claim-review.ts 导出、签名不变，商品 ID 落在规则表的字段名上', () => {
  expectTypeOf(storedUnionOrder).toEqualTypeOf<
    (order: Selectable<DB['orders']>, platform: RegisteredPlatform) => UnionOrder
  >();
  const row = {
    raw_item_id: 'item-2',
    sub_order_id: 'sub-2',
    parent_order_id: 'parent-2',
    pay_amount_fen: 200n,
    est_commission_fen: 20n,
    pid: 'pid-2',
    relation_id: null,
    custom_params: null,
    sub_union_id: null,
    shop_id: 'shop-2',
  } as unknown as Selectable<DB['orders']>;
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const order = storedUnionOrder(row, platform);
    expect(order[rules.itemIdField], platform).toBe('item-2');
  }
});
