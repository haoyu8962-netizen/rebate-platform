// B2-04zj 源码旁单元测试：维权吸收截止时间只取决定 orders.settle_commission_fen 的记录（BR-FUND-09）。
// 不连库：脚本化驱动按表回预设行，order_rights 的 UPDATE 在内存里按 updated_at < 截止时间生效。
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
import type { OrderUpdateChange } from '../../../orders/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import { createRebatePort, type RebateDependencies } from './rebate.ts';

const NOW = '2026-10-22T03:00:00.000Z';
const clock = new FixedClock(NOW);
const APP = 'unit-app';
const ORDER = '019a0000-0000-7000-8000-000000000001';
const ATTR_AT = new Date('2026-10-01T00:00:00.000Z');
const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 8, minute));

interface SettlementRow {
  readonly source: 'API' | 'STATEMENT';
  readonly created_at: Date;
}

interface Rights {
  readonly updated_at: Date;
  answered_at: Date | null;
}

function database(records: readonly SettlementRow[], rights: Rights) {
  const order = {
    app_id: APP,
    order_id: ORDER,
    attr_at: ATTR_AT,
    platform: 'taobao',
    rebate_status: 'WAITING',
    platform_status: 'SETTLED',
    rights_pending: false,
    commission_version: 1,
  };
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> {
          const { sql, parameters } = compiled;
          if (sql.startsWith('update "app"."order_rights"')) {
            const before = parameters.at(-1) as Date;
            const answers = rights.answered_at === null && rights.updated_at < before;
            if (answers) rights.answered_at = parameters[0] as Date;
            return Promise.resolve({ rows: [], numAffectedRows: answers ? 1n : 0n });
          }
          if (sql.includes('from "app"."order_settlements"')) {
            return Promise.resolve({ rows: records as unknown as R[] });
          }
          if (sql.includes('from "app"."orders"')) {
            return Promise.resolve({ rows: [order as R] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

const deps: RebateDependencies = {
  clock,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  events: { publish: () => Promise.resolve() } as unknown as RebateDependencies['events'],
  config: { get: () => Promise.resolve(null) },
  estimates: {
    bases: () => Promise.resolve({ before: 900n, after: 900n }),
    refresh: () => Promise.resolve(),
  },
  audit: { append: () => Promise.resolve() },
};

/** A settled order's sync that carried this amount; only the rights records can move. */
const change = (settleCommissionFen: bigint): OrderUpdateChange => ({
  app_id: APP,
  order_id: ORDER,
  attr_at: ATTR_AT,
  from_status: 'SETTLED',
  to_status: 'SETTLED',
  rule: null,
  received_at: at(0),
  est_before: 1000n,
  est_after: 1000n,
  settle_commission_fen: settleCommissionFen,
  attributed_now: false,
});

async function sync(records: readonly SettlementRow[], rights: Rights, fen: bigint): Promise<void> {
  const db = database(records, rights);
  const port = createRebatePort(deps);
  await db.transaction().execute((trx) =>
    port.onUpdated(trx, change(fen), {
      event: null,
      raw_status: 'SETTLED',
    } as unknown as Parameters<typeof port.onUpdated>[2]),
  );
}

it('[AC-B2-04zj#U16] seq1 API 1000、seq2 STATEMENT 900、后到维权 100、再来 API 900：新 API 不决定列值，扣款不被标 answered', async () => {
  const rights: Rights = { updated_at: at(3), answered_at: null };
  const records: SettlementRow[] = [
    { source: 'API', created_at: at(4) },
    { source: 'STATEMENT', created_at: at(2) },
    { source: 'API', created_at: at(1) },
  ];
  await sync(records, rights, 900n);
  expect(rights.answered_at).toBeNull();
});

it('[AC-B2-04zj#U17] 维权早于最新 STATEMENT：照常被吸收，answered_at 取 Clock', async () => {
  const rights: Rights = { updated_at: at(1), answered_at: null };
  const records: SettlementRow[] = [
    { source: 'API', created_at: at(4) },
    { source: 'STATEMENT', created_at: at(2) },
  ];
  await sync(records, rights, 900n);
  expect(rights.answered_at).toEqual(clock.now());
});

it('[AC-B2-04zj#U18] 没有 STATEMENT：最新 API 决定列值，它之前收到的维权被吸收', async () => {
  const rights: Rights = { updated_at: at(3), answered_at: null };
  const records: SettlementRow[] = [
    { source: 'API', created_at: at(4) },
    { source: 'API', created_at: at(2) },
  ];
  await sync(records, rights, 900n);
  expect(rights.answered_at).toEqual(clock.now());
});
