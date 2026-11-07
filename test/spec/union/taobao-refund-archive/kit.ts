// B1-04zzu（D10-796 ② 甲，D10-809；规划变更 20261031-淘宝订单经大淘客 §1「同步时按凑狸的推广位过滤，不入库
// 别家订单」）：淘宝维权 get-order-refund 请求的归档只存凑狸已入库订单的行。维权记录没有推广位字段，是否凑狸
// 订单由注入的「自家淘宝订单查询」（TaobaoAdapterOptions.ownOrders）按 ctx.appId 与这一页读得出的 tb_trade_id
// 回答。本目录的小工具：维权报文（外层形状照冻结的 taobao-refunds/kit.ts 的 refundData，可加外层字段）、
// 单号、内存里的自家订单查询、以及带这个端口的装配（照 taobao-order-archive/kit.ts 的 wire：真实
// createArchivingTransport + 真实 DataokeClient + 真实淘宝适配器，归档表是假的 insert；那个 wire 不能注入新端口，
// 这里自行组装，不改那个 kit）。报文与单号全部合成，不读任何录制。
// Task-local AC labels ([AC-B1-04zzu#n]) identify this task's acceptance points, not business rules.
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
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  createArchivingTransport,
  type ArchiveBodyLookupFailed,
} from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { DataokeClient } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoOrderWarning,
  type TaobaoOwnOrderReader,
  type TaobaoPunishWarning,
  type TaobaoRefundWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  DATAOKE_BASE,
  INSTANT,
  PLAIN,
  REFUND_PATH,
  answer,
  archiveDatabase,
  endpoint,
  visible,
  type Call,
  type Route,
} from '../taobao-order-archive/kit.ts';
import { SLOTS, jsonText, num, refundData, refundOf } from '../taobao-refunds/kit.ts';

export { PLAIN, REFUND_PATH };

/**
 * The error_code this task gives an archive row whose own-order lookup failed (the skeleton's
 * ArchiveBodyLookupFailed): the row then stores the body as received.
 */
export const LOOKUP_FAILED: ArchiveBodyLookupFailed = 'archive_body_lookup_failed';

/** The tb_trade_id of refundOf(index) (frozen taobao-refunds kit). */
export function tradeIdOf(index: number): string {
  return `${2900000000000001000n + BigInt(index)}`;
}

/** The refund_suit_id of refundOf(index): listRefunds' refund_id. */
export function suitIdOf(index: number): string {
  return `${3300000000000001000n + BigInt(index)}`;
}

/** refundOf(index) with its own refund_suit_id (another refund suit of the same trade). */
export function refundSuit(index: number, suit: number): Record<string, unknown> {
  return { ...refundOf(index), refund_suit_id: suitIdOf(suit) };
}

/** The amounts every refundOf row carries (none may reach a log). */
export const AMOUNTS: readonly string[] = ['88.80', '6.66', '7.99', '1.20'];

export interface RefundBodyOptions {
  readonly hasNext?: boolean;
  /** data.position_index; null leaves it out. */
  readonly position?: string | null;
  /** Extra members of the outer object (next to time / code / msg / data). */
  readonly top?: Record<string, unknown>;
  /** Extra or replaced members of `data` (next to has_next / position_index / result). */
  readonly data?: Record<string, unknown>;
}

/** The body text of one refund page holding `rows` (JSON number literals kept as written). */
export function refundBody(rows: unknown, options: RefundBodyOptions = {}): string {
  const page = refundData(rows, {
    ...(options.hasNext === undefined ? {} : { hasNext: options.hasNext }),
    ...(options.position === undefined ? {} : { position: options.position }),
  });
  return jsonText({
    time: num('1793433600000'),
    code: num('0'),
    msg: '成功',
    ...options.top,
    data: { ...page, ...options.data },
  });
}

/**
 * An in-memory own-order lookup: 凑狸's stored taobao orders are `owned` (mutable, so an order can
 * be stored later); it answers the asked numbers that are owned, as the real one does.
 */
export function ownOrders(owned: Iterable<string> = []) {
  const stored = new Set(owned);
  const reader = vi.fn<TaobaoOwnOrderReader>(
    async (_appId, orderNos) => new Set(orderNos.filter((no) => stored.has(no))),
  );
  return { reader, stored };
}

/** A lookup that always fails with `error`. */
export function failingOwnOrders(error: unknown) {
  return vi.fn<TaobaoOwnOrderReader>(async () => {
    throw error;
  });
}

/**
 * The lookup was asked exactly once, with `call.appId` and exactly the distinct `expected` numbers
 * (no number twice; order free).
 */
export function expectAskedOnce(
  reader: ReturnType<typeof ownOrders>['reader'],
  expected: readonly string[],
  call: CallCtx = PLAIN,
): void {
  expect(reader, 'one own-order lookup for the one refund page').toHaveBeenCalledTimes(1);
  const [appId, asked] = reader.mock.calls[0]!;
  expect(appId).toBe(call.appId);
  expect(new Set(asked).size, 'the asked numbers are deduplicated').toBe(asked.length);
  expect([...asked].sort()).toEqual([...new Set(expected)].sort());
}

function decode(request: UnionTransportRequest): Call {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = value;
  return { path: url.pathname, query };
}

export interface RefundWireOptions {
  /** The adapter's own-order lookup; absent leaves the port out (as before this task). */
  readonly ownOrders?: TaobaoOwnOrderReader;
}

/**
 * A live TaobaoUnionAdapter like taobao-order-archive's wire (same archive, 大淘客 client, slots,
 * convert and search switches), plus the own-order lookup when given.
 */
export function wireRefunds(route: Route, options: RefundWireOptions = {}) {
  const clock = new FixedClock(INSTANT);
  const database = archiveDatabase();
  const calls: Call[] = [];
  const upstream = vi.fn<UnionTransport>(async (request) => {
    const call = decode(request);
    calls.push(call);
    return route(call);
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const transport = createArchivingTransport(upstream, { db: database.db, clock, logger });
  const orderSource = new DataokeClient({
    baseUrl: DATAOKE_BASE,
    clock,
    credentials: async () => ({
      appKey: 'fake-refund-archive-dataoke-key',
      appSecret: 'rfnd-rfnd-rfnd-rfnd-rfnd',
    }),
    random: () => 42,
    transport,
  });
  const orderWarn = vi.fn<(event: TaobaoOrderWarning) => void>();
  const refundWarn = vi.fn<(event: TaobaoRefundWarning) => void>();
  const punishWarn = vi.fn<(event: TaobaoPunishWarning) => void>();
  const adapter = new TaobaoUnionAdapter({
    clock,
    credentials: async () => ({
      appKey: 'fake-refund-archive-taobao-key',
      appSecret: 'rfnt-rfnt-rfnt-rfnt-rfnt',
    }),
    transport: vi.fn<UnionTransport>(async () => answer('{}')),
    endpoint,
    orderSource,
    orderSlots: async () => SLOTS,
    orderWarn,
    refundWarn,
    punishWarn,
    convertSource: 'dataoke',
    searchSource: 'dataoke',
    ...(options.ownOrders === undefined ? {} : { ownOrders: options.ownOrders }),
  });
  return { adapter, database, logger, orderWarn, refundWarn, punishWarn, upstream, calls };
}

export type RefundWired = ReturnType<typeof wireRefunds>;

/**
 * Real Kysely compilation over an in-memory driver: records every statement and answers no rows
 * (so a read of stored orders finds none). Never touches a real database.
 */
export function recordingDatabase() {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(statement);
      return { rows: [] };
    },
    async *streamQuery() {
      expect.fail('the own-order read must not stream rows');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

/**
 * The statements of one own-order read are plain reads of app.orders for `appId`, platform taobao
 * and every one of `orderNos` (bound as values or inside an array value): no write, no lock.
 */
export function expectOwnOrderRead(
  statements: readonly CompiledQuery[],
  appId: string,
  orderNos: readonly string[],
): void {
  expect(statements.length, 'the read asks the database').toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement.sql, 'a plain read').toMatch(/^\s*(\(\s*)?(with\b[\s\S]*\b)?select\b/i);
    expect(statement.sql, 'no lock').not.toMatch(
      /\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b/i,
    );
    expect(statement.sql).not.toMatch(/\b(insert|update|delete|merge)\b/i);
  }
  const reads = statements.filter((statement) => /"orders"/.test(statement.sql));
  expect(reads.length, 'app.orders is read').toBeGreaterThan(0);
  const bound = reads.flatMap((statement) => statement.parameters.flat());
  expect(bound).toContain(appId);
  expect(bound).toContain('taobao');
  for (const no of orderNos) expect(bound).toContain(no);
}

/** Everything the archive logger and the refund warn hook received, as it would print. */
export function loggedText(wired: RefundWired): string {
  return visible([
    wired.logger.warn.mock.calls,
    wired.logger.error.mock.calls,
    wired.refundWarn.mock.calls,
  ]);
}
