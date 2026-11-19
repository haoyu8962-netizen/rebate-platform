// B2-02z (claude-independent; D10-2092 ⑤; contracts/openapi.yaml recalcBalanceAdminReconDiff
// 「Member notice」: the message is written in the same transaction that writes the balance row; a
// rolled-back transaction sends none): recordBalanceCorrectedMessage writes only on the caller's
// transaction — inside it both rows are visible, after the caller rolls back neither notify_logs
// nor inbox_messages has a row, and the same (reconDiffId, balanceVersion) then writes normally
// (no dedupe key was left behind). Real database over couli_app.
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  dedupeKeyOf,
  inputOf,
  member,
  record,
  recordBalanceCorrectedMessage,
  rowsOf,
} from './db-kit.ts';
import { CODE, TITLE, bodyOf } from './texts.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
}, 180_000);
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

it('[AC-B2-02z#9] 随调用方事务回滚：事务内写入后回滚 → notify_logs 与站内信都没有行；之后同一键照常写入一条', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: 1000n, after_fen: -1234n });
  const rollback = new Error('fixture rollback');
  const seen: { wrote?: boolean; inside?: Awaited<ReturnType<typeof rowsOf>> } = {};

  try {
    await db.transaction().execute(async (trx) => {
      seen.wrote = await recordBalanceCorrectedMessage(trx, input);
      seen.inside = await rowsOf(trx, m.appId);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }

  expect(seen.wrote).toBe(true);
  expect(seen.inside?.logs.map((row) => [row.channel, row.dedupe_key])).toEqual([
    ['inbox', dedupeKeyOf(input)],
  ]);
  expect(seen.inside?.inbox.map((row) => [row.code, row.title])).toEqual([[CODE, TITLE]]);
  // Rolled back with the caller: nothing was written on a connection of its own.
  expect(await rowsOf(db, m.appId)).toEqual({ logs: [], inbox: [] });

  expect(await record(db, input)).toBe(true);
  const { logs, inbox } = await rowsOf(db, m.appId);
  expect(logs.map((row) => [row.channel, row.status, row.dedupe_key])).toEqual([
    ['inbox', 'success', dedupeKeyOf(input)],
  ]);
  expect(inbox.map((row) => [row.title, row.body])).toEqual([[TITLE, bodyOf('¥10', '-¥12.34')]]);
}, 900_000);

it('[AC-B2-02z#9] 调用方在写入之后的步骤失败（如写余额行出错）→ 整笔回滚，两张表都没有行', async () => {
  const m = await member(db, { status: 'normal' });
  const input = inputOf(m, { before_fen: -300n, after_fen: 200n });
  const failure = new Error('fixture: the balance row write failed');

  await expect(
    db.transaction().execute(async (trx) => {
      expect(await recordBalanceCorrectedMessage(trx, input)).toBe(true);
      expect((await rowsOf(trx, m.appId)).inbox).toHaveLength(1);
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(await rowsOf(db, m.appId)).toEqual({ logs: [], inbox: [] });
}, 900_000);
