// B1-04zzab unit tests of the production pending port (compile-only db: DummyDriver, no connection).
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import {
  PUNISH_DETAIL_MAX,
  PUNISH_MARK_SEPARATOR,
  PUNISH_MARK_VALUE_MAX,
  punishMark,
} from '../infra/punish-pending-store.ts';
import { createPunishPendingRecorder, punishStatusKind } from './punish-pending.ts';

const dbs: Kysely<DB>[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.destroy();
});

function compileOnly(queries: string[], params: unknown[][] = []): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
      params.push([...event.query.parameters]);
    },
  });
  dbs.push(db);
  return db;
}

const signal = {
  app_id: 'unit',
  platform: 'taobao',
  sub_order_id: '3900000000000006001',
  reason: 'UNFREEZE_SIGNAL',
  raw_status: '1',
  detected_at: new Date('2026-11-06T04:00:00.000Z'),
} as const;

it('[AC-B1-04zzab#unit] punishStatusKind：0 与缺字段按处罚，1 为解冻，其余为表外值', () => {
  expect(['0', null, undefined, '1', '2', '-1', '', '01'].map((s) => punishStatusKind(s))).toEqual([
    'punish',
    'punish',
    'punish',
    'UNFREEZE_SIGNAL',
    'UNMAPPED_STATUS',
    'UNMAPPED_STATUS',
    'UNMAPPED_STATUS',
    'UNMAPPED_STATUS',
  ]);
});

it('[AC-B1-04zzab#D10-2449] 记录器：取子订单锁、读 order_keys、INSERT … ON CONFLICT 写待处理；不写订单、维权、分录，也不先查待处理', async () => {
  const queries: string[] = [];
  await createPunishPendingRecorder({ db: compileOnly(queries) }).record(signal);
  expect(queries).toHaveLength(3);
  expect(queries[0]).toMatch(/pg_advisory_xact_lock/);
  expect(queries[1]).toMatch(/^select .* from "app"\."order_keys"/);
  expect(queries[2]).toMatch(/^insert into "app"\."order_sync_pending"/);
  expect(queries[2]).toMatch(
    /on conflict \("app_id", "platform", "sub_order_id", "reason"\) where "status" = 'open' do update set "detected_at"/,
  );
  expect(queries[2]).not.toMatch(/do update set .*"raw_status"/s);
  for (const q of queries) {
    expect(q).not.toMatch(/\b(update|insert into) "app"\."(orders|order_rights|ledger_entries)"/);
    expect(q).not.toMatch(/order_sync_events|outbox/);
  }
});

it('[AC-B1-04zzab#unit] 记录器：单号不能作订单键（带冒号）时不取锁、不查 order_keys，照样写待处理', async () => {
  const queries: string[] = [];
  await createPunishPendingRecorder({ db: compileOnly(queries) }).record({
    ...signal,
    sub_order_id: 'bad:number',
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatch(/^insert into "app"\."order_sync_pending"/);
});

it('[AC-B1-04zzab#unit] 评审 r1 第 5 条：读订单关联的查询带 app_id 谓词；锁仍按全局子订单键（不含 app）', async () => {
  const queries: string[] = [];
  const params: unknown[][] = [];
  await createPunishPendingRecorder({ db: compileOnly(queries, params) }).record(signal);
  expect(params[0]).toEqual([`orders.order_key:taobao:${signal.sub_order_id}`]);
  expect(queries[1]).toMatch(
    /from "app"\."order_keys" where "platform" = \$1 and "sub_order_id" = \$2 and "app_id" = \$3$/,
  );
  expect(params[1]).toEqual(['taobao', signal.sub_order_id, 'unit']);
  expect(queries[1]).toMatch(/^select "order_id" from/);
});

it('[AC-B1-04zzab#unit] 评审 r1 第 1、2、4 条：同键冲突一条语句里 detected_at 取较晚、order_id 存量非空保留否则补本次、detail 去重追加本信号标记、raw_status 不改', async () => {
  const queries: string[] = [];
  const params: unknown[][] = [];
  await createPunishPendingRecorder({ db: compileOnly(queries, params) }).record({
    ...signal,
    reason: 'UNMAPPED_STATUS',
    raw_status: '2',
  });
  const upsert = queries[2] ?? '';
  const set = upsert.slice(upsert.indexOf('do update set'));
  expect(set).toMatch(
    /"detected_at" = greatest\(order_sync_pending\.detected_at, excluded\.detected_at\)/,
  );
  expect(set).toMatch(/"order_id" = coalesce\(order_sync_pending\.order_id, excluded\.order_id\)/);
  expect(set).toMatch(/when order_sync_pending\.detail is null then excluded\.detail/);
  expect(set).toMatch(
    /when excluded\.detail = any\(string_to_array\(order_sync_pending\.detail, \$\d+\)\) then order_sync_pending\.detail/,
  );
  expect(set).toMatch(
    /when length\(order_sync_pending\.detail\) >= \$\d+ then order_sync_pending\.detail/,
  );
  expect(set).toMatch(/else order_sync_pending\.detail \|\| \$\d+ \|\| excluded\.detail/);
  expect(set).not.toMatch(/"(raw_status|raw_payload_id|created_at|status)" =/);
  // New row: raw_status as delivered, detail the mark of the same format, created_at = detected_at.
  const values = params[2] ?? [];
  expect(values).toContain('2');
  expect(values).toContain('punish.window punish_status=2');
  expect(values.filter((v) => v === signal.detected_at)).toHaveLength(2);
  expect(values).toContain(PUNISH_MARK_SEPARATOR);
  expect(values).toContain(PUNISH_DETAIL_MAX);
});

it('[AC-B1-04zzab#unit] punishMark：同值同标记；截断到上限；转义后不含分隔符，孤立代理项不抛错', () => {
  expect(punishMark('1')).toBe('punish.window punish_status=1');
  expect(punishMark('-1')).toBe('punish.window punish_status=-1');
  expect(punishMark('2')).toBe(punishMark('2'));
  expect(punishMark('a; b')).toBe('punish.window punish_status=a%u003B%u0020b');
  expect(punishMark('a; b')).not.toContain(PUNISH_MARK_SEPARATOR.trim());
  const long = punishMark('9'.repeat(PUNISH_MARK_VALUE_MAX + 50));
  expect(long).toBe(`punish.window punish_status=${'9'.repeat(PUNISH_MARK_VALUE_MAX)}`);
  expect(() => punishMark('\ud800x')).not.toThrow();
  expect(punishMark('\ud800x')).toBe('punish.window punish_status=%uD800x');
  expect(punishMark('')).toBe('punish.window punish_status=');
});
