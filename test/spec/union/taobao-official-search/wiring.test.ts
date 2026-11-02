import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  APP,
  OTHER_APP,
  SEARCH_VARIABLE,
  assemble,
  clock,
  configured,
  ctx,
  dataokePaths,
  fakeUpstream,
  logText,
  observeTaobao,
  pidRow,
  refused,
  stubHttp,
  succeeded,
  type LogEntry,
} from '../taobao-dataoke-switches/kit.ts';
import {
  ADZONE,
  businessFields,
  detailItemId,
  gateway,
  query,
  rowsFrom,
  searchBody,
  searchItemId,
  searchRequests,
  searchRow,
  SLOT_PID,
  titleOf,
  topError,
  type GatewayOptions,
} from './official-harness.ts';
import { slotDatabase } from './slot-database.ts';

// 生产接线：真实 UnionModule 装配（Nest 完整解析，凭据打桩，HTTPS 传输换成内存假传输，union_pids 在内存里）。
// searchSlot 真的注入，且不依赖 orderSource：只有官方凭据、没有大淘客时官方搜索也能走。没有数据库句柄时
// 读不到推广位，保持 adapter_unimplemented（冻结用例 AC-B1-04zn#14 / #15 就是这样装配的）。
// 跳行事件写自己的 warn 日志，不被 logTaobaoWarning 记成 TAOBAO_API_PERMISSION_DENIED。

vi.mock('../../../../apps/api/src/modules/platform/config/taobao-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/taobao-startup.ts')
  >()),
  openTaobaoCredentials: async () => async () => ({
    appKey: 'fake-official-wiring-key',
    appSecret: 'wire-wire-wire-wire-wire',
  }),
}));
vi.mock(
  '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts',
  async (original) => ({
    ...(await original<
      typeof import('../../../../apps/api/src/modules/platform/config/dataoke-startup.ts')
    >()),
    openDataokeCredentials: async () => async () => ({
      appKey: 'fake-official-wiring-dataoke-key',
      appSecret: 'dtkw-dtkw-dtkw-dtkw-dtkw',
    }),
  }),
);

const PERMISSION_EVENT = 'TAOBAO_API_PERMISSION_DENIED';
const SKIP_EVENT = 'taobao_search_row_skipped';

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

/** Every HTTPS transport of the module answers as the official gateway; 大淘客 stays the fake. */
function stubGateway(options: GatewayOptions = {}) {
  const upstream = fakeUpstream();
  const transport = gateway(clock, options);
  const combined: UnionTransport = (request) =>
    new URL(request.url).pathname.startsWith('/api/')
      ? upstream.dataokeTransport(request)
      : transport(request);
  stubHttp({ ...upstream, combined });
  return { upstream, transport };
}

function slotRows() {
  return slotDatabase([pidRow({ pid: SLOT_PID, pid_scene: 'query' })]);
}

function warnEntries(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((entry) => entry.level === 'warn');
}

it('[AC-B1-04zx#66] 端到端：只有官方凭据、没有大淘客时官方搜索照走：searchSlot 真的注入，adzone_id 取 query 推广位，返回详情口径 ID', async () => {
  const { upstream, transport } = stubGateway();
  const observed = observeTaobao();
  const database = slotRows();
  const app = await assemble(configured({}, false), { db: database.db });
  try {
    expect(observed).toHaveBeenCalledTimes(1);
    const options = observed.mock.calls[0]![0];
    expect(options.orderSource).toBeUndefined();
    expect(options.searchSlot).toBeTypeOf('function');
    const page = await succeeded(
      () => app.registry.get('taobao').searchItems(query, ctx),
      'searchItems',
    );
    expect(page.items.map((item) => item.item_id)).toEqual([1, 2, 3].map(detailItemId));
    expect(searchRequests({ transport }).map(businessFields)).toEqual([
      { q: query.keyword, page_no: '1', page_size: '20', adzone_id: ADZONE },
    ]);
    expect(database.statements).toHaveLength(1);
    expect(upstream.dataokeTransport).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04zx#67] 端到端：大淘客凭据也在时缺省开关仍走官方；TAOBAO_SEARCH_SOURCE=dataoke 才走大淘客，且不读推广位', async () => {
  const { upstream, transport } = stubGateway();
  const database = slotRows();
  try {
    const official = await assemble(configured(), { db: database.db });
    try {
      await succeeded(() => official.registry.get('taobao').searchItems(query, ctx), 'searchItems');
    } finally {
      await official.close();
    }
    expect(searchRequests({ transport })).toHaveLength(1);
    expect(dataokePaths(upstream)).toEqual([]);
    expect(database.statements).toHaveLength(1);

    const dataoke = await assemble(configured({ [SEARCH_VARIABLE]: 'dataoke' }), {
      db: database.db,
    });
    try {
      await succeeded(() => dataoke.registry.get('taobao').searchItems(query, ctx), 'searchItems');
    } finally {
      await dataoke.close();
    }
    expect(searchRequests({ transport })).toHaveLength(1);
    expect(dataokePaths(upstream)).toEqual(['/api/goods/get-dtk-search-goods']);
    expect(database.statements).toHaveLength(1);
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zx#68] 端到端：推广位按 ctx.appId 每次重读：别的 App 没有 query 推广位 → adapter_unimplemented 不发请求；没有数据库句柄同样如此；有了才搜索', async () => {
  const { transport } = stubGateway();
  const database = slotRows();
  try {
    const noDatabase = await assemble(configured({}, false));
    try {
      await refused(
        () => noDatabase.registry.get('taobao').searchItems(query, ctx),
        'adapter_unimplemented',
      );
    } finally {
      await noDatabase.close();
    }
    expect(transport).not.toHaveBeenCalled();
    expect(database.statements).toHaveLength(0);

    const app = await assemble(configured({}, false), { db: database.db });
    try {
      const adapter = app.registry.get('taobao');
      await refused(
        () => adapter.searchItems(query, { ...ctx, appId: OTHER_APP }),
        'adapter_unimplemented',
      );
      expect(database.statements).toHaveLength(1);
      expect(transport).not.toHaveBeenCalled();
      await succeeded(() => adapter.searchItems(query, ctx), 'searchItems');
      expect(database.statements.map((statement) => statement.parameters)).toEqual([
        expect.arrayContaining([OTHER_APP, 'taobao', 'query', 'active']),
        expect.arrayContaining([APP, 'taobao', 'query', 'active']),
      ]);
      expect(searchRequests({ transport })).toHaveLength(1);
    } finally {
      await app.close();
    }
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zx#69] 端到端：搜索与换算都经归档传输，各写一行 union_raw_payloads', async () => {
  const { transport } = stubGateway();
  const database = slotRows();
  const app = await assemble(configured({}, false), { db: database.db });
  try {
    await succeeded(() => app.registry.get('taobao').searchItems(query, ctx), 'searchItems');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(database.archived).toHaveLength(2);
  } finally {
    await app.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04zx#70] 跳行写独立 warn 事件 taobao_search_row_skipped：平铺字段含 reason，不含取值，不记成 TAOBAO_API_PERMISSION_DENIED；真正的 code 11 才记权限告警', async () => {
  let refusing = false;
  const rows = [
    searchRow(1),
    searchRow(2, { basic: { title: undefined } }),
    searchRow(3, { income: { commission_rate: 'synthetic-bad-rate' } }),
  ];
  stubGateway({
    page: () => (refusing ? topError(11, 'isv.permission-api-package-limit') : searchBody(rows, 3)),
  });
  const database = slotRows();
  const app = await assemble(configured({}, false), { db: database.db });
  try {
    const adapter = app.registry.get('taobao');
    const page = await succeeded(() => adapter.searchItems(query, ctx), 'searchItems');
    expect(page.items.map((item) => item.item_id)).toEqual([detailItemId(1)]);

    const skipped = warnEntries(app.logs).filter((entry) => entry.text.includes(SKIP_EVENT));
    expect(skipped).toHaveLength(2);
    expect(skipped.map((entry) => entry.args[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: SKIP_EVENT, reason: 'title_missing' }),
        expect.objectContaining({ event: SKIP_EVENT, reason: 'commission_invalid' }),
      ]),
    );
    for (const entry of skipped) {
      const values = Object.values(entry.args[0] as Record<string, unknown>);
      for (const value of values) expect(['string', 'number']).toContain(typeof value);
    }
    const before = logText(warnEntries(app.logs));
    expect(before).not.toContain(PERMISSION_EVENT);
    for (const marker of [
      searchItemId(2),
      searchItemId(3),
      titleOf(3),
      'synthetic-bad-rate',
      ADZONE,
    ]) {
      expect(before, marker).not.toContain(marker);
    }

    refusing = true;
    await refused(() => adapter.searchItems(query, ctx), 'upstream_rejected');
    expect(logText(warnEntries(app.logs))).toContain(PERMISSION_EVENT);
  } finally {
    await app.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04zx#71] 价格异常的行不写权限告警：整页照常返回，日志里没有 TAOBAO_API_PERMISSION_DENIED', async () => {
  const rows = rowsFrom(1, 3).map((_row, i) =>
    searchRow(i + 1, { price: { zk_final_price: 'abc' } }),
  );
  stubGateway({ page: () => searchBody(rows, 3) });
  const database = slotRows();
  const app = await assemble(configured({}, false), { db: database.db });
  try {
    const page = await succeeded(
      () => app.registry.get('taobao').searchItems(query, ctx),
      'searchItems',
    );
    expect(page.items.map((item) => item.price_status)).toEqual(['anomaly', 'anomaly', 'anomaly']);
    expect(logText(warnEntries(app.logs))).not.toContain(PERMISSION_EVENT);
  } finally {
    await app.close();
    await database.db.destroy();
  }
});
