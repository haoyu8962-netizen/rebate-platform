// B1-08zy（FU-TB-FEE-MISSING-METRIC，编排 D10-741 ⑤、D10-992 ①选 (a)）：已有 est 的单，后续报文服务费与 est 都缺
// （est 不覆盖、版本不前进，B1-08zh / B1-04zz）时，真实 createOrderPipeline / createOrderUpdateStep 走完后看 /metrics：
// - 新计数 couli_service_fee_missing_total 在对应 platform 序列 +1，拼多多与淘宝都计，另一个平台的序列不动；
// - 拼多多照旧双写：旧计数 couli_pdd_service_fee_missing_total +1、打一条 pdd_service_fee_missing；
// - 淘宝不计旧计数、不打旧事件（[AC-B1-04zz#21] 不变）；
// - 有服务费、带了 est、库里原本没有 est（新单缺费走待处理 SERVICE_FEE_RATE_MISSING，不在本单）都不计新计数；
// - 这一路的 warn / error 日志只有平铺字段，不含金额、平台单号、商品、归因参数（照旧事件的字段口径）。
// 真实库（@couli/db/testing），报文是合成的归一订单，夹具同 test/spec/orders/platform-status/kit.ts。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { fakePort, runUpdate, scenario } from '../commission-snapshot/db-kit.ts';

const TIMEOUT = 120_000;
const OLD_EVENT = 'pdd_service_fee_missing';
const RELATION_ID = '3200000002';
const PLATFORMS = ['pdd', 'taobao'] as const;
type CountedPlatform = (typeof PLATFORMS)[number];

const registry = createMetricsRegistry({ entry: 'worker' });

/** 首入报文的改动：不含 platform（平台由 stored() 的参数定，夹具只收 taobao / jd / pdd）。 */
type Patch = Partial<Omit<UnionOrder, 'platform'>>;

/** 归因参数按平台：拼多多用夹具默认的 custom_parameters，淘宝给 relation_id（未绑定，照 [AC-B1-04zz#21]）。 */
const ATTR: Readonly<Record<CountedPlatform, Patch>> = {
  pdd: {},
  taobao: {
    attr_params: { relation_id: RELATION_ID, sub_union_id: null, custom_parameters: null },
  },
};

/** 已入库的单：佣金 1000、服务费 100、est 900；patch 改首入报文。 */
function stored(platform: CountedPlatform, patch: Patch = {}) {
  return scenario(db, {
    platform,
    ...ATTR[platform],
    commission_fen: 1000n,
    est_commission_fen: 900n,
    service_fee_fen: 100n,
    ...patch,
  });
}

/** 后续报文：服务费与 est 都缺，佣金变成 1200。 */
const FEE_MISSING: Partial<UnionOrder> = {
  commission_fen: 1200n,
  est_commission_fen: null,
  service_fee_fen: null,
};

/** 出现在这一路上的金额（分）。 */
const AMOUNTS = [900n, 1000n, 100n, 1200n, 12345n, 120n, 1080n];

interface Counters {
  readonly pdd: number;
  readonly taobao: number;
  /** 旧的 couli_pdd_service_fee_missing_total（各序列合计）。 */
  readonly old: number;
}

/**
 * 当前 /metrics：新计数每个平台至多一条序列、只带 platform 标签。计过才有序列（编排 D10-1003），
 * 没有序列的平台按 0。
 */
async function counters(): Promise<Counters> {
  const exposition = await registry.render();
  const fresh = new Map<string, number>();
  let old = 0;
  for (const line of exposition.split('\n')) {
    const series = /^couli_service_fee_missing_total(\{.*\})? (\S+)$/.exec(line);
    if (series !== null) {
      const label = /^\{platform="([a-z]+)"\}$/.exec(series[1] ?? '');
      expect(label, `${line}: only the platform label`).not.toBeNull();
      expect(fresh.has(label![1]!), `${line}: one series per platform`).toBe(false);
      fresh.set(label![1]!, Number(series[2]));
    }
    const legacy = /^couli_pdd_service_fee_missing_total(?:\{.*\})? (\S+)$/.exec(line);
    if (legacy !== null) old += Number(legacy[1]);
  }
  for (const platform of fresh.keys()) {
    expect(PLATFORMS as readonly string[], `platform="${platform}"`).toContain(platform);
  }
  return { pdd: fresh.get('pdd') ?? 0, taobao: fresh.get('taobao') ?? 0, old };
}

/** 一次日志调用的文本（bigint 按十进制）。 */
function text(call: readonly unknown[]): string {
  return JSON.stringify(call, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function oldEvents(calls: readonly (readonly unknown[])[]): number {
  return calls.filter((call) => text(call).includes(OLD_EVENT)).length;
}

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it(
  '[AC-B1-08zy#9][BR-CALC-03] 拼多多已有 est 的单后续缺服务费：est、版本不变；新计数 platform="pdd" +1、taobao 不变；旧计数照旧 +1，打一条 pdd_service_fee_missing',
  async () => {
    const f = await stored('pdd');
    const before = await counters();

    expect(await runUpdate(f, fakePort(), f.next(FEE_MISSING))).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });

    const { orders } = await f.read();
    expect(orders[0]).toMatchObject({
      est_commission_fen: 900n,
      commission_version: f.original.commission_version,
    });
    expect(await counters()).toEqual({
      pdd: before.pdd + 1,
      taobao: before.taobao,
      old: before.old + 1,
    });
    expect(oldEvents(f.logger.warn.mock.calls)).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zy#10][BR-CALC-03] 淘宝已有 est 的单后续缺服务费：est、版本不变；新计数 platform="taobao" +1、pdd 不变；旧计数不变，不打 pdd_service_fee_missing',
  async () => {
    const f = await stored('taobao');
    const before = await counters();

    expect(await runUpdate(f, fakePort(), f.next(FEE_MISSING))).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });

    const { orders } = await f.read();
    expect(orders[0]).toMatchObject({
      est_commission_fen: 900n,
      commission_version: f.original.commission_version,
    });
    expect(await counters()).toEqual({
      pdd: before.pdd,
      taobao: before.taobao + 1,
      old: before.old,
    });
    expect(oldEvents([...f.logger.warn.mock.calls, ...f.logger.error.mock.calls])).toBe(0);
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zy#11][BR-CALC-03] 不计数：有服务费、带了 est、库里原本没有 est——拼多多与淘宝的新计数都不动，旧计数也不动',
  async () => {
    const cases: readonly {
      readonly label: string;
      readonly first: Partial<UnionOrder>;
      readonly later: Partial<UnionOrder>;
    }[] = [
      {
        label: '后续报文有服务费',
        first: {},
        later: { commission_fen: 1200n, est_commission_fen: 1080n, service_fee_fen: 120n },
      },
      {
        label: '后续报文缺服务费但带了 est',
        first: {},
        later: { commission_fen: 1200n, est_commission_fen: 1080n, service_fee_fen: null },
      },
      {
        label: '库里原本没有 est',
        first: { est_commission_fen: null, service_fee_fen: null },
        later: FEE_MISSING,
      },
    ];
    // 先让两个平台各计一次、确认计数在走：不走的话下面的「不变」什么也没证明。
    for (const platform of PLATFORMS) {
      const f = await stored(platform);
      const before = await counters();
      expect(await runUpdate(f, fakePort(), f.next(FEE_MISSING))).toMatchObject({ ok: true });
      expect((await counters())[platform], `${platform} counted first`).toBe(before[platform] + 1);
    }
    for (const platform of PLATFORMS) {
      for (const { label, first, later } of cases) {
        const f = await stored(platform, first);
        const before = await counters();
        expect(
          await runUpdate(f, fakePort(), f.next(later)),
          `${platform} ${label}: update`,
        ).toMatchObject({ ok: true });
        expect(await counters(), `${platform} ${label}`).toEqual(before);
        expect(oldEvents(f.logger.warn.mock.calls), `${platform} ${label}: old event`).toBe(0);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zy#12][BR-ID-33] 缺服务费这一路的 warn / error 日志：只有平铺字段，字段名与值里没有金额、平台单号、商品、归因参数',
  async () => {
    for (const platform of PLATFORMS) {
      const f = await stored(platform);
      const before = await counters();
      f.logger.warn.mockClear();
      f.logger.error.mockClear();

      expect(await runUpdate(f, fakePort(), f.next(FEE_MISSING))).toMatchObject({
        ok: true,
        value: { kind: 'updated' },
      });

      // 这一路确实计了数（否则下面看的日志不是缺服务费这一路的）。
      expect((await counters())[platform], `${platform} counted`).toBe(before[platform] + 1);
      const forbidden = [
        f.incoming.sub_order_id,
        f.incoming.order_id,
        f.incoming.parent_order_id,
        f.incoming.goods_id,
        f.incoming.promotion_slot,
        'abcd1234',
        RELATION_ID,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0);
      const amountTexts = AMOUNTS.map((amount) => amount.toString());
      const calls = [...f.logger.warn.mock.calls, ...f.logger.error.mock.calls] as unknown[][];
      for (const call of calls) {
        const [fields] = call;
        const entries: readonly (readonly [string, unknown])[] =
          typeof fields === 'object' && fields !== null ? Object.entries(fields) : [];
        for (const [name, value] of entries) {
          expect(name, `${platform}: field name`).not.toMatch(
            /fen|amount|commission|promotion|service_fee|goods|item|sku|title|custom|relation|sub_order|buyer|phone/i,
          );
          expect(value === null || typeof value !== 'object', `${platform}: ${name} is flat`).toBe(
            true,
          );
          expect(amountTexts, `${platform}: ${name} is not an amount`).not.toContain(
            typeof value === 'bigint' || typeof value === 'number' ? value.toString() : '',
          );
        }
        const line = text(call);
        for (const value of forbidden) {
          expect(line, `${platform}: log carries ${value}`).not.toContain(value);
        }
        // 只比完整的数字词：连字符算在词里，UUID 的一段不会被当成金额。
        const words = line.split(/[^-\w]+/);
        for (const amount of amountTexts) {
          expect(words, `${platform}: amount ${amount} in ${line}`).not.toContain(amount);
        }
      }
    }
  },
  TIMEOUT,
);
