// B1-04zzu（D10-796 ② 甲）：生产组装。UnionModule.forRoot 的 taobaoOwnOrders 选项（app.module 给 orders 的
// readOwnTaobaoOrderNos）经模块的可选数据库句柄与 ctx.appId 接到 live 淘宝适配器：有数据库时维权归档只剩凑狸
// 订单的行；不给选项时维权归档仍是收到的原文；有选项而无数据库时 listRefunds 照常、不去查询（也没有归档）。
// 照 dataoke-wiring 的写法执行真实的 UNION_REGISTRY 工厂（staging + taobao live + 大淘客两变量），网络是
// 桩住的 fetch，数据库是只记 union_raw_payloads 插入的假 Kysely。凭据、报文全部合成。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type {
  UnionModuleOptions,
  UnionTaobaoOwnOrders,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { UnionEndpoint } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import {
  DATAOKE_SECRET,
  TAOBAO_SECRET,
  WINDOW,
  clock,
  configured,
  context,
  endpoints,
  removeDirectory,
  temporaryDirectory,
} from '../dataoke-wiring/kit.ts';
import {
  archiveDatabase,
  expectArchivedAs,
  onlyArchiveOf,
  payloadText,
  type ArchiveDatabase,
} from '../taobao-order-archive/kit.ts';
import { listed, refundOf } from '../taobao-refunds/kit.ts';
import { REFUND_PATH, refundBody, suitIdOf, tradeIdOf } from './kit.ts';

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory();
  // Even a broken implementation must not contact a real network from these tests.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('FAKE_NETWORK_MUST_BE_STUBBED')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await removeDirectory(directory);
});

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

interface UnionModuleExports {
  readonly UNION_ENDPOINTS: unknown;
  readonly UNION_REGISTRY: unknown;
  readonly UNION_QUERY_PID_SOURCE: unknown;
  readonly UnionModule: {
    forRoot(directory?: string, options?: UnionModuleOptions): { providers: readonly unknown[] };
  };
}

function factoryFor(providers: readonly unknown[], token: unknown): FactoryProvider | undefined {
  return providers.find(
    (value): value is FactoryProvider =>
      typeof value === 'object' && value !== null && 'provide' in value && value.provide === token,
  );
}

/**
 * The registered UNION_REGISTRY factory of UnionModule.forRoot(undefined, options), run with the
 * values Nest would inject; `database` goes to the optional-DB provider first (as Nest would).
 * Dynamic import as in the existing wiring tests (decorators stay out of the spec compilation).
 */
async function startUnion(
  config: AppConfig,
  configuredEndpoints: readonly UnionEndpoint[],
  options: UnionModuleOptions,
  database?: ArchiveDatabase,
): Promise<UnionRegistry> {
  const modulePath = '../../../../apps/api/src/modules/union/union.module.ts';
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as UnionModuleExports;
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  const dependencies = new Map<unknown, unknown>([
    [union.UNION_ENDPOINTS, configuredEndpoints],
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  const providers = union.UnionModule.forRoot(undefined, options).providers;
  if (database !== undefined) {
    const source = factoryFor(providers, union.UNION_QUERY_PID_SOURCE);
    expect(source?.useFactory).toBeTypeOf('function');
    source!.useFactory(database.db);
  }
  const provider = factoryFor(providers, union.UNION_REGISTRY);
  expect(provider?.useFactory).toBeTypeOf('function');
  const args = provider!.inject.map((token) => {
    expect(dependencies.has(token), 'factory dependency supplied by the harness').toBe(true);
    return dependencies.get(token);
  });
  return (await provider!.useFactory(...args)) as UnionRegistry;
}

/** staging with both taobao variables and both 大淘客 variables, secret files written. */
async function liveConfig(): Promise<AppConfig> {
  const taobaoFile = join(directory, 'FAKE_TAOBAO_SECRET_FILE.txt');
  const dataokeFile = join(directory, 'FAKE_DATAOKE_SECRET_FILE.txt');
  await writeFile(taobaoFile, TAOBAO_SECRET, 'utf8');
  await writeFile(dataokeFile, DATAOKE_SECRET, 'utf8');
  return configured(taobaoFile, dataokeFile);
}

/** The 大淘客 gateway answers every request with `body` (a fresh Response each time). */
function answering(body: string) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', network);
  return network;
}

/** orders' read as the option would be, over the stored order numbers `owned`. */
function ownOrdersOption(owned: readonly string[]) {
  const stored = new Set(owned);
  return vi.fn<UnionTaobaoOwnOrders>(
    async (_db, _appId, orderNos) => new Set(orderNos.filter((no) => stored.has(no))),
  );
}

async function refundsOf(registry: UnionRegistry) {
  return listed(registry.get('taobao').listRefunds?.(WINDOW, context));
}

it('[AC-B1-04zzu#12] UnionModule.forRoot 的 taobaoOwnOrders 经模块数据库与 ctx.appId 接到 live 淘宝适配器：有数据库时维权归档只剩凑狸订单的行；不给选项时归档仍是原文；有选项无数据库时 listRefunds 照常、不查询', async () => {
  const config = await liveConfig();
  const rows = [refundOf(1), refundOf(50)];
  const body = refundBody(rows);
  const network = answering(body);

  // With the option and a database: the archive keeps only 凑狸's order.
  const database = archiveDatabase();
  const taobaoOwnOrders = ownOrdersOption([tradeIdOf(1)]);
  const injected = await startUnion(config, endpoints(), { taobaoOwnOrders }, database);
  const page = await refundsOf(injected);

  expect(page.items.map((item) => item.refund_id)).toEqual([suitIdOf(1), suitIdOf(50)]);
  expect(network).toHaveBeenCalledTimes(1);
  expect(taobaoOwnOrders, 'asked once for the one refund page').toHaveBeenCalledTimes(1);
  const [db, appId, asked] = taobaoOwnOrders.mock.calls[0]!;
  expect(db, 'over the module database handle').toBe(database.db);
  expect(appId).toBe(context.appId);
  expect([...asked].sort()).toEqual([tradeIdOf(1), tradeIdOf(50)].sort());
  const row = onlyArchiveOf(database, REFUND_PATH);
  expect(row.values['app_id']).toBe(context.appId);
  const text = expectArchivedAs(row, refundBody([refundOf(1)]));
  expect(text).not.toContain(tradeIdOf(50));

  // Without the option (same kind of database): the refund archive is the body as received.
  const plainDatabase = archiveDatabase();
  const plain = await startUnion(config, endpoints(), {}, plainDatabase);
  const plainPage = await refundsOf(plain);
  expect(plainPage.items).toEqual(page.items);
  expect(payloadText(onlyArchiveOf(plainDatabase, REFUND_PATH))).toBe(body);

  // With the option but no database: nothing is archived, the lookup is not asked, refunds as usual.
  const unused = ownOrdersOption([tradeIdOf(1)]);
  const noDatabase = await startUnion(config, endpoints(), { taobaoOwnOrders: unused });
  const noDatabasePage = await refundsOf(noDatabase);
  expect(noDatabasePage.items).toEqual(page.items);
  expect(unused).not.toHaveBeenCalled();
  expect(database.inserted).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(3);
});
