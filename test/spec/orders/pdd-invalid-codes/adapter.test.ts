// B1-04zgc · 生产适配器接线（D10-1069 ⑥，spec-test r2 S1 / S2）：alerts.test.ts 只直接调 mapPddOrder 并自传
// logger；这里经生产适配器 PddUnionAdapter 拉单（listOrders increment / pay_time、getPddOrderDetail），告警出口是
// 适配器既有的 `warn` 选项（PddWarning；B1-04zgc 在骨架里扩了 alert / platform / fail_reason 与 event 值）。
// 状态 4 / 10 的订单：warn 收到 alert order_reason_sub_unmapped（platform pdd、fail_reason 原值）；毛额
// promotion_amount > 0 时另收到 alert pdd_invalid_with_commission（净额为 0 或服务费缺失也算）。整条告警序列
// 不含订单号、单号、金额、用户；不传 warn 时拉单照常成功。其他状态不打这两条。报文全部合成。
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  TimeWindow,
  UnionEndpoint,
  UnionOrder,
  UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import type { PddWarning } from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import {
  COMMISSION_ALERT,
  CUSTOM_PARAMETERS,
  FAIL_REASON,
  INVALID_STATUSES,
  MEMBER_UID,
  ORDER_SN,
  PLATFORM_ORDER_ID,
  PROMOTION_AMOUNT,
  SERVICE_FEE,
  SLOT,
  UNMAPPED_ALERT,
  expectRedacted,
  pddRow,
} from './kit.ts';

type Source = 'increment' | 'range' | 'detail';

/** 三个订单接口名（同 PddWarning.type 的取值）。 */
const METHOD: Readonly<Record<Source, string>> = {
  increment: 'pdd.ddk.order.list.increment.get',
  range: 'pdd.ddk.order.list.range.get',
  detail: 'pdd.ddk.order.detail.get',
};

const LIST_SOURCES = ['increment', 'range'] as const;
const ALL_SOURCES = [...LIST_SOURCES, 'detail'] as const;

const CTX: CallCtx = {
  appId: 'syn-app-inv',
  requestId: 'syn-request-inv',
  purpose: 'order_sync',
};

const ENDPOINT: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://orders-gateway.invalid/router',
  quotaKey: 'syn-quota-inv',
};

/** 注入时钟 2026-11-08T02:00Z；increment 窗口不超 24 小时、不早于 90 天前。 */
const NOW = '2026-11-08T02:00:00Z';
const WIN: TimeWindow = { from: '2026-11-07T03:00:00Z', to: '2026-11-08T01:00:00Z' };

/** 一个只回这几行报文的生产适配器；warn 为 undefined 时不传 warn 选项。 */
function adapterWith(
  rows: readonly Record<string, unknown>[],
  source: Source,
  warn: ((event: PddWarning) => void) | undefined,
) {
  const transport = vi.fn<UnionTransport>(async (request) => {
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe(METHOD[source]);
    const reply =
      source === 'detail'
        ? { order_detail_response: rows[0] }
        : { order_list_get_response: { order_list: rows, last_order_id: '' } };
    return { status: 200, headers: {}, body: JSON.stringify(reply) };
  });
  const adapter = new PddUnionAdapter({
    clock: new FixedClock(NOW),
    credentials: async () => ({ clientId: 'syn-client-inv', clientSecret: 'syn-secret-inv' }),
    transport,
    endpoint: ENDPOINT,
    ...(warn === undefined ? {} : { warn }),
  });
  return { adapter, transport };
}

/** 经适配器拉一次：列表一页（无下一页），详情一单。 */
async function pull(adapter: PddUnionAdapter, source: Source): Promise<readonly UnionOrder[]> {
  if (source === 'detail') return [await adapter.getPddOrderDetail(ORDER_SN, CTX)];
  const page = await adapter.listOrders(
    WIN,
    source === 'range' ? { queryMode: 'pay_time' } : {},
    CTX,
  );
  expect(page.nextCursor).toBeNull();
  return page.items;
}

/** 测试用 warn：记下每条 PddWarning。 */
function recorder() {
  const warn = vi.fn<(event: PddWarning) => void>();
  const events = (): PddWarning[] => warn.mock.calls.map(([event]) => event);
  return {
    warn,
    events,
    unmapped: () => events().filter((event) => event.alert === UNMAPPED_ALERT),
    withCommission: () => events().filter((event) => event.alert === COMMISSION_ALERT),
  };
}

/** 一条 PddWarning 照 kit 的口径查脱敏（字段名 / 值都不带单号、金额、用户；fail_reason 原值除外）。 */
function expectEventRedacted(event: PddWarning, raw: string | null = null): void {
  expectRedacted({ fields: Object.fromEntries(Object.entries(event)), message: undefined }, raw);
}

/** 整条告警序列序列化后不含订单号、平台单号、推广位、归因参数与用户码，也不含任一金额。 */
function expectSequenceRedacted(events: readonly PddWarning[], amounts: readonly number[]): void {
  const whole = JSON.stringify(events);
  for (const secret of [ORDER_SN, PLATFORM_ORDER_ID, SLOT, MEMBER_UID, CUSTOM_PARAMETERS]) {
    expect(whole.includes(secret), 'warn sequence carries an order, slot or user identifier').toBe(
      false,
    );
  }
  for (const amount of amounts) {
    expect(
      new RegExp(`(^|\\D)${amount}(\\D|$)`).test(whole),
      `warn sequence carries amount ${amount}`,
    ).toBe(false);
  }
}

const FAIL_REASONS = [
  ['原文', { fail_reason: FAIL_REASON }, FAIL_REASON],
  ['空串', { fail_reason: '' }, ''],
  ['JSON null', { fail_reason: null }, null],
  ['缺失', {}, null],
] as const;

const LIST_CASES = LIST_SOURCES.flatMap((source) =>
  INVALID_STATUSES.flatMap((status) =>
    FAIL_REASONS.map(([name, patch, raw]) => [source, status, name, patch, raw] as const),
  ),
);

it.each(LIST_CASES)(
  '[AC-B1-04zgc#9] 生产适配器 %s 拉单 order_status %s、fail_reason %s、无佣金：warn 恰收到一条 alert order_reason_sub_unmapped（platform pdd、type 为接口名、fail_reason 原值），不收 pdd_invalid_with_commission，不带单号 / 金额 / 用户；DTO 原码不变',
  async (source, status, _name, patch, raw) => {
    const log = recorder();
    const { adapter } = adapterWith([pddRow({ order_status: status, ...patch })], source, log.warn);
    const items = await pull(adapter, source);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ raw_status: String(status), commission_fen: 0n });
    const unmapped = log.unmapped();
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({
      alert: UNMAPPED_ALERT,
      event: UNMAPPED_ALERT,
      error_code: UNMAPPED_ALERT,
      platform: 'pdd',
      type: METHOD[source],
    });
    expect(unmapped[0]!.fail_reason ?? null).toBe(raw);
    expectEventRedacted(unmapped[0]!, raw);
    expect(log.withCommission()).toEqual([]);
    expect(log.events()).toHaveLength(1);
    expectSequenceRedacted(log.events(), []);
  },
);

it.each(INVALID_STATUSES)(
  '[AC-B1-04zgc#10] 生产适配器详情拉单 order_status %s（详情字段表不含 fail_reason，按缺失计）：warn 恰收到一条 alert order_reason_sub_unmapped（platform pdd、type 为详情接口名、fail_reason 为 null），不带单号 / 金额 / 用户',
  async (status) => {
    const log = recorder();
    const { adapter } = adapterWith(
      [pddRow({ order_status: status, fail_reason: FAIL_REASON })],
      'detail',
      log.warn,
    );
    const items = await pull(adapter, 'detail');
    expect(items[0]).toMatchObject({ raw_status: String(status) });
    const unmapped = log.unmapped();
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({
      alert: UNMAPPED_ALERT,
      event: UNMAPPED_ALERT,
      error_code: UNMAPPED_ALERT,
      platform: 'pdd',
      type: METHOD.detail,
    });
    expect(unmapped[0]!.fail_reason ?? null).toBeNull();
    expectEventRedacted(unmapped[0]!);
    expect(log.withCommission()).toEqual([]);
    expect(log.events()).toHaveLength(1);
  },
);

/**
 * 佣金告警按毛额 promotion_amount > 0 判（S2）：常规净额为正、净额为 0（毛额 100 = 服务费 100）、
 * 服务费缺失或 JSON null（净额 null）都告警。
 */
const COMMISSION_PATCHES = [
  [
    '净额为正',
    { promotion_amount: PROMOTION_AMOUNT, duo_id_service_fee: SERVICE_FEE },
    BigInt(PROMOTION_AMOUNT),
    BigInt(PROMOTION_AMOUNT - SERVICE_FEE),
    [PROMOTION_AMOUNT, SERVICE_FEE, PROMOTION_AMOUNT - SERVICE_FEE],
  ],
  ['净额为 0', { promotion_amount: 100, duo_id_service_fee: 100 }, 100n, 0n, [100]],
  ['服务费缺失', { promotion_amount: 100, duo_id_service_fee: undefined }, 100n, null, [100]],
  ['服务费 JSON null', { promotion_amount: 100, duo_id_service_fee: null }, 100n, null, [100]],
] as const;

const COMMISSION_CASES = ALL_SOURCES.flatMap((source) =>
  INVALID_STATUSES.flatMap((status) =>
    COMMISSION_PATCHES.map(
      ([name, patch, gross, net, amounts]) =>
        [source, status, name, patch, gross, net, amounts] as const,
    ),
  ),
);

it.each(COMMISSION_CASES)(
  '[AC-B1-04zgc#11] 生产适配器 %s 拉单 order_status %s 却有佣金（%s，毛额 promotion_amount > 0）：照样给原码按失效，warn 另收到一条 alert pdd_invalid_with_commission（platform pdd、type 为接口名），共两条，整条序列不带单号 / 金额 / 用户',
  async (source, status, _name, patch, gross, net, amounts) => {
    const log = recorder();
    const { adapter } = adapterWith(
      [pddRow({ order_status: status, fail_reason: FAIL_REASON, ...patch })],
      source,
      log.warn,
    );
    const items = await pull(adapter, source);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      raw_status: String(status),
      commission_fen: gross,
      est_commission_fen: net,
    });
    const unmapped = log.unmapped();
    const withCommission = log.withCommission();
    expect(unmapped).toHaveLength(1);
    expect(withCommission).toHaveLength(1);
    expect(withCommission[0]).toMatchObject({
      alert: COMMISSION_ALERT,
      event: COMMISSION_ALERT,
      error_code: COMMISSION_ALERT,
      platform: 'pdd',
      type: METHOD[source],
    });
    expect(unmapped[0]!.fail_reason ?? null).toBe(source === 'detail' ? null : FAIL_REASON);
    expectEventRedacted(withCommission[0]!);
    expectEventRedacted(unmapped[0]!, source === 'detail' ? null : FAIL_REASON);
    expect(log.events()).toHaveLength(2);
    expectSequenceRedacted(log.events(), amounts);
  },
);

/** 状态表内外的其他码（含缺失的 order_status）。 */
const OTHER_STATUSES = [0, 1, 2, 3, 5, 6, 9, 11, 99, null] as const;

const OTHER_CASES = LIST_SOURCES.flatMap((source) =>
  OTHER_STATUSES.map((status) => [source, status] as const),
);

it.each(OTHER_CASES)(
  '[AC-B1-04zgc#12] 生产适配器 %s 同页里 order_status %s（有佣金、有 fail_reason）的订单不打这两条告警：warn 只收到同页状态 4 那单的一条 order_reason_sub_unmapped',
  async (source, status) => {
    const log = recorder();
    const { adapter } = adapterWith(
      [
        pddRow({
          order_status: status,
          promotion_amount: PROMOTION_AMOUNT,
          duo_id_service_fee: SERVICE_FEE,
          fail_reason: FAIL_REASON,
        }),
        pddRow({ order_status: 4, order_sn: 'SYN-PDD-INV-other' }),
      ],
      source,
      log.warn,
    );
    const items = await pull(adapter, source);
    expect(items.map((item) => item.raw_status)).toEqual([
      status === null ? null : String(status),
      '4',
    ]);
    expect(log.withCommission()).toEqual([]);
    expect(log.unmapped()).toHaveLength(1);
    expect(log.events()).toHaveLength(1);
  },
);

const NO_WARN_CASES = ALL_SOURCES.flatMap((source) =>
  INVALID_STATUSES.map((status) => [source, status] as const),
);

it.each(NO_WARN_CASES)(
  '[AC-B1-04zgc#13] 生产适配器 %s 拉单 order_status %s（有佣金）：不传 warn 时拉单照常成功、不抛错，DTO 与传 warn 时相同；传 warn 时同一报文收到两条告警',
  async (source, status) => {
    const row = pddRow({
      order_status: status,
      promotion_amount: PROMOTION_AMOUNT,
      duo_id_service_fee: SERVICE_FEE,
      fail_reason: FAIL_REASON,
    });
    const bare = adapterWith([row], source, undefined);
    const withoutWarn = await pull(bare.adapter, source);
    expect(bare.transport).toHaveBeenCalledTimes(1);
    expect(withoutWarn).toHaveLength(1);
    expect(withoutWarn[0]).toMatchObject({ raw_status: String(status) });
    const log = recorder();
    const wired = adapterWith([row], source, log.warn);
    const withWarn = await pull(wired.adapter, source);
    expect(withWarn).toEqual(withoutWarn);
    expect(log.unmapped()).toHaveLength(1);
    expect(log.withCommission()).toHaveLength(1);
    expect(log.events()).toHaveLength(2);
  },
);
