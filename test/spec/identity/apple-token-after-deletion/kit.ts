// B1-02zzd rule-test kit (BR-ID-27「Sign in with Apple 用户必须调用 Apple 撤销接口，失败重试 3 次后
// 告警」, BR-ID-28「user_oauth 全部行（先撤销 Apple 授权）」; 编排 D10-966, D10-968). An Apple login or
// Apple re-verification of an account in deletion (users.status deleting or deleted) exchanges a
// fresh refresh token that is never stored: one apple_unbind_revoke job (B1-02zw) carries it as a
// cipher of APPLE_REFRESH_TOKEN_CONTEXT, on identity's data-copy queue, committed on its own.
//
// The apps are those of oauth-login/kit.ts and reverify/kit.ts (real AppModule, real database and
// queue; only the provider exchange is a double). A job is found by its app id in pgboss.job, its
// cipher decrypted with the app's own FieldCrypto, and it is handed once to the real handler of
// apple-unbind-revocation.ts over a recording Apple double: what it revokes is what was exchanged.
// The retries and the alert of the handler are B1-02zw's (AC-B1-02zw#20, #21, #26), not repeated.
//
// Every test reaches a step only the implementation passes: a case that says "nothing is queued"
// ends with the same app queueing the revocation of an account in deletion, because on today's code
// the first half alone is green and proves nothing. A decryption that fails is an assertion, never a
// thrown error.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  APPLE_UNBIND_REVOKE_JOB,
  createAppleUnbindRevocation,
} from '../../../../apps/api/src/modules/identity/application/apple-unbind-revocation.ts';
import { DATA_COPY_QUEUE } from '../../../../apps/api/src/modules/identity/application/data-copy-worker.ts';
import type { AppleTokenRevokeInput } from '../../../../apps/api/src/modules/identity/ports/apple-token-revoker.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';

/** Field-cipher context of the Apple refresh token (identity's APPLE_REFRESH_TOKEN_CONTEXT). */
export const APPLE_REFRESH_CONTEXT = 'user_oauth.apple_refresh_token';
/** What a cipher that does not decrypt reads as, so the comparison fails as an assertion. */
const UNREADABLE = '<cipher does not decrypt>';

/** A fresh Apple refresh token per call, so that a leak of one is attributable. */
export function appleToken(): string {
  return `apple-refresh-${randomUUID()}`;
}

/** A job row of pgboss.job as the executor would claim it. */
export interface QueuedJob {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
}

/** The app's committed jobs, whatever their queue (event queues left out). */
export async function jobsOf(db: Kysely<DB>, appId: string): Promise<QueuedJob[]> {
  const { rows } = await sql<{
    id: string;
    queue: string;
    data: { name?: unknown; payload?: unknown } | null;
  }>`select id::text as id, name as queue, data from pgboss.job
    where data::text like ${`%${appId}%`} and name not like 'evt.%'`.execute(db);
  return rows.map((job) => {
    const data: { name?: unknown; payload?: unknown } = job.data ?? {};
    const { name, payload } = data;
    return {
      id: job.id,
      queue: job.queue,
      name: typeof name === 'string' ? name : '',
      payload: payload !== null && typeof payload === 'object' ? (payload as JobPayload) : {},
    };
  });
}

/** The plaintext a job's payload.cipher decrypts to (UNREADABLE when it does not). */
export function plaintextOf(crypto: FieldCrypto, job: QueuedJob): string {
  const cipher = job.payload['cipher'];
  if (typeof cipher !== 'string') return UNREADABLE;
  try {
    return crypto.decrypt(cipher, APPLE_REFRESH_CONTEXT);
  } catch {
    return UNREADABLE;
  }
}

/** The app's apple_unbind_revoke jobs. */
export async function revocations(db: Kysely<DB>, appId: string): Promise<QueuedJob[]> {
  return (await jobsOf(db, appId)).filter((job) => job.name === APPLE_UNBIND_REVOKE_JOB);
}

/** The tokens the app's apple_unbind_revoke jobs would revoke, sorted. */
export async function revokedTokens(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
): Promise<string[]> {
  return (await revocations(db, appId)).map((job) => plaintextOf(crypto, job)).sort();
}

/** The ways a string can be spelled in a JSON payload or a log line. */
export function spellings(text: string): string[] {
  const buffer = Buffer.from(text, 'utf8');
  return [text, buffer.toString('base64'), buffer.toString('base64url'), buffer.toString('hex')];
}

/** No spelling of any of `secrets` appears in `text`. */
export function expectNoPlaintext(text: string, secrets: readonly string[], what: string): void {
  for (const secret of secrets) {
    for (const spelled of spellings(secret)) {
      expect(text.includes(spelled), `${what} 含有令牌明文（${spelled.slice(0, 12)}…）`).toBe(
        false,
      );
    }
  }
}

/**
 * Exactly one apple_unbind_revoke job of the app, on identity's data-copy queue, payload
 * {appId, cipher}: appId is the app's, the cipher decrypts to `token`, and the job holds no spelling
 * of the plaintext. Returns the job.
 */
export async function expectOneRevocation(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  token: string,
): Promise<QueuedJob> {
  const jobs = await revocations(db, appId);
  expect(
    jobs.map((job) => plaintextOf(crypto, job)),
    '换码所得 refresh_token 不保存时必须恰好入队一条 apple_unbind_revoke，密文解密等于本次令牌',
  ).toEqual([token]);
  const job = jobs[0]!;
  expect(job.queue).toBe(DATA_COPY_QUEUE);
  expect(Object.keys(job.payload).sort()).toEqual(['appId', 'cipher']);
  expect(job.payload['appId']).toBe(appId);
  expectNoPlaintext(JSON.stringify(job), [token], '作业');
  return job;
}

/** The app has no apple_unbind_revoke job. */
export async function expectNoRevocation(db: Kysely<DB>, appId: string): Promise<void> {
  expect(await revocations(db, appId), '不应入队 apple_unbind_revoke').toEqual([]);
}

/**
 * Hands the job once (attempt 1) to the real handler over a recording Apple double that succeeds;
 * returns what Apple was asked to revoke and the handler's log lines.
 */
export async function deliverOnce(crypto: FieldCrypto, job: QueuedJob) {
  const calls: AppleTokenRevokeInput[] = [];
  const { logger, lines } = memoryLogger();
  const worker = createAppleUnbindRevocation({
    crypto,
    apple: {
      revoke(input) {
        calls.push({ ...input });
        return Promise.resolve();
      },
    },
    logger,
  });
  await worker.handle(Object.freeze({ ...job, attempt: 1 }));
  return { calls, lines };
}

/** The Apple binding's stored refresh token, decrypted (null when none is stored). */
export async function storedAppleToken(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  uid: string,
): Promise<string | null> {
  const { rows } = await sql<{ cipher: Buffer | null }>`SELECT apple_refresh_token_cipher AS cipher
    FROM app.user_oauth
    WHERE app_id = ${appId} AND user_id = ${uid} AND provider = 'apple'`.execute(db);
  expect(rows, 'the account has one Apple binding').toHaveLength(1);
  const cipher = rows[0]!.cipher;
  if (cipher === null) return null;
  try {
    return crypto.decrypt(Buffer.from(cipher).toString('utf8'), APPLE_REFRESH_CONTEXT);
  } catch {
    return UNREADABLE;
  }
}

/** Stores `token` as the Apple binding's refresh token, as an earlier Apple login would have. */
export async function keepAppleToken(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  uid: string,
  token: string,
): Promise<void> {
  const cipher = Buffer.from(crypto.encrypt(token, APPLE_REFRESH_CONTEXT), 'utf8');
  const { rows } = await sql`UPDATE app.user_oauth SET apple_refresh_token_cipher = ${cipher}
    WHERE app_id = ${appId} AND user_id = ${uid} AND provider = 'apple'
    RETURNING id`.execute(db);
  expect(rows).toHaveLength(1);
}

/** Adds an Apple binding to an existing account; returns its union id. */
export async function bindApple(db: Kysely<DB>, appId: string, uid: string): Promise<string> {
  const unionId = `union-${randomUUID()}`;
  await sql`INSERT INTO app.user_oauth (id, app_id, user_id, provider, union_id)
    VALUES (${randomUUID()}, ${appId}, ${uid}, 'apple', ${unionId})`.execute(db);
  return unionId;
}

/** The Apple binding row of the account, every column (to_jsonb: ciphers and timestamps as text). */
export async function appleBinding(db: Kysely<DB>, appId: string, uid: string): Promise<string> {
  const { rows } = await sql<{ row: string }>`SELECT to_jsonb(o)::text AS row FROM app.user_oauth o
    WHERE o.app_id = ${appId} AND o.user_id = ${uid} AND o.provider = 'apple'`.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!.row;
}

/**
 * What the cooling-period expiry (deleting) or the completed deletion (deleted) leaves on the users
 * row; nothing else moves. The binding stays, as it does until the completion removes it.
 */
export async function moveStatus(
  db: Kysely<DB>,
  appId: string,
  uid: string,
  status: 'deleting' | 'deleted',
): Promise<void> {
  const { rows } = await sql`UPDATE app.users SET status = ${status}, row_version = row_version + 1
    WHERE app_id = ${appId} AND id = ${uid} RETURNING id`.execute(db);
  expect(rows).toHaveLength(1);
}
