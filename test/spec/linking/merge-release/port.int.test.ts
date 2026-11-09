// B1-20c: linking's merge port releaseForMerge (规划/08 BR-ID-06「当前账号联盟绑定直接置 released（不冷却）」;
// BR-ID-19 / BR-ID-20): on identity's merge transaction, the source account's active / invalid
// bindings become released with released_at = cooldown_until = the merge instant; every other row
// stays; re-entrant; this app and this user only. Only the orchestrator runs this file, with the
// shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { releaseForMerge } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  AT,
  DAY_MS,
  bind,
  bindingsOf,
  bindingsOfApp,
  lockUser,
  rolledBack,
  shift,
  subject,
  type BindingRow,
  type Subject,
} from '../deletion-cleanup/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

/** A merge source: a normal third-party account (not in deletion). */
const source = (appId?: string) =>
  subject(db, { status: 'normal', ...(appId === undefined ? {} : { appId }) });

/** The row BR-ID-06 expects after the merge at `at` (the reason column is not judged here). */
function releasedForMerge(before: BindingRow, at: Date = AT): BindingRow {
  return {
    ...before,
    status: 'released',
    released_at: at,
    cooldown_until: at,
    row_version: before.row_version + 1,
    updated_at: at,
  };
}

function withoutReason(rows: readonly BindingRow[]) {
  return rows.map((row) => ({ ...row, reason: undefined }));
}

/** One row per status a source may hold when it is merged, one platform each. */
const STATES = [
  { platform: 'taobao', status: 'active', blocked_reason: null, releases: true },
  { platform: 'jd', status: 'invalid', blocked_reason: null, releases: true },
  { platform: 'meituan', status: 'blocked', blocked_reason: 'ban', releases: false },
  { platform: 'vip', status: 'blocked', blocked_reason: 'admin_disable', releases: false },
  { platform: 'douyin', status: 'blocked', blocked_reason: 'deletion', releases: false },
  { platform: 'eleme', status: 'released', blocked_reason: null, releases: false },
  { platform: 'kuaishou', status: 'unbound', blocked_reason: null, releases: false },
] as const;

async function everyState(s: Subject) {
  const rows: { releases: boolean; row: BindingRow }[] = [];
  for (const state of STATES) {
    rows.push({
      releases: state.releases,
      row: await bind(db, s, {
        platform: state.platform,
        status: state.status,
        blocked_reason: state.blocked_reason,
      }),
    });
  }
  return rows;
}

function expected(rows: readonly { releases: boolean; row: BindingRow }[], at: Date = AT) {
  return rows
    .map(({ releases, row }) => (releases ? releasedForMerge(row, at) : row))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

it.each(['active', 'invalid'] as const)(
  '[AC-B1-20c#36] 并号释放：%s → released，released_at = cooldown_until = 并号时刻（不冷却），relation_id / bound_at 保留',
  async (status) => {
    const s = await source();
    const row = await bind(db, s, { platform: 'taobao', status });
    await db
      .transaction()
      .execute((trx) => releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT }));
    const after = await bindingsOf(db, s);
    expect(withoutReason(after)).toStrictEqual(withoutReason([releasedForMerge(row)]));
    expect(after[0]!.cooldown_until).toEqual(after[0]!.released_at);
  },
);

it('[AC-B1-20c#37] 一次调用覆盖该用户全部平台：active / invalid 释放；blocked（ban、admin_disable、deletion）、已释放、未绑定的行不动，不增删行', async () => {
  const s = await source();
  const rows = await everyState(s);
  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect(withoutReason(await bindingsOf(db, s))).toStrictEqual(withoutReason(expected(rows)));
});

it('[AC-B1-20c#38] 可重入：同一事务内再调、提交后换更晚的时刻再调，都不再改任何行', async () => {
  const s = await source();
  await everyState(s);
  const input = { appId: s.appId, userId: s.userId };
  const once = await db.transaction().execute(async (trx) => {
    await releaseForMerge(trx, { ...input, at: AT });
    const first = await bindingsOf(trx, s);
    expect(first.filter((row) => row.status === 'released')).toHaveLength(3);
    await releaseForMerge(trx, { ...input, at: shift(AT, 1) });
    expect(await bindingsOf(trx, s)).toStrictEqual(first);
    return first;
  });
  expect(await bindingsOf(db, s)).toStrictEqual(once);
  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { ...input, at: shift(AT, DAY_MS) }));
  expect(await bindingsOf(db, s)).toStrictEqual(once);
});

it('[AC-B1-20c#39] 只用调用方事务：提交前别的连接看不到改动，调用方回滚后全部绑定复原', async () => {
  const s = await source();
  const rows = await everyState(s);
  const before = await bindingsOf(db, s);
  // rolledBack catches only its own rollback sentinel; NotImplemented must propagate.
  await rolledBack(db, async (trx) => {
    await releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT });
    expect(withoutReason(await bindingsOf(trx, s))).toStrictEqual(withoutReason(expected(rows)));
    expect(await bindingsOf(db, s)).toStrictEqual(before);
  });
  expect(await bindingsOf(db, s)).toStrictEqual(before);
});

it('[AC-B1-20c#40] 调用方事务已锁住源的 users 行（并号事务的锁）时照常执行，随调用方提交', async () => {
  const s = await source();
  const row = await bind(db, s, { platform: 'taobao', status: 'active' });
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
    await lockUser(trx, s);
    await releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT });
    expect(withoutReason(await bindingsOf(trx, s))).toStrictEqual(
      withoutReason([releasedForMerge(row)]),
    );
    expect(await bindingsOf(db, s)).toStrictEqual([row]);
  });
  expect(withoutReason(await bindingsOf(db, s))).toStrictEqual(
    withoutReason([releasedForMerge(row)]),
  );
});

it('[AC-B1-20c#41] 按 app_id 与用户隔离：同 App 其他用户（含并号目标）、别的 App 不受影响；同一 userId 配别的 appId 不改任何行', async () => {
  const s = await source();
  const target = await source(s.appId);
  const elsewhere = await source();
  await everyState(s);
  await everyState(target);
  await everyState(elsewhere);
  const mine = await bindingsOf(db, s);
  const theirs = await bindingsOf(db, target);
  const otherApp = await bindingsOfApp(db, elsewhere.appId);

  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: elsewhere.appId, userId: s.userId, at: AT }));
  expect(await bindingsOf(db, s)).toStrictEqual(mine);
  expect(await bindingsOfApp(db, elsewhere.appId)).toStrictEqual(otherApp);

  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect((await bindingsOf(db, s)).filter((row) => row.status === 'released')).toHaveLength(3);
  expect(await bindingsOf(db, target)).toStrictEqual(theirs);
  expect(await bindingsOfApp(db, elsewhere.appId)).toStrictEqual(otherApp);
});

it('[AC-B1-20c#42] 没有任何绑定的源：调用成功、不写任何行', async () => {
  const s = await source();
  const neighbour = await source(s.appId);
  await bind(db, neighbour, { platform: 'taobao', status: 'active' });
  const sameApp = await bindingsOfApp(db, s.appId);
  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT }));
  expect(await bindingsOf(db, s)).toStrictEqual([]);
  expect(await bindingsOfApp(db, s.appId)).toStrictEqual(sameApp);
});
