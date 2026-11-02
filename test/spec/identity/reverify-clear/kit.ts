// B1-02zw fixtures (BR-WDR-01 细则「清除标记只走人工」, BR-ID-28; contract adminEditUserProfile
// 「Pending re-verification」, CT-26j; 编排 D10-513 ④; task §9). Real PATCH /admin/v1/users/{user_id}/
// profile over the real admin entry and database (container runner only), reusing the B1-27b kit
// for the request, the users and the sessions. Three seams, none of them a business rule:
//   - JOB_QUEUE.send is the real one with a spy: each send records whether it came with a
//     transaction and whether another connection could see the job right after it. failSend makes
//     the send really happen and then throw, so the caller must roll it back.
//   - admin's createAuditWriter can fail the user_profile_edit row, the last write of a save. Tests
//     cannot run DDL (TEST_DB_ROLES), so no trigger breaks a table.
//   - the AppleTokenRevoker of the job handler is a recording double.
// The job's queue, name and payload keys are the implementation's: a job is found by its app id in
// pgboss.job, handed to the handler as the queue would and judged by what it does.
//
// The app id has the shape of a production one (data-copy's payload check is /^[a-z0-9_]{1,32}$/).
//
// Every test reaches a step only the implementation passes: a case that says "nothing changes" ends
// with the same account losing its flag through a real phone change, because on today's code the
// first half alone is green and proves nothing.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import type { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type {
  AppleTokenRevokeInput,
  AppleTokenRevoker,
} from '../../../../apps/api/src/modules/identity/ports/apple-token-revoker.ts';
import type { AuditPort } from '../../../../apps/api/src/modules/platform/audit/port.ts';
import { QUEUE_CATALOG } from '../../../../apps/api/src/modules/platform/queue/catalog.ts';
import type {
  JobHandler,
  JobPayload,
  JobQueue,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { seed } from '../../admin/accounts/kit.ts';
import { fixture, signedIn, type Harness } from '../../admin/auth/kit.ts';
import {
  ACTION,
  REASON,
  edit,
  hmacOf,
  ok,
  row,
  snapshot,
  testPhone,
  user,
  type User,
} from '../admin-profile/kit.ts';
import { gate, type Ports } from '../deletion-processing/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
/** The plaintext of a stored Apple refresh token; it must never leave the database as such. */
export const TOKEN = 'synthetic apple refresh 7c1e';
/** Field-cipher context of the Apple refresh token (identity's APPLE_REFRESH_TOKEN_CONTEXT). */
export const APPLE_REFRESH_CONTEXT = 'user_oauth.apple_refresh_token';
/** The +08:00 day of the admin kit's NOW (2026-10-09 10:00 +08:00). */
export const FAIL_DAY = '2026-10-09';
/** BR-ID-27 as the deletion flow counts it: the third failed attempt is final. */
export const APPLE_MAX_ATTEMPTS = 3;

export type Provider = 'wechat' | 'apple' | 'huawei';
export interface Trusted {
  realname: boolean;
  providers: Provider[];
}
export interface ReverifyState {
  reverify_flagged_at: Date | null;
  reverify_trusted: Trusted | null;
  reverify_fail_count: number;
  reverify_fail_day: string | null;
}

/** One send of a job as the entry made it (event sends left out). */
export interface SentJob {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly inTransaction: boolean;
  /** Another connection could read the job right after the send. */
  readonly visibleOutside: boolean;
}

/** A job row of pgboss.job as the executor would claim it. */
export interface QueuedJob {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
}

export async function scene(h: Harness, options: { appId?: string } = {}) {
  const f = await fixture(h);
  const { JOB_QUEUE } = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as { JOB_QUEUE: symbol };
  const queue = f.app.get<JobQueue>(JOB_QUEUE);
  const realSend = queue.send.bind(queue);
  const sent: SentJob[] = [];
  const control: {
    failSend: boolean;
    failAudit: boolean;
    onSend: (() => Promise<void>) | null;
  } = { failSend: false, failAudit: false, onSend: null };
  vi.spyOn(queue, 'send').mockImplementation(
    async (name: string, job: string, payload: JobPayload, sendOptions: SendOptions) => {
      const id = await realSend(name, job, payload, sendOptions);
      if (name.startsWith('evt.')) return id;
      if (control.failSend) {
        control.failSend = false;
        throw new Error('synthetic enqueue failure');
      }
      const seen =
        id === null
          ? []
          : (
              await sql<{ id: string }>`select id::text as id from pgboss.job
                where id = ${id}::uuid`.execute(h.db)
            ).rows;
      sent.push({
        queue: name,
        name: job,
        payload,
        inTransaction: sendOptions.trx !== null && sendOptions.trx.isTransaction,
        visibleOutside: seen.length > 0,
      });
      await control.onSend?.();
      return id;
    },
  );
  const appId = options.appId ?? `rc_${randomBytes(10).toString('hex')}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'reverify_clear_test_capture_ready' }, 'capture ready');
  return { ...f, h, appId, actor, token: session.admin_token, sent, control };
}
export type Scene = Awaited<ReturnType<typeof scene>>;

type WriterDeps = Parameters<typeof createAuditWriter>[0];

/** From now on control.failAudit fails the next user_profile_edit row (the save's last write). */
export async function breakableAudit(s: Scene): Promise<void> {
  const admin = (await import(new URL('apps/api/src/modules/admin/index.ts', ROOT).href)) as {
    createAuditWriter: (deps: WriterDeps) => AuditPort;
  };
  const real = admin.createAuditWriter;
  vi.spyOn(admin, 'createAuditWriter').mockImplementation((deps: WriterDeps) => {
    const writer = real(deps);
    return {
      ...writer,
      append: (input) => {
        if (input.action === ACTION && s.control.failAudit) {
          s.control.failAudit = false;
          return Promise.reject(new Error('synthetic audit failure'));
        }
        return writer.append(input);
      },
    };
  });
}

// ---------------------------------------------------------------- seeds

export async function bind(
  s: Scene,
  target: Pick<User, 'id' | 'appId'>,
  provider: Provider,
  options: { token?: string } = {},
) {
  await s.h.db
    .insertInto('user_oauth')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      provider,
      union_id: `union-${randomUUID()}`,
      apple_refresh_token_cipher:
        options.token === undefined
          ? null
          : Buffer.from(s.h.fields.encrypt(options.token, APPLE_REFRESH_CONTEXT), 'utf8'),
    })
    .execute();
}

/** The flag of BR-WDR-01 with `failures` failed attempts today. */
export async function flag(
  s: Scene,
  target: Pick<User, 'id' | 'appId'>,
  trusted: Trusted,
  failures = 0,
) {
  await sql`UPDATE app.users SET reverify_flagged_at = ${s.clock.now()},
      reverify_trusted = ${JSON.stringify(trusted)}::jsonb,
      reverify_fail_count = ${failures},
      reverify_fail_day = ${failures === 0 ? null : FAIL_DAY}::date
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);
}

export async function reverified(
  s: Scene,
  target: Pick<User, 'id' | 'appId'>,
  source: 'self' | 'admin',
) {
  await sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
    VALUES (${randomUUID()}, ${target.appId}, ${target.id}, ${randomBytes(32).toString('hex')},
      ${source})`.execute(s.h.db);
}

export interface AccountSpec {
  /** The bindings of the account. */
  bound: readonly Provider[];
  /** The providers of the frozen snapshot (default none). */
  trusted?: readonly Provider[];
  /** The snapshot's realname (default false). */
  realname?: boolean;
  /** The stored refresh token of the Apple binding (default none). */
  token?: string;
  failures?: number;
  /** undefined: a bound test phone; null: no phone. */
  phone?: string | null;
  /** false: no flag at all (default flagged). */
  flagged?: boolean;
}

/** A member of the scene's app with these bindings, flagged unless told otherwise. */
export async function account(s: Scene, spec: AccountSpec, appId = s.appId): Promise<User> {
  const target = await user(s.h, appId, spec.phone === undefined ? {} : { phone: spec.phone });
  for (const provider of spec.bound) {
    await bind(
      s,
      target,
      provider,
      provider === 'apple' && spec.token !== undefined ? { token: spec.token } : {},
    );
  }
  if (spec.flagged !== false) {
    await flag(
      s,
      target,
      { realname: spec.realname ?? false, providers: [...(spec.trusted ?? [])] },
      spec.failures ?? 0,
    );
  }
  return target;
}

// ---------------------------------------------------------------- reads

export async function state(s: Scene, target: Pick<User, 'id' | 'appId'>): Promise<ReverifyState> {
  const { rows } = await sql<ReverifyState>`SELECT reverify_flagged_at, reverify_trusted,
      reverify_fail_count, reverify_fail_day::text AS reverify_fail_day
    FROM app.users WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

export const bindings = (s: Scene, target: Pick<User, 'id' | 'appId'>) =>
  s.h.db
    .selectFrom('user_oauth')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('provider')
    .execute();

export const providersOf = async (s: Scene, target: Pick<User, 'id' | 'appId'>) =>
  (await bindings(s, target)).map((binding) => binding.provider);

export const reverifiedOf = (s: Scene, target: Pick<User, 'id' | 'appId'>) =>
  s.h.db
    .selectFrom('reverified_devices')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('id')
    .execute();

/** What a save of this account must leave alone unless it clears the flag. */
export async function guarded(s: Scene, target: Pick<User, 'id' | 'appId'>) {
  return {
    state: await state(s, target),
    bindings: await bindings(s, target),
    reverified: await reverifiedOf(s, target),
  };
}

/** Everything a save may write in the scene's app (B1-27b's snapshot, the bindings and devices). */
export async function world(s: Scene) {
  return {
    ...(await snapshot(s.h, s.appId)),
    bindings: await s.h.db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    reverified: await s.h.db
      .selectFrom('reverified_devices')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
  };
}

/** The app's committed jobs, whatever their queue (event queues left out). */
export async function queued(s: Scene): Promise<QueuedJob[]> {
  const { rows } = await sql<{
    id: string;
    queue: string;
    data: { name: string; payload: JobPayload };
  }>`select id::text as id, name as queue, data from pgboss.job
    where data::text like ${`%${s.appId}%`} and name not like 'evt.%'`.execute(s.h.db);
  return rows.map((job) => ({
    id: job.id,
    queue: job.queue,
    name: job.data.name,
    payload: job.data.payload,
  }));
}

/** The one committed job of the app. */
export async function onlyJob(s: Scene): Promise<QueuedJob> {
  const jobs = await queued(s);
  expect(jobs, '改号事务必须提交一条撤销作业').toHaveLength(1);
  return jobs[0]!;
}

// ---------------------------------------------------------------- expectations

export async function expectCleared(s: Scene, target: Pick<User, 'id' | 'appId'>) {
  expect(await state(s, target)).toMatchObject({
    reverify_flagged_at: null,
    reverify_trusted: null,
    reverify_fail_count: 0,
  });
}

/** The control of a "nothing changes" case: a real phone change does clear this account. */
export async function phoneChangeClears(s: Scene, target: Pick<User, 'id' | 'appId'>) {
  const next = testPhone();
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  expect((await row(s.h, target)).phone_hmac).toBe(hmacOf(s.h, next));
  await expectCleared(s, target);
}

/** The ways a byte string can be spelled in a JSON payload. */
export function spellings(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString('utf8'),
    buffer.toString('base64'),
    buffer.toString('base64url'),
    buffer.toString('hex'),
  ];
}

/** Every string of a JSON value, keys left out. */
export function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Lines of level warn and above about this app. */
export const alerts = (p: Pick<Ports, 'logs'>, appId: string) =>
  p
    .logs()
    .filter(
      (line) =>
        typeof line['level'] === 'number' && line['level'] >= 40 && line['app_id'] === appId,
    );

// ---------------------------------------------------------------- the job

/** The AppleTokenRevoker double: records its input, fails `failures` times, then succeeds. */
export function appleDouble(failures = 0) {
  const calls: AppleTokenRevokeInput[] = [];
  let left = failures;
  const revoker: AppleTokenRevoker = {
    revoke(input) {
      calls.push({ ...input });
      if (left === 0) return Promise.resolve();
      left -= 1;
      return Promise.reject(new Error(`synthetic-apple-failure ${input.refreshToken}`));
    },
  };
  return { calls, revoker };
}

/**
 * Delivers a job as the queue does: `attempt` grows by one while the handler rejects, up to the
 * retries of the job's queue. Returns the last attempt.
 */
export async function deliver(handle: JobHandler, job: QueuedJob): Promise<number> {
  const spec = QUEUE_CATALOG.find((queue) => queue.name === job.queue);
  expect(spec, `queue ${job.queue} is not in the catalog`).toBeDefined();
  const last = spec!.retryLimit + 1;
  for (let attempt = 1; attempt < last; attempt += 1) {
    try {
      await handle(Object.freeze({ ...job, attempt }));
      return attempt;
    } catch {
      continue;
    }
  }
  await handle(Object.freeze({ ...job, attempt: last })).catch(() => undefined);
  return last;
}

// ---------------------------------------------------------------- barriers

/**
 * Runs `work` in a transaction of its own and keeps it open until release(), so a request stops at
 * the first statement that needs what `work` locked.
 */
export async function hold(s: Scene, work: (trx: Transaction<DB>) => Promise<unknown>) {
  const opened = gate();
  const locked = gate();
  const holder = s.h.db.transaction().execute(async (trx) => {
    await work(trx);
    locked.open();
    await opened.promise;
  });
  await Promise.race([locked.promise, holder]);
  return {
    release: async () => {
      opened.open();
      await holder;
    },
  };
}
