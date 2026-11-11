// B1-18e（BR-CALC-03，D10-1250 ②）：服务费回退经生产装配入口 createUnionRegistry。注册表的
// serviceFeeConfig（按配置键 + CallCtx 读原值）交给真实淘宝适配器时只读 union.taobao.service_fee_bp，
// 交给真实拼多多适配器时只读 union.pdd.service_fee_bp，不串平台。假传输、假配置读取，不连库、不联网。
// 报文全部合成，行形状照 taobao-orders / taobao-net-n 与 pdd-orders 的已有夹具。
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ServiceFeeConfigReader,
  UnionEndpoint,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  createUnionRegistry,
  type UnionRegistry,
} from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { envelope, reply as pddReply } from '../orders-shape/kit.ts';
import {
  ctx as pddCtx,
  endpoint as pddEndpoint,
  row as pddRow,
  win as pddWin,
} from '../pdd-orders/kit.ts';
import { paidRow } from '../taobao-net-n/net-row.ts';
import {
  SLOTS,
  ctx as taobaoCtx,
  endpoint as taobaoEndpoint,
  listed,
  num,
  pageData,
  reply as taobaoReply,
  win as taobaoWin,
} from '../taobao-orders/kit.ts';

const TAOBAO_KEY = 'union.taobao.service_fee_bp';
const PDD_KEY = 'union.pdd.service_fee_bp';
/** 两个平台的窗口都在它之前 90 天内。 */
const clock = new FixedClock('2026-11-01T06:00:00.000Z');

const endpoints: readonly UnionEndpoint[] = [
  {
    platform: 'jd',
    mode: 'live',
    baseUrl: 'https://jd-service-fee.invalid/router',
    quotaKey: 'synthetic-service-fee-jd',
  },
  pddEndpoint,
  taobaoEndpoint,
];

/** 淘宝：未结算行，预估毛额 10.01 元，没有服务费金额（alimama_share_fee「--」、无 dto），也就没有费率。 */
const taobaoRow = paidRow(1, {
  pub_share_pre_fee_for_commission: num('10.01'),
  alimama_share_fee: '--',
  alimm_share_info_dto: undefined,
});

/** 拼多多：已支付（0），佣金毛额 1001 分，没有 duo_id_service_fee。 */
const pddInput = pddRow({
  order_status: 0,
  fail_reason: undefined,
  duo_id_service_fee: undefined,
  promotion_amount: 1001,
});

/** 真实淘宝、拼多多适配器经注册表装配；传输都是假的，`serviceFeeConfig` 原样给注册表。 */
function registryWith(serviceFeeConfig?: ServiceFeeConfigReader) {
  const dataokeTransport = vi.fn<UnionTransport>(async () => taobaoReply(pageData([taobaoRow])));
  const topTransport = vi.fn<UnionTransport>(async () =>
    expect.fail('listOrders must not use TOP'),
  );
  const pddTransport = vi.fn<UnionTransport>(async () => pddReply(envelope('increment', pddInput)));
  const registry = createUnionRegistry({
    endpoints,
    environment: 'staging',
    seed: 'service-fee-fallback',
    clock,
    taobaoLive: {
      credentials: async () => ({ appKey: 'fake-fee-taobao-key', appSecret: 'fee-fee-fee-fee' }),
      transport: topTransport,
      orderSource: {
        credentials: async () => ({ appKey: 'fake-fee-dataoke-key', appSecret: 'dtk-fee-dtk-fee' }),
        transport: dataokeTransport,
        random: () => 42,
        baseUrl: 'https://dataoke-service-fee.invalid',
      },
      orderSlots: async () => SLOTS,
    },
    pddLive: {
      credentials: async () => ({ clientId: 'synthetic-client', clientSecret: 'fake-secret' }),
      transport: pddTransport,
    },
    ...(serviceFeeConfig === undefined ? {} : { serviceFeeConfig }),
  });
  return { registry, dataokeTransport, pddTransport };
}

async function taobaoOrder(registry: UnionRegistry): Promise<UnionOrder> {
  const page = await listed(registry.get('taobao').listOrders(taobaoWin, {}, taobaoCtx));
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

async function pddOrder(registry: UnionRegistry): Promise<UnionOrder> {
  const page = await registry.get('pdd').listOrders(pddWin, { queryMode: 'increment' }, pddCtx);
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

it('[AC-B1-18e#18][BR-CALC-03] 生产装配 createUnionRegistry：serviceFeeConfig 交给淘宝适配器只读 union.taobao.service_fee_bp、交给拼多多适配器只读 union.pdd.service_fee_bp（不串平台，带该次 CallCtx）；缺金额与费率的淘宝行、缺 duo_id_service_fee 的拼多多行都按 "*" 600 bp 扣：1001 分 → 服务费 61、N 940', async () => {
  const read = vi.fn<ServiceFeeConfigReader>(async (key) =>
    key === TAOBAO_KEY || key === PDD_KEY
      ? { '*': { bp: 600, source: '合成来源：规则测试夹具', verified: true } }
      : null,
  );
  const { registry, dataokeTransport, pddTransport } = registryWith(read);
  // 装配本身不读配置。
  expect(read).not.toHaveBeenCalled();

  const taobao = await taobaoOrder(registry);
  expect(dataokeTransport).toHaveBeenCalled();
  expect(taobao).toMatchObject({
    platform: 'taobao',
    est_commission_fen: 940n,
    service_fee_fen: 61n,
  });
  expect(read).toHaveBeenCalled();
  expect(new Set(read.mock.calls.map(([key]) => key))).toEqual(new Set([TAOBAO_KEY]));
  for (const [, call] of read.mock.calls) expect(call.appId).toBe(taobaoCtx.appId);

  read.mockClear();
  const pdd = await pddOrder(registry);
  expect(pddTransport).toHaveBeenCalled();
  expect(pdd).toMatchObject({
    platform: 'pdd',
    est_commission_fen: 940n,
    service_fee_fen: 61n,
    commission_fen: 1001n,
  });
  expect(read).toHaveBeenCalled();
  expect(new Set(read.mock.calls.map(([key]) => key))).toEqual(new Set([PDD_KEY]));
  for (const [, call] of read.mock.calls) expect(call.appId).toBe(pddCtx.appId);

  // 附带：不给 serviceFeeConfig 即没有配置，两边都是 null（不按 0 扣）。
  const bare = registryWith();
  const bareTaobao = await taobaoOrder(bare.registry);
  expect(bareTaobao.est_commission_fen).toBeNull();
  expect(bareTaobao.service_fee_fen).toBeNull();
  const barePdd = await pddOrder(bare.registry);
  expect(barePdd.est_commission_fen).toBeNull();
  expect(barePdd.service_fee_fen).toBeNull();
});
