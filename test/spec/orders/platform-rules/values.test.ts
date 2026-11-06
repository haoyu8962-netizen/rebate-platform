import { expect, it, vi } from 'vitest';
import { attributeOrderUser } from '../../../../apps/api/src/modules/orders/application/attribute-user.ts';
import { storedUnionOrder } from '../../../../apps/api/src/modules/orders/application/claim-review.ts';
import { createOrderSourcePorts } from '../../../../apps/api/src/modules/orders/application/source-ports.ts';
import { classifyBuyType } from '../../../../apps/api/src/modules/orders/domain/attribution.ts';
import { claimCompareValue } from '../../../../apps/api/src/modules/orders/domain/claim-rules.ts';
import { manualSyncPlatforms } from '../../../../apps/api/src/modules/orders/domain/manual-sync.ts';
import { PLATFORM_RULES } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import {
  INCREMENT_WINDOW_CAP_MS,
  scheduledPlatforms,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { normalizeOrderNo } from '../../../../apps/api/src/modules/orders/infra/rights-order-lookup.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  PARAM_SAMPLES,
  PINNED,
  REGISTERED_PLATFORMS,
  params,
  platformsWhere,
  rulesOf,
  tableAttrCode,
  type RegisteredPlatform,
} from './kit.ts';

const AT = new Date('2026-10-12T02:03:04Z');

it('[AC-B1-08za#3] 归因参数解析：京东只读 subUnionId 整串第 1 组，拼多多只读 custom_parameters（app=n、8 位字符串 uid），互不借用', () => {
  const cases: Record<'jd' | 'pdd', readonly [ReturnType<typeof params>, string | null][]> = {
    jd: [
      [params({ sub_union_id: 'n_abcd1234' }), 'abcd1234'],
      [params({ sub_union_id: 'n_abcd1234_lk01' }), 'abcd1234'],
      [params({ sub_union_id: `n_abcd1234_${'0'.repeat(16)}` }), 'abcd1234'],
      [params({ sub_union_id: 'n_abcd1234_' }), null],
      [params({ sub_union_id: 'n_abcd1234\n' }), null],
      [params({ sub_union_id: 'n_ABCD1234' }), null],
      [params({ sub_union_id: `n_abcd1234_${'a'.repeat(17)}` }), null],
      [params({ sub_union_id: '' }), null],
      [params({ custom_parameters: '{"app":"n","uid":"wxyz5678"}' }), null],
    ],
    pdd: [
      [params({ custom_parameters: '{"app":"n","uid":"wxyz5678"}' }), 'wxyz5678'],
      [
        params({ custom_parameters: '{"uid":"wxyz5678","lk":"a1","app":"n","sc":"share"}' }),
        'wxyz5678',
      ],
      [params({ custom_parameters: '{"app":"n","uid":12345678}' }), null],
      [params({ custom_parameters: '{"app":"x","uid":"wxyz5678"}' }), null],
      [params({ custom_parameters: '{"uid":"wxyz5678"}' }), null],
      [params({ custom_parameters: '{"app":"n","uid":"WXYZ5678"}' }), null],
      [params({ custom_parameters: '{"app":"n","uid":"wxyz567"}' }), null],
      [params({ custom_parameters: '[]' }), null],
      [params({ custom_parameters: '{' }), null],
      [params({ custom_parameters: '' }), null],
      [params({ sub_union_id: 'n_abcd1234' }), null],
    ],
  };
  for (const platform of ['jd', 'pdd'] as const) {
    const rules = rulesOf(platform);
    expect(rules.attribution.kind, platform).toBe(PINNED[platform].attribution);
    for (const [input, expected] of cases[platform]) {
      expect(tableAttrCode(rules, input), `${platform} ${JSON.stringify(input)}`).toBe(expected);
    }
  }
});

it('[AC-B1-08za#4] 归因方式：淘宝走 relation_id 绑定、不解析 attr_code；京东 / 拼多多按 attr_code 查用户、不查绑定', async () => {
  const input = params({
    relation_id: 'relation-1',
    sub_union_id: 'n_abcd1234',
    custom_parameters: '{"app":"n","uid":"abcd1234"}',
  });
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    expect(rules.attribution.kind, platform).toBe(PINNED[platform].attribution);
    const ports = {
      users: {
        findByAttrCode: vi.fn<
          (input: { appId: string; attrCode: string }) => Promise<string | null>
        >(async () => 'user-1'),
      },
      bindings: {
        findByRelation: vi.fn<
          (input: {
            appId: string;
            unionAccountId: string;
            relationId: string;
          }) => Promise<readonly never[]>
        >(async () => []),
      },
    };
    const result = await attributeOrderUser(ports, {
      appId: 'app-1',
      platform,
      unionAccountId: 'account-1',
      params: input,
      attrAt: AT,
    });
    if (PINNED[platform].attribution === 'relation_id') {
      for (const sample of PARAM_SAMPLES) expect(tableAttrCode(rules, sample)).toBeNull();
      expect(ports.bindings.findByRelation).toHaveBeenCalledWith({
        appId: 'app-1',
        unionAccountId: 'account-1',
        relationId: 'relation-1',
      });
      expect(ports.users.findByAttrCode).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: 'unattributed',
        user_id: null,
        counter: 'attr_binding_miss',
        conflict: false,
      });
    } else {
      expect(ports.users.findByAttrCode).toHaveBeenCalledWith({
        appId: 'app-1',
        attrCode: 'abcd1234',
      });
      expect(ports.bindings.findByRelation).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'attributed', user_id: 'user-1' });
    }
  }
});

it('[AC-B1-08za#5] 来源短码：京东取 subUnionId 第 2 组，拼多多取 custom_parameters.lk（1–16 位 [0-9a-z]），淘宝恒为 null', () => {
  const cases: Record<RegisteredPlatform, readonly [ReturnType<typeof params>, string | null][]> = {
    jd: [
      [params({ sub_union_id: 'n_abcd1234_lk01' }), 'lk01'],
      [params({ sub_union_id: `n_abcd1234_${'z'.repeat(16)}` }), 'z'.repeat(16)],
      [params({ sub_union_id: 'n_abcd1234' }), null],
      [params({ sub_union_id: 'n_abcd1234_' }), null],
      [params({ sub_union_id: `n_abcd1234_${'a'.repeat(17)}` }), null],
      [params({ sub_union_id: 'n_abcd1234_LK01' }), null],
      [params({ custom_parameters: '{"lk":"a1b2c3"}' }), null],
    ],
    pdd: [
      [params({ custom_parameters: '{"app":"n","uid":"wxyz5678","lk":"a1b2c3"}' }), 'a1b2c3'],
      [params({ custom_parameters: `{"lk":"${'z'.repeat(16)}"}` }), 'z'.repeat(16)],
      [params({ custom_parameters: `{"lk":"${'z'.repeat(17)}"}` }), null],
      [params({ custom_parameters: '{"lk":"A1"}' }), null],
      [params({ custom_parameters: '{"lk":""}' }), null],
      [params({ custom_parameters: '{"lk":12}' }), null],
      [params({ custom_parameters: '[]' }), null],
      [params({ sub_union_id: 'n_abcd1234_lk01' }), null],
    ],
    taobao: PARAM_SAMPLES.map((sample) => [sample, null] as const),
  };
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    for (const [input, expected] of cases[platform]) {
      expect(rules.parseLinkCode(input), `${platform} ${JSON.stringify(input)}`).toBe(expected);
    }
  }
});

it('[AC-B1-08za#6] 购买场景回退：只有拼多多在推广位 fallback 时读 custom_parameters.sc；推广位场景已知时各平台都按推广位', () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const fallback = PINNED[platform].sceneParamFallback;
    expect(rules.sceneParamFallback, platform).toBe(fallback);
    expect(classifyBuyType(platform, 'fallback', '{"sc":"share"}'), platform).toEqual(
      fallback
        ? { buy_type: 'share', scene_basis: 'param' }
        : { buy_type: 'self', scene_basis: 'fallback' },
    );
    expect(classifyBuyType(platform, 'fallback', '{"sc":"taolijin"}'), platform).toEqual({
      buy_type: 'self',
      scene_basis: fallback ? 'param' : 'fallback',
    });
    for (const sc of ['{"sc":"weird"}', '{"sc":"fallback"}', '{"sc":1}', '{', null]) {
      expect(classifyBuyType(platform, 'fallback', sc), `${platform} ${sc}`).toEqual({
        buy_type: 'self',
        scene_basis: 'fallback',
      });
    }
    expect(classifyBuyType(platform, 'share', '{"sc":"self_buy"}'), platform).toEqual({
      buy_type: 'share',
      scene_basis: 'pid',
    });
    expect(classifyBuyType(platform, 'query', '{"sc":"share"}'), platform).toEqual({
      buy_type: 'self',
      scene_basis: 'fallback',
    });
  }
});

it('[AC-B1-08za#7] 单号规范化：拼多多两侧去掉全部连字符（保留前导零与空格），其他平台与未登记平台原样', () => {
  const samples = ['260101-12-3456--7', '000-12', '-', '12 -3', '2601011234567', ''];
  const stripped = ['2601011234567', '00012', '', '12 3', '2601011234567', ''];
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const strip = PINNED[platform].orderNoStripHyphens;
    expect(rules.orderNoStripHyphens, platform).toBe(strip);
    samples.forEach((no, i) => {
      const expected = strip ? stripped[i] : no;
      expect(normalizeOrderNo(platform, no), `${platform} ${no}`).toBe(expected);
      expect(claimCompareValue(platform, no), `${platform} ${no}`).toBe(expected);
    });
  }
  for (const platform of ['meituan', 'PDD', '']) {
    expect(claimCompareValue(platform, '260101-12-3456--7')).toBe('260101-12-3456--7');
  }
});

it('[AC-B1-08za#8] 商品键推送：京东不推（不读 key_prefix、返回 null），拼多多与淘宝按平台读 key_prefix 推导', async () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const pushes = PINNED[platform].pushesProductKey;
    expect(rules.pushesProductKey, platform).toBe(pushes);
    const keyPrefix = vi.fn<(platform: RegisteredPlatform) => Promise<string | null>>(
      async () => null,
    );
    const ports = createOrderSourcePorts({
      linkLogs: vi.fn(async () => []),
      keyPrefix,
      configValue: vi.fn(async () => null),
    });
    const order: UnionOrder = {
      platform,
      order_id: 'order-1',
      paid_fen: 100n,
      commission_fen: 10n,
      item_id: 'item-1',
      itemId: 'item-1',
      goods_sign: 'item-1',
    };
    expect(await ports.productKey({ platform, order }), platform).toBeNull();
    if (pushes) {
      expect(keyPrefix, platform).toHaveBeenCalledTimes(1);
      expect(keyPrefix, platform).toHaveBeenCalledWith(platform);
    } else {
      expect(keyPrefix, platform).not.toHaveBeenCalled();
    }
  }
});

it('[AC-B1-08za#9] 同步窗口上限：京东 60 分钟、拼多多 30 分钟，淘宝没有固定上限；调度与手动同步只列有上限的平台', () => {
  // B1-04zzl：淘宝进调度（B1-04zzb）前后两态过渡，合并后收紧为单态
  const TB = PLATFORM_RULES.taobao.syncWindowCapMs;
  expect([null, 20 * 60_000]).toContain(TB);
  const on = TB !== null;
  const pinned = (p: RegisteredPlatform): number | null =>
    p === 'taobao' ? TB : PINNED[p].syncWindowCapMs;
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const cap = pinned(platform);
    expect(rules.syncWindowCapMs, platform).toBe(cap);
    expect(INCREMENT_WINDOW_CAP_MS[platform], platform).toBe(cap ?? undefined);
    expect(Object.hasOwn(INCREMENT_WINDOW_CAP_MS, platform), platform).toBe(cap !== null);
  }
  // kit 的 PINNED 仍钉淘宝 null（不改 kit）；开态按 pinned() 现算，关态与原断言相同。
  const capped = on
    ? [...REGISTERED_PLATFORMS].filter((p) => pinned(p) !== null).sort()
    : platformsWhere('syncWindowCapMs', (cap) => cap !== null);
  expect(capped).toEqual(on ? ['jd', 'pdd', 'taobao'] : ['jd', 'pdd']);
  expect([...scheduledPlatforms()].sort()).toEqual(capped);
  expect([...manualSyncPlatforms()].sort()).toEqual(capped);
});

it('[AC-B1-08za#10] 商品 ID 字段名：淘宝 item_id、京东 itemId、拼多多 goods_sign；库内订单还原只填该平台那一个字段', () => {
  const row = {
    raw_item_id: 'item-1',
    sub_order_id: 'sub-1',
    parent_order_id: null,
    pay_amount_fen: 100n,
    est_commission_fen: 10n,
    pid: null,
    relation_id: null,
    custom_params: null,
    sub_union_id: null,
    shop_id: null,
  } as unknown as Parameters<typeof storedUnionOrder>[0];
  const fields = ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const;
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const field = PINNED[platform].itemIdField;
    expect(rules.itemIdField, platform).toBe(field);
    const order = storedUnionOrder(row, platform);
    for (const name of fields) {
      expect(Object.hasOwn(order, name), `${platform} ${name}`).toBe(name === field);
    }
    expect(order[field], platform).toBe('item-1');
  }
});
