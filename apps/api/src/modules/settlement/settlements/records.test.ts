// B2-04zj 源码旁单元测试：结算记录端口的取 seq、内容比较与时间回退（不连库：脚本化驱动回预设行，记录编译后的语句）。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createSettlementRecords, type ApiSettlementInput } from './records.ts';

const NOW = '2026-10-22T03:00:00.000Z';
const clock = new FixedClock(NOW);
const REPORTED = new Date('2026-10-21T08:00:00.000Z');
const ORDER_AT = new Date('2026-10-20T08:00:00.000Z');

interface Stored {
  readonly seq: number;
  readonly source: string;
  readonly content_hash: string;
}

/** selects return `rows`; inserts are recorded as column name → parameter. */
function scripted(rows: readonly unknown[]) {
  const inserts: Record<string, unknown>[] = [];
  const selects: { sql: string; parameters: readonly unknown[] }[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> {
          if (compiled.sql.startsWith('insert')) {
            const columns = /\(([^)]*)\) values/u.exec(compiled.sql)?.[1] ?? '';
            const names = columns.split(', ').map((name) => name.replaceAll('"', ''));
            inserts.push(Object.fromEntries(names.map((n, i) => [n, compiled.parameters[i]])));
            return Promise.resolve({ rows: [] });
          }
          selects.push({ sql: compiled.sql, parameters: compiled.parameters });
          return Promise.resolve({ rows: rows as R[] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, inserts, selects };
}

const input = (patch: Partial<ApiSettlementInput> = {}): ApiSettlementInput => ({
  appId: 'unit-app',
  orderId: '019a0000-0000-7000-8000-000000000001',
  commissionFen: 1000n,
  reportedSettledAt: REPORTED,
  orderSettledAt: ORDER_AT,
  ...patch,
});

async function record(rows: readonly Stored[], value: ApiSettlementInput) {
  const { db, inserts } = scripted(rows);
  const records = createSettlementRecords({ clock });
  const result = await db.transaction().execute((trx) => records.recordApi(trx, value));
  return { result, inserts };
}

/** The hash `value` stores on an order without records. */
async function hashOf(value: ApiSettlementInput): Promise<string> {
  const { inserts } = await record([], value);
  return inserts[0]?.content_hash as string;
}

it('[AC-B2-04zj#U9] 第一条 seq=1，source=API，created_at 取 Clock，settled_at 取报文', async () => {
  const { result, inserts } = await record([], input());
  expect(result).toEqual({ seq: 1, inserted: true });
  expect(inserts).toMatchObject([
    {
      app_id: 'unit-app',
      seq: 1,
      source: 'API',
      settle_commission_fen: 1000n,
      settled_at: REPORTED,
      created_at: clock.now(),
    },
  ]);
});

it('[AC-B2-04zj#U10] settled_at 回退：订单，再 Clock；回退值不进内容', async () => {
  const fromOrder = await record([], input({ reportedSettledAt: null }));
  expect(fromOrder.inserts[0]?.settled_at).toEqual(ORDER_AT);
  const fromClock = await record([], input({ reportedSettledAt: null, orderSettledAt: null }));
  expect(fromClock.inserts[0]?.settled_at).toEqual(clock.now());
  expect(fromClock.inserts[0]?.content_hash).toBe(fromOrder.inserts[0]?.content_hash);
  expect(fromClock.inserts[0]?.content_hash).not.toBe(await hashOf(input()));
});

it('[AC-B2-04zj#U11] 内容只与最新 API 比：夹在中间的 STATEMENT 不参与，返回全局最大 seq', async () => {
  const hash = await hashOf(input());
  const rows: Stored[] = [
    { seq: 2, source: 'STATEMENT', content_hash: 'statement' },
    { seq: 1, source: 'API', content_hash: hash },
  ];
  const { result, inserts } = await record(rows, input());
  expect(result).toEqual({ seq: 2, inserted: false });
  expect(inserts).toEqual([]);
});

it('[AC-B2-04zj#U12] 内容不同接在任意来源的最大 seq 后；旧 API 行同内容不算（A→B→A）', async () => {
  const hash = await hashOf(input());
  const rows: Stored[] = [
    { seq: 3, source: 'STATEMENT', content_hash: hash },
    { seq: 2, source: 'API', content_hash: 'other' },
    { seq: 1, source: 'API', content_hash: hash },
  ];
  const { result, inserts } = await record(rows, input());
  expect(result).toEqual({ seq: 4, inserted: true });
  expect(inserts[0]?.seq).toBe(4);
});

it('[AC-B2-04zj#U13] 哈希随金额与时间变，金额 0 与 null 时间不相撞', async () => {
  const hashes = await Promise.all([
    hashOf(input()),
    hashOf(input({ commissionFen: 999n })),
    hashOf(input({ reportedSettledAt: new Date('2026-10-21T09:00:00.000Z') })),
    hashOf(input({ reportedSettledAt: null })),
    hashOf(input({ commissionFen: 0n, reportedSettledAt: null })),
  ]);
  expect(new Set(hashes).size).toBe(hashes.length);
});

it('[AC-B2-04zj#U14] latestStatementFen 只看本订单 STATEMENT 取 seq 最大；0 是金额，没有行是 null', async () => {
  const ref = { appId: 'unit-app', orderId: input().orderId };
  const records = createSettlementRecords({ clock });
  const zero = scripted([{ settle_commission_fen: 0n }]);
  await expect(
    zero.db.transaction().execute((trx) => records.latestStatementFen(trx, ref)),
  ).resolves.toBe(0n);
  expect(zero.selects[0]?.parameters).toEqual([ref.appId, ref.orderId, 'STATEMENT', 1]);
  expect(zero.selects[0]?.sql).toContain('order by "seq" desc');
  const none = scripted([]);
  await expect(
    none.db.transaction().execute((trx) => records.latestStatementFen(trx, ref)),
  ).resolves.toBeNull();
});

it('[AC-B2-04zj#U15] latestDecidingRecordAt 有 STATEMENT 取最新 STATEMENT，没有才取最新 API，没有行是 null', async () => {
  const ref = { appId: 'unit-app', orderId: input().orderId };
  const records = createSettlementRecords({ clock });
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 8, minute));
  const read = async (rows: readonly { source: string; created_at: Date }[]) => {
    const { db, selects } = scripted(rows);
    const value = await db.transaction().execute((trx) => records.latestDecidingRecordAt(trx, ref));
    return { value, selects };
  };

  const beside = await read([
    { source: 'API', created_at: at(4) },
    { source: 'STATEMENT', created_at: at(3) },
    { source: 'STATEMENT', created_at: at(2) },
    { source: 'API', created_at: at(1) },
  ]);
  expect(beside.value).toEqual(at(3));
  expect(beside.selects[0]?.parameters).toEqual([ref.appId, ref.orderId]);
  expect(beside.selects[0]?.sql).toContain('order by "seq" desc');

  const apiOnly = await read([
    { source: 'API', created_at: at(2) },
    { source: 'API', created_at: at(1) },
  ]);
  expect(apiOnly.value).toEqual(at(2));
  expect((await read([])).value).toBeNull();
});

it('[AC-B2-04zi#U5] newDecidingSeq：本事务新写且无 STATEMENT 才给 seq；别的端口实例同事务可问，别的事务、别的订单问不到', async () => {
  const ref = { appId: 'unit-app', orderId: input().orderId };
  const writer = createSettlementRecords({ clock });
  const asker = createSettlementRecords({ clock });
  const { db } = scripted([{ seq: 1, source: 'API', content_hash: 'older' }]);
  await db.transaction().execute(async (trx) => {
    expect(asker.newDecidingSeq(trx, ref)).toBeNull();
    await expect(writer.recordApi(trx, input())).resolves.toEqual({ seq: 2, inserted: true });
    expect(asker.newDecidingSeq(trx, ref)).toBe(2);
    expect(asker.newDecidingSeq(trx, { ...ref, appId: 'other-app' })).toBeNull();
    expect(
      asker.newDecidingSeq(trx, { ...ref, orderId: '019a0000-0000-7000-8000-000000000002' }),
    ).toBeNull();
  });
  await db.transaction().execute((trx) => {
    expect(asker.newDecidingSeq(trx, ref)).toBeNull();
    return Promise.resolve();
  });
});

it('[AC-B2-04zi#U6] newDecidingSeq：同内容重放不新写、有 STATEMENT 时新 API 不决定金额，都是 null', async () => {
  const ref = { appId: 'unit-app', orderId: input().orderId };
  const records = createSettlementRecords({ clock });
  const hash = await hashOf(input());
  const replay = scripted([{ seq: 1, source: 'API', content_hash: hash }]);
  await replay.db.transaction().execute(async (trx) => {
    await expect(records.recordApi(trx, input())).resolves.toEqual({ seq: 1, inserted: false });
    expect(records.newDecidingSeq(trx, ref)).toBeNull();
  });
  const beside = scripted([
    { seq: 2, source: 'STATEMENT', content_hash: 'statement' },
    { seq: 1, source: 'API', content_hash: 'older' },
  ]);
  await beside.db.transaction().execute(async (trx) => {
    await expect(records.recordApi(trx, input())).resolves.toEqual({ seq: 3, inserted: true });
    expect(records.newDecidingSeq(trx, ref)).toBeNull();
  });
});
