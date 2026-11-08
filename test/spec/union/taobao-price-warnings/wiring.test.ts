import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type { DataokeImageHostWarning } from '../../../../apps/api/src/modules/union/infra/taobao/dataoke-search.ts';
import type { TaobaoPriceWarningEvent } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  SEARCH_VARIABLE,
  assemble,
  clock,
  configured,
  ctx,
  fakeUpstream,
  logText,
  observeTaobao,
  pidRow,
  refused,
  stubHttp,
  succeeded,
  type LogEntry,
} from '../taobao-dataoke-switches/kit.ts';
import * as goods from '../taobao-goods/kit.ts';
import {
  ADZONE,
  OFFICIAL_SEARCH,
  SLOT_PID,
  detailItemId,
  gateway,
  searchBody,
  searchItemId,
  searchRow,
  titleOf as officialTitleOf,
} from '../taobao-official-search/official-harness.ts';
import { slotDatabase } from '../taobao-official-search/slot-database.ts';
import {
  DETAIL,
  SEARCH_PATH,
  convertAll,
  couliItemId,
  dataokeEnvelope,
  dtkGoodsId,
  dtkRow,
  formOf,
  query,
  response,
  rowWithout,
  searchData,
  titleOf as dataokeTitleOf,
  topError,
  truthfulTop,
} from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzg#n]) identify this task's acceptance points (B1-04l 遗留，
// D10-1072 ①), not business rules. 真实 UnionModule 装配（Nest 完整解析，凭据打桩，HTTPS 传输换成内存
// 假传输）：
// - 淘宝详情 / 官方搜索的价格告警经适配器 priceWarn 钩子（模块装配）→ logger，各记一条自己的 warn 事件；
//   现有 warn 钩子不经手（冻结 [AC-B1-04zx#36]）。
// - 淘宝 warn 钩子 → logTaobaoWarning：只有 code '11' 记 TAOBAO_API_PERMISSION_DENIED（字段照旧）；大淘客
//   图片主机仍 DATAOKE_IMAGE_HOST_DROPPED；大淘客搜索发的价格类（PRICE_ANOMALY / PRICE_CALC_DIFF）与行校验类
//   （invalid_item / invalid_commission）各记一条自己的 warn 事件。
// 事件名由实现定，这里只钉「不是权限 / 图片主机事件」、字段只有 event / method / code（PRICE_PROMO_UNKNOWN
// 另带优惠名），不含商品信息。
// 合成值，复用 ../taobao-dataoke-switches/、../taobao-goods/、../taobao-official-search/、../taobao-search/
// 的夹具；不联网、不连库（union_pids 在内存里）、不监听端口。

vi.mock('../../../../apps/api/src/modules/platform/config/taobao-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/taobao-startup.ts')
  >()),
  openTaobaoCredentials: async () => async () => ({
    appKey: 'fake-price-warnings-key',
    appSecret: 'prwn-prwn-prwn-prwn-prwn',
  }),
}));
vi.mock(
  '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts',
  async (original) => ({
    ...(await original<
      typeof import('../../../../apps/api/src/modules/platform/config/dataoke-startup.ts')
    >()),
    openDataokeCredentials: async () => async () => ({
      appKey: 'fake-price-warnings-dataoke-key',
      appSecret: 'dtpw-dtpw-dtpw-dtpw-dtpw',
    }),
  }),
);

const PERMISSION_EVENT = 'TAOBAO_API_PERMISSION_DENIED';
const IMAGE_HOST_EVENT = 'DATAOKE_IMAGE_HOST_DROPPED';
const PERMISSION_SUB_CODE = 'isv.permission-api-package-limit';
const CALC_DIFF = 'PRICE_CALC_DIFF';
const PROMO_UNKNOWN = 'PRICE_PROMO_UNKNOWN';
// Special characters are built from code points, never written literally.
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const FULL_WIDTH_A = String.fromCharCode(0xff21);
/** An unknown promotion name as it may come on the wire: ideographic space, full-width A, a blank. */
const RAW_UNKNOWN = `${IDEOGRAPHIC_SPACE}合成未知优惠${FULL_WIDTH_A} `;
/** The same name after NFKC and trim, as mapTaobaoPrice reports it. */
const UNKNOWN_NAME = '合成未知优惠A';
/** Values of the synthetic detail row that no log line may show. */
const DETAIL_MARKERS = [
  goods.ITEM_ID,
  '合成详情商品',
  '合成一级类目',
  goods.MAIN_IMAGE,
  'img.synthetic',
  'synthetic-click',
  '59.90',
  '40.00',
  '10.00',
  'syn-coupon',
  'syn-unknown',
  goods.SELLER_ID_TEXT,
  'synthetic-request-id',
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every HTTPS transport of the module: 大淘客 paths (/api/…) to `dataoke`, the rest to `top`. */
function stub(top: UnionTransport, dataoke?: UnionTransport): void {
  const upstream = fakeUpstream();
  const combined: UnionTransport = (request) =>
    new URL(request.url).pathname.startsWith('/api/')
      ? (dataoke ?? upstream.dataokeTransport)(request)
      : top(request);
  stubHttp({ ...upstream, combined });
}

function warnEntries(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((entry) => entry.level === 'warn');
}

/** The flat pino fields of a log call (its first argument). */
function fieldsOf(entry: LogEntry): Record<string, unknown> {
  const first = entry.args[0];
  return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
}

function withCode(logs: readonly LogEntry[], code: string): LogEntry[] {
  return warnEntries(logs).filter((entry) => fieldsOf(entry)['code'] === code);
}

/** A warn event of its own: a named event that is neither the permission nor the image host one. */
function expectOwnEvent(entry: LogEntry, method: string, code: string): void {
  const fields = fieldsOf(entry);
  expect(fields, code).toMatchObject({ method, code });
  expect(typeof fields['event'], code).toBe('string');
  expect(fields['event'], code).not.toBe('');
  expect(fields['event'], code).not.toBe(PERMISSION_EVENT);
  expect(fields['event'], code).not.toBe(IMAGE_HOST_EVENT);
}

function expectOnlyEventMethodCode(entry: LogEntry): void {
  expect(Object.keys(fieldsOf(entry)).sort()).toEqual(['code', 'event', 'method']);
}

it('[AC-B1-04zzzzg#10] 端到端：淘宝详情 calc_diff 经 priceWarn 记一条自己的 warn 事件（不是 TAOBAO_API_PERMISSION_DENIED），字段只有 event / method / code，不含商品信息，返回结果不变；真正的 code 11 仍记权限告警，字段照旧', async () => {
  let reply: unknown = goods.detailBody([
    goods.detailRow({ price: { zk_final_price: '59.90', final_promotion_price: '40.00' } }),
  ]);
  stub(async () => response(reply));
  const app = await assemble(configured({}, false));
  try {
    const adapter = app.registry.get('taobao');
    const detail = await succeeded(() => adapter.getItem(goods.ref, ctx), 'getItem');
    expect(detail).toMatchObject({
      item_id: goods.ITEM_ID,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
      price_status: 'anomaly',
      price_anomaly_reason: 'calc_diff',
    });
    const entries = withCode(app.logs, CALC_DIFF);
    expect(entries).toHaveLength(1);
    expectOwnEvent(entries[0]!, DETAIL, CALC_DIFF);
    expectOnlyEventMethodCode(entries[0]!);
    const text = logText(warnEntries(app.logs));
    expect(text).not.toContain(PERMISSION_EVENT);
    for (const marker of DETAIL_MARKERS) expect(text, marker).not.toContain(marker);

    reply = topError(11, PERMISSION_SUB_CODE);
    await refused(() => adapter.getItem(goods.ref, ctx), 'upstream_misconfigured');
    expect(withCode(app.logs, '11').map(fieldsOf)).toEqual([
      { event: PERMISSION_EVENT, method: DETAIL, code: '11', sub_code: PERMISSION_SUB_CODE },
    ]);
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zzzzg#11] 端到端：淘宝详情未知优惠名经 priceWarn 记一条自己的 warn 事件：event / method / code 之外只带归一化优惠名，不是权限事件，不含商品信息；返回 unknown_promo 不变', async () => {
  const row = goods.detailRow({
    promotions: [
      goods.promotion('商品券', '10.00', 'syn-coupon-0001'),
      goods.promotion(RAW_UNKNOWN, '5.00', 'syn-unknown-0001'),
    ],
  });
  stub(async () => response(goods.detailBody([row])));
  const app = await assemble(configured({}, false));
  try {
    const detail = await succeeded(
      () => app.registry.get('taobao').getItem(goods.ref, ctx),
      'getItem',
    );
    expect(detail).toMatchObject({
      price_status: 'anomaly',
      price_anomaly_reason: 'unknown_promo',
    });
    const entries = withCode(app.logs, PROMO_UNKNOWN);
    expect(entries).toHaveLength(1);
    expectOwnEvent(entries[0]!, DETAIL, PROMO_UNKNOWN);
    const extra = Object.entries(fieldsOf(entries[0]!)).filter(
      ([key]) => !['event', 'method', 'code'].includes(key),
    );
    expect(extra.map(([, value]) => value)).toEqual([UNKNOWN_NAME]);
    const text = logText(warnEntries(app.logs));
    expect(text).not.toContain(PERMISSION_EVENT);
    expect(text).not.toContain(FULL_WIDTH_A);
    for (const marker of DETAIL_MARKERS) expect(text, marker).not.toContain(marker);
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zzzzg#12] 端到端：官方搜索价格不合格的行经 priceWarn 记自己的 warn 事件（方法名为物料搜索），不是权限事件，不含取值；整页照常返回', async () => {
  const rows = [searchRow(1), searchRow(2, { price: { final_promotion_price: '40.00' } })];
  stub(gateway(clock, { page: () => searchBody(rows, rows.length) }));
  const database = slotDatabase([pidRow({ pid: SLOT_PID, pid_scene: 'query' })]);
  const app = await assemble(configured({}, false), { db: database.db });
  try {
    const page = await succeeded(
      () => app.registry.get('taobao').searchItems(query, ctx),
      'searchItems',
    );
    expect(page.items.map((item) => item.item_id)).toEqual([detailItemId(1), detailItemId(2)]);
    expect(page.items.map((item) => item.price_status)).toEqual(['ok', 'anomaly']);
    const entries = withCode(app.logs, CALC_DIFF);
    expect(entries).toHaveLength(1);
    expectOwnEvent(entries[0]!, OFFICIAL_SEARCH, CALC_DIFF);
    expectOnlyEventMethodCode(entries[0]!);
    const text = logText(warnEntries(app.logs));
    expect(text).not.toContain(PERMISSION_EVENT);
    for (const marker of [
      searchItemId(2),
      detailItemId(2),
      officialTitleOf(2),
      'SharedTail',
      '40.00',
      ADZONE,
    ]) {
      expect(text, marker).not.toContain(marker);
    }
  } finally {
    await app.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04zzzzg#13] 端到端：大淘客搜索的 PRICE_ANOMALY / invalid_commission / invalid_item 各记一条自己的 warn 事件（不是 TAOBAO_API_PERMISSION_DENIED），字段只有 event / method / code，不含商品信息；图片主机仍记 DATAOKE_IMAGE_HOST_DROPPED；结果不变', async () => {
  const rows = [
    dtkRow(1),
    dtkRow(2, { actualPrice: 'abc' }),
    dtkRow(3, { commissionRate: 'abc' }),
    rowWithout(4, 'title', 'dtitle'),
    dtkRow(5, { smallImages: ['https://img.synthetic.invalid/dtk/small-0005.jpg'] }),
  ];
  const top: UnionTransport = async (request) =>
    response(truthfulTop((formOf(request)['item_id'] ?? '').split(','), convertAll));
  const dataoke: UnionTransport = async (request) =>
    new URL(request.url).pathname === SEARCH_PATH
      ? response(dataokeEnvelope(searchData(rows, rows.length)))
      : response({ time: 1_793_500_000_000, code: -1, msg: 'synthetic unexpected path' });
  stub(top, dataoke);
  const app = await assemble(configured({ [SEARCH_VARIABLE]: 'dataoke' }));
  try {
    const page = await succeeded(
      () => app.registry.get('taobao').searchItems(query, ctx),
      'searchItems',
    );
    expect(page.items.map((item) => item.item_id)).toEqual([1, 2, 5].map(couliItemId));
    expect(page.items.map((item) => item.price_status)).toEqual(['ok', 'anomaly', 'ok']);
    for (const code of ['PRICE_ANOMALY', 'invalid_commission', 'invalid_item']) {
      const entries = withCode(app.logs, code);
      expect(entries, code).toHaveLength(1);
      expectOwnEvent(entries[0]!, SEARCH_PATH, code);
      expectOnlyEventMethodCode(entries[0]!);
    }
    expect(warnEntries(app.logs).map(fieldsOf)).toContainEqual({
      event: IMAGE_HOST_EVENT,
      method: SEARCH_PATH,
      host: 'img.synthetic.invalid',
      count: 1,
    });
    const text = logText(warnEntries(app.logs));
    expect(text).not.toContain(PERMISSION_EVENT);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(text).not.toContain(dtkGoodsId(n));
      expect(text).not.toContain(dataokeTitleOf(n));
      expect(text).not.toContain(couliItemId(n));
    }
    expect(text).not.toContain('synthetic-seller');
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zzzzg#14] 模块装配的淘宝 warn 钩子按码分事件：价格类与行校验类（任一方法名）都不记成权限事件、字段只有 event / method / code；code 11（有无 sub_code）仍记 TAOBAO_API_PERMISSION_DENIED、字段照旧；图片主机仍 DATAOKE_IMAGE_HOST_DROPPED', async () => {
  stub(async () => response(topError('synthetic-unexpected-method')));
  const observed = observeTaobao();
  const app = await assemble(configured({}, false));
  try {
    expect(observed).toHaveBeenCalledTimes(1);
    const hook = observed.mock.calls[0]![0].warn;
    expect(hook).toBeTypeOf('function');
    const logged = (warning: Parameters<NonNullable<typeof hook>>[0]): LogEntry[] => {
      const before = app.logs.length;
      hook!(warning);
      return warnEntries(app.logs.slice(before));
    };
    const priceAndRows: [string, string][] = [
      [SEARCH_PATH, 'PRICE_ANOMALY'],
      [SEARCH_PATH, CALC_DIFF],
      [SEARCH_PATH, 'invalid_item'],
      [SEARCH_PATH, 'invalid_commission'],
      [DETAIL, CALC_DIFF],
      [OFFICIAL_SEARCH, CALC_DIFF],
    ];
    for (const [method, code] of priceAndRows) {
      const added = logged({ method, code });
      expect(added, `${method} ${code}`).toHaveLength(1);
      expectOwnEvent(added[0]!, method, code);
      expectOnlyEventMethodCode(added[0]!);
    }

    const permission = logged({ method: DETAIL, code: '11', sub_code: PERMISSION_SUB_CODE });
    expect(permission.map(fieldsOf)).toEqual([
      { event: PERMISSION_EVENT, method: DETAIL, code: '11', sub_code: PERMISSION_SUB_CODE },
    ]);
    expect(logged({ method: OFFICIAL_SEARCH, code: '11' }).map(fieldsOf)).toEqual([
      { event: PERMISSION_EVENT, method: OFFICIAL_SEARCH, code: '11' },
    ]);
    const imageHost: DataokeImageHostWarning = {
      method: SEARCH_PATH,
      code: 'dataoke_image_host_dropped',
      host: 'img.synthetic.invalid',
      count: 2,
    };
    expect(logged(imageHost).map(fieldsOf)).toEqual([
      { event: IMAGE_HOST_EVENT, method: SEARCH_PATH, host: 'img.synthetic.invalid', count: 2 },
    ]);
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zzzzg#15] 模块给淘宝适配器装了 priceWarn：详情与官方搜索方法名下，PRICE_CALC_DIFF 记一条自己的 warn 事件、字段只有 event / method / code；PRICE_PROMO_UNKNOWN 另只带归一化优惠名；都不是权限 / 图片主机事件，一条告警只记一条', async () => {
  stub(async () => response(topError('synthetic-unexpected-method')));
  const observed = observeTaobao();
  const app = await assemble(configured({}, false));
  try {
    expect(observed).toHaveBeenCalledTimes(1);
    const hook = observed.mock.calls[0]![0].priceWarn;
    expect(hook).toBeTypeOf('function');
    const logged = (event: TaobaoPriceWarningEvent): LogEntry[] => {
      const before = app.logs.length;
      hook!(event);
      return warnEntries(app.logs.slice(before));
    };
    for (const method of [DETAIL, OFFICIAL_SEARCH]) {
      const diff = logged({ method, code: CALC_DIFF });
      expect(diff, `${method} ${CALC_DIFF}`).toHaveLength(1);
      expectOwnEvent(diff[0]!, method, CALC_DIFF);
      expectOnlyEventMethodCode(diff[0]!);

      const unknown = logged({ method, code: PROMO_UNKNOWN, promotion_title: UNKNOWN_NAME });
      expect(unknown, `${method} ${PROMO_UNKNOWN}`).toHaveLength(1);
      expectOwnEvent(unknown[0]!, method, PROMO_UNKNOWN);
      const extra = Object.entries(fieldsOf(unknown[0]!)).filter(
        ([key]) => !['event', 'method', 'code'].includes(key),
      );
      expect(extra.map(([, value]) => value)).toEqual([UNKNOWN_NAME]);
    }
    expect(logText(warnEntries(app.logs))).not.toContain(PERMISSION_EVENT);
  } finally {
    await app.close();
  }
});
