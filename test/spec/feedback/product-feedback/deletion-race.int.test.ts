// B1-28p (money r1 S1, S2; orchestrator brief §10): product feedback against an account deletion in
// progress, and a token and a signing device of different apps.
// S1 (08 BR-ID-28 删除清单「商品反馈记录」): the route is x-auth optional, so the deletion guard (stage
// ⑥, login levels only) lets a user in deletion processing through with a still valid token. The
// line's fix: a logged-in submission takes a shared lock on the users row in its own transaction,
// so it runs after (or before) the deletion cleanup, never across it; when it reads the account
// already in the deletion flow (users.status deleting / deleted) the row is written as a guest's
// (no user_id). So after the cleanup no row carries the user's user_id, whatever the timing.
// The cleanup transaction here is the one identity runs: users row FOR UPDATE, then feedback's
// deleteFeedbackForUser on that transaction; it is held open while the submission is sent and
// committed only after the submission waits on a lock (or has answered). #34 also moves the status
// normal → deleting under the same lock: the expiry transition and the cleanup landing while the
// submission is in flight, which a status read without the lock would miss.
// S2: a token of app A with a request signed by a device registered in app B is refused (the
// device does not belong to the app; the contract has no route-specific code, so the platform's
// device / app-source codes 10401 / 10402 / 10403) and writes nothing in either app.
// Only the orchestrator runs this file, with the shared integration global setup.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { deleteFeedbackForUser } from '../../../../apps/api/src/modules/feedback/index.ts';
import { lockUserRow } from '../../catalog/favorites-deletion/kit.ts';
import {
  CLEANUP_BLOCKED,
  capturedWorkerOptions,
  fieldCrypto,
  gate,
  identity,
  member,
  ports,
  seedRequest,
  settledOrWaiting,
  warnings,
  workerHarness,
  type Member,
  type Runner,
} from '../../identity/deletion-processing/kit.ts';
import {
  PATH,
  TRACE,
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
  type Device,
  type FeedbackRow,
  type Harness,
  type Response,
} from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

/** HTTP status of the platform refusals a foreign device may get (contracts/error-codes.yaml). */
const FOREIGN_DEVICE_STATUS: Readonly<Record<number, number>> = {
  10401: 401,
  10402: 401,
  10403: 403,
};

interface Scene {
  readonly appId: string;
  readonly m: Member;
  readonly device: Device;
  readonly token: string;
  readonly linkId: string;
  /** Submitted by the user while the account was normal (carries user_id). */
  readonly own: string;
  /** Submitted as a guest on the same device (no user_id). */
  readonly guest: string;
}

/** A normal user logged in on a registered device, with one own and one guest feedback. */
async function scene(h: Harness): Promise<Scene> {
  const appId = newAppId();
  const m = await member(h.db, { appId, status: 'normal' });
  await normalRisk(h, appId, m.uid);
  const device = await registerDevice(h, appId);
  const session = await login(h, device, m.uid);
  const linkId = await seedLink(h, appId);
  const own = accepted(h, await submit(h, device, feedbackBody(linkId), { token: session.token }));
  const guest = accepted(h, await submit(h, device, feedbackBody(linkId, { reason: 'other' })));
  const rows = await feedbackRows(h.db, appId);
  expect(rows.find((row) => row.id === own)?.user_id).toBe(m.uid);
  expect(rows.find((row) => row.id === guest)?.user_id).toBeNull();
  return { appId, m, device, token: session.token, linkId, own, guest };
}

function ownRows(rows: readonly FeedbackRow[], uid: string): FeedbackRow[] {
  return rows.filter((row) => row.user_id === uid);
}

/** users.status normal → deleting, as the cooling-period expiry does (one row). */
async function toDeleting(db: Kysely<DB>, appId: string, uid: string): Promise<void> {
  const result = await sql`UPDATE app.users SET status = 'deleting', row_version = row_version + 1
    WHERE app_id = ${appId} AND id = ${uid}::uuid AND status = 'normal'`.execute(db);
  expect(result.numAffectedRows).toBe(1n);
}

/** One round of the assembled deletion worker; feedback must not be a blocked port. */
async function deletionRound(h: Harness, appId: string, requestId: string): Promise<void> {
  const api = await identity();
  const p = await ports();
  let options: unknown;
  try {
    options = await capturedWorkerOptions(api, p);
  } finally {
    vi.restoreAllMocks();
  }
  const context = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
    h.db,
    await fieldCrypto(),
  );
  try {
    await (context.get(api.deletionExpiryToken()) as Runner).runOnce();
  } finally {
    await context.close();
  }
  const blocked = warnings(p, CLEANUP_BLOCKED, appId).filter(
    (line) => line['deletion_request_id'] === requestId,
  );
  expect(blocked.map((line) => line['port'])).not.toContain('feedback');
}

/**
 * Opens the cleanup transaction (users row FOR UPDATE, `before` on it, then
 * deleteFeedbackForUser), sends the user's logged-in submission while it is open, waits until the
 * submission waits on a lock or has answered, then commits the cleanup. Returns the submission's
 * response.
 */
async function submittedDuringCleanup(
  h: Harness,
  s: Scene,
  before?: (trx: Transaction<DB>) => Promise<void>,
): Promise<Response> {
  const locked = gate();
  const release = gate();
  const cleanup = h.db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, s.appId, s.m.uid)).toBe(1);
    if (before !== undefined) await before(trx);
    await deleteFeedbackForUser(trx, { appId: s.appId, userId: s.m.uid, at: h.clock.now() });
    expect(ownRows(await feedbackRows(trx, s.appId), s.m.uid)).toEqual([]);
    locked.open();
    await release.promise;
  });
  await Promise.race([locked.promise, cleanup]);
  const pending = submit(h, s.device, feedbackBody(s.linkId, { reason: 'info' }), {
    token: s.token,
  });
  try {
    await settledOrWaiting(h.db, pending);
  } finally {
    release.open();
  }
  await cleanup;
  return pending;
}

/** A platform refusal of a device that is not the app's: contract 4XX envelope, nothing else. */
function refusedAsForeign(h: Harness, response: Response): void {
  const body = response.json<Record<string, unknown>>();
  const code = body['code'];
  expect(
    Object.keys(FOREIGN_DEVICE_STATUS).map(Number),
    `a device of another app must be refused (HTTP ${response.statusCode}, code ${String(code)})`,
  ).toContain(code);
  expect(response.statusCode).toBe(FOREIGN_DEVICE_STATUS[code as number]);
  expect(body).toMatchObject({ msg: expect.any(String), trace_id: TRACE });
  const schema =
    h.document.paths[PATH]?.post?.responses['4XX']?.content?.['application/json']?.schema;
  expect(schema, `${PATH} must declare a 4XX JSON response`).toBeDefined();
  const validate = h.compile({ schema: schema!, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

it('[AC-B1-28p#32] 注销 processing（users.status=deleting）的用户仍持有效令牌提交 → 200，这条按游客记录写（不带 user_id，设备照记）；随后一轮注销清理后该 user_id 名下反馈为 0，这条与游客记录仍在', async () => {
  const h = use();
  const s = await scene(h);
  await toDeleting(h.db, s.appId, s.m.uid);
  const request = await seedRequest(h.db, s.m);
  const during = accepted(
    h,
    await submit(h, s.device, feedbackBody(s.linkId, { reason: 'rebate' }), { token: s.token }),
  );
  const rows = await feedbackRows(h.db, s.appId);
  expect(rows.find((row) => row.id === during)).toMatchObject({
    id: during,
    app_id: s.appId,
    device_id: s.device.id,
    user_id: null,
    reason: 'rebate',
  });

  await deletionRound(h, s.appId, request.id);
  const after = await feedbackRows(h.db, s.appId);
  expect(ownRows(after, s.m.uid)).toEqual([]);
  expect(after.map((row) => row.id).sort()).toEqual([s.guest, during].sort());
  expect(after.every((row) => row.user_id === null)).toBe(true);
}, 90_000);

it('[AC-B1-28p#33] 并发：注销清理事务持 users 行锁（用户已在 deleting）时发来登录提交，清理提交后：该 user_id 名下反馈为 0，这条按游客记录写，游客记录不动', async () => {
  const h = use();
  const s = await scene(h);
  await toDeleting(h.db, s.appId, s.m.uid);
  const response = await submittedDuringCleanup(h, s);
  const id = accepted(h, response);
  const after = await feedbackRows(h.db, s.appId);
  expect(ownRows(after, s.m.uid)).toEqual([]);
  expect(after.find((row) => row.id === id)).toMatchObject({
    id,
    device_id: s.device.id,
    user_id: null,
    reason: 'info',
  });
  expect(after.map((row) => row.id).sort()).toEqual([s.guest, id].sort());
}, 60_000);

it('[AC-B1-28p#34] 并发：同一事务持 users 行锁把用户由 normal 转 deleting 并清理时发来登录提交，提交后：该 user_id 名下反馈为 0，这条按游客记录写', async () => {
  const h = use();
  const s = await scene(h);
  const response = await submittedDuringCleanup(h, s, (trx) => toDeleting(trx, s.appId, s.m.uid));
  const id = accepted(h, response);
  const after = await feedbackRows(h.db, s.appId);
  expect(ownRows(after, s.m.uid)).toEqual([]);
  expect(after.find((row) => row.id === id)).toMatchObject({
    id,
    device_id: s.device.id,
    user_id: null,
  });
  expect(after.map((row) => row.id).sort()).toEqual([s.guest, id].sort());
}, 60_000);

it('[AC-B1-28p#35] 令牌属 app A、签名设备属 app B → 按设备不属本 app 拒绝（10401 / 10402 / 10403），两个 app 都不写；各自本 app 的设备照常收', async () => {
  const h = use();
  const a = newAppId();
  const b = newAppId();
  const deviceA = await registerDevice(h, a);
  const deviceB = await registerDevice(h, b);
  const user = await login(h, deviceA);
  const linkA = await seedLink(h, a);
  const linkB = await seedLink(h, b);
  const ownA = accepted(h, await submit(h, deviceA, feedbackBody(linkA), { token: user.token }));
  const ownB = accepted(h, await submit(h, deviceB, feedbackBody(linkB)));

  // X-App-Id A (the token's app), signed by app B's device with its own install secret.
  const borrowed: Device = { appId: a, id: deviceB.id, secret: deviceB.secret };
  refusedAsForeign(h, await submit(h, borrowed, feedbackBody(linkA), { token: user.token }));
  refusedAsForeign(h, await submit(h, borrowed, feedbackBody(linkA)));
  // X-App-Id B (the device's app) with app A's token.
  refusedAsForeign(h, await submit(h, deviceB, feedbackBody(linkB), { token: user.token }));
  refusedAsForeign(h, await submit(h, deviceB, feedbackBody(linkA), { token: user.token }));

  expect((await feedbackRows(h.db, a)).map((row) => row.id)).toEqual([ownA]);
  expect((await feedbackRows(h.db, b)).map((row) => row.id)).toEqual([ownB]);
}, 60_000);
