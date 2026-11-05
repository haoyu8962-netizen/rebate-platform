// Unit tests of the B1-05zd shop_name write in the pool refresh, without a database: Kysely runs
// on a scripted driver that records every statement. A live answer rewrites shop_name (NULL when the
// answer has none); a union failure or an anomalous price writes nothing, shop_name included. The
// PostgreSQL behaviour is covered by the rule tests in test/spec/catalog/pool-shop-name.
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { UnionError, type UnionAdapter, type UnionItemDetail } from '../../union/index.ts';
import type { GovernedUnion } from '../ports.ts';
import { createPoolRefreshJobHandler, type PoolRefreshOptions } from './pool-refresh.ts';

const NOW = '2026-11-05T02:00:00.000Z';
const APP = 'unit-app';
const KEY = 'tb:K1';
const RAW = 'raw-K1';

type Answer = UnionItemDetail | Error;

function answer(extra: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: RAW,
    title: 'K1',
    price_fen: 6000n,
    coupon_fen: 1000n,
    final_price_fen: 5000n,
    commission_rate_bp: 1500n,
    quoted_at: NOW,
    ...extra,
  };
}

function setup(reply: Answer) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const text = compiled.sql;
      if (/^select "title" from "app"\."pool_items"/.test(text)) {
        return Promise.resolve({ rows: [{ title: 'K1' }] as R[] });
      }
      if (/^select "coupon_fen" from "app"\."pool_items"/.test(text)) {
        return Promise.resolve({ rows: [{ coupon_fen: 1000n }] as R[] });
      }
      return Promise.resolve({ rows: [] as R[], numAffectedRows: 1n });
    },
    streamQuery() {
      throw new Error('pool-refresh unit test: no streaming');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const getItem = vi.fn(() =>
    reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
  );
  const union: GovernedUnion = {
    adapter: () => ({ getItem }) as unknown as UnionAdapter,
  };
  const options: PoolRefreshOptions = {
    db,
    clock: new FixedClock(new Date(NOW)),
    queue: {} as PoolRefreshOptions['queue'],
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    config: { configValue: () => Promise.resolve(null) },
    catalog: {
      listPlatforms: () =>
        Promise.resolve([
          {
            code: 'taobao',
            key_prefix: 'tb',
            key_stability: 'unverified',
            search_support: 'official',
            convert_support: 'official',
            order_sync_support: 'official',
            stage: 'mvp',
          },
        ]),
      resolveProductKey: (key) => Promise.resolve(key),
      readProductRef: () => Promise.resolve(null),
      takeRawItemId: () => Promise.resolve({ rawItemId: RAW, source: 'product_refs' }),
    },
    union,
    dropDetailCache: () => Promise.resolve(),
  };
  const handler = createPoolRefreshJobHandler(options);
  const run = () =>
    handler({
      id: 'unit-job',
      queue: 'pool-refresh',
      name: 'refresh',
      payload: { app_id: APP, product_key: KEY, platform: 'taobao' },
      attempt: 1,
    });
  const updates = () => statements.filter((s) => /^update "app"\."pool_items"/.test(s.sql));
  return { run, updates, getItem };
}

/** The value bound to `"shop_name" = $n` in an UPDATE; undefined when the column is not set. */
function shopNameSet(update: CompiledQuery): unknown {
  const match = /"shop_name" = \$(\d+)/.exec(update.sql);
  return match === null ? undefined : update.parameters[Number(match[1]) - 1];
}

it.each([
  { label: '有店铺名 → 写入', extra: { shop_name: '合成新店' }, expected: '合成新店' },
  { label: '无店铺名 → 置 NULL，不留旧值', extra: {}, expected: null },
])('[AC-B1-05zd-unit#1] 刷新拿到最新条目：$label', async ({ extra, expected }) => {
  const f = setup(answer(extra));
  await f.run();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  const updates = f.updates();
  expect(updates).toHaveLength(1);
  expect(shopNameSet(updates[0]!)).toBe(expected);
});

it.each([
  {
    label: '联盟调用失败',
    reply: new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
  },
  { label: '联盟标记价格异常（not_passed）', reply: answer({ price_status: 'anomaly' }) },
  { label: '价格字段异常', reply: answer({ final_price_fen: 7000n, shop_name: '不该写入' }) },
])('[AC-B1-05zd-unit#2] $label：不写任何池行，shop_name 保持不动', async ({ reply }) => {
  const f = setup(reply);
  await f.run();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(f.updates()).toEqual([]);
});
