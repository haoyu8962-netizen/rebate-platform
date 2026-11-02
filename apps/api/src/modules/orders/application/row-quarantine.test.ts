// B1-04zv 源码旁单元测试：单号本身不能作订单键的坏行，不取锁、不查 order_keys，待处理照常写。不连库：用只记录
// 语句、不返回行的 Kysely，语句是真编译出来的。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { RejectedOrderRow } from '../../union/index.ts';
import type { OrderPipelineContext } from './pipeline-types.ts';
import { quarantineRows } from './row-quarantine.ts';

const NOW = '2026-10-02T00:00:00.000Z';

const ctx: OrderPipelineContext = {
  app_id: 'couli',
  platform: 'pdd',
  union_account_id: 'unit-account',
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: NOW,
  requestId: 'unit-request',
};

/** A Kysely whose driver records each compiled statement and answers no rows. */
function recordingDb() {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  return { db, queries };
}

function rejected(subOrderId: string): RejectedOrderRow {
  return {
    sub_order_id: subOrderId,
    raw_status: 'paid',
    raw_payload_id: null,
    detail: 'order_amount: not a number',
    row_key: subOrderId,
  };
}

it.each([
  ['[AC-B1-04zv#u1] a colon', '123:456'],
  ['[AC-B1-04zv#u2] an empty string', ''],
])(
  '%s as the sub-order number skips the lock and order_keys and still writes the pending row',
  async (_label, subOrderId) => {
    const { db, queries } = recordingDb();
    const error = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error };

    await quarantineRows({ db, clock: new FixedClock(NOW), logger }, [rejected(subOrderId)], ctx);

    expect(queries).toHaveLength(1);
    const insert = queries[0];
    expect(insert?.sql).toContain('insert into "app"."order_sync_pending"');
    expect(insert?.parameters.slice(0, 5)).toEqual([
      'couli',
      'pdd',
      subOrderId,
      null,
      'ORDER_ROW_INVALID',
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: 'P1', event: 'order_row_invalid' }),
      expect.any(String),
    );
  },
);
