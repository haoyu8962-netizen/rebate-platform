// Shared transactional login writes. The caller owns commit/rollback and chooses the method.
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { isVersionGatedPlatform, type Clock, type FieldCrypto } from '../../platform/index.ts';
import {
  LOGIN_LOGS_DEVICE_ID_CONTEXT,
  LOGIN_MERGE_CHANNEL,
  LOGIN_PAGE_CHANNEL,
  LOGIN_PAGE_TYPES,
  loginMergeCopies,
} from '../domain/login.ts';
import {
  deviceConsentRecords,
  insertConsentRecords,
  lockUserConsents,
  userConsentRecords,
  type NewConsentRecord,
} from '../infra/consent-records.ts';
import { deviceHashOf, type LoginAccount } from '../infra/login-accounts.ts';
import { hasLoginLog, insertLoginLog } from '../infra/login-logs.ts';
import type { TokenService } from './access-tokens.ts';
import { recordLoginActivity } from './reverify-activity.ts';
import type { SessionPushTokens } from './push-tokens.ts';
import { createSession, type LoginMethod } from './sessions.ts';

type SessionScope = 'full' | 'deletion_only';
export interface LoginCommand {
  readonly app_id: string;
  readonly device_id: string;
  readonly platform: ClientPlatform;
  readonly client_ip: string;
  readonly body: Pick<Schema<'LoginBySmsRequest'>, 'consent_at' | 'legal_versions'>;
  /** withdraw.dormant_reverify_days, read before the transaction (reverify-activity.ts); absent: off. */
  readonly dormantReverifyDays?: number | undefined;
}
/** B1-11 supplies the review; identity selects landing-bound users with no login_logs.
 * Invoke on App platforms only, in the same transaction as the first successful login log.
 * This port cannot create a relationship. Absence means no work (no landing binds exist yet).
 */
export interface FirstAppLoginReview {
  review(
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      /** blindIndex(verifiedDevice.deviceId, 'login_logs.device_id').
       * Implementation exports LOGIN_LOGS_DEVICE_ID_CONTEXT from identity/index.ts.
       * Test-stage skeletons cannot declare initialized constants.
       */
      readonly device_id_hash: string;
    },
  ): Promise<void>;
}

export interface LoginCompletionOptions {
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly tokens: TokenService;
  readonly pushTokens?: SessionPushTokens;
  readonly firstAppLoginReview?: FirstAppLoginReview;
}
function instantAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

/** Login-page consents, login_merge, login log, first-App-login review and the session. */
export async function completeLogin(
  trx: Transaction<DB>,
  command: LoginCommand,
  account: LoginAccount,
  scope: SessionScope,
  method: LoginMethod,
  options: LoginCompletionOptions,
): Promise<Schema<'TokenPair'>> {
  const { clock, crypto, tokens } = options;
  const { app_id: appId, device_id: deviceId, body } = command;
  const userId = account.id;
  // BR-INV-09 candidate, decided before any lock is waited for: a landing-bound account with no
  // login_logs yet, logging in on an App platform with the review assembled.
  const review = options.firstAppLoginReview;
  const reviewCandidate =
    review !== undefined &&
    isVersionGatedPlatform(command.platform) &&
    account.parent_bind_source === 'landing' &&
    !(await hasLoginLog(trx, appId, userId));
  // Lock order (B1-11f money review r1 / r2 S1), the same in every path that takes both locks:
  // users row (FOR NO KEY UPDATE) → consent lock → growth's relation write lock. The OAuth lookup
  // (findOauthAccount) and a user-level consent write (consents.ts) lock the row first too. Only a
  // candidate takes it here: the review may UPDATE this users row after the consent lock, while any
  // other login writes under the consent lock only rows that reference users (their foreign-key
  // KEY SHARE does not conflict with FOR NO KEY UPDATE), so it never waits on the row lock.
  if (reviewCandidate) {
    await trx
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }
  // BR-ID-12: one user's logins on several devices merge one after another (lockUserConsents).
  await lockUserConsents(trx, appId, userId);
  const now = clock.now();
  // consent_at is a contract date-time (client clock), stored as reported.
  const clientAt = instantAt(now, Date.parse(body.consent_at));
  // BR-ID-04: two user-level records of the login page, version as reported by the client.
  await insertConsentRecords(
    trx,
    LOGIN_PAGE_TYPES.map((type): NewConsentRecord => ({
      app_id: appId,
      subject_type: 'user',
      user_id: userId,
      device_id: null,
      type,
      version: body.legal_versions[type],
      channel: LOGIN_PAGE_CHANNEL,
      accepted: true,
      client_at: clientAt,
      server_at: now,
      created_at: now,
    })),
  );
  // BR-ID-12 login_merge: this installation's device-level current states.
  const copies = loginMergeCopies(
    await deviceConsentRecords(trx, appId, deviceId),
    await userConsentRecords(trx, appId, userId),
  );
  await insertConsentRecords(
    trx,
    copies.map((record): NewConsentRecord => ({
      app_id: appId,
      subject_type: 'user',
      user_id: userId,
      device_id: null,
      type: record.type,
      version: record.version,
      channel: LOGIN_MERGE_CHANNEL,
      accepted: record.accepted,
      client_at: record.client_at,
      server_at: now,
      created_at: now,
    })),
  );
  const deviceIdHash = crypto.blindIndex(deviceId, LOGIN_LOGS_DEVICE_ID_CONTEXT);
  const firstLogin = !(await hasLoginLog(trx, appId, userId));
  // BR-ID-37: the device_hash of this request's verified device row, for the same-device check.
  const deviceHash = (await deviceHashOf(trx, appId, deviceId)) ?? null;
  await insertLoginLog(trx, {
    app_id: appId,
    user_id: userId,
    device_id_hash: deviceIdHash,
    device_hash: deviceHash,
    ip: command.client_ip,
    method,
    created_at: now,
  });
  // BR-INV-09: only an App login, only a landing-bound user, only the first login log (checked
  // again under the consent lock: a concurrent first login may have committed meanwhile). Only a
  // candidate holds the users row lock, so the review never waits for a row lock after the
  // consent lock.
  if (review !== undefined && reviewCandidate && firstLogin) {
    await review.review(trx, { app_id: appId, user_id: userId, device_id_hash: deviceIdHash });
  }
  // BR-WDR-01 细则「判定」: every login method passes here.
  await recordLoginActivity(trx, {
    app_id: appId,
    user_id: userId,
    deviceHash,
    now,
    days: command.dormantReverifyDays,
  });
  const pushTokens = options.pushTokens;
  const session = await createSession(
    trx,
    { uid: userId, app_id: appId, device_id: deviceId, scp: scope },
    { clock, tokens, loginMethod: method },
    pushTokens === undefined
      ? undefined
      : (sameTransaction, issued) =>
          pushTokens.bind(sameTransaction, {
            app_id: appId,
            user_id: userId,
            device_id: deviceId,
            sid: issued.sid,
          }),
  );
  // The expiries the session primitive actually issued (JWT exp, refresh_tokens.expire_at).
  return {
    session_scope: session.session_scope,
    access_token: session.access_token,
    access_expires_at: session.access_expires_at.toISOString(),
    refresh_token: session.refresh_token,
    refresh_expires_at: session.refresh_expires_at.toISOString(),
  };
}
