import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { UnionError } from '../domain/types.ts';
import {
  ARCHIVE_BODY_FAILED,
  ARCHIVE_BODY_LOOKUP_FAILED,
  ArchiveBodyLookupError,
  createArchivingTransport,
  isSensitiveParameter,
  requestSummary,
  responseErrorCode,
} from './archive.ts';
import type { UnionTransportRequest } from './replay.ts';

function fakeDb(fail = false, id?: bigint) {
  const statements: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            statements.push(query);
            if (fail) throw new RangeError('fake insert refused');
            return { rows: (id === undefined ? [] : [{ id }]) as R[], numAffectedRows: 1n };
          },
          async *streamQuery() {
            throw new Error('not streamed');
          },
        }),
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      }),
    },
  });
  return { db, statements };
}

const base: UnionTransportRequest = {
  platform: 'pdd',
  method: 'POST',
  url: 'https://unit.invalid/api?sign=x1&type=q',
  headers: { 'content-type': 'application/json', authorization: 'hdr-x' },
  body: '{"client_id":"c1","p_id":"p1","nested":{"access_token":"t1","keep":1}}',
  archive: { appId: 'unit-app', kind: 'query' },
};

it('[AC-B1-04p-UNIT#1] 敏感键判定覆盖大小写、下划线、连字符与 secret/token 后缀', () => {
  for (const name of ['appKey', 'CLIENT-ID', 'Session_Key', 'x_secret', 'myToken', 'SIGN']) {
    expect(isSensitiveParameter(name)).toBe(true);
  }
  for (const name of ['type', 'p_id', 'goods_sign', 'custom_parameters', 'order_sn']) {
    expect(isSensitiveParameter(name)).toBe(false);
  }
});

it('[AC-B1-04m-UNIT#1] 大淘客 signRan 各种写法都算敏感键，nonce / timer / version 不算', () => {
  for (const name of ['signRan', 'sign_ran', 'SIGN-RAN']) {
    expect(isSensitiveParameter(name)).toBe(true);
  }
  for (const name of ['nonce', 'timer', 'version']) {
    expect(isSensitiveParameter(name)).toBe(false);
  }
});

it('[AC-B1-04p-UNIT#2] 摘要去掉查询串与敏感键（含嵌套），不含请求头', () => {
  expect(requestSummary(base)).toEqual({
    method: 'POST',
    url: 'https://unit.invalid/api',
    params: { type: 'q', p_id: 'p1', nested: { keep: 1 } },
  });
  expect(requestSummary({ ...base, body: 'not json' })).toEqual({
    method: 'POST',
    url: 'https://unit.invalid/api',
    body_bytes: 8,
  });
});

it('[AC-B1-04p-UNIT#3] 错误码：非 2xx、错误信封、其余为 null', () => {
  const reply = (status: number, body: string) => ({ status, headers: {}, body });
  expect(responseErrorCode(reply(500, ''))).toBe('http_500');
  expect(responseErrorCode(reply(200, '{"error_response":{"error_code":7}}'))).toBe('7');
  expect(responseErrorCode(reply(200, '{"ok":1}'))).toBeNull();
  expect(responseErrorCode(reply(200, 'x'))).toBeNull();
});

it('[AC-B1-04p-UNIT#4] 成功调用插入一行后返回原响应，延迟取 Clock 差', async () => {
  const { db, statements } = fakeDb();
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const reply = { status: 200, headers: {}, body: 'raw' };
  const wrapped = createArchivingTransport(
    async () => {
      clock.advanceMs(5);
      return reply;
    },
    { db, clock, logger },
  );
  expect(await wrapped(base)).toBe(reply);
  expect(statements).toHaveLength(1);
  expect(statements[0]!.sql).toMatch(/^insert into "app"\."union_raw_payloads"/);
  const parameters = statements[0]!.parameters;
  expect(parameters).toContain('unit-app');
  expect(parameters).toContain(5);
  const payload = parameters.find((value) => Buffer.isBuffer(value)) as Buffer;
  expect(gunzipSync(payload).toString()).toBe('raw');
  expect(JSON.stringify(parameters)).not.toMatch(/hdr-x|"c1"|t1|x1/);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B1-04p-UNIT#5] 插入失败时原错误照抛并记 error；无上下文只 warn 不插入', async () => {
  const { db, statements } = fakeDb(true);
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const failure = new UnionError('upstream_unavailable', 'unit failure', 'pdd');
  const wrapped = createArchivingTransport(
    async () => {
      throw failure;
    },
    { db, clock, logger },
  );
  await expect(wrapped(base)).rejects.toBe(failure);
  expect(logger.error).toHaveBeenCalledWith(
    {
      event: 'union.raw_payload.archive_failed',
      platform: 'pdd',
      kind: 'query',
      error_name: 'RangeError',
    },
    expect.any(String),
  );
  const { archive: omitted, ...plain } = base;
  void omitted;
  await expect(wrapped(plain)).rejects.toBe(failure);
  expect(statements).toHaveLength(1);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ event: 'union.raw_payload.no_context' });
});

it('[AC-B1-08e-UNIT#1] 插入成功时以不可枚举属性回传行 id，响应引用与可枚举内容不变', async () => {
  const { db, statements } = fakeDb(false, 9007199254740993n);
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const reply = { status: 200, headers: {}, body: 'raw' };
  const wrapped = createArchivingTransport(async () => reply, { db, clock, logger });
  const result = await wrapped(base);
  expect(result).toBe(reply);
  expect(result.raw_payload_id).toBe('9007199254740993');
  expect(Object.keys(result)).toEqual(['status', 'headers', 'body']);
  expect(result).toEqual({ status: 200, headers: {}, body: 'raw' });
  expect(statements[0]!.sql).toMatch(/returning "id"$/);
});

it('[AC-B1-08e-UNIT#2] 插入失败或无上下文时不挂 raw_payload_id', async () => {
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const failing = createArchivingTransport(
    async () => ({ status: 200, headers: {}, body: 'raw' }),
    { db: fakeDb(true).db, clock, logger },
  );
  expect(await failing(base)).not.toHaveProperty('raw_payload_id');
  const { archive: omitted, ...plain } = base;
  void omitted;
  const wrapped = createArchivingTransport(
    async () => ({ status: 200, headers: {}, body: 'raw' }),
    { db: fakeDb(false, 7n).db, clock, logger },
  );
  expect(await wrapped(plain)).not.toHaveProperty('raw_payload_id');
});

/** Column → bound value of the single-row insert. */
function inserted(statement: CompiledQuery): Record<string, unknown> {
  const match = /\(([^)]*)\) values \(([^)]*)\)/.exec(statement.sql);
  expect(match).not.toBeNull();
  const names = match![1]!.split(',').map((name) => name.trim().replace(/"/g, ''));
  const slots = match![2]!.split(',').map((slot) => Number(slot.trim().slice(1)) - 1);
  return Object.fromEntries(names.map((name, i) => [name, statement.parameters[slots[i]!]]));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

it('[AC-B1-04zzc-UNIT#1] 带 archiveBody：存改写后的正文（content_hash 是存下的 gzip 的 sha256），error_code 不加标记，调用方拿到原响应', async () => {
  const { db, statements } = fakeDb(false, 11n);
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const reply = { status: 200, headers: {}, body: 'raw-with-foreign' };
  const rewrite = vi.fn((body: string) => body.replace('-with-foreign', ''));
  const wrapped = createArchivingTransport(async () => reply, { db, clock, logger });
  const result = await wrapped({ ...base, archiveBody: rewrite });
  expect(result).toBe(reply);
  expect(result.body).toBe('raw-with-foreign');
  expect(result.raw_payload_id).toBe('11');
  expect(rewrite).toHaveBeenCalledExactlyOnceWith('raw-with-foreign');
  const row = inserted(statements[0]!);
  const payload = row['payload'] as Buffer;
  expect(gunzipSync(payload).toString()).toBe('raw');
  expect(row['content_hash']).toBe(sha256(payload));
  expect(row['error_code']).toBeNull();
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B1-04zzc-UNIT#2] 改写抛错：照样插入一行，payload 是空串的 gzip、error_code 有值（非 2xx 保留 http_<status>），error 日志不带正文，调用结果不变', async () => {
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  for (const [status, code] of [
    [200, ARCHIVE_BODY_FAILED],
    [502, 'http_502'],
  ] as const) {
    const { db, statements } = fakeDb(false, 12n);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const reply = { status, headers: {}, body: 'secret-order-2900000000000001050' };
    const wrapped = createArchivingTransport(async () => reply, { db, clock, logger });
    const result = await wrapped({
      ...base,
      archiveBody: () => {
        throw new SyntaxError('synthetic rewrite failure 2900000000000001050');
      },
    });
    expect(result).toBe(reply);
    expect(result.raw_payload_id).toBe('12');
    expect(statements).toHaveLength(1);
    const row = inserted(statements[0]!);
    const payload = row['payload'] as Buffer;
    expect(gunzipSync(payload).toString()).toBe('');
    expect(row['content_hash']).toBe(sha256(payload));
    expect(row['error_code']).toBe(code);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      {
        event: 'union.raw_payload.archive_body_failed',
        platform: 'pdd',
        kind: 'query',
        error_name: 'SyntaxError',
      },
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('2900000000000001050');
  }
});

it('[AC-B1-04zzc-UNIT#3] 不带 archiveBody：存收到的原文，行为与之前相同；inner 抛错时不调用改写', async () => {
  const { db, statements } = fakeDb();
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const wrapped = createArchivingTransport(
    async () => ({ status: 200, headers: {}, body: 'raw-as-received' }),
    { db, clock, logger },
  );
  await wrapped(base);
  const row = inserted(statements[0]!);
  expect(gunzipSync(row['payload'] as Buffer).toString()).toBe('raw-as-received');
  expect(row['error_code']).toBeNull();

  const failure = new UnionError('upstream_unavailable', 'unit failure', 'pdd');
  const rewrite = vi.fn((body: string) => body);
  const failing = createArchivingTransport(
    async () => {
      throw failure;
    },
    { db, clock, logger },
  );
  await expect(failing({ ...base, archiveBody: rewrite })).rejects.toBe(failure);
  expect(rewrite).not.toHaveBeenCalled();
  const second = inserted(statements[1]!);
  expect(gunzipSync(second['payload'] as Buffer).toString()).toBe('');
  expect(second['error_code']).toBe('upstream_unavailable');
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B1-04zzu-UNIT#1] archiveBody 返回 Promise：存它给出的正文；以 ArchiveBodyLookupError 失败时照样插入、存收到的原文、error_code 是 archive_body_lookup_failed（非 2xx 保留 http_<status>），日志只带错误名', async () => {
  const clock = new FixedClock('2026-11-07T00:00:00.000Z');
  const resolved = fakeDb(false, 21n);
  const quiet = { warn: vi.fn(), error: vi.fn() };
  const ok = createArchivingTransport(
    async () => ({ status: 200, headers: {}, body: 'raw-with-foreign' }),
    { db: resolved.db, clock, logger: quiet },
  );
  await ok({ ...base, archiveBody: async (body) => body.replace('-with-foreign', '') });
  const kept = inserted(resolved.statements[0]!);
  expect(gunzipSync(kept['payload'] as Buffer).toString()).toBe('raw');
  expect(kept['error_code']).toBeNull();
  expect(quiet.error).not.toHaveBeenCalled();

  expect(ARCHIVE_BODY_LOOKUP_FAILED).not.toBe(ARCHIVE_BODY_FAILED);
  for (const [status, code] of [
    [200, ARCHIVE_BODY_LOOKUP_FAILED],
    [502, 'http_502'],
  ] as const) {
    const { db, statements } = fakeDb(false, 22n);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const reply = { status, headers: {}, body: 'body-with-order-2900000000000001077' };
    const wrapped = createArchivingTransport(async () => reply, { db, clock, logger });
    const result = await wrapped({
      ...base,
      archiveBody: async () => {
        throw new ArchiveBodyLookupError(new RangeError('lookup down 2900000000000001077'));
      },
    });
    expect(result).toBe(reply);
    expect(result.raw_payload_id).toBe('22');
    const row = inserted(statements[0]!);
    const payload = row['payload'] as Buffer;
    expect(gunzipSync(payload).toString()).toBe(reply.body);
    expect(row['content_hash']).toBe(sha256(payload));
    expect(row['error_code']).toBe(code);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      {
        event: 'union.raw_payload.archive_body_lookup_failed',
        platform: 'pdd',
        kind: 'query',
        error_name: 'RangeError',
      },
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('2900000000000001077');
  }
});
