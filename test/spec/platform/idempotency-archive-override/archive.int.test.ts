// Rule tests of the archive override of executeInTransaction (task B1-01zzs; orchestrator
// D10-1099 Q-6 (B), B1-20c plan §8.1 Q-6; 规划/04 §3.2 sessions「token 只存哈希」, §5「幂等」;
// 08 BR-WDR-07「成功和 3xxxx 业务错误写入」; contract in
// apps/api/src/modules/platform/idempotency/archive.ts and section 4 of ./index.ts there).
// POST /v1/auth/merge answers with the target account's tokens; with `{ archive }` the caller
// still gets them, while idempotency_keys keeps the archived envelope (tokens null) and a replay
// returns that. Without the option nothing changes; both are asserted side by side.
// Real PostgreSQL (the test database of @couli/db/testing), connected as couli_app; the
// handlers' business write is one processed_events row. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { IdempotencyArchiveOptions } from '../../../../apps/api/src/modules/platform/idempotency/archive.ts';
import {
  createIdempotency,
  type HandlerResult,
  type ResponseEnvelope,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  RESPONSES,
  RETENTION_MS,
  USER_A,
  businessCount,
  businessWrite,
  freshKey,
  isoPlus,
  outcome,
  recordingLogger,
  request as idemRequest,
  rowsOf,
  sha256Hex,
  type StoredRow,
} from '../idempotency/kit.ts';
import {
  MERGE_BODY,
  MERGE_HASH,
  MERGE_PATH,
  archiveSpy,
  freshTokens,
  loginBody,
  loginEnvelope,
  mergeRequest,
  nullTokens,
  rowsWithTokens,
  type ArchivingIdempotency,
  type Tokens,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';

let database: TestDatabase;
let db: Kysely<DB>;
let observer: Kysely<DB>;
let labelSeq = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(db);
  await destroyDb(observer);
  await database.drop();
});

function setup() {
  const clock = new FixedClock(T0);
  const { logger, calls } = recordingLogger();
  const idem: ArchivingIdempotency = createIdempotency({ db, clock, logger });
  return { idem, calls };
}

function freshLabel(): string {
  labelSeq += 1;
  return `b101zzs-${String(labelSeq)}`;
}

function newKey(): string {
  return freshKey('zzs');
}

/** A merge handler: one business write, then `status` with loginEnvelope(tokens, code, msg). */
function mergeHandler(
  label: string,
  tokens: Tokens,
  status = 200,
  code = 0,
  msg = '',
): { handler: (trx: Transaction<DB>) => Promise<HandlerResult>; handled: () => number } {
  let count = 0;
  return {
    handler: async (trx) => {
      count += 1;
      await businessWrite(trx, label, count);
      return { status, envelope: loginEnvelope(tokens, code, msg) };
    },
    handled: () => count,
  };
}

function responsesOf(rows: StoredRow[]): unknown[] {
  return rows.map((row) => [row.status, row.response]);
}

it('[AC-B1-01zzs#1] 不传覆写（省略、undefined、{}、{archive: undefined}）：返回与存档逐字相同、同键重放原样；同组传覆写的键：返回仍是含令牌的原响应，存档为覆写体，覆写函数只调用一次、收到的就是处理函数的 envelope，同键重放得到存档体', async () => {
  const { idem } = setup();
  const absent: (IdempotencyArchiveOptions | undefined | 'omitted')[] = [
    'omitted',
    undefined,
    {},
    { archive: undefined },
  ];
  for (const options of absent) {
    const key = newKey();
    const tokens = freshTokens();
    const { handler, handled } = mergeHandler(freshLabel(), tokens);
    const call = () =>
      options === 'omitted'
        ? idem.executeInTransaction(mergeRequest(key), handler)
        : idem.executeInTransaction(mergeRequest(key), handler, options);
    const label = JSON.stringify(options ?? 'undefined');
    expect(await outcome(call), label).toStrictEqual({
      status: 200,
      body: loginBody(tokens),
      source: 'handler',
    });
    expect(responsesOf(await rowsOf(observer, key)), label).toEqual([
      ['completed', { status: 200, body: loginBody(tokens) }],
    ]);
    expect(await outcome(call), label).toStrictEqual({
      status: 200,
      body: loginBody(tokens),
      source: 'replay',
    });
    expect(handled(), label).toBe(1);
  }

  const key = newKey();
  const tokens = freshTokens();
  const spy = archiveSpy();
  const { handler, handled } = mergeHandler(freshLabel(), tokens);
  const call = () => idem.executeInTransaction(mergeRequest(key), handler, spy.options);
  expect(await outcome(call)).toStrictEqual({
    status: 200,
    body: loginBody(tokens),
    source: 'handler',
  });
  expect(spy.seen).toStrictEqual([loginEnvelope(tokens)]);
  expect(responsesOf(await rowsOf(observer, key))).toEqual([
    ['completed', { status: 200, body: loginBody(null) }],
  ]);
  expect(await outcome(call)).toStrictEqual({
    status: 200,
    body: loginBody(null),
    source: 'replay',
  });
  expect(handled()).toBe(1);
  expect(spy.seen).toHaveLength(1);
});

it('[AC-B1-01zzs#2] 传覆写（data.tokens 置 null）：调用方拿到的响应含 access / refresh 令牌原文；idempotency_keys 任何一行（整行转文本）都不含这两个令牌原文，日志也不含；业务写入照常一起提交；覆写函数直接改动传入的对象并返回它，已返回的响应也不受影响', async () => {
  const { idem, calls } = setup();
  const variants: [string, (envelope: ResponseEnvelope) => ResponseEnvelope][] = [
    ['returns a new envelope', nullTokens],
    [
      'changes the envelope it is given',
      (envelope) => {
        (envelope.data as { tokens: unknown }).tokens = null;
        return envelope;
      },
    ],
  ];
  for (const [name, archive] of variants) {
    const key = newKey();
    const tokens = freshTokens();
    const label = freshLabel();
    const { handler } = mergeHandler(label, tokens);
    const response = await outcome(() =>
      idem.executeInTransaction(mergeRequest(key), handler, { archive }),
    );
    // loginBody(tokens) is the body with both token values in it.
    expect(response, name).toStrictEqual({
      status: 200,
      body: loginBody(tokens),
      source: 'handler',
    });
    expect(await businessCount(observer, label), name).toBe(1);
    expect(await rowsWithTokens(observer, tokens), name).toBe(0);
    const rows = await rowsOf(observer, key);
    expect(responsesOf(rows), name).toEqual([
      ['completed', { status: 200, body: loginBody(null) }],
    ]);
    const stored = JSON.stringify(rows);
    expect(stored, name).not.toContain(tokens.access_token);
    expect(stored, name).not.toContain(tokens.refresh_token);
    const logged = JSON.stringify(calls);
    expect(logged, name).not.toContain(tokens.access_token);
    expect(logged, name).not.toContain(tokens.refresh_token);
  }
});

it('[AC-B1-01zzs#3] 传覆写后同键重放：返回存档体（source replay，状态码同原响应，code、msg、trace_id 与 data 其余字段同原响应，tokens 为 null）；重放时带覆写、不带覆写、带会抛错的覆写都一样；处理函数与覆写函数都不再调用；换请求体仍 20901', async () => {
  const { idem } = setup();
  const key = newKey();
  const tokens = freshTokens();
  const label = freshLabel();
  const spy = archiveSpy();
  const { handler, handled } = mergeHandler(label, tokens, 201);
  expect(
    await outcome(() => idem.executeInTransaction(mergeRequest(key), handler, spy.options)),
  ).toStrictEqual({ status: 201, body: loginBody(tokens), source: 'handler' });
  // loginBody(null) differs from loginBody(tokens) only in data.tokens (both written by hand).
  const replay = { status: 201, body: loginBody(null), source: 'replay' };
  expect(
    await outcome(() => idem.executeInTransaction(mergeRequest(key), handler, spy.options)),
  ).toStrictEqual(replay);
  expect(await outcome(() => idem.executeInTransaction(mergeRequest(key), handler))).toStrictEqual(
    replay,
  );
  expect(
    await outcome(() =>
      idem.executeInTransaction(mergeRequest(key), handler, {
        archive: () => {
          throw new Error('archive must not run on a replay');
        },
      }),
    ),
  ).toStrictEqual(replay);
  expect(handled()).toBe(1);
  expect(spy.seen).toHaveLength(1);
  expect(
    await outcome(() =>
      idem.executeInTransaction(
        mergeRequest(key, { body: { merge_ticket: 'another-ticket' } }),
        handler,
        spy.options,
      ),
    ),
  ).toStrictEqual(RESPONSES.e20901);
  expect(handled()).toBe(1);
  expect(await businessCount(observer, label)).toBe(1);
  expect(await rowsWithTokens(observer, tokens)).toBe(0);
});

it('[AC-B1-01zzs#4] 3xxxx 结果同样按覆写存档：返回原响应、存档为覆写体、业务写入提交、同键重放存档体；1xxxx / 2xxxx / 4xxxx / 5xxxx 带覆写时照旧不存档：返回原响应、业务写入回滚、没有记录、覆写函数不调用、库里没有令牌原文', async () => {
  const { idem } = setup();
  {
    const key = newKey();
    const tokens = freshTokens();
    const label = freshLabel();
    const spy = archiveSpy();
    const { handler, handled } = mergeHandler(label, tokens, 409, 30411, 'm30411');
    expect(
      await outcome(() => idem.executeInTransaction(mergeRequest(key), handler, spy.options)),
    ).toStrictEqual({ status: 409, body: loginBody(tokens, 30411, 'm30411'), source: 'handler' });
    expect(responsesOf(await rowsOf(observer, key))).toEqual([
      ['completed', { status: 409, body: loginBody(null, 30411, 'm30411') }],
    ]);
    expect(spy.seen).toStrictEqual([loginEnvelope(tokens, 30411, 'm30411')]);
    expect(await businessCount(observer, label)).toBe(1);
    expect(await rowsWithTokens(observer, tokens)).toBe(0);
    expect(
      await outcome(() => idem.executeInTransaction(mergeRequest(key), handler, spy.options)),
    ).toStrictEqual({ status: 409, body: loginBody(null, 30411, 'm30411'), source: 'replay' });
    expect(handled()).toBe(1);
  }
  for (const [code, status] of [
    [10002, 401],
    [20002, 400],
    [40901, 409],
    [42901, 429],
    [50001, 500],
  ] as const) {
    const key = newKey();
    const tokens = freshTokens();
    const label = freshLabel();
    const spy = archiveSpy();
    const msg = `m${String(code)}`;
    const { handler } = mergeHandler(label, tokens, status, code, msg);
    expect(
      await outcome(() => idem.executeInTransaction(mergeRequest(key), handler, spy.options)),
      String(code),
    ).toStrictEqual({ status, body: loginBody(tokens, code, msg), source: 'handler' });
    expect(await rowsOf(observer, key), String(code)).toEqual([]);
    expect(await businessCount(observer, label), String(code)).toBe(0);
    expect(spy.seen, String(code)).toEqual([]);
    expect(await rowsWithTokens(observer, tokens), String(code)).toBe(0);
  }
});

it('[AC-B1-01zzs#5] 覆写只改 response 列：同一请求体分别不传与传覆写的两个键，主体、user_id、方法、路径、请求摘要、状态、创建时刻、过期时刻逐列相同并按规则写出（合并 30 天、提现 infinity）；response 的 status 都是处理函数的状态码，body 分别为原响应与覆写体', async () => {
  const targets = [
    { path: MERGE_PATH, body: MERGE_BODY, hash: MERGE_HASH, expire: isoPlus(T0, RETENTION_MS) },
    {
      path: '/v1/withdrawals',
      body: { amount_fen: 10000 },
      hash: sha256Hex('{"amount_fen":10000}'),
      expire: 'infinity',
    },
  ];
  for (const target of targets) {
    const { idem } = setup();
    const plainKey = newKey();
    const archivedKey = newKey();
    const plainTokens = freshTokens();
    const archivedTokens = freshTokens();
    const plain = mergeHandler(freshLabel(), plainTokens, 201);
    const archived = mergeHandler(freshLabel(), archivedTokens, 201);
    const req = (key: string) =>
      idemRequest({ method: 'POST', path: target.path, key, body: target.body });
    expect(
      await outcome(() => idem.executeInTransaction(req(plainKey), plain.handler)),
      target.path,
    ).toStrictEqual({ status: 201, body: loginBody(plainTokens), source: 'handler' });
    expect(
      await outcome(() =>
        idem.executeInTransaction(req(archivedKey), archived.handler, { archive: nullTokens }),
      ),
      target.path,
    ).toStrictEqual({ status: 201, body: loginBody(archivedTokens), source: 'handler' });
    const columns = (rows: StoredRow[]) =>
      rows.map((row) => ({
        subject: row.subject,
        user_id: row.user_id,
        method: row.method,
        path: row.path,
        request_hash: row.request_hash,
        status: row.status,
        created: row.created,
        expire: row.expire,
      }));
    const expected = [
      {
        subject: `u:${USER_A}`,
        user_id: USER_A,
        method: 'POST',
        path: target.path,
        request_hash: target.hash,
        status: 'completed',
        created: T0,
        expire: target.expire,
      },
    ];
    const plainRows = await rowsOf(observer, plainKey);
    const archivedRows = await rowsOf(observer, archivedKey);
    expect(columns(plainRows), target.path).toEqual(expected);
    expect(columns(archivedRows), target.path).toEqual(expected);
    expect(
      plainRows.map((row) => row.response),
      target.path,
    ).toEqual([{ status: 201, body: loginBody(plainTokens) }]);
    expect(
      archivedRows.map((row) => row.response),
      target.path,
    ).toEqual([{ status: 201, body: loginBody(null) }]);
  }
});

it('[AC-B1-01zzs#6] 覆写函数抛错：同一个错误对象原样抛出，处理函数的业务写入与幂等记录一起回滚，不留存档、库里与日志里没有令牌原文；同键再发带正常覆写，重新执行并按覆写存档', async () => {
  const { idem, calls } = setup();
  const key = newKey();
  const tokens = freshTokens();
  const label = freshLabel();
  const { handler, handled } = mergeHandler(label, tokens);
  const boom = new Error('archive failed');
  let caught: unknown = 'resolved without an error';
  try {
    await idem.executeInTransaction(mergeRequest(key), handler, {
      archive: () => {
        throw boom;
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(boom);
  expect(await businessCount(observer, label)).toBe(0);
  expect(await rowsOf(observer, key)).toEqual([]);
  expect(await rowsWithTokens(observer, tokens)).toBe(0);
  const logged = JSON.stringify(calls);
  expect(logged).not.toContain(tokens.access_token);
  expect(logged).not.toContain(tokens.refresh_token);
  expect(
    await outcome(() =>
      idem.executeInTransaction(mergeRequest(key), handler, { archive: nullTokens }),
    ),
  ).toStrictEqual({ status: 200, body: loginBody(tokens), source: 'handler' });
  expect(handled()).toBe(2);
  expect(await businessCount(observer, label)).toBe(1);
  expect(responsesOf(await rowsOf(observer, key))).toEqual([
    ['completed', { status: 200, body: loginBody(null) }],
  ]);
  expect(await rowsWithTokens(observer, tokens)).toBe(0);
});

it('[AC-B1-01zzs#6] 覆写函数返回非法值（undefined、null、字符串、数组、缺 trace_id、code 非整数、msg 非字符串、data 含 NaN 或 undefined、原型非普通对象、code 与原响应不同）→ IdempotencyError invalid_result：不返回处理函数的响应，业务写入回滚、没有记录、库里没有令牌原文', async () => {
  const { idem } = setup();
  const invalid: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['string', '{"code":0,"msg":"","trace_id":"t"}'],
    ['array', []],
    ['no trace_id', { code: 0, msg: '' }],
    ['code as string', { code: '0', msg: '', trace_id: 'archived-trace' }],
    ['code not an integer', { code: 0.5, msg: '', trace_id: 'archived-trace' }],
    ['msg not a string', { code: 0, msg: 0, trace_id: 'archived-trace' }],
    ['data with NaN', { code: 0, msg: '', data: { n: Number.NaN }, trace_id: 'archived-trace' }],
    [
      'data with undefined',
      { code: 0, msg: '', data: { tokens: undefined }, trace_id: 'archived-trace' },
    ],
    [
      'not a plain object',
      Object.assign(Object.create({ inherited: true }) as object, {
        code: 0,
        msg: '',
        trace_id: 'archived-trace',
      }),
    ],
    ['another code', { code: 30411, msg: 'm30411', trace_id: 'archived-trace' }],
  ];
  for (const [name, value] of invalid) {
    const key = newKey();
    const tokens = freshTokens();
    const label = freshLabel();
    const { handler } = mergeHandler(label, tokens);
    expect(
      await outcome(() =>
        idem.executeInTransaction(mergeRequest(key), handler, {
          archive: () => value as ResponseEnvelope,
        }),
      ),
      name,
    ).toStrictEqual({ error: 'IdempotencyError invalid_result' });
    expect(await businessCount(observer, label), name).toBe(0);
    expect(await rowsOf(observer, key), name).toEqual([]);
    expect(await rowsWithTokens(observer, tokens), name).toBe(0);
  }
});
