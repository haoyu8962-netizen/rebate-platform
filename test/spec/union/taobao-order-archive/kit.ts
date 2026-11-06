// B1-04zzc（D10-776，方案 A）：淘宝订单详情请求的归档只存去掉别家推广位行的报文。共用夹具：真实
// createArchivingTransport 包住内存里的假上游，交给真实 DataokeClient，再作为 orderSource 交给真实
// TaobaoUnionAdapter（大淘客订单路径）；归档表是假的 insert 记录（真实 Kysely 编译，只记
// app.union_raw_payloads 的插入，照 taobao-dataoke-switches/kit.ts 的写法）。
// 报文与推广位全部合成（冻结的 taobao-orders / taobao-refunds / taobao-convert kit 只读复用），不读任何录制。
// Task-local AC labels ([AC-B1-04zzc#n]) identify this task's acceptance points, not business rules.
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
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  OrderPage,
  UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { DataokeClient } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoOrderWarning,
  type TaobaoPunishWarning,
  type TaobaoRefundWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  FOREIGN_ADZONE,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  RETIRED_ADZONE,
  SLOTS,
  jsonText,
  num,
  pageData,
  rowOf,
  win,
} from '../taobao-orders/kit.ts';

export { FOREIGN_ADZONE, OTHER_FOREIGN_ADZONE, OUR_ADZONE, RETIRED_ADZONE, jsonText, num, win };

/** The 大淘客 interfaces (task brief): order details, refunds, punishments. */
export const ORDER_PATH = '/api/tb-service/get-order-details';
export const REFUND_PATH = '/api/tb-service/get-order-refund';
export const PUNISH_PATH = '/api/tb-service/get-foul-order-list';
export const DATAOKE_BASE = 'https://dataoke-order-archive.invalid';
export const INSTANT = '2026-11-02T04:00:00.000Z';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-order-archive.invalid/router/rest',
  quotaKey: 'synthetic-taobao-order-archive',
};

/** listOrders without the switch: a bad row is skipped with a warning. */
export const PLAIN: CallCtx = {
  appId: 'synthetic-order-archive-app',
  requestId: 'synthetic-order-archive-request',
  purpose: 'order_sync',
};
/** listOrders as the order sync calls it (B1-04zv): refused rows go to `rejected`. */
export const COLLECT: CallCtx = { ...PLAIN, rowErrors: 'collect' };

export const MODES: readonly { readonly mode: string; readonly call: CallCtx }[] = [
  { mode: '不开 collect', call: PLAIN },
  { mode: 'collect', call: COLLECT },
];

// ---------------------------------------------------------------------------------------------
// 报文
// ---------------------------------------------------------------------------------------------

/** The trade_id (sub-order number) of row `index` (rowOf's numbering). */
export function idOf(index: number): string {
  return `${2900000000000001000n + BigInt(index)}`;
}

/**
 * A good settled row of ours on `adzone` (active by default, RETIRED_ADZONE for the retired slot).
 * Under collect a settled row needs its settlement commission (B1-04zz): 7.66 − 1.00. A member set
 * to undefined in `overrides` is left out of the body.
 */
export function ours(
  index: number,
  adzone: string = OUR_ADZONE,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...rowOf(index, adzone), pub_share_fee_for_commission: '7.66', ...overrides };
}

/**
 * A row of another company's promotion slot (the shared union account): its adzone_id is readable
 * (a JSON integer, or a decimal string when `asText`) and not one of ours.
 */
export function foreign(
  index: number,
  adzone: string = FOREIGN_ADZONE,
  asText = false,
): Record<string, unknown> {
  return {
    ...rowOf(index, adzone),
    ...(asText ? { adzone_id: adzone } : {}),
    pub_share_fee_for_commission: '7.66',
  };
}

export interface BodyOptions {
  readonly hasNext?: boolean;
  readonly position?: string;
  /** Extra members of the outer object (next to time / code / msg / data). */
  readonly top?: Record<string, unknown>;
  /** Extra or replaced members of `data` (next to has_next / position_index / results). */
  readonly data?: Record<string, unknown>;
}

/** The body text of one order page holding `rows` (JSON number literals kept as written). */
export function orderBody(rows: readonly unknown[], options: BodyOptions = {}): string {
  const page = pageData(rows, {
    ...(options.hasNext === undefined ? {} : { hasNext: options.hasNext }),
    ...(options.position === undefined ? {} : { position: options.position }),
  });
  return jsonText({
    time: num('1793600000000'),
    code: num('0'),
    msg: '成功',
    ...options.top,
    data: { ...page, ...options.data },
  });
}

/** A fresh transport response per call (the archive hangs raw_payload_id on the object). */
export function answer(body: string, status = 200): UnionTransportResponse {
  return { status, headers: { 'content-type': 'application/json;charset=utf-8' }, body };
}

/** An order-shaped row of another slot slipped into a non-order answer; strings only. */
export const DECOY_TRADE_ID = '2900000000000009999';
export const DECOY: Readonly<Record<string, unknown>> = {
  trade_id: DECOY_TRADE_ID,
  adzone_id: FOREIGN_ADZONE,
  alipay_total_price: '66.60',
};

// ---------------------------------------------------------------------------------------------
// 归档表（内存）
// ---------------------------------------------------------------------------------------------

/** One insert into app.union_raw_payloads as the fake database received it. */
export interface ArchivedRow {
  /** The id the fake database returned (bigint decimal text). */
  readonly id: string;
  /** Column name → bound value. */
  readonly values: Readonly<Record<string, unknown>>;
}

const INSERT = /^insert into "app"\."union_raw_payloads" \(([^)]*)\) values \(([^)]*)\)/i;

/** The bound value of each column of a single-row insert into union_raw_payloads, or null. */
function boundValues(statement: CompiledQuery): Record<string, unknown> | null {
  const match = INSERT.exec(statement.sql);
  if (match === null) return null;
  const names = match[1]!.split(',').map((name) => name.trim().replace(/^"|"$/g, ''));
  const slots = match[2]!.split(',').map((slot) => slot.trim());
  const values: Record<string, unknown> = {};
  names.forEach((name, index) => {
    const slot = /^\$(\d+)$/.exec(slots[index] ?? '');
    values[name] = slot === null ? slots[index] : statement.parameters[Number(slot[1]) - 1];
  });
  return values;
}

/** Ids handed out when the test gives none: beyond 2^53, so they must stay decimal text. */
export const ARCHIVE_ID_BASE = 8_100_000_000_000_000_000n;

/**
 * Real Kysely compilation over an in-memory archive table: each insert into
 * app.union_raw_payloads is recorded and answered with the next id (`ids`, then ARCHIVE_ID_BASE +
 * n); any other statement is recorded in `unexpected` and fails.
 */
export function archiveDatabase(ids: readonly string[] = []) {
  const inserted: ArchivedRow[] = [];
  const unexpected: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      const values = boundValues(statement);
      if (values === null) {
        unexpected.push(statement.sql);
        throw new Error('synthetic archive database: unexpected statement');
      }
      const id = ids[inserted.length] ?? String(ARCHIVE_ID_BASE + BigInt(inserted.length + 1));
      inserted.push({ id, values });
      return { rows: [{ id }] as R[], numAffectedRows: 1n };
    },
    async *streamQuery() {
      expect.fail('the archive must not stream rows');
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
  return { db, inserted, unexpected };
}

export type ArchiveDatabase = ReturnType<typeof archiveDatabase>;

/** The stored payload bytes of an archive row. */
export function payloadBytes(row: ArchivedRow): Uint8Array {
  const payload = row.values['payload'];
  expect(payload, 'payload is stored as bytes').toBeInstanceOf(Uint8Array);
  return payload as Uint8Array;
}

/** gunzip of the stored payload, as UTF-8 text. */
export function payloadText(row: ArchivedRow): string {
  const bytes = payloadBytes(row);
  let text: string | undefined;
  try {
    text = gunzipSync(bytes).toString('utf8');
  } catch {
    text = undefined;
  }
  expect(text, 'payload is gzip').toBeDefined();
  return text!;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The URL path of the request an archive row summarises (request_summary.url). */
export function pathOf(row: ArchivedRow): string {
  const raw = row.values['request_summary'];
  let summary: unknown = raw;
  if (typeof raw === 'string') {
    try {
      summary = JSON.parse(raw) as unknown;
    } catch {
      summary = undefined;
    }
  }
  const url =
    typeof summary === 'object' && summary !== null
      ? (summary as Record<string, unknown>)['url']
      : undefined;
  expect(typeof url, 'request_summary carries the url').toBe('string');
  let path: string | undefined;
  try {
    path = new URL(url as string).pathname;
  } catch {
    path = undefined;
  }
  expect(path, 'request_summary.url is absolute').toBeDefined();
  return path!;
}

/** The single archive row of the requests to `path`. */
export function onlyArchiveOf(database: ArchiveDatabase, path: string): ArchivedRow {
  const rows = database.inserted.filter((row) => pathOf(row) === path);
  expect(rows, `exactly one archive row for ${path}`).toHaveLength(1);
  return rows[0]!;
}

// ---------------------------------------------------------------------------------------------
// JSON 数字原文
// ---------------------------------------------------------------------------------------------

/** A JSON number of a parsed text, kept as its literal (0.29999999999999999 stays as written). */
export class Literal {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** JSON.parse 的源文本访问（Node ≥ 21；本仓库 engines 为 Node 24）。 */
interface ReviverContext {
  readonly source?: string;
}

/** The JSON tree of `text`, every number as its Literal; throws when `text` is not JSON. */
export function parseLiterals(text: string): unknown {
  return JSON.parse(text, (_name: string, value: unknown, context?: ReviverContext) =>
    typeof value === 'number'
      ? new Literal(typeof context?.source === 'string' ? context.source : String(value))
      : value,
  );
}

/** parseLiterals as an assertion: a text that is not JSON fails the test. */
export function literalTree(text: string, label = 'archived payload'): unknown {
  let tree: unknown;
  let parsed: boolean;
  try {
    tree = parseLiterals(text);
    parsed = true;
  } catch {
    parsed = false;
  }
  expect(parsed, `${label} is JSON`).toBe(true);
  return tree;
}

/**
 * The archive row stores exactly `expected` (as a JSON tree whose numbers are compared by their
 * literal text; member order and whitespace are free), and content_hash is the sha256 of the stored
 * payload. Returns the stored text.
 */
export function expectArchivedAs(row: ArchivedRow, expected: string): string {
  const text = payloadText(row);
  expect(literalTree(text)).toEqual(literalTree(expected, 'expected body'));
  expect(row.values['content_hash'], 'content_hash is the sha256 of the stored payload').toBe(
    sha256Hex(payloadBytes(row)),
  );
  return text;
}

// ---------------------------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------------------------

/** One upstream request as the fake 大淘客 saw it: the path and the decoded query string. */
export interface Call {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export type Route = (call: Call) => UnionTransportResponse;

function decode(request: UnionTransportRequest): Call {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = value;
  return { path: url.pathname, query };
}

export interface WireOptions {
  /** Ids the fake archive table returns, insert by insert. */
  readonly ids?: readonly string[];
}

/**
 * A live TaobaoUnionAdapter whose 大淘客 client sends through the real archiving transport to a
 * fake upstream answering by `route`. Our slots are SLOTS (one active, one retired); the convert and
 * search switches are on 大淘客 so those requests pass the same archive.
 */
export function wire(route: Route, options: WireOptions = {}) {
  const clock = new FixedClock(INSTANT);
  const database = archiveDatabase(options.ids);
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
      appKey: 'fake-order-archive-dataoke-key',
      appSecret: 'arcv-arcv-arcv-arcv-arcv',
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
      appKey: 'fake-order-archive-taobao-key',
      appSecret: 'arct-arct-arct-arct-arct',
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
  });
  return { adapter, database, logger, orderWarn, refundWarn, punishWarn, upstream, calls };
}

export type Wired = ReturnType<typeof wire>;

// ---------------------------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------------------------

/** The skeleton's NotImplemented and assertion failures stay reds of their own. */
function isHarness(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AssertionError' || /\bNotImplemented\b/.test(`${error.name} ${error.message}`))
  );
}

/** The page a listOrders call resolves to; a rejection fails the test as an assertion. */
export async function resolvedPage(run: () => Promise<OrderPage>): Promise<OrderPage> {
  let page: OrderPage | undefined;
  let failure: unknown;
  try {
    page = await run();
  } catch (error) {
    if (isHarness(error)) throw error;
    failure = error;
  }
  expect(failure, 'listOrders must resolve').toBeUndefined();
  expect(page).toBeDefined();
  return page!;
}

/** What a call rejects with; resolving fails as an assertion. */
export async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    if (isHarness(error)) throw error;
    return error;
  }
  expect.fail('the call must reject');
}

/** Runs a call whose own result does not matter here (only its archive row is read). */
export async function regardless(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isHarness(error)) throw error;
  }
}

/** The counts of the taobao_order_foreign_slot warnings (one per page with foreign rows). */
export function foreignCounts(wired: Wired): readonly (number | undefined)[] {
  return wired.orderWarn.mock.calls
    .map(([event]) => event)
    .filter((event) => event.event === 'taobao_order_foreign_slot')
    .map((event) => event.count);
}

/** Everything a value would print, for redaction checks. */
export function visible(value: unknown): string {
  const replacer = (_key: string, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member;
  return `${JSON.stringify(value, replacer)}\n${inspect(value, { depth: null })}`;
}
