// B1-08zza 源码旁单元测试：首次入库第 ④ 步的编排（buy-type-step.ts）与来源回填复用已读 link。不连库：
// 读口与来源端口都是替身，事务句柄只作透传标记。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { OrderAttributionLink } from '../../linking/index.ts';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { platformRules } from '../domain/platform-rules/index.ts';
import { decideBuyType, type BuyTypeStepInput } from './buy-type-step.ts';
import type { OrderPipelineDeps } from './pipeline-types.ts';
import { backfillOrderSource, type OrderSourcePorts } from './source-backfill.ts';

const at = (iso: string) => new FixedClock(iso).now();
const PAID = '2026-10-15T16:00:00.000Z';
const USER = '019a0000-0000-7000-8000-000000000042';
const trx = { marker: 'trx' } as unknown as Transaction<DB>;

function params(fields: Record<string, unknown>): UnionOrderAttrParams {
  return {
    relation_id: null,
    sub_union_id: null,
    custom_parameters: JSON.stringify({ app: 'n', uid: 'abcd1234', ...fields }),
  };
}

function input(patch: Partial<BuyTypeStepInput> = {}): BuyTypeStepInput {
  const p = patch.params ?? params({ lk: 'q7w2e9', sc: 'self_buy' });
  const order: UnionOrder = {
    platform: 'pdd',
    sub_order_id: 'synthetic-child',
    goods_id: '123',
    goods_sign: 'sign-1',
    paid_fen: 100n,
    paid_at: at(PAID),
    deposit_paid_at: null,
    attr_params: p,
  } as UnionOrder;
  return {
    appId: 'app-1',
    platform: 'pdd',
    order,
    params: p,
    pidScene: 'self_buy',
    userId: USER,
    ...patch,
  };
}

function link(patch: Partial<OrderAttributionLink> = {}): OrderAttributionLink {
  return {
    link_id: '019a0000-0000-7000-8000-0000000000aa',
    user_id: USER,
    platform: 'pdd',
    raw_item_id: 'sign-1',
    product_key: 'pp:999',
    created_at: at('2026-10-14T12:00:00.000Z'),
    pid_scene: 'share',
    scene: 'share',
    agent_session_id: null,
    ...patch,
  };
}

function reader(result: OrderAttributionLink | null) {
  return vi.fn<NonNullable<OrderPipelineDeps['readBuyTypeLink']>>().mockResolvedValue(result);
}

it('[AC-B1-08zza#U1] 带 lk：本事务按 (app_id, lk) 读一次，对得上按 link 判，返回读到的 link', async () => {
  const read = reader(link());
  const result = await decideBuyType(trx, { readBuyTypeLink: read }, input());
  // 用推广位 self_buy 或 sc 判、或不传事务句柄，这里都会红。
  expect(result).toEqual({ decision: { buy_type: 'share', scene_basis: 'link' }, link: link() });
  expect(read).toHaveBeenCalledExactlyOnceWith(trx, { appId: 'app-1', lk: 'q7w2e9' });
});

it('[AC-B1-08zza#U2] 带 lk 但不合法：不查库，按查不到判 self / fallback', async () => {
  const read = reader(link());
  const result = await decideBuyType(
    trx,
    { readBuyTypeLink: read },
    input({ params: params({ lk: 'BAD!', sc: 'share' }), pidScene: 'share' }),
  );
  expect(result).toEqual({ decision: { buy_type: 'self', scene_basis: 'fallback' }, link: null });
  expect(read).not.toHaveBeenCalled();
});

it('[AC-B1-08zza#U3] 缺 lk：规则 pid 照推广位判，规则 self 判 self / fallback，都不查库', async () => {
  const read = reader(link());
  const noLk = input({ params: params({ sc: 'self_buy' }), pidScene: 'share' });
  expect(await decideBuyType(trx, { readBuyTypeLink: read }, noLk)).toEqual({
    decision: { buy_type: 'share', scene_basis: 'pid' },
    link: undefined,
  });
  const selfRules = { ...platformRules('pdd'), missingLinkBuyTypeBasis: 'self' as const };
  expect(
    await decideBuyType(trx, { readBuyTypeLink: read, buyTypeRules: () => selfRules }, noLk),
  ).toEqual({ decision: { buy_type: 'self', scene_basis: 'fallback' }, link: undefined });
  expect(read).not.toHaveBeenCalled();
});

it('[AC-B1-08zza#U4] 不按链接判的平台（规则表为 null）或未注入读口：照推广位判，不查库', async () => {
  expect(platformRules('jd').missingLinkBuyTypeBasis).toBeNull();
  expect(platformRules('taobao').missingLinkBuyTypeBasis).toBeNull();
  const read = reader(link());
  const jd = input({ platform: 'jd', pidScene: 'share' });
  expect(await decideBuyType(trx, { readBuyTypeLink: read }, jd)).toEqual({
    decision: { buy_type: 'share', scene_basis: 'pid' },
    link: undefined,
  });
  expect(read).not.toHaveBeenCalled();
  expect(await decideBuyType(trx, {}, input({ pidScene: 'share' }))).toMatchObject({
    decision: { buy_type: 'share', scene_basis: 'pid' },
  });
});

it('[AC-B1-08zza#U5] goods_sign 不等才推商品键；推得相等仍按 link，没有来源端口按对不上', async () => {
  const read = reader(link({ raw_item_id: 'rotated', product_key: 'pp:123' }));
  const productKey = vi.fn<OrderSourcePorts['productKey']>().mockResolvedValue('pp:123');
  const sources = { linkLogs: vi.fn(), productKey } as unknown as OrderSourcePorts;
  expect((await decideBuyType(trx, { readBuyTypeLink: read, sources }, input())).decision).toEqual({
    buy_type: 'share',
    scene_basis: 'link',
  });
  expect(productKey).toHaveBeenCalledTimes(1);
  expect((await decideBuyType(trx, { readBuyTypeLink: read }, input())).decision).toEqual({
    buy_type: 'self',
    scene_basis: 'fallback',
  });
  productKey.mockClear();
  await decideBuyType(trx, { readBuyTypeLink: reader(link()), sources }, input());
  // goods_sign 已相等时不再读商品键。
  expect(productKey).not.toHaveBeenCalled();
});

it('[AC-B1-08zza#U6] 只付定金的预售按定金时刻比，link 晚于定金即对不上', async () => {
  const read = reader(link({ created_at: at('2026-10-14T12:00:00.001Z') }));
  const base = input();
  const presale = input({
    order: { ...base.order, paid_at: null, deposit_paid_at: at('2026-10-14T12:00:00.000Z') },
  });
  expect((await decideBuyType(trx, { readBuyTypeLink: read }, presale)).decision).toEqual({
    buy_type: 'self',
    scene_basis: 'fallback',
  });
});

it('[AC-B1-08zza#U7] 来源回填给了已读 link：exact 用它、不再调 linkByCode；开关关着不看 exact', async () => {
  const linkByCode = vi.fn<NonNullable<OrderSourcePorts['linkByCode']>>();
  const linkLogs = vi.fn<OrderSourcePorts['linkLogs']>().mockResolvedValue([]);
  const productKey = vi.fn<OrderSourcePorts['productKey']>().mockResolvedValue(null);
  const base = { appId: 'app-1', platform: 'pdd' as const, userId: USER, attrAt: at(PAID) };
  const order = input().order;
  const on: OrderSourcePorts = { linkLogs, productKey, linkByCode, clickCode: () => true };
  const hit = await backfillOrderSource(on, {
    ...base,
    pidScene: 'self_buy',
    order,
    shopId: null,
    exactLink: link({ scene: 'detail' }),
  });
  expect(hit).toEqual({
    source_match: 'exact',
    link_id: link().link_id,
    source_scene: 'detail',
    agent_session_id: null,
  });
  expect(linkByCode).not.toHaveBeenCalled();
  const off: OrderSourcePorts = { linkLogs, productKey, linkByCode, clickCode: () => false };
  const miss = await backfillOrderSource(off, {
    ...base,
    pidScene: 'self_buy',
    order,
    shopId: null,
    exactLink: link(),
  });
  expect(miss.source_match).toBe('none');
  expect(linkByCode).not.toHaveBeenCalled();
});
