// Processing of deletion requests that reached processing: cleanup and done (task B1-15g; 08
// BR-ID-27, BR-ID-28, BR-ID-04, BR-ID-20, BR-AI-22, BR-FUND-24 ⑧; orchestrator brief §9.2,
// rulings D10-137, D10-186).
//
// One round (runOnce), run by the worker's deletion timer before the cooling-period expiry:
// across apps, `status = 'processing'`, keyset batches on id; one request that throws is one warn
// line and the round goes on; a stop request is honoured between requests. Per request, three
// steps, each with its own Clock reading:
//   ① cleanup transaction (cleaned_at still NULL): users row, then the request; sessions revoked
//      (account_deleted), nickname / avatar reset, the old-number re-verification data removed
//      (B1-02zr), real name cleared or retained (tax_retained), payout accounts anonymized,
//      login_logs detached, the cross-module ports; cleaned_at = now only when every port is
//      available.
//   ② Apple revocation outside any transaction (cleaned_at set, apple_revoke_result NULL): at most
//      one attempt per round, the third failure is final (failed) and alerts, never blocking done.
//      B1-27h (BR-ID-40 细则「副本请求与注销状态」): the same transaction cancels the user's open
//      personal information copy requests (pending / running / ready); once it committed, every
//      copy file of the user still recorded (delivered and unexpired ones included) is deleted
//      through dataCopyStore and object_key cleared — a failed delete is one warn line and the file
//      stays recorded for its expire job; without dataCopyStore the files wait for those jobs.
//   ③ completion transaction: closing adjustment none_needed / done required; phone_hmac and the
//      device hashes into deleted_identities (180 days), user_oauth deleted, users tombstone
//      (status deleted), the request COMPLETE → done.
// Progress columns (cleaned_at, apple_*) never move row_version / updated_at.
//
// Phone and user_oauth stay until ③: a login during processing must still find the account and
// answer 10007 (BR-ID-27 细则), never create a new one.
// devices rows are never touched (D10-137 ③: devices are shared by installation; revoking the
// install secret would reach other members of the same phone); only the user's sids are revoked.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { transitionDeletionRequest } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, ExportStore, FieldCrypto, RootLogger } from '../../platform/index.ts';
import { DEFAULT_AVATAR } from '../domain/registration.ts';
import { APPLE_REFRESH_TOKEN_CONTEXT } from '../infra/oauth-accounts.ts';
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';
import type {
  DeletionCleanupPort,
  DeletionCleanupPortName,
  DeletionCleanupPorts,
  DeletionCleanupStep,
  DeletionClosingAdjustmentReader,
} from '../ports/deletion-cleanup.ts';
import { cancelOpenCopiesOfUser, deleteCopyFilesOfUser } from '../infra/personal-data-copies.ts';
import { lockUsersForUpdate } from '../ports/lock-users.ts';
import type { WithdrawalSucceededReader } from '../ports/withdrawal-in-flight.ts';
import { instantPlus } from './config-seconds.ts';
import { createDailyDedup } from './daily-dedup.ts';
import { revokeSessionsByUser, type AfterSessionsRevoked } from './revoke-sessions.ts';

export interface DeletionProcessingOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /**
   * Decrypts user_oauth.apple_refresh_token_cipher (APPLE_REFRESH_TOKEN_CONTEXT). Without a keyring
   * an Apple attempt cannot decrypt and counts as a failed attempt.
   */
  readonly crypto?: FieldCrypto;
  readonly cleanup: DeletionCleanupPorts;
  readonly funds: DeletionClosingAdjustmentReader;
  /** D10-137 ②: a paid-out withdrawal keeps the real-name ciphertext (tax_retained). */
  readonly withdrawals: WithdrawalSucceededReader;
  readonly apple: AppleTokenRevoker;
  /** The push token unbinding of the revoked sessions, in the cleanup transaction. */
  readonly afterRevoked?: AfterSessionsRevoked;
  /**
   * B1-27h (BR-ID-40 细则「副本请求与注销状态」): the private store of the personal information
   * copies, whose files of the user (delivered ones included) the cleanup deletes.
   */
  readonly dataCopyStore?: Pick<ExportStore, 'delete'>;
  readonly batchSize?: number;
}

export interface DeletionProcessing {
  /** The timer passes its stop predicate so shutdown can finish the current request only. */
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

/** Brief §9.2 #2: keyset page size. */
const DEFAULT_BATCH_SIZE = 100;
const DAY_MS = 86_400_000;
/** BR-ID-28: deleted_identities are kept 180 days from the completion. */
const RETENTION_MS = 180 * DAY_MS;
/** BR-ID-27: the third failed Apple attempt is final. */
const APPLE_MAX_ATTEMPTS = 3;
/** BR-ID-28: the nickname of a deleted account. */
const TOMBSTONE_NICKNAME = '已注销用户';
/** payout_accounts.payee_name stays NOT NULL (0077): a placeholder without the original name. */
const ANONYMIZED_PAYEE = '已注销用户';
const DELETED_REASON = 'account_deleted';
/** The order the cross-module ports run in, inside the cleanup transaction. */
const PORT_ORDER: readonly DeletionCleanupPortName[] = [
  'linking',
  'growth',
  'notification',
  'agent',
  'catalog',
  'feedback',
];

interface Due {
  readonly app_id: string;
  readonly id: string;
  readonly user_id: string;
}

interface Progress {
  readonly status: string;
  readonly cleaned_at: Date | null;
  readonly apple_revoke_attempts: number;
  readonly apple_revoke_result: string | null;
}

type CleanupOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'cleaned' }
  | { readonly kind: 'blocked'; readonly ports: readonly DeletionCleanupPortName[] };

type CompletionOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'done' }
  | { readonly kind: 'adjustment_pending'; readonly state: string };

/** users.status was not deleting at completion: the completion transaction rolls back. */
class DeletionUserNotDeleting extends Error {
  constructor() {
    super('identity: the user of a processing deletion request is not deleting');
    this.name = 'DeletionUserNotDeleting';
  }
}

/** A conditional write lost to a concurrent writer: the transaction rolls back. */
class DeletionRequestChanged extends Error {
  constructor() {
    super('identity: deletion request changed concurrently');
    this.name = 'DeletionRequestChanged';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function batchSizeOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BATCH_SIZE;
}

function isStep(port: DeletionCleanupPort): port is DeletionCleanupStep {
  return typeof port === 'function';
}

/** A Clock fixed at the step's reading, so every write of the step carries the same instant. */
function fixedAt(now: Date): Clock {
  return { now: () => instantPlus(now, 0) };
}

export function createDeletionProcessing(options: DeletionProcessingOptions): DeletionProcessing {
  const { db, clock, logger, crypto, cleanup, funds, withdrawals, apple, afterRevoked } = options;
  const dataCopyStore = options.dataCopyStore;
  const batchSize = batchSizeOf(options.batchSize);
  const dedup = createDailyDedup();

  /** The request's progress, a plain read (every decision is re-checked under lock or by CAS). */
  async function progressOf(due: Due): Promise<Progress | undefined> {
    return db
      .withSchema('app')
      .selectFrom('deletion_requests')
      .select(['status', 'cleaned_at', 'apple_revoke_attempts', 'apple_revoke_result'])
      .where('app_id', '=', due.app_id)
      .where('id', '=', due.id)
      .executeTakeFirst();
  }

  /** ① The cleanup transaction. */
  async function clean(due: Due): Promise<CleanupOutcome> {
    return db.transaction().execute(async (trx: Transaction<DB>): Promise<CleanupOutcome> => {
      const now = clock.now();
      const appId = due.app_id;
      const userId = due.user_id;
      // Lock order: the user's row, then the request (then growth's children, in its port).
      await lockUsersForUpdate(trx, { appId, userIds: [userId] });
      const row = await trx
        .withSchema('app')
        .selectFrom('deletion_requests')
        .select('id')
        .where('app_id', '=', appId)
        .where('id', '=', due.id)
        .where('status', '=', 'processing')
        .where('cleaned_at', 'is', null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'skipped' };

      // Sessions: every live sid of the user; devices stay (D10-137 ③). The push unbinding hook
      // joins this transaction.
      await revokeSessionsByUser(
        trx,
        { app_id: appId, user_id: userId, reason: 'account_deleted' },
        fixedAt(now),
        afterRevoked,
      );

      // Nickname, avatar and the re-verification columns (BR-ID-28, BR-ID-28 细则「待加验记录」;
      // reverify_fail_count is NOT NULL, its empty value is 0). Written only when something
      // changes, so a blocked cleanup that runs again every round does not bump row_version each
      // time. reverify_fail_epoch stays: a generation counter, not personal data, and a late
      // releaseFailure already finds no reverify_fail_day to match.
      // TODO(规划/11 §2.3): 删除自定义头像文件 — blocked on 头像上传（尚未实现，avatar 只存引用）
      await trx
        .withSchema('app')
        .updateTable('users')
        .set((eb) => ({
          nickname: TOMBSTONE_NICKNAME,
          avatar: DEFAULT_AVATAR,
          nickname_change_month: null,
          nickname_change_count: 0,
          last_active_at: null,
          last_login_device_hash: null,
          reverify_flagged_at: null,
          reverify_trusted: null,
          reverify_fail_count: 0,
          reverify_fail_day: null,
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where((eb) =>
          eb.or([
            eb('nickname', '<>', TOMBSTONE_NICKNAME),
            eb('avatar', '<>', DEFAULT_AVATAR),
            eb('nickname_change_month', 'is not', null),
            eb('nickname_change_count', '<>', 0),
            eb('last_active_at', 'is not', null),
            eb('last_login_device_hash', 'is not', null),
            eb('reverify_flagged_at', 'is not', null),
            eb('reverify_trusted', 'is not', null),
            eb('reverify_fail_count', '<>', 0),
            eb('reverify_fail_day', 'is not', null),
          ]),
        )
        .execute();

      // The devices that passed re-verification, this user's rows only: the same device under
      // another account keeps its own.
      await trx
        .withSchema('app')
        .deleteFrom('reverified_devices')
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .execute();

      // Real name (D10-137 ②): kept read-only and marked when a withdrawal was paid out, cleared
      // otherwise; status none either way, so the verified-HMAC index is released.
      const retained = await withdrawals.hasSucceeded(trx, { appId, userId });
      if (retained) {
        await trx
          .withSchema('app')
          .updateTable('realname')
          .set((eb) => ({
            status: 'none',
            tax_retained: true,
            row_version: eb('row_version', '+', 1),
            updated_at: now,
          }))
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where((eb) => eb.or([eb('status', '<>', 'none'), eb('tax_retained', '=', false)]))
          .execute();
      } else {
        await trx
          .withSchema('app')
          .updateTable('realname')
          .set((eb) => ({
            status: 'none',
            name_cipher: null,
            id_no_cipher: null,
            id_no_hmac: null,
            birth_date_cipher: null,
            provider: null,
            verified_at: null,
            tax_retained: false,
            row_version: eb('row_version', '+', 1),
            updated_at: now,
          }))
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where((eb) =>
            eb.or([
              eb('status', '<>', 'none'),
              eb('name_cipher', 'is not', null),
              eb('id_no_cipher', 'is not', null),
              eb('id_no_hmac', 'is not', null),
              eb('birth_date_cipher', 'is not', null),
              eb('provider', 'is not', null),
              eb('verified_at', 'is not', null),
              eb('tax_retained', '=', true),
            ]),
          )
          .execute();
      }

      // Payout accounts (D10-186 ①): anonymized in place, never deleted (withdrawals keep their
      // reference); the 0077 trigger admits exactly this one update per row.
      await trx
        .withSchema('app')
        .updateTable('payout_accounts')
        .set((eb) => ({
          alipay_logon_id_cipher: null,
          alipay_hmac: null,
          bank_card_no_cipher: null,
          bank_card_hmac: null,
          bank_name: null,
          card_bin: null,
          payee_name: ANONYMIZED_PAYEE,
          is_current: false,
          anonymized_at: now,
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('anonymized_at', 'is', null)
        .execute();

      // Personal information copies (BR-ID-40 细则「副本请求与注销状态」): open requests cancelled;
      // their files are deleted after the commit (processOne).
      await cancelOpenCopiesOfUser(trx, { appId, userId, at: now });

      // Login logs: detached from the user, kept until their own retention (BR-ID-28).
      await trx
        .withSchema('app')
        .updateTable('login_logs')
        .set({ user_id: null })
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .execute();

      // The owning modules' shares, on this transaction. An unshipped port blocks cleaned_at.
      const blocked: DeletionCleanupPortName[] = [];
      for (const name of PORT_ORDER) {
        const port = cleanup[name];
        // Only the optional feedback port can be absent (a port set without it): nothing to run.
        if (port === undefined) continue;
        if (isStep(port)) await port(trx, { appId, userId, at: now });
        else blocked.push(name);
      }
      if (blocked.length > 0) return { kind: 'blocked', ports: blocked };

      const marked = await trx
        .withSchema('app')
        .updateTable('deletion_requests')
        .set({ cleaned_at: now })
        .where('app_id', '=', appId)
        .where('id', '=', due.id)
        .where('status', '=', 'processing')
        .where('cleaned_at', 'is', null)
        .executeTakeFirst();
      if (marked.numUpdatedRows !== 1n) throw new DeletionRequestChanged();
      return { kind: 'cleaned' };
    });
  }

  /** ② One Apple attempt outside any transaction; the outcome is written by CAS. */
  async function revokeApple(due: Due, progress: Progress): Promise<void> {
    const binding = await db
      .withSchema('app')
      .selectFrom('user_oauth')
      .select('apple_refresh_token_cipher')
      .where('app_id', '=', due.app_id)
      .where('user_id', '=', due.user_id)
      .where('provider', '=', 'apple')
      .where('apple_refresh_token_cipher', 'is not', null)
      .executeTakeFirst();
    const base = db
      .withSchema('app')
      .updateTable('deletion_requests')
      .where('app_id', '=', due.app_id)
      .where('id', '=', due.id)
      .where('status', '=', 'processing')
      .where('cleaned_at', 'is not', null)
      .where('apple_revoke_result', 'is', null)
      .where('apple_revoke_attempts', '=', progress.apple_revoke_attempts);
    const cipher = binding?.apple_refresh_token_cipher;
    if (cipher === null || cipher === undefined) {
      await base.set({ apple_revoke_result: 'not_applicable' }).execute();
      return;
    }
    let revoked: boolean;
    try {
      if (crypto === undefined) throw new Error('identity: no field keyring for the Apple token');
      const refreshToken = crypto.decrypt(
        Buffer.from(cipher).toString('utf8'),
        APPLE_REFRESH_TOKEN_CONTEXT,
      );
      await apple.revoke({ appId: due.app_id, refreshToken });
      revoked = true;
    } catch {
      // The error may carry the token or Apple's answer: nothing of it is logged.
      revoked = false;
    }
    const attempts = progress.apple_revoke_attempts + 1;
    const final = !revoked && attempts >= APPLE_MAX_ATTEMPTS;
    const written = await base
      .set({
        apple_revoke_attempts: attempts,
        apple_revoke_result: revoked ? 'revoked' : final ? 'failed' : null,
      })
      .executeTakeFirst();
    if (final && written.numUpdatedRows === 1n) {
      logger.warn(
        { app_id: due.app_id, deletion_request_id: due.id },
        'identity_deletion_apple_revoke_failed',
      );
    }
  }

  /** ③ The completion transaction. */
  async function complete(due: Due): Promise<CompletionOutcome> {
    return db.transaction().execute(async (trx: Transaction<DB>): Promise<CompletionOutcome> => {
      const now = clock.now();
      const appId = due.app_id;
      const userId = due.user_id;
      await lockUsersForUpdate(trx, { appId, userIds: [userId] });
      const row = await trx
        .withSchema('app')
        .selectFrom('deletion_requests')
        .select(['id', 'row_version'])
        .where('app_id', '=', appId)
        .where('id', '=', due.id)
        .where('status', '=', 'processing')
        .where('cleaned_at', 'is not', null)
        .where('apple_revoke_result', 'is not', null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'skipped' };

      // D10-137 ①, BR-FUND-24 ⑧: a balance never passes to done.
      const state = await funds.closingAdjustmentState(trx, { appId, userId });
      if (state !== 'none_needed' && state !== 'done') {
        return { kind: 'adjustment_pending', state: String(state) };
      }

      const user = await trx
        .withSchema('app')
        .selectFrom('users')
        .select(['phone_hmac', 'status'])
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      if (user === undefined || user.status !== 'deleting') throw new DeletionUserNotDeleting();

      // The devices of the user's sessions (sessions keep user_id; login_logs are detached).
      const devices = await trx
        .withSchema('app')
        .selectFrom('sessions as s')
        .innerJoin('devices as d', (join) =>
          join.onRef('d.app_id', '=', 's.app_id').onRef('d.id', '=', 's.device_id'),
        )
        .select('d.device_hash')
        .distinct()
        .where('s.app_id', '=', appId)
        .where('s.user_id', '=', userId)
        .execute();
      const expireAt = instantPlus(now, RETENTION_MS);
      const identities = [
        ...(user.phone_hmac === null ? [] : [{ phone_hmac: user.phone_hmac, device_hash: null }]),
        ...devices.map((d) => ({ phone_hmac: null, device_hash: d.device_hash })),
      ].map((identity) => ({
        app_id: appId,
        reason: DELETED_REASON,
        ...identity,
        deleted_at: now,
        expire_at: expireAt,
      }));
      if (identities.length > 0) {
        await trx.withSchema('app').insertInto('deleted_identities').values(identities).execute();
      }

      await trx
        .withSchema('app')
        .deleteFrom('user_oauth')
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .execute();

      // When identity caches account states, the cache must be invalidated here (BR-ID-01).
      const tomb = await trx
        .withSchema('app')
        .updateTable('users')
        .set((eb) => ({
          status: 'deleted',
          phone_cipher: null,
          phone_hmac: null,
          deleted_reason: DELETED_REASON,
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where('status', '=', 'deleting')
        .executeTakeFirst();
      if (tomb.numUpdatedRows !== 1n) throw new DeletionUserNotDeleting();

      const moved = transitionDeletionRequest('processing', 'COMPLETE');
      if (!moved.ok) throw new Error('identity: deletion complete transition refused');
      const done = await trx
        .withSchema('app')
        .updateTable('deletion_requests')
        .set({
          status: moved.to,
          processed_at: now,
          row_version: row.row_version + 1,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', row.id)
        .where('status', '=', 'processing')
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (done.numUpdatedRows !== 1n) throw new DeletionRequestChanged();
      return { kind: 'done' };
    });
  }

  async function processOne(due: Due): Promise<void> {
    let progress = await progressOf(due);
    if (progress === undefined || progress.status !== 'processing') return;
    if (progress.cleaned_at === null) {
      const outcome = await clean(due);
      if (outcome.kind !== 'skipped' && dataCopyStore !== undefined) {
        try {
          await deleteCopyFilesOfUser(
            db,
            { appId: due.app_id, userId: due.user_id },
            { clock, store: dataCopyStore, logger },
          );
        } catch (error) {
          // The files stay recorded in object_key: their expire jobs delete them.
          logger.warn(
            { app_id: due.app_id, deletion_request_id: due.id, error_name: errorName(error) },
            'identity_deletion_data_copy_files_failed',
          );
        }
      }
      if (outcome.kind === 'blocked') {
        const now = clock.now();
        for (const port of outcome.ports) {
          // TODO(规划/11 §2.3): 未上线端口阻塞置 done — blocked on 各端口的属主任务（见 app.module 装配）
          if (dedup.first(`blocked:${due.id}:${port}`, now)) {
            logger.warn(
              { app_id: due.app_id, deletion_request_id: due.id, port },
              'identity_deletion_cleanup_blocked',
            );
          }
        }
        return;
      }
      progress = await progressOf(due);
      if (progress === undefined || progress.status !== 'processing') return;
      if (progress.cleaned_at === null) return;
    }
    if (progress.apple_revoke_result === null) {
      await revokeApple(due, progress);
      progress = await progressOf(due);
      if (progress === undefined || progress.status !== 'processing') return;
      if (progress.apple_revoke_result === null) return;
    }
    const outcome = await complete(due);
    if (outcome.kind === 'adjustment_pending') {
      if (dedup.first(`adjustment:${due.id}`, clock.now())) {
        logger.warn(
          { app_id: due.app_id, deletion_request_id: due.id, state: outcome.state },
          'identity_deletion_adjustment_pending',
        );
      }
    }
  }

  return Object.freeze({
    async runOnce(stopping: () => boolean = () => false): Promise<{ scanned: number }> {
      let scanned = 0;
      let after: string | undefined;
      for (;;) {
        if (stopping()) return { scanned };
        let query = db
          .withSchema('app')
          .selectFrom('deletion_requests')
          .select(['app_id', 'id', 'user_id'])
          .where('status', '=', 'processing');
        if (after !== undefined) query = query.where('id', '>', after);
        const rows = await query.orderBy('id').limit(batchSize).execute();
        for (const row of rows) {
          if (stopping()) return { scanned };
          scanned += 1;
          try {
            await processOne(row);
          } catch (error) {
            // The row's content and the error message stay out of the log.
            if (dedup.first(`failed:${row.id}`, clock.now())) {
              logger.warn(
                { app_id: row.app_id, deletion_request_id: row.id, error_name: errorName(error) },
                'identity_deletion_cleanup_failed',
              );
            }
          }
        }
        const last = rows.at(-1);
        if (rows.length < batchSize || last === undefined) return { scanned };
        after = last.id;
      }
    },
  });
}
