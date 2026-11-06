// B1-28p: feedback's deletion cleanup step deleteFeedbackForUser (08 BR-ID-28 删除清单「商品反馈记录」,
// BR-ID-30 细则「商品反馈记录」 留存; brief §9.2 ④). The step is identity's DeletionCleanupStep:
// (trx, { appId, userId, at }) on the caller's transaction, which has already locked the users row;
// it never opens or commits a transaction, so a rollback of the caller takes the deletion back.
// Every row carrying the user's user_id in that app goes (any device, whatever its created_at); rows
// a guest submitted (no user_id) stay, also on the user's own devices, and so do other users' rows.
// Re-entrant. Then the same step as app.module assembles it, and one real deletion round of the
// worker. The feedback rows are written through the HTTP route, so before the implementation the
// fixture fails as an assertion.
// Only the orchestrator runs this file, with the shared integration global setup.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { deleteFeedbackForUser } from '../../../../apps/api/src/modules/feedback/index.ts';
import type { DeletionCleanupStep } from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import { assembledCleanup, lockUserRow, rolledBack } from '../../catalog/favorites-deletion/kit.ts';
import {
  CLEANUP_BLOCKED,
  capturedWorkerOptions,
  fieldCrypto,
  identity,
  member,
  ports,
  seedRequest,
  warnings,
  workerHarness,
  type Runner,
} from '../../identity/deletion-processing/kit.ts';
import {
  accepted,
  feedbackBody,
  feedbackRows,
  login,
  newAppId,
  normalRisk,
  registerDevice,
  seedLink,
  submit,
  suite,
  type FeedbackRow,
  type Harness,
} from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);
const HOUR_MS = 3_600_000;

/**
 * One app: the user U (a deletion-kit member, status normal) logged in on two devices with three
 * feedbacks; guest feedbacks on both of U's devices; another user V on U's first device with one.
 */
async function scene(h: Harness) {
  const appId = newAppId();
  const m = await member(h.db, { appId, status: 'normal' });
  await normalRisk(h, appId, m.uid);
  const first = await registerDevice(h, appId);
  const second = await registerDevice(h, appId);
  const onFirst = await login(h, first, m.uid);
  const onSecond = await login(h, second, m.uid);
  const other = await login(h, first);
  const linkId = await seedLink(h, appId);
  const own = [
    accepted(h, await submit(h, first, feedbackBody(linkId), { token: onFirst.token })),
    accepted(
      h,
      await submit(h, first, feedbackBody(linkId, { reason: 'rebate' }), { token: onFirst.token }),
    ),
    accepted(h, await submit(h, second, feedbackBody(linkId), { token: onSecond.token })),
  ];
  const kept = [
    accepted(h, await submit(h, first, feedbackBody(linkId))),
    accepted(h, await submit(h, second, feedbackBody(linkId, { reason: 'other' }))),
    accepted(h, await submit(h, first, feedbackBody(linkId), { token: other.token })),
  ];
  const rows = await feedbackRows(h.db, appId);
  expect(
    rows
      .filter((row) => row.user_id === m.uid)
      .map((row) => row.id)
      .sort(),
  ).toEqual([...own].sort());
  expect(rows.filter((row) => row.user_id !== m.uid)).toHaveLength(kept.length);
  return { appId, m, own, kept, otherUid: other.uid };
}

function ownRows(rows: readonly FeedbackRow[], uid: string): FeedbackRow[] {
  return rows.filter((row) => row.user_id === uid);
}

function keptRows(rows: readonly FeedbackRow[], uid: string): FeedbackRow[] {
  return rows.filter((row) => row.user_id !== uid);
}

it('[AC-B1-28p#23] 在调用方事务里删掉该用户本 app 名下全部反馈（各设备、晚于 at 的也删）；游客记录与别的用户记录不动；提交前别的连接仍看到原样', async () => {
  const h = use();
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  const at = new Date(h.clock.now().getTime() - HOUR_MS);
  await h.db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, s.appId, s.m.uid)).toBe(1);
    await deleteFeedbackForUser(trx, { appId: s.appId, userId: s.m.uid, at });
    expect(ownRows(await feedbackRows(trx, s.appId), s.m.uid)).toEqual([]);
    expect(ownRows(await feedbackRows(h.db, s.appId), s.m.uid)).toHaveLength(s.own.length);
  });
  const after = await feedbackRows(h.db, s.appId);
  expect(ownRows(after, s.m.uid)).toEqual([]);
  expect(after).toEqual(keptRows(before, s.m.uid));
  expect(after.map((row) => row.id).sort()).toEqual([...s.kept].sort());
  expect(after.filter((row) => row.user_id === null)).toHaveLength(2);
}, 60_000);

it('[AC-B1-28p#24] 调用方回滚则删除一并回滚：一条不少', async () => {
  const h = use();
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  await rolledBack(h.db, async (trx) => {
    expect(await lockUserRow(trx, s.appId, s.m.uid)).toBe(1);
    await deleteFeedbackForUser(trx, { appId: s.appId, userId: s.m.uid, at: h.clock.now() });
    expect(ownRows(await feedbackRows(trx, s.appId), s.m.uid)).toEqual([]);
  });
  expect(await feedbackRows(h.db, s.appId)).toEqual(before);
}, 60_000);

it('[AC-B1-28p#25] 按 app_id 限定：同一 user_id 配另一个 appId 时本 app 一条不删', async () => {
  const h = use();
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  await h.db
    .transaction()
    .execute((trx) =>
      deleteFeedbackForUser(trx, { appId: newAppId(), userId: s.m.uid, at: h.clock.now() }),
    );
  expect(await feedbackRows(h.db, s.appId)).toEqual(before);
  await h.db
    .transaction()
    .execute((trx) =>
      deleteFeedbackForUser(trx, { appId: s.appId, userId: s.otherUid, at: h.clock.now() }),
    );
  const after = await feedbackRows(h.db, s.appId);
  expect(after.filter((row) => row.user_id === s.otherUid)).toEqual([]);
  expect(ownRows(after, s.m.uid)).toEqual(ownRows(before, s.m.uid));
}, 60_000);

it('[AC-B1-28p#26] 可重入：同一事务再调、提交后另起事务再调都不报错，结果不变；没有反馈的用户也不报错', async () => {
  const h = use();
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  const input = { appId: s.appId, userId: s.m.uid, at: h.clock.now() };
  await h.db.transaction().execute(async (trx) => {
    await deleteFeedbackForUser(trx, input);
    await deleteFeedbackForUser(trx, { ...input, at: new Date(input.at.getTime() + 1) });
    expect(ownRows(await feedbackRows(trx, s.appId), s.m.uid)).toEqual([]);
  });
  await h.db.transaction().execute((trx) => deleteFeedbackForUser(trx, input));
  expect(await feedbackRows(h.db, s.appId)).toEqual(keptRows(before, s.m.uid));

  const empty = await member(h.db, { appId: s.appId, status: 'normal' });
  await h.db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, s.appId, empty.uid)).toBe(1);
    await deleteFeedbackForUser(trx, { appId: s.appId, userId: empty.uid, at: h.clock.now() });
  });
  expect(await feedbackRows(h.db, s.appId)).toEqual(keptRows(before, s.m.uid));
}, 60_000);

it('[AC-B1-28p#27] 装配版 feedback 端口在调用方事务里删掉该用户的反馈，游客与别人的不动', async () => {
  const h = use();
  const api = await identity();
  const p = await ports();
  let cleanup: Readonly<Record<string, unknown>> = {};
  try {
    cleanup = assembledCleanup(await capturedWorkerOptions(api, p), p) as unknown as Readonly<
      Record<string, unknown>
    >;
  } finally {
    vi.restoreAllMocks();
  }
  expect(cleanup['feedback'], 'deletionCleanupPorts.feedback must be a cleanup step').toBeTypeOf(
    'function',
  );
  const step = cleanup['feedback'] as DeletionCleanupStep;
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  await h.db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, s.appId, s.m.uid)).toBe(1);
    await step(trx, { appId: s.appId, userId: s.m.uid, at: h.clock.now() });
  });
  expect(await feedbackRows(h.db, s.appId)).toEqual(keptRows(before, s.m.uid));
}, 60_000);

it('[AC-B1-28p#28] 装配版注销清理跑完一轮：processing 用户名下反馈为空，游客与别人的记录不动，cleanup_blocked 不点名 feedback', async () => {
  const h = use();
  const api = await identity();
  const p = await ports();
  let options: unknown;
  try {
    options = await capturedWorkerOptions(api, p);
  } finally {
    vi.restoreAllMocks();
  }
  const s = await scene(h);
  const before = await feedbackRows(h.db, s.appId);
  // The user applied for deletion and the cooling period is over: users.status deleting plus a
  // processing request (the deletion kit's fixture).
  await sql`UPDATE app.users SET status = 'deleting', row_version = row_version + 1
    WHERE app_id = ${s.appId} AND id = ${s.m.uid}`.execute(h.db);
  const request = await seedRequest(h.db, s.m);
  const context = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
    h.db,
    await fieldCrypto(),
  );
  try {
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    await runner.runOnce();
  } finally {
    await context.close();
  }
  expect(await feedbackRows(h.db, s.appId)).toEqual(keptRows(before, s.m.uid));
  const blocked = warnings(p, CLEANUP_BLOCKED, s.appId).filter(
    (line) => line['deletion_request_id'] === request.id,
  );
  expect(blocked.map((line) => line['port'])).not.toContain('feedback');
}, 90_000);
