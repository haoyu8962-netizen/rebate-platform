// adminEditUserProfile (PATCH /admin/v1/users/{user_id}/profile; 08 BR-ID-44 细则「后台编辑会员信息」,
// BR-ID-39 细则「后台改昵称」, BR-ID-06 正文; task B1-27b). The admin operation guard has already
// checked the account, the point user.phone_change and its totp step-up, and the route schema the
// body, before this runs. Here, for the user (app_id of the admin actor, user_id):
//   1. unknown user, or one of another app → 20001 [user_id];
//   2. phone: normalize_phone (bind-phone.ts) → 20001 [phone] phone_invalid; equal to the current
//      number after normalisation → not edited; nickname: trimmed, 1–16 extended grapheme clusters
//      (update-nickname.ts) → 20001 [nickname]; equal to the current one after trimming → not
//      edited. A field not edited is not written, checked, reviewed or revoked for;
//   3. an edited phone: risk's blocklist (matchRegistration, nothing recorded: a console refusal
//      writes no risk_hits) → 44001, before the occupancy by another account of the app
//      (status <> 'deleted', by the normalised phone_hmac) → 30411 without data, never mergeable;
//   4. an edited nickname: the content-safety review (NicknameReviewPort; anything but 'pass',
//      a throw included, is 20001 [nickname] nickname_sensitive), not counted in the user's
//      3 changes per month;
//   5. in one transaction: users.phone_cipher / phone_hmac and nickname, the old phone_hmac into
//      deleted_identities (reason phone_changed, 180 days), every session of the user revoked
//      (reason phone_changed, with the push token unbinding of app.module's assembly) when the
//      phone changed, and one audit row user_profile_edit (reason, the changed fields with
//      before / after values, phones masked 3 + 4); any failure rolls all of it back.
//   6. a changed phone of an account flagged for re-verification (BR-WDR-01 细则「清除标记只走人工」;
//      contract「Pending re-verification」, CT-26j; task B1-02zw), in that same transaction and read
//      under its row lock: the flag, its instant, the snapshot and the failure count cleared
//      (reverified_devices stay), every user_oauth row outside the snapshot deleted, and for a
//      deleted Apple row with a stored token one revocation job carrying only the cipher
//      (./apple-unbind-revocation.ts, 编排 D10-513 ④). The clearing restarts the dormancy clock:
//      last_active_at is the save's instant, last_login_device_hash stays (编排 D10-584). The
//      audit row's `after` says the flag was cleared and, when any row went, which providers were
//      really unbound; `fields` stays the edited fields only.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, FieldCrypto, JobQueue, RootLogger } from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT, PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import { trustedIdentitiesOf } from '../domain/reverify.ts';
import {
  REVERIFY_CLEARED,
  readReverifyAccount,
  unbindUntrusted,
  type ReverifyAccount,
} from '../infra/reverify-store.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';
import { enqueueAppleUnbindRevocation } from './apple-unbind-revocation.ts';
import { instantPlus } from './config-seconds.ts';

/** The audit action of a successful save (contract adminEditUserProfile). */
export type AdminProfileEditAction = 'user_profile_edit';
export const ADMIN_PROFILE_EDIT_ACTION: AdminProfileEditAction = 'user_profile_edit';

export interface AdminProfileEditCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  readonly body: {
    readonly phone?: string;
    readonly nickname?: string;
    readonly reason: string;
  };
}

export type AdminProfileEditResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly ['user_id'] } }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20001; readonly data: { readonly fields: readonly ['nickname'] } }
  | {
      readonly code: 20001;
      readonly data: {
        readonly fields: readonly ['nickname'];
        readonly reason: 'nickname_sensitive';
      };
    }
  | { readonly code: 30411 }
  | { readonly code: 44001 };

export interface AdminProfileEditOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly crypto: FieldCrypto;
  readonly review: NicknameReviewPort;
  /** risk's blocklist; only matchRegistration is used (a console refusal records no hit). */
  readonly blocklist: Pick<BlocklistService, 'matchRegistration'>;
  /** Binds the audit port to the save's transaction (app.module: admin's createAuditWriter). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** identity's revocation of every session of the user, on the save's transaction. */
  readonly revokeSessions: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly user_id: string; readonly reason: 'phone_changed' },
  ) => Promise<readonly string[]>;
  /**
   * The Apple revocation job's queue. Without it a save that would unbind a stored Apple token
   * fails and rolls back rather than dropping the revocation.
   */
  readonly queue?: Pick<JobQueue, 'send'>;
}

const PHONE_CHANGED_RETENTION_MS = 180 * 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NICKNAME_MAX = 16;

/** What `after` adds for a clearing (no token, only the providers whose rows were deleted). */
function clearingAudit(unbound: readonly string[]) {
  return {
    reverify_cleared: true,
    ...(unbound.length === 0 ? {} : { unbound_providers: [...unbound] }),
  };
}

/** The phone took a partial unique index slot another account won after the checks. */
class PhoneOccupied extends Error {
  constructor() {
    super('identity: admin profile phone occupied');
    this.name = 'PhoneOccupied';
  }
}

/** Under the row lock the nickname became an edit that was not reviewed: start again. */
class NicknameNotReviewed extends Error {
  constructor() {
    super('identity: admin profile nickname changed concurrently');
    this.name = 'NicknameNotReviewed';
  }
}

/** Attempts of one save when concurrent edits keep moving the current nickname. */
const MAX_ATTEMPTS = 3;

/** A phone check refusal found again inside the write transaction. */
class PhoneRefused extends Error {
  readonly code: 30411 | 44001;
  constructor(code: 30411 | 44001) {
    super('identity: admin profile phone refused');
    this.name = 'PhoneRefused';
    this.code = code;
  }
}

interface CurrentUser {
  readonly phone_hmac: string | null;
  readonly phone_cipher: Uint8Array | null;
  readonly nickname: string;
  readonly row_version: number;
}

interface NewPhone {
  readonly phone: string;
  readonly hmac: string;
}

function graphemes(segmenter: Intl.Segmenter, text: string): number {
  // Stop at the first excess cluster instead of segmenting an arbitrary body.
  let length = 0;
  for (const cluster of segmenter.segment(text)) {
    void cluster;
    if (++length > NICKNAME_MAX) break;
  }
  return length;
}

function isPhoneIndexConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'users_phone_hmac_key'
  );
}

export class AdminProfileEdit {
  readonly #options: AdminProfileEditOptions;
  readonly #segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

  constructor(options: AdminProfileEditOptions) {
    this.#options = options;
  }

  edit(command: AdminProfileEditCommand): Promise<AdminProfileEditResult> {
    return this.#attempt(command, 1);
  }

  async #attempt(
    command: AdminProfileEditCommand,
    attempt: number,
  ): Promise<AdminProfileEditResult> {
    const { body } = command;
    if (!UUID.test(command.userId)) return { code: 20001, data: { fields: ['user_id'] } };
    const db = this.#options.db.withSchema('app');
    const current = await this.#read(db, command);
    if (current === undefined) return { code: 20001, data: { fields: ['user_id'] } };

    let next: NewPhone | null = null;
    if (body.phone !== undefined) {
      const normalized = normalize_phone(body.phone);
      if (normalized.code !== 0) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      next = {
        phone: normalized.phone,
        hmac: this.#options.crypto.blindIndex(normalized.phone, PHONE_BLIND_INDEX_CONTEXT),
      };
    }
    let nickname: string | null = null;
    if (body.nickname !== undefined) {
      nickname = body.nickname.trim();
      const length = graphemes(this.#segmenter, nickname);
      if (length < 1 || length > NICKNAME_MAX) {
        return { code: 20001, data: { fields: ['nickname'] } };
      }
    }

    // Phone checks before the review (contract order); read-only, nothing recorded.
    if (next !== null && next.hmac !== current.phone_hmac) {
      const refused = await this.#options.db
        .transaction()
        .execute((trx) => this.#phoneRefusal(trx, command, next));
      if (refused !== null) return { code: refused };
    }
    // The external review runs outside any transaction or row lock.
    const reviewed = nickname !== null && nickname !== current.nickname;
    if (reviewed) {
      if (!(await this.#reviewed(command, nickname!))) {
        return { code: 20001, data: { fields: ['nickname'], reason: 'nickname_sensitive' } };
      }
    }

    let fields: readonly string[];
    try {
      fields = await this.#options.db
        .transaction()
        .execute((trx) => this.#save(trx, command, next, nickname, reviewed));
    } catch (error) {
      if (error instanceof NicknameNotReviewed && attempt < MAX_ATTEMPTS) {
        return this.#attempt(command, attempt + 1);
      }
      // Thrown out of the transaction, so everything it wrote is rolled back.
      if (error instanceof PhoneRefused) return { code: error.code };
      if (error instanceof PhoneOccupied) return { code: 30411 };
      throw error;
    }
    // Committed: no phone number, no nickname in the line.
    this.#options.logger.info(
      { app_id: command.appId, user_id: command.userId, admin_id: command.adminId, fields },
      'identity_admin_profile_edited',
    );
    return { code: 0 };
  }

  #read(db: Kysely<DB>, command: AdminProfileEditCommand) {
    return db
      .selectFrom('users')
      .select(['phone_hmac', 'phone_cipher', 'nickname', 'row_version'])
      .where('app_id', '=', command.appId)
      .where('id', '=', command.userId)
      .executeTakeFirst();
  }

  /** 44001 before 30411 (task §9); null when the number may be used. */
  async #phoneRefusal(
    trx: Transaction<DB>,
    command: AdminProfileEditCommand,
    next: NewPhone,
  ): Promise<30411 | 44001 | null> {
    const blocked = await this.#options.blocklist.matchRegistration(trx, {
      app_id: command.appId,
      phone_hmac: next.hmac,
      related_phone: next.phone,
    });
    // A console refusal: the hits are not recorded (no risk_hits, no appeal).
    if (blocked !== null) return 44001;
    const holder = await trx
      .withSchema('app')
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', command.appId)
      .where('phone_hmac', '=', next.hmac)
      .where('status', '<>', 'deleted')
      .where('id', '<>', command.userId)
      .executeTakeFirst();
    return holder === undefined ? null : 30411;
  }

  async #reviewed(command: AdminProfileEditCommand, nickname: string): Promise<boolean> {
    let verdict;
    try {
      verdict = await this.#options.review.review({ appId: command.appId, text: nickname });
    } catch {
      // Review errors may echo the submitted text: never log the error object or message.
      verdict = 'unavailable';
    }
    if (verdict === 'pass') return true;
    if (verdict !== 'hit') {
      this.#options.logger.warn(
        { app_id: command.appId, user_id: command.userId },
        'identity_admin_nickname_review_unavailable',
      );
    }
    return false;
  }

  async #save(
    trx: Transaction<DB>,
    command: AdminProfileEditCommand,
    next: NewPhone | null,
    nickname: string | null,
    reviewed: boolean,
  ): Promise<readonly string[]> {
    const { clock, crypto } = this.#options;
    const app = trx.withSchema('app');
    const user: CurrentUser = await app
      .selectFrom('users')
      .select(['phone_hmac', 'phone_cipher', 'nickname', 'row_version'])
      .where('app_id', '=', command.appId)
      .where('id', '=', command.userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Compared again under the row lock: a concurrent save may have made a field unchanged.
    const phone = next !== null && next.hmac !== user.phone_hmac ? next : null;
    const name = nickname !== null && nickname !== user.nickname ? nickname : null;
    // Never write a nickname the review has not passed (a concurrent save changed the current one).
    if (name !== null && !reviewed) throw new NicknameNotReviewed();
    if (phone !== null) {
      const refused = await this.#phoneRefusal(trx, command, phone);
      if (refused !== null) throw new PhoneRefused(refused);
    }
    // Under the row lock, so a flag committed while this save waited for it still counts.
    const subject = { app_id: command.appId, user_id: command.userId };
    const reverify = phone === null ? undefined : await readReverifyAccount(app, subject);
    const flagged = reverify !== undefined && reverify.flagged_at !== null;

    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    const fields: string[] = [];
    let unbound: readonly string[] | null = null;
    if (phone !== null || name !== null) {
      const now = clock.now();
      if (phone !== null) {
        const old =
          user.phone_cipher === null
            ? null
            : crypto.decrypt(Buffer.from(user.phone_cipher).toString('utf8'), PHONE_CIPHER_CONTEXT);
        fields.push('phone');
        before['phone_masked'] = old === null ? null : maskPhone(old);
        after['phone_masked'] = maskPhone(phone.phone);
      }
      if (name !== null) {
        fields.push('nickname');
        before['nickname'] = user.nickname;
        after['nickname'] = name;
      }
      try {
        await app
          .updateTable('users')
          .set({
            ...(phone === null
              ? {}
              : {
                  phone_cipher: Buffer.from(
                    crypto.encrypt(phone.phone, PHONE_CIPHER_CONTEXT),
                    'utf8',
                  ),
                  phone_hmac: phone.hmac,
                }),
            ...(name === null ? {} : { nickname: name }),
            ...(flagged ? { ...REVERIFY_CLEARED, last_active_at: now } : {}),
            updated_at: now,
            row_version: user.row_version + 1,
          })
          .where('app_id', '=', command.appId)
          .where('id', '=', command.userId)
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isPhoneIndexConflict(error)) throw new PhoneOccupied();
        throw error;
      }
      if (phone !== null) {
        // BR-ID-06 正文: the old phone_hmac, kept 180 days; a user without a phone has none.
        if (user.phone_hmac !== null) {
          await app
            .insertInto('deleted_identities')
            .values({
              app_id: command.appId,
              reason: 'phone_changed',
              phone_hmac: user.phone_hmac,
              device_hash: null,
              deleted_at: now,
              expire_at: instantPlus(now, PHONE_CHANGED_RETENTION_MS),
            })
            .execute();
        }
        await this.#options.revokeSessions(trx, {
          app_id: command.appId,
          user_id: command.userId,
          reason: 'phone_changed',
        });
        if (flagged) unbound = await this.#unbind(trx, command.appId, command.userId, reverify);
      }
    }
    await this.#options.auditOn(trx).append({
      appId: command.appId,
      actor: command.adminId,
      action: ADMIN_PROFILE_EDIT_ACTION,
      target: command.userId,
      before,
      after: {
        user_id: command.userId,
        reason: command.body.reason,
        fields,
        ...after,
        ...(unbound === null ? {} : clearingAudit(unbound)),
      },
      ip: command.ip,
    });
    return fields;
  }

  /**
   * Step 6: the bindings outside the snapshot; an unreadable snapshot trusts none of them. Returns
   * the providers of the rows really deleted, sorted.
   */
  async #unbind(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    reverify: ReverifyAccount,
  ): Promise<readonly string[]> {
    const { providers } = trustedIdentitiesOf(reverify.trusted);
    const unbound = await unbindUntrusted(
      trx.withSchema('app'),
      { app_id: appId, user_id: userId },
      providers,
    );
    const cipher = unbound.find((row) => row.provider === 'apple')?.apple_refresh_token_cipher;
    if (cipher !== null && cipher !== undefined) {
      const { queue } = this.#options;
      if (queue === undefined) throw new Error('identity: no queue for the Apple revocation job');
      await enqueueAppleUnbindRevocation(queue, trx, { appId, cipher });
    }
    return unbound.map((row) => row.provider).sort();
  }
}
