// B1-04zzzze (D10-1072 ②): through the archiving transport, the error_code column of
// union_raw_payloads also carries the 淘宝 error_response that 大淘客 forwards inside `data`.
// Reuses the frozen ../archive/ fixtures read-only; synthetic data only.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { harness, request, response, rows, START } from '../archive/kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let reader: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  if (reader) await destroyDb(reader);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

const NESTED =
  '{"code":0,"data":{"error_response":{"code":11,"sub_code":"isv.synthetic","msg":"合成说明"}}}';

it.each([
  [200, NESTED, '11'],
  [200, '{"code":0,"data":{"error_response":{"error_code":50001,"code":8}}}', '50001'],
  [201, '{"code":0,"data":{"error_response":{"error_code":null,"code":"E-syn"}}}', 'E-syn'],
  [299, '{"error_response":null,"data":{"error_response":{"code":12}}}', '12'],
] as const)(
  '[AC-B1-04zzzze#6] status=%s body=%s 经归档传输提交的行 error_code 为 data 内淘宝错误码 %s，原文与时延不变',
  async (status, body, code) => {
    const h = harness(db);
    const reply: UnionTransportResponse = { ...response(body), status };
    const wrapped = createArchivingTransport(async () => {
      h.clock.advanceMs(23);
      return reply;
    }, h);
    expect(await wrapped(request(h.appId, { platform: 'taobao' }))).toBe(reply);
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      platform: 'taobao',
      error_code: code,
      latency_ms: 23,
      fetched_at: new Date(Date.parse(START) + 23),
    });
    expect(gunzipSync(stored[0]!.payload).toString('utf8')).toBe(body);
    expect(h.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzzze#7] 同一 app 依次归档：顶层优先、正常回包与 data.error_response 非对象记 NULL、非 2xx 记 http_<status>、只在 data 内时记其码', async () => {
  const h = harness(db);
  const replies: readonly [number, string][] = [
    [200, '{"error_response":{"code":7},"data":{"error_response":{"code":11}}}'],
    [200, '{"code":0,"msg":"ok","data":{"list":[{"id":"synthetic-1"}],"totalNum":1}}'],
    [200, '{"code":0,"data":{"error_response":null}}'],
    [200, '{"code":0,"data":[{"error_response":{"code":11}}]}'],
    [502, NESTED],
    [200, NESTED],
  ];
  let index = 0;
  const wrapped = createArchivingTransport(async () => {
    const [status, body] = replies[index++]!;
    return { ...response(body), status };
  }, h);
  for (let i = 0; i < replies.length; i++) await wrapped(request(h.appId, { platform: 'taobao' }));
  const stored = await rows(reader, h.appId);
  expect(stored.map((row) => gunzipSync(row.payload).toString('utf8'))).toEqual(
    replies.map(([, body]) => body),
  );
  expect(stored.map((row) => row.error_code)).toEqual(['7', null, null, null, 'http_502', '11']);
});
